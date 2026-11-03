// The production ceiling is 10,000 entries. This worker lowers it so the same
// boundary (fold closed months, refuse a write that would pass the ceiling
// before saving) is covered with a handful of runs. The lower ceiling stays
// in this worker, so the other tests keep the real one.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { generateKeyPairSync, sign } from 'node:crypto';
import { acceptCap, memoryStore, monthSpent, reserve, settle, signingBytes } from '../src/cap/index.mjs';
import { REASONS } from '../src/cap/reasons.mjs';
import { setLedgerCeilingForTests } from '../src/cap/ledger.mjs';

const ceiling = 8;
setLedgerCeilingForTests(ceiling, 1024 * 1024);

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const record = {
  revision: 1,
  currency: 'USD',
  timeZone: 'America/Los_Angeles',
  perRun: { amount: '10', currency: 'USD' },
  monthlyByCapability: { amount: '1000', currency: 'USD' },
  monthlyAll: { amount: '1000', currency: 'USD' },
  paused: false,
  conversion: null,
};
const signature = sign('sha256', signingBytes(record), { key: privateKey, dsaEncoding: 'der' });
const dir = mkdtempSync(join(tmpdir(), 'cap-ceiling-'));
const store = memoryStore();
acceptCap(store, record, signature, publicKey);
const base = {
  ledgerDir: dir,
  store,
  record,
  signature,
  publicKey,
  capabilityId: 'make-media',
  routeId: 'own-key',
};

function countLines() {
  const text = readFileSync(join(dir, 'entries.jsonl'), 'utf8');
  return text.trim() === '' ? 0 : text.trim().split('\n').length;
}

function kinds() {
  return readFileSync(join(dir, 'entries.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).kind);
}

async function completed(jobId, amount, now) {
  const reserved = await reserve({ ...base, jobId, max: { amount, currency: 'USD' }, now });
  if (!reserved.ok) throw new Error(`${jobId} reserve ${reserved.reason}`);
  const settled = await settle({ ...base, jobId, actual: { amount, currency: 'USD' }, now });
  if (!settled.ok) throw new Error(`${jobId} settle ${settled.reason}`);
}

async function proveClosingRoom() {
  // Ceiling of two lines: one reservation fills it, because the closing line
  // is reserved too. The next reservation is refused. Settling the open run
  // with an over-bill still fits, and the bill is recorded.
  setLedgerCeilingForTests(2, 1024 * 1024);
  const roomDir = mkdtempSync(join(tmpdir(), 'cap-closing-'));
  const roomStore = memoryStore();
  acceptCap(roomStore, record, signature, publicKey);
  const room = { ...base, ledgerDir: roomDir, store: roomStore };
  const now = '2026-01-15T20:00:00.000Z';
  try {
    const reserved = await reserve({ ...room, jobId: 'open', max: { amount: '1', currency: 'USD' }, now });
    if (!reserved.ok) throw new Error(`closing-room reserve ${reserved.reason}`);
    const lines = readFileSync(join(roomDir, 'entries.jsonl'), 'utf8').trim().split('\n').length;
    if (lines !== 1) throw new Error(`expected one open line, saw ${lines}`);
    const refused = await reserve({ ...room, jobId: 'next', max: { amount: '1', currency: 'USD' }, now });
    if (refused.ok || refused.reason !== REASONS.ledgerFull) {
      throw new Error(`expected the next reservation to be refused, got ${JSON.stringify(refused)}`);
    }
    const settled = await settle({ ...room, jobId: 'open', actual: { amount: '2', currency: 'USD' }, now });
    if (!settled.ok || settled.routeOff !== true || settled.amount.amount !== '2') {
      throw new Error(`expected the over-bill to be recorded, got ${JSON.stringify(settled)}`);
    }
    const after = readFileSync(join(roomDir, 'entries.jsonl'), 'utf8').trim().split('\n');
    if (after.length !== 2 || !after.some((line) => JSON.parse(line).kind === 'over-bill')) {
      throw new Error(`expected the over-bill on disk, saw ${after.length} lines`);
    }
    const spent = await monthSpent({ ...room, now });
    if (!spent.ok || spent.spent.amount !== '2' || spent.reserved.amount !== '0') {
      throw new Error(`closing-room total ${spent.spent?.amount} reserved ${spent.reserved?.amount}`);
    }
  } finally {
    rmSync(roomDir, { recursive: true, force: true });
    setLedgerCeilingForTests(ceiling, 1024 * 1024);
  }
}

async function proveWideSequence() {
  // Every bill uses the longest amount the ledger can store, so the only
  // extra byte in a closing line is a sequence number that gained a digit.
  // The first run was sequence 1 and is closed at sequence 10. One byte of
  // room past the finished file is enough. Without that byte a new
  // reservation is refused, and the first run's bill is still recorded.
  const now = '2026-01-15T20:00:00.000Z';
  const bill = '999999999.999999';
  const sameSize = '100000000.000001';
  const rich = {
    ...record,
    perRun: { amount: bill, currency: 'USD' },
    monthlyByCapability: { amount: bill, currency: 'USD' },
    monthlyAll: { amount: bill, currency: 'USD' },
  };
  const richSig = sign('sha256', signingBytes(rich), { key: privateKey, dsaEncoding: 'der' });

  async function run(bytes) {
    setLedgerCeilingForTests(10, bytes);
    const wideDir = mkdtempSync(join(tmpdir(), 'cap-wide-'));
    const wideStore = memoryStore();
    acceptCap(wideStore, rich, richSig, publicKey);
    const wide = { ...base, ledgerDir: wideDir, store: wideStore, record: rich, signature: richSig };
    try {
      const reserved = await reserve({ ...wide, jobId: 'early', max: { amount: '1', currency: 'USD' }, now });
      if (!reserved.ok) return { reserved };
      let stopped = null;
      for (let index = 0; index < 4; index += 1) {
        const jobId = `later-${index}`;
        const held = await reserve({ ...wide, jobId, max: { amount: '1', currency: 'USD' }, now });
        if (!held.ok) {
          stopped = held;
          break;
        }
        const closed = await settle({ ...wide, jobId, actual: { amount: sameSize, currency: 'USD' }, now });
        if (!closed.ok) return { closed };
      }
      const settled = await settle({ ...wide, jobId: 'early', actual: { amount: bill, currency: 'USD' }, now });
      const text = readFileSync(join(wideDir, 'entries.jsonl'));
      const last = JSON.parse(text.toString('utf8').trim().split('\n').at(-1));
      const spent = await monthSpent({ ...wide, now });
      return { stopped, settled, seq: last.seq, bytes: text.length, spent };
    } finally {
      rmSync(wideDir, { recursive: true, force: true });
    }
  }

  const roomy = await run(1024 * 1024);
  if (!roomy.settled?.ok || roomy.seq !== 10 || roomy.stopped) {
    throw new Error(`wide sequence did not reach 10: ${JSON.stringify(roomy.settled || roomy.closed || roomy.reserved)}`);
  }
  try {
    const tight = await run(roomy.bytes + 1);
    if (tight.stopped || !tight.settled?.ok || tight.settled.amount?.amount !== bill || tight.seq !== 10) {
      throw new Error(`expected the widened over-bill to be recorded, got ${JSON.stringify(tight.settled || tight.stopped)}`);
    }
    if (!tight.spent?.ok) throw new Error(`widened total ${tight.spent?.reason}`);
    const exact = await run(roomy.bytes);
    if (!exact.stopped || exact.stopped.reason !== REASONS.ledgerFull) {
      throw new Error(`expected the last reservation to be refused, got ${JSON.stringify(exact.stopped || exact.settled)}`);
    }
    if (!exact.settled?.ok || exact.settled.amount?.amount !== bill || !exact.spent?.ok) {
      throw new Error(`expected the first run's bill to be recorded, got ${JSON.stringify(exact.settled)}`);
    }
  } finally {
    setLedgerCeilingForTests(ceiling, 1024 * 1024);
  }
}

try {
  await proveClosingRoom();
  await proveWideSequence();
  const january = '2026-01-15T20:00:00.000Z';
  // Four completed runs are eight lines, exactly the lowered ceiling.
  for (let index = 0; index < 4; index += 1) await completed(`j-${index}`, '0.1', january);
  const full = countLines();
  if (full !== ceiling) throw new Error(`expected ${ceiling} lines, saw ${full}`);
  const refused = await reserve({ ...base, jobId: 'j-over', max: { amount: '0.1', currency: 'USD' }, now: january });
  if (refused.ok || refused.reason !== REASONS.ledgerFull) {
    throw new Error(`expected a full-ledger refusal, got ${JSON.stringify(refused)}`);
  }
  if (countLines() !== full) throw new Error('a refused write changed the ledger');
  const januaryFull = await monthSpent({ ...base, now: january });
  if (!januaryFull.ok || januaryFull.counted.amount !== '0.4') {
    throw new Error(`january total ${januaryFull.counted?.amount} ${januaryFull.reason}`);
  }

  // Eight stored lines plus another month would pass the ceiling if the old
  // lines were kept. Folding them into one checkpoint leaves room.
  const february = '2026-02-15T20:00:00.000Z';
  await completed('feb', '0.25', february);
  const folded = countLines();
  if (folded > 3) throw new Error(`folding should shrink the file, saw ${folded}`);
  if (!kinds().includes('checkpoint')) throw new Error(`expected a checkpoint, saw ${kinds().join(',')}`);
  const januaryAfter = await monthSpent({ ...base, now: january });
  if (januaryAfter.counted.amount !== '0.4') throw new Error(`folded january total ${januaryAfter.counted.amount}`);
  const februarySpent = await monthSpent({ ...base, now: february });
  if (februarySpent.counted.amount !== '0.25') throw new Error(`february total ${februarySpent.counted.amount}`);

  // A third month folds February too. Six completed runs are 12 lines
  // unfolded, more than the ceiling of 8, and the file stays under it.
  const march = '2026-03-15T20:00:00.000Z';
  await completed('mar', '0.05', march);
  const lines = countLines();
  if (lines > ceiling) throw new Error(`ledger grew past the ceiling to ${lines}`);
  if (lines >= 12) throw new Error(`history was not folded, saw ${lines} lines`);
  const checkpoints = kinds().filter((kind) => kind === 'checkpoint').length;
  if (checkpoints !== 2) throw new Error(`expected two checkpoints, saw ${checkpoints}`);
  const marchSpent = await monthSpent({ ...base, now: march });
  if (marchSpent.counted.amount !== '0.05') throw new Error(`march total ${marchSpent.counted.amount}`);
  if ((await monthSpent({ ...base, now: january })).counted.amount !== '0.4') {
    throw new Error('january total changed after the later fold');
  }
  parentPort.postMessage({ ok: true, lines });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
