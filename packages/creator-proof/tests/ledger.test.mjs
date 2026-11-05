import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashEntry } from '../src/canonical.mjs';
import { ZERO_HASH } from '../src/errors.mjs';
import {
  amendOriginal,
  buildReport,
  currentOriginals,
  recordOriginal,
  verifyLedger,
} from '../src/index.mjs';

const HASH_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HASH_B = '0123456789abcdefffffffffffffffffffffffffffffffffffffffffffffffff';
const HASH_C = '0123456789abcdef000000000000000000000000000000000000000000000000';
const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-02-01T00:00:00.000Z';
const T3 = '2026-03-01T00:00:00.000Z';

function meadow(extra = {}) {
  return { title: 'Meadow morning', fileName: 'meadow.mov', fileSha256: HASH_A, sizeBytes: 12, platform: 'Townstage', ...extra };
}

function record(ledger, original, recordedAt, expectedHead) {
  return recordOriginal(ledger, original, { recordedAt, expectedHead });
}

test('two originals get ids, sequence, chain and a fixed hash', () => {
  const input = [];
  const original = meadow();
  const first = record(input, original, T1, null);
  assert.notEqual(first, input);
  assert.deepEqual(input, []);
  assert.equal(original.title, 'Meadow morning');
  assert.equal(first[0].originalId, 'orig-0123456789ab');
  assert.equal(first[0].entryId, 'entry-1');
  assert.equal(first[0].seq, 1);
  assert.equal(first[0].prevHash, ZERO_HASH);
  assert.equal(first[0].entryHash, '2e1c3982ba858c2f78e150137e290ae702a0434e8f3e89a0f28a601e2e631099');
  assert.equal(first[0].entryHash, hashEntry(first[0]));

  const head1 = { seq: 1, entryHash: first[0].entryHash };
  const second = record(first, {
    title: 'Lantern talk',
    fileName: 'lantern.mov',
    fileSha256: HASH_B,
    sizeBytes: 20,
  }, T2, head1);
  assert.equal(second[1].originalId, 'orig-0123456789ab-2');
  assert.equal(second[1].entryId, 'entry-2');
  assert.equal(second[1].seq, 2);
  assert.equal(second[1].prevHash, first[0].entryHash);
  assert.equal(first[0].title, 'Meadow morning');
  assert.equal(verifyLedger(second, { expectedHead: { seq: 2, entryHash: second[1].entryHash } }).complete, true);

  assert.throws(
    () => record(second, meadow(), T3, { seq: 2, entryHash: second[1].entryHash }),
    /This file is already recorded as orig-0123456789ab\./,
  );

  const third = record(second, {
    title: 'Third reel',
    fileName: 'third.mov',
    fileSha256: HASH_C,
  }, T3, { seq: 2, entryHash: second[1].entryHash });
  assert.equal(third[2].originalId, 'orig-0123456789ab-3');
});

test('a null entry is reported instead of crashing the check', () => {
  let ledger = record([], meadow(), T1, null);
  ledger = record(ledger, {
    title: 'Lantern talk',
    fileName: 'lantern.mov',
    fileSha256: HASH_B,
  }, T2, { seq: 1, entryHash: ledger[0].entryHash });
  const damaged = [null, ledger[1]];
  const result = verifyLedger(damaged, { expectedHead: { seq: 2, entryHash: ledger[1].entryHash } });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /Ledger entry 1 was changed after it was recorded/);
  assert.ok(result.problems.every((item) => typeof item.message === 'string'));
});

test('an amendment is appended and current facts keep their times', () => {
  let ledger = record([], meadow(), T1, null);
  const before = structuredClone(ledger);
  ledger = amendOriginal(ledger, ledger[0].originalId, {
    postUrl: 'https://social.example/meadow',
    postedAt: '2026-01-02T00:00:00.000Z',
    notes: 'first post',
  }, { recordedAt: T2, expectedHead: { seq: 1, entryHash: ledger[0].entryHash } });
  assert.equal(ledger.length, 2);
  assert.deepEqual(ledger[0], before[0]);
  assert.equal(ledger[1].kind, 'amend');
  assert.equal(ledger[1].entryId, 'entry-2');
  assert.equal(ledger[1].targetOriginalId, ledger[0].originalId);
  assert.equal(verifyLedger(ledger, { expectedHead: { seq: 2, entryHash: ledger[1].entryHash } }).complete, true);

  const [current] = currentOriginals(ledger, { expectedHead: { seq: 2, entryHash: ledger[1].entryHash } });
  assert.equal(current.postUrl, 'https://social.example/meadow');
  assert.equal(current.facts.platform.recordedAt, T1);
  assert.equal(current.facts.postUrl.recordedAt, T2);
  assert.equal(current.facts.postedAt.recordedAt, T2);
  assert.equal(current.facts.notes.value, 'first post');
});

test('verify names a changed field, a missing entry, a swap, a prevHash and a duplicate id', () => {
  let ledger = record([], meadow(), T1, null);
  ledger = record(ledger, { title: 'Lantern talk', fileName: 'lantern.mov', fileSha256: HASH_B }, T2, { seq: 1, entryHash: ledger[0].entryHash });
  ledger = amendOriginal(ledger, ledger[0].originalId, { notes: 'kept' }, {
    recordedAt: T3,
    expectedHead: { seq: 2, entryHash: ledger[1].entryHash },
  });
  const head = { seq: 3, entryHash: ledger[2].entryHash };

  const changed = structuredClone(ledger);
  changed[0].title = 'Edited';
  const changedProblem = verifyLedger(changed, { expectedHead: head }).problems[0];
  assert.equal(changedProblem.seq, 1);
  assert.match(changedProblem.message, /Ledger entry 1 was changed/);

  const removed = [ledger[0], ledger[2]];
  const missing = verifyLedger(removed).problems[0];
  assert.equal(missing.seq, 2);
  assert.match(missing.message, /missing/);

  const swapped = [ledger[1], ledger[0], ledger[2]];
  const order = verifyLedger(swapped).problems[0];
  assert.equal(order.code, 'out-of-order');
  assert.equal(order.seq, 2);

  const relinked = structuredClone(ledger);
  relinked[1].prevHash = ZERO_HASH;
  relinked[1].entryHash = hashEntry(relinked[1]);
  const prev = verifyLedger(relinked).problems[0];
  assert.equal(prev.seq, 2);
  assert.equal(prev.code, 'changed-prev');

  const duplicate = structuredClone(ledger);
  duplicate[1].entryId = 'entry-1';
  duplicate[1].entryHash = hashEntry(duplicate[1]);
  const dup = verifyLedger(duplicate).problems[0];
  assert.equal(dup.seq, 2);
  assert.match(dup.message, /duplicate id/);

  const sameOriginal = structuredClone(ledger);
  sameOriginal[1].originalId = ledger[0].originalId;
  sameOriginal[1].entryHash = hashEntry(sameOriginal[1]);
  assert.match(verifyLedger(sameOriginal).problems[0].message, /duplicate id/);

  const earlyAmend = structuredClone(ledger);
  const amend = { ...earlyAmend[2], targetOriginalId: 'orig-does-not-exist' };
  amend.entryHash = hashEntry(amend);
  earlyAmend[2] = amend;
  assert.match(verifyLedger(earlyAmend).problems[0].message, /not an earlier original/);
});

test('a missing tail is caught only when the expected head is given', () => {
  let ledger = record([], meadow(), T1, null);
  ledger = record(ledger, { title: 'Lantern talk', fileName: 'lantern.mov', fileSha256: HASH_B }, T2, { seq: 1, entryHash: ledger[0].entryHash });
  ledger = amendOriginal(ledger, ledger[0].originalId, { notes: 'later' }, {
    recordedAt: T3,
    expectedHead: { seq: 2, entryHash: ledger[1].entryHash },
  });
  const fullHead = { seq: 3, entryHash: ledger[2].entryHash };
  const withoutTail = ledger.slice(0, 2);
  const withoutAmend = ledger.slice(0, 2);
  const cutoff = verifyLedger(withoutTail, { expectedHead: fullHead });
  assert.equal(cutoff.complete, false);
  assert.match(cutoff.problems[0].message, /The ledger ends at entry 2, but your last record was entry 3\./);

  const unchecked = verifyLedger(withoutTail);
  assert.equal(unchecked.endChecked, false);
  assert.match(unchecked.message, /can't be checked/);
  assert.equal(unchecked.complete, false);

  for (const fn of [
    () => recordOriginal(withoutTail, { title: 'More', fileName: 'more.mov', fileSha256: HASH_C }, { recordedAt: T3, expectedHead: fullHead }),
    () => amendOriginal(withoutTail, ledger[0].originalId, { notes: 'nope' }, { recordedAt: T3, expectedHead: fullHead }),
    () => currentOriginals(withoutTail, { expectedHead: fullHead }),
    () => buildReport(withoutAmend, caseFor(ledger), { expectedHead: fullHead }),
    () => currentOriginals(ledger),
  ]) {
    assert.throws(fn, /The ledger ends at entry|can't be checked/);
  }

  const passed = verifyLedger(ledger, { expectedHead: fullHead });
  assert.equal(currentOriginals(ledger, { expectedHead: passed })[0].notes, 'later');

  let recordsOnly = record([], meadow(), T1, null);
  recordsOnly = record(recordsOnly, {
    title: 'Lantern talk',
    fileName: 'lantern.mov',
    fileSha256: HASH_B,
  }, T2, { seq: 1, entryHash: recordsOnly[0].entryHash });
  const recordHead = { seq: 2, entryHash: recordsOnly[1].entryHash };
  const droppedRecord = recordsOnly.slice(0, 1);
  for (const fn of [
    () => record(droppedRecord, { title: 'More', fileName: 'more.mov', fileSha256: HASH_C }, T3, recordHead),
    () => amendOriginal(droppedRecord, recordsOnly[0].originalId, { notes: 'nope' }, { recordedAt: T3, expectedHead: recordHead }),
    () => currentOriginals(droppedRecord, { expectedHead: recordHead }),
    () => buildReport(droppedRecord, caseFor(recordsOnly), { expectedHead: recordHead }),
  ]) {
    assert.throws(fn, /The ledger ends at entry 1, but your last record was entry 2\./);
  }
});

test('twenty thousand amendments still verify quickly', () => {
  const fileSha256 = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const first = {
    entryId: 'entry-1',
    seq: 1,
    kind: 'record',
    originalId: 'orig-0123456789ab',
    recordedAt: T1,
    title: 'Meadow morning',
    fileName: 'meadow.mov',
    fileSha256,
    prevHash: ZERO_HASH,
  };
  first.entryHash = hashEntry(first);
  const entries = [first];
  const count = 20000;
  for (let seq = 2; seq <= count + 1; seq += 1) {
    const amend = {
      entryId: `entry-${seq}`,
      seq,
      kind: 'amend',
      targetOriginalId: first.originalId,
      recordedAt: T1,
      changes: { notes: `note ${seq}` },
      prevHash: entries[seq - 2].entryHash,
    };
    amend.entryHash = hashEntry(amend);
    entries.push(amend);
  }
  const started = Date.now();
  const result = verifyLedger(entries, {
    expectedHead: { seq: entries.length, entryHash: entries[entries.length - 1].entryHash },
  });
  const elapsed = Date.now() - started;
  assert.equal(result.complete, true);
  assert.equal(result.problems.length, 0);
  assert.ok(elapsed < 2000, `verification took ${elapsed}ms`);
});

function caseFor(ledger) {
  return {
    kind: 'stolen-video',
    creatorName: 'River Lane',
    originalIds: [ledger[0].originalId],
    copies: [{ url: 'https://social.example/copy', accountName: 'Copy account', seenAt: T3, whatItShows: 'A copy.' }],
  };
}
