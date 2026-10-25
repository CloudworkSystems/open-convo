import { createHash } from 'node:crypto';
import {
  COMMON_MAIL_DOMAINS, EmailActionsError, LIMITS, PILES, PILE_NAMES, addressKey, compareText,
  domainOf, lower, own,
} from './rules.mjs';
import { compareDates, parseDate, validateMessages, validateRequests } from './validate.mjs';

function asciiLower(text) {
  return text.replace(/[A-Z]/g, character => character.toLowerCase());
}

function headerValues(headers, name) {
  const wanted = asciiLower(name);
  const keys = Object.keys(headers).filter(key => asciiLower(key) === wanted).sort(compareText);
  return keys.flatMap(key => Array.isArray(headers[key]) ? headers[key] : [headers[key]]);
}

function firstHeader(headers, name) {
  return headerValues(headers, name).find(value => value.trim() !== '') ?? null;
}

function normalizeId(text) {
  const id = lower(text.replace(/^[\s<>]+|[\s<>]+$/g, ''));
  if ([...id].length <= LIMITS.headerIdChars) return id;
  return `SHA256:${createHash('sha256').update(Buffer.from(id, 'utf16le')).digest('hex')}`;
}

function messageIdOf(headers) {
  const value = firstHeader(headers, 'Message-ID');
  if (value === null) return null;
  const token = /<([^<>]*)>/.exec(value);
  const id = normalizeId(token ? token[1] : value);
  return id === '' ? null : id;
}

function listIdOf(headers) {
  const value = firstHeader(headers, 'List-Id');
  if (value === null) return null;
  const token = /<([^<>]*)>/.exec(value);
  const id = normalizeId(token ? token[1] : value);
  return id === '' ? null : id;
}

function compareRef(a, b) {
  return compareText(a.inbox, b.inbox) || compareText(a.id, b.id);
}

function newestFirst(a, b) {
  return -compareDates(a.when, b.when) || compareRef(a.source, b.source);
}

function copyPerson(person) {
  return own(person, 'name') ? { name: person.name, address: person.address } : { address: person.address };
}

function mergeMessages(messages) {
  const entries = [];
  const byMessageId = new Map();
  for (const message of messages) {
    const messageId = messageIdOf(message.headers);
    let entry;
    if (messageId === null) {
      entry = { messageId: null, copies: [] };
      entries.push(entry);
    } else if (byMessageId.has(messageId)) {
      entry = byMessageId.get(messageId);
    } else {
      entry = { messageId, copies: [] };
      byMessageId.set(messageId, entry);
      entries.push(entry);
    }
    entry.copies.push(message);
  }
  return entries.map((entry) => {
    entry.copies.sort(compareRef);
    const source = entry.copies[0];
    return {
      source,
      copies: entry.copies,
      copyKeys: new Set(entry.copies.map(copy => JSON.stringify([copy.inbox, copy.id]))),
      when: parseDate(source.date),
      pile: own(source, 'pile') ? source.pile : null,
      listId: listIdOf(source.headers),
      sender: addressKey(source.from.address),
    };
  });
}

function senderGroupKey(item) {
  return item.listId === null ? `address:${item.sender}` : `list:${item.listId}`;
}

function labelFor(items) {
  const names = new Set(items.map(item => own(item.source.from, 'name') && item.source.from.name.trim() !== '' ? item.source.from.name : null));
  if (names.size === 1 && !names.has(null)) return [...names][0];
  const addresses = new Set(items.map(item => item.sender));
  if (addresses.size === 1) return items[0].source.from.address.trim();
  return senderGroupKey(items[0]).slice('list:'.length);
}

function outputMessage(item, matchedBy) {
  const idsByInbox = new Map();
  for (const copy of item.copies) {
    if (!idsByInbox.has(copy.inbox)) idsByInbox.set(copy.inbox, []);
    idsByInbox.get(copy.inbox).push(copy.id);
  }
  const inboxes = [...idsByInbox.keys()].sort(compareText);
  const ids = Object.fromEntries(inboxes.map(inbox => [inbox, idsByInbox.get(inbox)]));
  return {
    inboxes,
    ids,
    from: copyPerson(item.source.from),
    subject: item.source.subject,
    date: item.source.date,
    pile: item.pile ?? 'unsorted',
    matchedBy: [...matchedBy].sort((a, b) => a - b),
  };
}

function groupItems(items, matches) {
  const groups = new Map();
  for (const item of items) {
    const key = senderGroupKey(item);
    const mapKey = JSON.stringify([item.pile, key]);
    if (!groups.has(mapKey)) groups.set(mapKey, { pile: item.pile, key, items: [] });
    groups.get(mapKey).items.push(item);
  }
  const output = [...groups.values()];
  for (const group of output) group.items.sort(newestFirst);
  output.sort((left, right) => (left.pile === null ? PILES.length : PILES.indexOf(left.pile))
    - (right.pile === null ? PILES.length : PILES.indexOf(right.pile))
    || -compareDates(left.items[0].when, right.items[0].when) || compareText(left.key, right.key));
  return output.map(group => ({
    pile: group.pile ?? 'unsorted',
    key: group.key,
    label: labelFor(group.items),
    count: group.items.length,
    copies: group.items.reduce((count, item) => count + item.copies.length, 0),
    messages: group.items.map(item => outputMessage(item, matches.get(item))),
  }));
}

function targetKind(request) {
  return ['sender', 'domain', 'listId', 'messages'].find(kind => own(request.target, kind));
}

function guardedAddress(targetAddress, items, isDomain) {
  return items.some(item => item.source.to.some((person) => {
    const recipient = addressKey(person.address);
    const matches = isDomain ? domainOf(recipient) === targetAddress : recipient === targetAddress;
    return matches && item.sender !== recipient;
  }));
}

function candidateMatches(request, items) {
  const kind = targetKind(request);
  if (kind === 'messages') {
    const refs = new Set(request.target.messages.map(ref => JSON.stringify([ref.inbox, ref.id])));
    return items.filter(item => [...item.copyKeys].some(ref => refs.has(ref)));
  }
  const wanted = kind === 'listId' ? normalizeId(request.target.listId)
    : kind === 'sender' ? addressKey(request.target.sender) : lower(request.target.domain.slice(1).trim());
  return items.filter((item) => {
    if (kind === 'sender') return item.sender === wanted;
    if (kind === 'domain') return domainOf(item.sender) === wanted;
    return item.listId === wanted;
  });
}

function reasonCounts(items) {
  const reasons = new Map();
  for (const item of items) {
    const reason = item.pile === null
      ? 'Not sorted yet: pick these messages one by one'
      : `In ${PILE_NAMES[item.pile]}: pick these messages one by one`;
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  const order = [
    'In People: pick these messages one by one',
    'In Work: pick these messages one by one',
    'Not sorted yet: pick these messages one by one',
  ];
  return [...reasons].map(([reason, count]) => ({ reason, count }))
    .sort((left, right) => order.indexOf(left.reason) - order.indexOf(right.reason));
}

function safeUrl(text, scheme) {
  if ([...text].length > LIMITS.urlChars) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== scheme || url.username !== '' || url.password !== '') return null;
    return url;
  } catch {
    return null;
  }
}

function listUnsubscribeUris(headers) {
  const value = firstHeader(headers, 'List-Unsubscribe');
  if (value === null) return [];
  return [...value.matchAll(/<([^<>]*)>/g)].map(match => match[1].trim()).filter(Boolean);
}

function parseMailto(text) {
  const url = safeUrl(text, 'mailto:');
  if (url === null || url.hash !== '') return null;
  let to;
  const values = { subject: '', body: '' };
  const seen = new Set();
  try {
    const address = decodeURIComponent(url.pathname);
    if (!/^[^\s@<>,]+@[^\s@<>,]+$/u.test(address) || /[\r\n]/u.test(address)) return null;
    to = [address];
    const queryAt = text.indexOf('?');
    if (queryAt !== -1) {
      for (const pair of text.slice(queryAt + 1).split('&')) {
        if (pair === '') continue;
        const equalsAt = pair.indexOf('=');
        const rawName = equalsAt === -1 ? pair : pair.slice(0, equalsAt);
        const rawValue = equalsAt === -1 ? '' : pair.slice(equalsAt + 1);
        const name = asciiLower(decodeURIComponent(rawName));
        const value = decodeURIComponent(rawValue);
        if (/[\r\n]/u.test(name) || /[\r\n]/u.test(value)) return null;
        if (name !== 'subject' && name !== 'body') return { invalidFields: true };
        if (!seen.has(name)) values[name] = value;
        seen.add(name);
      }
    }
  } catch {
    return null;
  }
  return { to, subject: values.subject, body: values.body };
}

function unsubscribeMethod(message) {
  const uris = listUnsubscribeUris(message.headers);
  const oneClick = headerValues(message.headers, 'List-Unsubscribe-Post')
    .some(value => asciiLower(value.trim()) === 'list-unsubscribe=one-click');
  if (oneClick) {
    for (const uri of uris) {
      const url = safeUrl(uri, 'https:');
      if (url !== null) return { method: 'oneClick', url: uri };
    }
  }
  let extraFields = false;
  for (const uri of uris) {
    const mailto = parseMailto(uri);
    if (mailto?.invalidFields) extraFields = true;
    else if (mailto !== null) return { method: 'mailto', to: mailto.to, subject: mailto.subject, body: mailto.body };
  }
  for (const uri of uris) {
    const url = safeUrl(uri, 'https:');
    if (url !== null) return { method: 'webPage', url: uri };
  }
  if (extraFields) return { method: 'none', reason: 'This unsubscribe address asks to send extra mail fields' };
  const hasHttp = uris.some(uri => safeUrl(uri, 'http:') !== null);
  return hasHttp
    ? { method: 'none', reason: 'Only an insecure link' }
    : { method: 'none', reason: 'This sender gives no way to unsubscribe; you can delete or report it instead' };
}

function buildUnsubscribe(items) {
  const groups = new Map();
  for (const item of items) {
    const key = senderGroupKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const entries = [...groups].map(([key, groupItems]) => {
    groupItems.sort(newestFirst);
    return { key, label: labelFor(groupItems), newest: groupItems[0], method: unsubscribeMethod(groupItems[0].source) };
  });
  entries.sort((left, right) => -compareDates(left.newest.when, right.newest.when) || compareText(left.key, right.key));
  return entries.map(entry => ({ key: entry.key, label: entry.label, ...entry.method }));
}

function copiesOf(items) {
  return items.flatMap(item => item.copies.map(copy => ({ inbox: copy.inbox, id: copy.id }))).sort(compareRef);
}

export function canonicalActionForm(actions, unsubscribe) {
  return {
    actions: actions.map(action => ({ action: action.action, messages: action.groups.flatMap(group => group.messages.flatMap(message =>
      message.inboxes.flatMap(inbox => message.ids[inbox].map(id => ({ inbox, id })))))
      .sort(compareRef) })),
    unsubscribe: unsubscribe.map((entry) => {
      const output = { key: entry.key, method: entry.method };
      if (entry.method === 'oneClick' || entry.method === 'webPage') output.url = entry.url;
      if (entry.method === 'mailto') Object.assign(output, { to: entry.to, subject: entry.subject, body: entry.body });
      return output;
    }).sort((left, right) => compareText(left.key, right.key)),
  };
}

function summaryLines(actions, unsubscribe) {
  const byAction = Object.fromEntries(actions.map(action => [action.action, action]));
  const lines = [];
  for (const action of ['spam', 'delete']) {
    const value = byAction[action];
    const name = action === 'spam' ? 'Spam' : 'Delete';
    lines.push(`${name}: ${value.count} message${value.count === 1 ? '' : 's'} from ${value.groups.length} sender${value.groups.length === 1 ? '' : 's'}`);
  }
  const counts = { oneClick: 0, mailto: 0, webPage: 0, none: 0 };
  for (const entry of unsubscribe) counts[entry.method] += 1;
  lines.push(`Unsubscribe: ${unsubscribe.length} sender${unsubscribe.length === 1 ? '' : 's'} (${counts.oneClick} one-click, ${counts.mailto} by email, ${counts.webPage} web page, ${counts.none} has no way)`);
  return lines;
}

export function previewActions(input, requestInput) {
  validateMessages(input);
  const messageRefs = new Set(input.messages.map(message => JSON.stringify([message.inbox, message.id])));
  validateRequests(requestInput, messageRefs);
  const items = mergeMessages(input.messages);
  const commonDomains = new Set(COMMON_MAIL_DOMAINS);
  const blocked = [];
  const requestResults = [];
  const matchedByAction = { spam: new Map(), delete: new Map(), unsubscribe: new Map() };

  requestInput.requests.forEach((request, index) => {
    const position = index + 1;
    const kind = targetKind(request);
    const result = { position, action: request.action, matched: 0, kept: 0, leftOut: 0, leftOutReasons: [] };
    requestResults.push(result);
    const domain = kind === 'domain' ? lower(request.target.domain.slice(1).trim()) : null;
    const sender = kind === 'sender' ? addressKey(request.target.sender) : null;
    let reason = null;
    if (kind === 'domain' && commonDomains.has(domain)) reason = `This would match everyone who uses ${domain}; choose a sender instead`;
    else if (kind === 'sender' && guardedAddress(sender, items, false)) reason = 'This address also receives mail here; pick messages one by one';
    else if (kind === 'domain' && guardedAddress(domain, items, true)) reason = 'This address also receives mail here; pick messages one by one';
    if (reason !== null) {
      blocked.push({ position, reason });
      return;
    }
    let matches = candidateMatches(request, items);
    if (kind !== 'messages') {
      const leftOut = matches.filter(item => item.pile === null
        || (!own(request, 'pile') && (item.pile === 'people' || item.pile === 'work'))
        || (own(request, 'pile') && item.pile === request.pile && (item.pile === 'people' || item.pile === 'work')));
      matches = matches.filter(item => item.pile !== null
        && (!own(request, 'pile') || item.pile === request.pile)
        && item.pile !== 'people' && item.pile !== 'work');
      result.leftOut = leftOut.length;
      result.leftOutReasons = reasonCounts(leftOut);
    }
    if (matches.length === 0) {
      blocked.push({ position, reason: 'Nothing matches this request' });
      return;
    }
    result.matched = matches.length;
    for (const item of matches) {
      if (!matchedByAction[request.action].has(item)) matchedByAction[request.action].set(item, new Set());
      matchedByAction[request.action].get(item).add(position);
    }
  });

  // Spam wins over delete; its output still names every spam and delete
  // request that matched the message. Unsubscribe remains independent.
  for (const [item, deletePositions] of matchedByAction.delete) {
    if (!matchedByAction.spam.has(item)) continue;
    const keptPositions = matchedByAction.spam.get(item);
    for (const position of deletePositions) keptPositions.add(position);
    matchedByAction.delete.delete(item);
  }
  const actionItems = {
    spam: [...matchedByAction.spam.keys()],
    delete: [...matchedByAction.delete.keys()],
    unsubscribe: [...matchedByAction.unsubscribe.keys()],
  };
  for (const result of requestResults) {
    const map = matchedByAction[result.action];
    result.kept = [...map.values()].filter(positions => positions.has(result.position)).length;
  }
  const actions = ['spam', 'delete', 'unsubscribe'].map((action) => {
    const selected = actionItems[action];
    return {
      action,
      count: selected.length,
      copies: selected.reduce((count, item) => count + item.copies.length, 0),
      groups: groupItems(selected, matchedByAction[action]),
    };
  });
  const unsubscribe = buildUnsubscribe(actionItems.unsubscribe);
  const seal = createHash('sha256').update(JSON.stringify(canonicalActionForm(actions, unsubscribe))).digest('hex');
  return {
    schemaVersion: 1,
    seal,
    actions,
    unsubscribe,
    blocked,
    requests: requestResults,
    summary: summaryLines(actions, unsubscribe),
  };
}
