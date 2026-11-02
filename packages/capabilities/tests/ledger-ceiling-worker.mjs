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

try {
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
