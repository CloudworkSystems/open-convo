import { ANCHOR_KINDS, ANCHOR_LIMIT, COPY_LIMIT, KINDS, TEXT_LIMIT, fail } from './errors.mjs';
import { currentOriginals, verifyLedger } from './ledger.mjs';
import { placesFor, PAYMENT_UNKNOWN } from './destinations.mjs';
import { isIsoUtc, sortKey } from './time.mjs';
import { COMPLETE_LINE, PLAIN_NOTE } from './words.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > TEXT_LIMIT) {
    fail(`${label} must be text.`);
  }
  return value;
}

function cell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function marked(value) {
  if (value === undefined || value === null || value === '') return 'not recorded';
  return String(value);
}

function videoSentence(count) {
  return count === 1 ? 'This video is mine.' : `These ${count} videos are mine.`;
}

function summaryText(kind, creatorName, originals, copies) {
  const names = [];
  for (const copy of copies) {
    if (copy.accountName && !names.includes(copy.accountName)) names.push(copy.accountName);
  }
  const account = names.length > 1 ? 'The accounts below' : 'The account below';
  const verb = names.length > 1 ? 'are' : 'is';
  const repost = originals.length === 1 ? 'it' : 'them';
  const ask = names.length > 1 ? 'ask' : 'asks';
  if (kind === 'impersonation') return `I am ${creatorName}. ${account} ${verb} pretending to be me.`;
  if (kind === 'fake-fundraiser') {
    return `${videoSentence(originals.length)} ${account} reposted ${repost} and ${ask} for donations.`;
  }
  return `${videoSentence(originals.length)} ${account} reposted ${repost}.`;
}

function timeline(originals, copies, seenAt) {
  const events = [];
  const gaps = [];
  for (const original of originals) {
    const posted = original.facts?.postedAt?.value;
    if (posted) {
      events.push({ time: posted, rank: 0, label: `Posted: ${original.title} (your original post)` });
    } else {
      gaps.push(`Posted date not recorded for ${original.title}.`);
    }
    events.push({
      time: original.recordedAt,
      rank: 1,
      label: `Recorded: ${original.title} (your ledger)`,
    });
  }
  copies.forEach((copy, index) => {
    const who = copy.accountName || `copy ${index + 1}`;
    if (copy.seenAt) events.push({ time: copy.seenAt, rank: 2, label: `Seen: ${who} (the copy)` });
    else gaps.push(`Seen date not recorded for ${who}.`);
  });
  if (seenAt) events.push({ time: seenAt, rank: 3, label: 'Noted: you wrote this case down' });
  events.sort((a, b) => sortKey(a.time).localeCompare(sortKey(b.time)) || a.rank - b.rank || a.label.localeCompare(b.label));
  return { events, gaps };
}

function missingFacts(originals, copies, paymentMissing) {
  const missing = [];
  for (const original of originals) {
    const postUrl = original.facts?.postUrl?.value;
    const postedAt = original.facts?.postedAt?.value;
    if (!postUrl) {
      missing.push({
        field: 'postUrl',
        originalId: original.originalId,
        message: `${original.title} has no post link. The platform's own link is the strongest evidence that the video was yours first.`,
      });
    }
    if (!postedAt) {
      missing.push({
        field: 'postedAt',
        originalId: original.originalId,
        message: `${original.title} has no posted date. The platform's own post date is the strongest evidence that the video was yours first.`,
      });
    }
  }
  copies.forEach((copy, index) => {
    if (!copy.seenAt) {
      const who = copy.accountName || copy.url || `copy ${index + 1}`;
      missing.push({
        field: 'seenAt',
        message: `${who} has no seen date. That date shows when you found the copy.`,
      });
    }
  });
  if (paymentMissing) {
    missing.push({
      field: 'paymentService',
      message: 'The fake link\'s payment service is not named. Name the service and the account shown on the copy so that service can be told.',
    });
  }
  return missing;
}

function originalsTable(originals) {
  const lines = [
    '| Title | Platform | Post link | Posted | File | Size | SHA-256 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const original of originals) {
    const size = original.sizeBytes === undefined ? 'not recorded' : `${original.sizeBytes} bytes`;
    lines.push(`| ${[
      cell(original.title),
      cell(marked(original.platform)),
      cell(marked(original.postUrl)),
      cell(marked(original.postedAt)),
      cell(original.fileName),
      cell(size),
      cell(original.fileSha256),
    ].join(' | ')} |`);
  }
  return lines.join('\n');
}

function copiesSection(copies) {
  return copies.map((copy, index) => {
    const title = copy.accountName || `Copy ${index + 1}`;
    return [
      `### ${title}`,
      '',
      `- Link: ${copy.url}`,
      `- Account: ${marked(copy.accountUrl)}`,
      `- Seen: ${marked(copy.seenAt)}`,
      `- What it shows: ${marked(copy.whatItShows)}`,
    ].join('\n');
  }).join('\n\n');
}

function draftBody(place, theCase, originals) {
  const titles = originals.map((original) => original.title).join(', ');
  const files = originals.map((original) => original.fileName).join(', ');
  if (place.id === 'fans') {
    return [
      'Fans who already sent money can report the scam at ReportFraud.ftc.gov and at IC3.gov.',
      'Tell them the account that asked for the money, and that the real donation links are the ones on your real links page.',
    ].join('\n');
  }
  const lines = [
    `I am [your legal name]. I am ${theCase.creatorName}. I created these videos: ${titles}.`,
    `The files are: ${files}.`,
    'The originals table in this pack lists each post link, posted date and file hash.',
    'The copies section lists the reposts.',
  ];
  if (place.id === 'copyright') {
    lines.push('These copies use my work without my permission. Please remove them.');
  } else if (place.id === 'impersonation') {
    lines.push('This account is pretending to be me. Please remove it.');
    lines.push('If you need ID, I will send it to Meta directly. I will not send it through True Convo.');
  } else if (place.id === 'in-app') {
    lines.push('Please review this account. It is reposting my work and is not me.');
  } else if (place.id === 'payment') {
    const account = theCase.paymentService?.accountShownOnCopy;
    lines.push(`The fake fundraiser asks for money${account ? ` through ${account}` : ''}.`);
    lines.push('Please freeze that account and mark the report with [the case number].');
  }
  lines.push('My contact email is [your email].');
  return lines.join('\n');
}

function draftedSection(places, theCase, originals) {
  return places.map((place) => {
    const steps = place.steps.map((step, index) => `${index + 1}. ${step}`).join('\n');
    return `### ${place.name}\n\n${steps}\n\n${draftBody(place, theCase, originals)}`;
  }).join('\n\n');
}

function hashTable(entries) {
  const lines = ['| Entry | Kind | Proof code |', '| --- | --- | --- |'];
  for (const entry of entries) {
    const kind = entry.kind === 'amend' ? `amend ${entry.targetOriginalId}` : `record ${entry.originalId}`;
    lines.push(`| ${entry.seq} | ${kind} | ${entry.entryHash} |`);
  }
  return lines.join('\n');
}

function originalsAtOrBefore(entries, originals, entryHash) {
  const anchor = entries.find((entry) => entry.entryHash === entryHash);
  if (!anchor) return null;
  const covered = new Set(
    entries.filter((entry) => entry.kind === 'record' && entry.seq <= anchor.seq).map((entry) => entry.originalId),
  );
  return originals.filter((original) => covered.has(original.originalId));
}

function anchorSection(anchors, entries, originals) {
  if (anchors.length === 0) return 'No anchors were given.';
  return anchors.map((anchor) => {
    const covered = originalsAtOrBefore(entries, originals, anchor.entryHash);
    if (anchor.kind === 'email') {
      const list = covered.map((original) => `- ${original.title} (${original.originalId})`).join('\n');
      return [
        `### Email: ${anchor.where}`,
        '',
        `Received ${anchor.date} in someone else's inbox.`,
        `Proof code: ${anchor.entryHash}`,
        'These originals were recorded at or before that code:',
        list,
      ].join('\n');
    }
    if (anchor.kind === 'post') {
      return [
        `### Post: ${anchor.where}`,
        '',
        `You say this code was in the post when it was first published on ${anchor.date}. Anyone checking will look at the post's edit history.`,
        `Proof code: ${anchor.entryHash}`,
      ].join('\n');
    }
    return [
      `### Page: ${anchor.where}`,
      '',
      'Your page shows this proof code today.',
      `Proof code: ${anchor.entryHash}`,
    ].join('\n');
  }).join('\n\n');
}

function readCopy(copy, index) {
  if (!isPlainObject(copy)) fail(`Copy ${index + 1} needs a link.`);
  const url = requireText(copy.url, `Copy ${index + 1} link`);
  const clean = { url };
  for (const key of ['accountName', 'accountUrl', 'whatItShows']) {
    if (copy[key] === undefined || copy[key] === '') continue;
    if (typeof copy[key] !== 'string' || copy[key].length > TEXT_LIMIT) fail(`Copy ${index + 1} ${key} must be text.`);
    clean[key] = copy[key];
  }
  if (copy.seenAt !== undefined && copy.seenAt !== '') {
    if (!isIsoUtc(copy.seenAt)) fail(`Copy ${index + 1} seenAt must be an ISO 8601 UTC time.`);
    clean.seenAt = copy.seenAt;
  }
  return clean;
}

function readAnchor(anchor, index, entries) {
  if (!isPlainObject(anchor)) fail(`Anchor ${index + 1} needs a kind, a place, a date and a proof code.`);
  if (!ANCHOR_KINDS.includes(anchor.kind)) fail('An anchor kind must be email, post or page.');
  const where = requireText(anchor.where, `Anchor ${index + 1} place`);
  if (typeof anchor.entryHash !== 'string' || !/^[0-9a-f]{64}$/.test(anchor.entryHash)) {
    fail(`Anchor ${index + 1} needs a proof code of 64 lowercase hex characters.`);
  }
  if (!entries.some((entry) => entry.entryHash === anchor.entryHash)) {
    fail(`No ledger entry has the proof code ${anchor.entryHash}, so the anchor was not used. Check the code and try again.`);
  }
  if (anchor.kind !== 'page') {
    if (typeof anchor.date !== 'string' || anchor.date.length === 0 || anchor.date.length > TEXT_LIMIT) {
      fail(`Anchor ${index + 1} needs the date you want the pack to show.`);
    }
  }
  return {
    kind: anchor.kind,
    where,
    date: typeof anchor.date === 'string' ? anchor.date : '',
    entryHash: anchor.entryHash,
  };
}

export function buildReport(ledger, theCase, options = {}) {
  const checked = verifyLedger(ledger, { expectedHead: options.expectedHead });
  if (!checked.complete) {
    const first = checked.problems[0];
    fail(first?.message || checked.message, { seq: first?.seq ?? null, problems: checked.problems });
  }
  if (!isPlainObject(theCase)) fail('The case needs a kind, your name, the originals and at least one copy.');
  if (!KINDS.includes(theCase.kind)) fail('The case kind must be stolen-video, impersonation or fake-fundraiser.');
  if (theCase.kind !== 'fake-fundraiser' && theCase.paymentService !== undefined) {
    fail('paymentService is only for a fake-fundraiser case.');
  }
  if (theCase.kind === 'fake-fundraiser' && theCase.paymentService !== undefined) {
    if (!isPlainObject(theCase.paymentService) || typeof theCase.paymentService.name !== 'string' || theCase.paymentService.name.trim() === '') {
      fail('paymentService needs a name and the account shown on the copy.');
    }
    if (theCase.paymentService.accountShownOnCopy !== undefined && typeof theCase.paymentService.accountShownOnCopy !== 'string') {
      fail('paymentService accountShownOnCopy must be text.');
    }
  }
  const creatorName = requireText(theCase.creatorName, 'creatorName');
  if (!Array.isArray(theCase.originalIds) || theCase.originalIds.length === 0) {
    fail('Name at least one original in this case.');
  }
  if (theCase.originalIds.length > COPY_LIMIT) fail('This case names too many originals.');
  const seenIds = new Set();
  for (const id of theCase.originalIds) {
    if (typeof id !== 'string' || id.length === 0) fail('Each original id must be text.');
    if (seenIds.has(id)) fail(`${id} is listed twice in this case.`);
    seenIds.add(id);
  }
  if (!Array.isArray(theCase.copies) || theCase.copies.length === 0) fail('Add at least one copy: the link to the repost.');
  if (theCase.copies.length > COPY_LIMIT) fail('This case has too many copies.');
  const copies = theCase.copies.map((copy, index) => readCopy(copy, index));
  let seenAt;
  if (theCase.seenAt !== undefined && theCase.seenAt !== '') {
    if (!isIsoUtc(theCase.seenAt)) fail('Case seenAt must be an ISO 8601 UTC time.');
    seenAt = theCase.seenAt;
  }
  let notes = '';
  if (theCase.notes !== undefined && theCase.notes !== '') {
    notes = requireText(theCase.notes, 'notes');
  }
  const anchors = Array.isArray(theCase.anchors) ? theCase.anchors : [];
  if (anchors.length > ANCHOR_LIMIT) fail('This case has too many anchors.');
  const readAnchors = anchors.map((anchor, index) => readAnchor(anchor, index, ledger));

  const all = currentOriginals(ledger, { expectedHead: options.expectedHead });
  const originals = theCase.originalIds.map((id) => {
    const found = all.find((original) => original.originalId === id);
    if (!found) fail(`No original ${id} is in this ledger.`);
    return found;
  });

  const places = placesFor(theCase.kind, theCase.paymentService);
  const paymentMissing = places.some((place) => place.missing);
  const missing = missingFacts(originals, copies, paymentMissing);
  const { events, gaps } = timeline(originals, copies, seenAt);
  const checklist = places.map((place) => ({ place: place.name, steps: place.steps }));
  const summary = summaryText(theCase.kind, creatorName, originals, copies);
  const kindTitle = theCase.kind.replaceAll('-', ' ');

  const markdown = [
    `# Evidence pack: ${kindTitle}`,
    '',
    '## Summary',
    '',
    summary,
    notes ? `\n${notes}` : '',
    '',
    '## Timeline',
    '',
    ...events.map((event) => `- ${event.time} — ${event.label}`),
    ...gaps.map((gap) => `- ${gap}`),
    '',
    '## Originals',
    '',
    originalsTable(originals),
    '',
    '## Copies',
    '',
    copiesSection(copies),
    '',
    '## Drafted reports',
    '',
    draftedSection(places, { ...theCase, creatorName }, originals),
    '',
    '## Proof ledger',
    '',
    COMPLETE_LINE,
    '',
    PLAIN_NOTE,
    '',
    'The strongest evidence of first is still the platform\'s own post date and link, in the originals table above.',
    '',
    hashTable(ledger),
    '',
    '### Anchors',
    '',
    anchorSection(readAnchors, ledger, all),
    paymentMissing ? `\nThe places still name "${PAYMENT_UNKNOWN}" because no payment service was given.` : '',
    '',
  ].join('\n').replace(/\n{3,}/g, '\n\n');

  return { markdown, checklist, missing };
}
