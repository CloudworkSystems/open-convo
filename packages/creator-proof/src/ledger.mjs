import { hashEntry } from './canonical.mjs';
import {
  AMENDABLE,
  ENTRY_LIMIT,
  ProofError,
  TEXT_LIMIT,
  ZERO_HASH,
  fail,
} from './errors.mjs';
import { isIsoUtc } from './time.mjs';
import { COMPLETE_LINE, END_UNCHECKED, cutoffLine } from './words.mjs';

const HEX64 = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireText(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if (!allowEmpty && value.length === 0) fail(`${label} must be text.`);
  if (value.length > TEXT_LIMIT) fail(`${label} is too long.`);
  return value;
}

function requireIso(value, label) {
  if (!isIsoUtc(value)) {
    fail(`${label} must be an ISO 8601 UTC time such as 2026-03-01T12:00:00.000Z.`);
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HEX64.test(value)) fail(`${label} must be 64 lowercase hex characters.`);
  return value;
}

export function originalIdFor(fileSha256, taken) {
  const prefix = fileSha256.slice(0, 12);
  const base = `orig-${prefix}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

function idMatchesFile(originalId, fileSha256) {
  const prefix = fileSha256.slice(0, 12);
  const base = `orig-${prefix}`;
  if (originalId === base) return true;
  const suffix = originalId.slice(base.length);
  return /^-[1-9][0-9]*$/.test(suffix) && Number(suffix.slice(1)) >= 2;
}

function copyLedger(ledger) {
  if (!Array.isArray(ledger)) return null;
  return ledger.map((entry) => (isPlainObject(entry) ? { ...entry } : entry));
}

function headOf(entries) {
  if (entries.length === 0) return null;
  const last = entries[entries.length - 1];
  return { seq: last.seq, entryHash: last.entryHash };
}

function unwrapExpected(expectedHead) {
  if (expectedHead === undefined) return { provided: false, head: undefined };
  if (expectedHead === null) return { provided: true, head: null };
  if (!isPlainObject(expectedHead)) fail('The expected head must name a seq and an entryHash.');
  if (Object.hasOwn(expectedHead, 'endChecked')) {
    if (!expectedHead.complete) {
      const problem = expectedHead.problems?.[0];
      fail(problem?.message || expectedHead.message || END_UNCHECKED, {
        seq: problem?.seq ?? null,
        problems: expectedHead.problems ?? null,
      });
    }
    return { provided: true, head: expectedHead.head ?? null };
  }
  if (!Number.isInteger(expectedHead.seq) || expectedHead.seq < 1) {
    fail('The expected head must name a seq and an entryHash.');
  }
  requireHash(expectedHead.entryHash, 'The expected head entryHash');
  return { provided: true, head: { seq: expectedHead.seq, entryHash: expectedHead.entryHash } };
}

function problem(seq, code, message) {
  return { seq, code, message };
}

function checkEntryShape(entry, index) {
  const seq = index + 1;
  if (!isPlainObject(entry)) return [problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`)];
  const found = [];
  if (entry.seq !== seq) {
    found.push(problem(seq, 'out-of-order', `Entry ${entry.seq} is out of order.`));
  }
  if (entry.entryId !== `entry-${seq}`) {
    found.push(problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`));
  }
  if (entry.kind !== 'record' && entry.kind !== 'amend') {
    found.push(problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`));
  }
  if (!isIsoUtc(entry.recordedAt)) {
    found.push(problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`));
  }
  if (typeof entry.prevHash !== 'string' || !HEX64.test(entry.prevHash)) {
    found.push(problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`));
  }
  if (typeof entry.entryHash !== 'string' || !HEX64.test(entry.entryHash)) {
    found.push(problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`));
  }
  return found;
}

function checkHashAndLink(entry, index, entries) {
  const seq = index + 1;
  const previous = index === 0 ? null : entries[index - 1];
  if (index > 0 && (!isPlainObject(previous) || typeof previous.entryHash !== 'string')) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  const expectedPrev = index === 0 ? ZERO_HASH : previous.entryHash;
  let digest;
  try {
    digest = hashEntry(entry);
  } catch {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  if (digest !== entry.entryHash) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  if (entry.prevHash !== expectedPrev) {
    return problem(seq, 'changed-prev', `Entry ${seq} has a changed prevHash.`);
  }
  return null;
}

function checkRecord(entry, index, seenOriginals, seenFiles) {
  const seq = index + 1;
  if (typeof entry.originalId !== 'string' || typeof entry.fileSha256 !== 'string' || !HEX64.test(entry.fileSha256)) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  if (typeof entry.title !== 'string' || entry.title.length === 0 || typeof entry.fileName !== 'string' || entry.fileName.length === 0) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  if (Object.hasOwn(entry, 'sizeBytes') && (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0)) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  for (const key of AMENDABLE) {
    if (!Object.hasOwn(entry, key)) continue;
    if (typeof entry[key] !== 'string') {
      return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
    }
    if (key === 'postedAt' && !isIsoUtc(entry[key])) {
      return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
    }
  }
  if (!idMatchesFile(entry.originalId, entry.fileSha256)) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  if (seenOriginals.has(entry.originalId)) {
    return problem(seq, 'duplicate-id', `Entry ${seq} has a duplicate id.`);
  }
  seenOriginals.add(entry.originalId);
  if (seenFiles.has(entry.fileSha256)) {
    const first = seenFiles.get(entry.fileSha256);
    return problem(seq, 'duplicate-id', `Entry ${seq} has a duplicate id. This file is already recorded as ${first}.`);
  }
  seenFiles.set(entry.fileSha256, entry.originalId);
  return null;
}

function checkAmend(entry, index, entries) {
  const seq = index + 1;
  if (typeof entry.targetOriginalId !== 'string' || !isPlainObject(entry.changes)) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  const keys = Object.keys(entry.changes);
  if (keys.length === 0 || keys.some((key) => !AMENDABLE.includes(key))) {
    return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
  }
  for (const key of keys) {
    if (typeof entry.changes[key] !== 'string') {
      return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
    }
    if (key === 'postedAt' && entry.changes[key] !== '' && !isIsoUtc(entry.changes[key])) {
      return problem(seq, 'changed', `Ledger entry ${seq} was changed after it was recorded.`);
    }
  }
  const earlier = entries.slice(0, index).some((item) => item && item.kind === 'record' && item.originalId === entry.targetOriginalId);
  if (!earlier) {
    return problem(seq, 'missing', `Entry ${seq} amends ${entry.targetOriginalId}, which is not an earlier original.`);
  }
  return null;
}

export function verifyLedger(ledger, options = {}) {
  const problems = [];
  if (!Array.isArray(ledger)) {
    problems.push(problem(0, 'changed', 'The ledger is not a list of entries.'));
    return {
      ok: false,
      complete: false,
      endChecked: false,
      problems,
      head: null,
      message: problems[0].message,
    };
  }
  if (ledger.length > ENTRY_LIMIT) {
    problems.push(problem(0, 'changed', 'The ledger has too many entries.'));
  }

  const seenEntryIds = new Set();
  const seqs = new Set();
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    const expectedSeq = index + 1;
    if (!isPlainObject(entry)) {
      problems.push(problem(expectedSeq, 'changed', `Ledger entry ${expectedSeq} was changed after it was recorded.`));
      continue;
    }
    if (seenEntryIds.has(entry.entryId)) {
      problems.push(problem(Number.isInteger(entry.seq) ? entry.seq : expectedSeq, 'duplicate-id', `Entry ${expectedSeq} has a duplicate id.`));
    } else if (typeof entry.entryId === 'string') {
      seenEntryIds.add(entry.entryId);
    }
    if (Number.isInteger(entry.seq)) seqs.add(entry.seq);
    if (entry.seq !== expectedSeq) {
      if (!seqs.has(expectedSeq) && entry.seq !== expectedSeq) {
        const missing = !ledger.some((item) => item && item.seq === expectedSeq);
        if (missing) {
          problems.push(problem(expectedSeq, 'missing', `Entry ${expectedSeq} is missing.`));
        } else {
          problems.push(problem(entry.seq, 'out-of-order', `Entry ${entry.seq} is out of order.`));
        }
      } else {
        problems.push(problem(entry.seq, 'out-of-order', `Entry ${entry.seq} is out of order.`));
      }
      continue;
    }
    problems.push(...checkEntryShape(entry, index).filter((item) => item.code !== 'out-of-order'));
  }

  const seenOriginals = new Set();
  const seenFiles = new Map();
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    if (!isPlainObject(entry) || entry.seq !== index + 1) continue;
    if (problems.some((item) => item.seq === index + 1 && (item.code === 'changed' || item.code === 'duplicate-id'))) {
      continue;
    }
    const linked = checkHashAndLink(entry, index, ledger);
    if (linked) {
      problems.push(linked);
      continue;
    }
    if (entry.kind === 'record') {
      const recordProblem = checkRecord(entry, index, seenOriginals, seenFiles);
      if (recordProblem) problems.push(recordProblem);
    } else if (entry.kind === 'amend') {
      const amendProblem = checkAmend(entry, index, ledger);
      if (amendProblem) problems.push(amendProblem);
    }
  }

  let expected;
  try {
    expected = unwrapExpected(options.expectedHead);
  } catch (error) {
    if (error instanceof ProofError) {
      problems.push(problem(0, 'changed', error.message));
      expected = { provided: false, head: undefined };
    } else {
      throw error;
    }
  }

  const chainOk = problems.length === 0;
  let endChecked = false;
  if (expected.provided && chainOk) {
    endChecked = true;
    const actual = headOf(ledger);
    const actualSeq = actual ? actual.seq : 0;
    const wanted = expected.head;
    const wantedSeq = wanted ? wanted.seq : 0;
    const same = wanted === null
      ? actual === null
      : actual !== null && actual.seq === wanted.seq && actual.entryHash === wanted.entryHash;
    if (!same) {
      problems.push(problem(actualSeq, 'cutoff', cutoffLine(actualSeq, wantedSeq)));
    }
  }

  const settled = problems.length === 0;
  let message = COMPLETE_LINE;
  if (!settled) message = problems[0].message;
  else if (!endChecked) message = END_UNCHECKED;
  const ok = settled && endChecked;
  return {
    ok,
    complete: ok,
    endChecked,
    problems,
    head: chainOk ? headOf(ledger) : null,
    message,
  };
}

function assertComplete(ledger, expectedHead) {
  const result = verifyLedger(copyLedger(ledger) ?? ledger, { expectedHead });
  if (!Array.isArray(ledger)) {
    fail(result.message, { seq: result.problems[0]?.seq ?? null, problems: result.problems });
  }
  if (!result.complete) {
    const first = result.problems[0];
    const message = first?.message || result.message;
    fail(message, { seq: first?.seq ?? null, problems: result.problems });
  }
  return ledger.map((entry) => ({ ...entry }));
}

function optionalFacts(original) {
  const facts = {};
  for (const key of AMENDABLE) {
    if (!Object.hasOwn(original, key) || original[key] === undefined || original[key] === '') continue;
    facts[key] = requireText(original[key], key);
    if (key === 'postedAt') requireIso(facts[key], 'postedAt');
  }
  return facts;
}

export function recordOriginal(ledger, original, options = {}) {
  const entries = assertComplete(ledger, options.expectedHead);
  if (!isPlainObject(original)) fail('An original needs a title, a file name and a file hash.');
  const title = requireText(original.title, 'title');
  const fileName = requireText(original.fileName, 'fileName');
  const fileSha256 = requireHash(original.fileSha256, 'fileSha256');
  const recordedAt = requireIso(options.recordedAt, 'recordedAt');
  const existing = entries.find((entry) => entry.kind === 'record' && entry.fileSha256 === fileSha256);
  if (existing) fail(`This file is already recorded as ${existing.originalId}.`);
  let sizeBytes;
  if (Object.hasOwn(original, 'sizeBytes') && original.sizeBytes !== undefined) {
    if (!Number.isSafeInteger(original.sizeBytes) || original.sizeBytes < 0) fail('sizeBytes must be a whole number of bytes.');
    sizeBytes = original.sizeBytes;
  }
  const taken = new Set(entries.filter((entry) => entry.kind === 'record').map((entry) => entry.originalId));
  const seq = entries.length + 1;
  const body = {
    entryId: `entry-${seq}`,
    seq,
    kind: 'record',
    originalId: originalIdFor(fileSha256, taken),
    recordedAt,
    title,
    fileName,
    fileSha256,
    prevHash: seq === 1 ? ZERO_HASH : entries[entries.length - 1].entryHash,
  };
  if (sizeBytes !== undefined) body.sizeBytes = sizeBytes;
  Object.assign(body, optionalFacts(original));
  body.entryHash = hashEntry(body);
  return [...entries, body];
}

export function pickChanges(changes) {
  if (!isPlainObject(changes)) {
    fail('Name at least one fact to change: platform, post link, posted date or notes.');
  }
  const keys = Object.keys(changes);
  if (keys.length === 0) fail('Name at least one fact to change: platform, post link, posted date or notes.');
  for (const key of keys) {
    if (!AMENDABLE.includes(key)) fail('Only platform, post link, posted date and notes can be added later.');
  }
  const clean = {};
  for (const key of AMENDABLE) {
    if (!Object.hasOwn(changes, key)) continue;
    clean[key] = requireText(changes[key], key, { allowEmpty: true });
    if (key === 'postedAt' && clean[key] !== '') requireIso(clean[key], 'postedAt');
  }
  return clean;
}

export function amendOriginal(ledger, id, changes, options = {}) {
  const entries = assertComplete(ledger, options.expectedHead);
  if (typeof id !== 'string' || id.length === 0) fail('Name the original to update.');
  const record = entries.find((entry) => entry.kind === 'record' && entry.originalId === id);
  if (!record) fail(`No original ${id} is in this ledger.`);
  const clean = pickChanges(changes);
  const seq = entries.length + 1;
  const body = {
    entryId: `entry-${seq}`,
    seq,
    kind: 'amend',
    targetOriginalId: id,
    recordedAt: requireIso(options.recordedAt, 'recordedAt'),
    changes: clean,
    prevHash: entries[entries.length - 1].entryHash,
  };
  body.entryHash = hashEntry(body);
  return [...entries, body];
}

export function currentOriginals(ledger, options = {}) {
  const entries = assertComplete(ledger, options.expectedHead);
  const byId = new Map();
  const order = [];
  for (const entry of entries) {
    if (entry.kind === 'record') {
      const facts = {};
      for (const key of AMENDABLE) {
        if (Object.hasOwn(entry, key)) facts[key] = { value: entry[key], recordedAt: entry.recordedAt };
      }
      const current = {
        originalId: entry.originalId,
        entryId: entry.entryId,
        seq: entry.seq,
        recordedAt: entry.recordedAt,
        entryHash: entry.entryHash,
        title: entry.title,
        fileName: entry.fileName,
        fileSha256: entry.fileSha256,
        facts,
      };
      if (Object.hasOwn(entry, 'sizeBytes')) current.sizeBytes = entry.sizeBytes;
      for (const key of AMENDABLE) {
        if (Object.hasOwn(entry, key)) current[key] = entry[key];
      }
      byId.set(entry.originalId, current);
      order.push(entry.originalId);
    } else if (entry.kind === 'amend') {
      const current = byId.get(entry.targetOriginalId);
      for (const key of Object.keys(entry.changes)) {
        current.facts[key] = { value: entry.changes[key], recordedAt: entry.recordedAt };
        if (entry.changes[key] === '') delete current[key];
        else current[key] = entry.changes[key];
      }
    }
  }
  return order.map((id) => byId.get(id));
}
