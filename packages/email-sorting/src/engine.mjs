// The sorting engine: messages in, piles with reasons out. No network, no
// files, no clock, no locale, no random values.

import { createHash } from 'node:crypto';
import {
  CATEGORIES, CATEGORY_DESCRIPTIONS, EmailSortError, LIMITS, PILE_NAMES, charLength, compareText, cutChars,
  domainOf, lower, oneLine, own,
} from './rules.mjs';
import { compareDates, parseDate, validateInput, validateSettings } from './validate.mjs';

// ---------------------------------------------------------------- headers

// The one place a header is looked up; every header the engine reads goes
// through headerValues or firstValue. A key matches a header name exactly
// apart from the case of ASCII letters (RFC 5322 field names are ASCII):
// no trimming, so " List-Id " is an unknown header, not List-Id. When the
// same name appears under more than one key (for example "List-Id" and
// "list-id"), their values are joined in character-code order of the keys,
// so the result never depends on how the file was written.
function asciiLower(text) {
  return text.replace(/[A-Z]/g, ch => ch.toLowerCase());
}

function headerValues(headers, name) {
  const wanted = asciiLower(name);
  const keys = Object.keys(headers).filter(key => asciiLower(key) === wanted).sort(compareText);
  const values = [];
  for (const key of keys) {
    const value = headers[key];
    if (Array.isArray(value)) values.push(...value);
    else values.push(value);
  }
  return values;
}

// A header counts as present only when at least one value holds more than
// white space (RFC 5322 header fields with an empty body carry nothing).
function firstValue(headers, name) {
  for (const value of headerValues(headers, name)) {
    if (value.trim() !== '') return value;
  }
  return null;
}

// Every ID taken from a header (Message-ID, In-Reply-To, References,
// List-Id) passes through here before it is compared, stored or copied into
// the output. Trimmed of spaces and angle brackets, lower case, and bounded:
// an ID over 200 characters becomes "SHA256:" plus the SHA-256 of its UTF-16
// code units in hex. The hash keeps two different long IDs apart and the
// same long ID together; the upper-case prefix can't occur in a lower-cased
// ID, so a hashed ID never equals a real one.
function normalizeId(text) {
  const id = lower(text.replace(/^[\s<>]+|[\s<>]+$/g, ''));
  if (charLength(id) <= LIMITS.headerIdChars) return id;
  return `SHA256:${createHash('sha256').update(Buffer.from(id, 'utf16le')).digest('hex')}`;
}

// Message-ID: the first "<...>" token if there is one (RFC 5322 allows
// comments and folding around msg-id), otherwise the whole value with
// spaces and angle brackets trimmed. Lower case. Only the first non-empty
// Message-ID header is read (RFC 5322 allows at most one).
function messageIdOf(headers) {
  const value = firstValue(headers, 'Message-ID');
  if (value === null) return null;
  const token = /<([^<>]*)>/.exec(value);
  const id = normalizeId(token ? token[1] : value);
  return id === '' ? null : id;
}

// In-Reply-To and References: every "<...>" token in every copy of the
// header; text outside angle brackets is ignored.
function referencedIds(headers, name) {
  const ids = [];
  for (const value of headerValues(headers, name)) {
    for (const match of value.matchAll(/<([^<>]*)>/g)) {
      const id = normalizeId(match[1]);
      if (id !== '') ids.push(id);
    }
  }
  return ids;
}

// List-Id (RFC 2919): the list identifier is the "<...>" part; without one,
// the whole value trimmed. Lower case.
function listIdOf(headers) {
  const value = firstValue(headers, 'List-Id');
  if (value === null) return null;
  const token = /<([^<>]*)>/.exec(value);
  const id = normalizeId(token ? token[1] : value);
  return id === '' ? null : id;
}

// Auto-Submitted (RFC 3834) and Precedence: the keyword of the first
// non-empty value, before any ";" parameters, trimmed and in lower case.
function keywordOf(headers, name) {
  const value = firstValue(headers, name);
  if (value === null) return null;
  const keyword = lower(value.split(';')[0].trim());
  return keyword === '' ? null : keyword;
}

function headerFacts(message, index) {
  const h = message.headers;
  return {
    hasListId: firstValue(h, 'List-Id') !== null,
    hasListUnsubscribe: firstValue(h, 'List-Unsubscribe') !== null,
    autoSubmitted: keywordOf(h, 'Auto-Submitted'),
    precedence: keywordOf(h, 'Precedence'),
    isReply: referencedIds(h, 'In-Reply-To').length > 0 || referencedIds(h, 'References').length > 0,
    senderIsWorkDomain: index.work.has(domainOf(message.from.address)),
  };
}

// ---------------------------------------------------------------- ordering

function addressKey(address) {
  return lower(address.trim());
}

function compareRef(a, b) {
  return compareText(a.inbox, b.inbox) || compareText(a.id, b.id);
}

// Newest first; ties by inbox, then id, in character-code order.
function newestFirst(a, b) {
  return -compareDates(a.when, b.when) || compareRef(a, b);
}

// ---------------------------------------------------------------- steps

// Step 2: copies with the same Message-ID are one message.
function mergeCopies(messages) {
  const byId = new Map();
  const out = [];
  for (const message of messages) {
    const messageId = messageIdOf(message.headers);
    if (messageId === null) {
      out.push({ copies: [message], messageId: null });
      continue;
    }
    if (!byId.has(messageId)) {
      const entry = { copies: [], messageId };
      byId.set(messageId, entry);
      out.push(entry);
    }
    byId.get(messageId).copies.push(message);
  }
  return out.map(({ copies, messageId }) => {
    const sorted = [...copies].sort(compareRef);
    const chosen = sorted[0];
    const inboxes = [...new Set(copies.map(c => c.inbox))].sort(compareText);
    return {
      source: chosen,
      inbox: chosen.inbox,
      id: chosen.id,
      inboxes,
      messageId,
      when: parseDate(chosen.date),
      ids: [
        ...(messageId === null ? [] : [messageId]),
        ...referencedIds(chosen.headers, 'In-Reply-To'),
        ...referencedIds(chosen.headers, 'References'),
      ],
    };
  });
}

// Step 3: messages whose ID sets share an ID, directly or through other
// messages, are one conversation.
function buildConversations(items) {
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    let node = x;
    while (parent.get(node) !== root) {
      const next = parent.get(node);
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    // Keep the smaller ID as the root so the result is order-free.
    if (compareText(ra, rb) < 0) parent.set(rb, ra);
    else parent.set(ra, rb);
  };
  for (const item of items) {
    for (const id of item.ids) if (!parent.has(id)) parent.set(id, id);
    for (let i = 1; i < item.ids.length; i += 1) union(item.ids[0], item.ids[i]);
  }
  const conversations = new Map();
  for (const item of items) {
    let key;
    if (item.ids.length === 0) key = `msg:${JSON.stringify([item.inbox, item.id])}`;
    else key = `id:${find(item.ids[0])}`;
    if (!conversations.has(key)) conversations.set(key, { key, items: [] });
    conversations.get(key).items.push(item);
  }
  // The root of each set is its smallest ID, so `id:` + root is the key the
  // plan asks for: the smallest normalized ID in the union of the ID sets.
  return [...conversations.values()].sort((a, b) => compareText(a.key, b.key));
}

// Built once per sort, before any conversation: exact-address rules and
// domain rules in two Maps keyed the way they are compared, keeping only the
// first rule for each key (the first rule in the file wins), and the
// owner's addresses and work domains in Sets. Each lookup is then constant time however
// many rules or addresses the settings hold.
function indexSettings(settings) {
  const exact = new Map();
  const domains = new Map();
  for (const rule of settings.senderRules) {
    const domainRule = rule.match.startsWith('@');
    const map = domainRule ? domains : exact;
    const key = domainRule ? lower(rule.match.slice(1).trim()) : addressKey(rule.match);
    if (!map.has(key)) map.set(key, rule);
  }
  return { exact, domains, mine: new Set(settings.myAddresses), work: new Set(settings.workDomains) };
}

// An exact address rule beats a domain rule.
function ruleFor(address, index) {
  return index.exact.get(addressKey(address)) || index.domains.get(domainOf(address)) || null;
}

// A value placed inside a reason (a rule's match, a header keyword, a
// domain): one line of at most 80 characters (see oneLine in rules.mjs).
function shownValue(text) {
  return oneLine(text, LIMITS.reasonValueChars);
}

// A rule's match as shown in a reason; for a domain rule the white space
// after the "@" goes too. Worked out once per rule, not once per
// conversation, so a padded setting is flattened only once.
const shownMatches = new WeakMap();

function ruleReason(rule) {
  if (!shownMatches.has(rule)) {
    const { match } = rule;
    shownMatches.set(rule, match.startsWith('@') ? `@${shownValue(match.slice(1))}` : shownValue(match));
  }
  return `Your rule: mail from ${shownMatches.get(rule)} goes to ${PILE_NAMES[rule.category]}`;
}

// The model's reason, cleaned like every other reason text (one line, cut
// to 160 characters with "…"); an empty one is replaced.
export function cleanReason(reason, category) {
  const text = oneLine(reason, LIMITS.reasonChars);
  return text === '' ? `The model chose ${PILE_NAMES[category]}` : text;
}

function contractProblem(answer) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return 'the model\'s answer was not an object';
  for (const field of ['category', 'confidence', 'reason']) {
    if (!own(answer, field) || answer[field] === undefined) return `the model's answer was missing "${field}"`;
  }
  if (typeof answer.category !== 'string' || !CATEGORIES.includes(answer.category)) {
    return 'the model answered with a pile outside the fixed list';
  }
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence)
    || answer.confidence < 0 || answer.confidence > 1) {
    return "the model's confidence was outside 0 to 1";
  }
  if (typeof answer.reason !== 'string') return "the model's reason was not text";
  return null;
}

function fallback(message, facts) {
  if (facts.hasListId) return { pile: 'newsletters', fact: 'the message has a List-Id header' };
  if (facts.hasListUnsubscribe) return { pile: 'newsletters', fact: 'the message has a List-Unsubscribe header' };
  if (facts.autoSubmitted !== null && facts.autoSubmitted !== 'no') {
    return { pile: 'alerts', fact: `the message has Auto-Submitted: ${shownValue(facts.autoSubmitted)}` };
  }
  if (['bulk', 'junk', 'list'].includes(facts.precedence)) {
    return { pile: 'alerts', fact: `the message has Precedence: ${shownValue(facts.precedence)}` };
  }
  if (facts.senderIsWorkDomain) {
    return { pile: 'work', fact: `the sender's domain ${shownValue(domainOf(message.from.address))} is a work domain` };
  }
  return { pile: 'other', fact: 'no header fact applied' };
}

function copyPerson(person) {
  return own(person, 'name') ? { name: person.name, address: person.address } : { address: person.address };
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export function buildQuestion(item, facts, messageCount) {
  const m = item.source;
  return deepFreeze({
    ref: { inbox: m.inbox, id: m.id },
    from: copyPerson(m.from),
    to: m.to.map(copyPerson),
    subject: m.subject,
    date: m.date,
    snippet: cutChars(m.snippet, LIMITS.questionSnippetChars),
    facts: { ...facts },
    messageCount,
    categories: CATEGORIES.map(category => ({ category, description: CATEGORY_DESCRIPTIONS[category] })),
  });
}

const TIMED_OUT = Symbol('timed out');

async function ask(classifier, question, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    const call = Promise.resolve().then(() => classifier.classify(question));
    // A late answer is ignored; a late failure must not surface as an
    // unhandled rejection.
    call.catch(() => {});
    const answer = await Promise.race([call, timeout]);
    if (answer === TIMED_OUT) return { problem: `the model didn't answer within ${timeoutMs} ms` };
    return { answer };
  } catch {
    return { problem: 'the model failed with an error' };
  } finally {
    clearTimeout(timer);
  }
}

async function decide(conversation, settings, index, classifier, problems) {
  const items = [...conversation.items].sort(newestFirst);
  const deciding = items.find(item => !index.mine.has(addressKey(item.source.from.address)));
  if (!deciding) {
    // The plan sends these to Other without naming a decidedBy; no rule or
    // model decided, so it is a fallback (one of the plan's four values).
    return { pile: 'other', decidedBy: 'fallback', reason: 'Only messages you sent' };
  }
  const message = deciding.source;
  const rule = ruleFor(message.from.address, index);
  if (rule) {
    return { pile: rule.category, decidedBy: 'rule', reason: ruleReason(rule) };
  }
  const facts = headerFacts(message, index);
  const question = buildQuestion(deciding, facts, items.length);
  const { answer, problem: askProblem } = await ask(classifier, question, settings.timeoutMs);
  const problem = askProblem || contractProblem(answer);
  if (problem) {
    const { pile, fact } = fallback(message, facts);
    problems.push(`Conversation ${shownValue(conversation.key)} was sorted without the model because ${problem}.`);
    return { pile, decidedBy: 'fallback', reason: `Sorted without the model: ${fact}` };
  }
  if (answer.confidence < settings.confidenceFloor) {
    return { pile: 'other', decidedBy: 'not-sure', reason: `Not sure: the model's best guess was ${PILE_NAMES[answer.category]}` };
  }
  return { pile: answer.category, decidedBy: 'model', reason: cleanReason(answer.reason, answer.category) };
}

// Step 7: groups inside each pile.
function groupPile(category, entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = category === 'newsletters' && entry.listId !== null
      ? `list:${entry.listId}` : `address:${addressKey(entry.item.source.from.address)}`;
    if (!groups.has(key)) groups.set(key, { key, entries: [] });
    groups.get(key).entries.push(entry);
  }
  const out = [...groups.values()].map((group) => {
    group.entries.sort((a, b) => newestFirst(a.item, b.item));
    return group;
  });
  // Groups: newest message first, then key in character-code order.
  out.sort((a, b) => -compareDates(a.entries[0].item.when, b.entries[0].item.when)
    || compareText(a.key, b.key));
  return out.map(group => ({
    key: group.key,
    label: groupLabel(group),
    count: group.entries.length,
    messages: group.entries.map(entry => entry.output),
  }));
}

function nameOf(person) {
  return own(person, 'name') && person.name.trim() !== '' ? person.name : null;
}

// The sender's name if every message gives the same one; otherwise the
// address if every message has the same one; otherwise (a newsletter group
// whose senders differ) the normalized List-Id.
function groupLabel(group) {
  const people = group.entries.map(entry => entry.item.source.from);
  const names = new Set(people.map(nameOf));
  if (names.size === 1 && !names.has(null)) return [...names][0];
  const addresses = new Set(people.map(p => addressKey(p.address)));
  if (addresses.size === 1) return people[0].address.trim();
  return group.key.slice('list:'.length);
}

export async function sortMessages(input, settings, classifier) {
  const config = validateSettings(settings);
  validateInput(input);
  if (!classifier || typeof classifier.classify !== 'function') {
    throw new EmailSortError('A classifier with a classify(question) method is required.');
  }

  const items = mergeCopies(input.messages);
  const conversations = buildConversations(items);
  const problems = [];
  const entries = [];
  const index = indexSettings(config);
  // One question at a time, in conversation-key order.
  for (const conversation of conversations) {
    const decision = await decide(conversation, config, index, classifier, problems);
    for (const item of conversation.items) {
      entries.push({
        item,
        pile: decision.pile,
        listId: listIdOf(item.source.headers),
        output: {
          id: item.id,
          inboxes: [...item.inboxes],
          from: copyPerson(item.source.from),
          subject: item.source.subject,
          date: item.source.date,
          pile: decision.pile,
          decidedBy: decision.decidedBy,
          // Every reason passes through oneLine once more, whatever built it.
          reason: oneLine(decision.reason, LIMITS.reasonChars),
          conversation: conversation.key,
        },
      });
    }
  }
  const piles = CATEGORIES.map((category) => {
    const inPile = entries.filter(entry => entry.pile === category);
    return { category, count: inPile.length, groups: groupPile(category, inPile) };
  });
  return { schemaVersion: 1, piles, problems };
}
