// Proves a write that would pass the ceiling is refused before it is saved,
// and that folding closed months lets later months continue past that ceiling.
// The ceiling is lowered only in this worker, so other tests keep the real one.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parentPort } from 'node:worker_threads';
import { generateKeyPairSync, sign } from 'node:crypto';
import { acceptCap, memoryStore, monthSpent, reserve, settle, signingBytes } from '../src/cap/index.mjs';
import { REASONS } from '../src/cap/reasons.mjs';
import { setLedgerCeilingForTests } from '../src/cap/ledger.mjs';

const ceiling = 6;
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

try {
  const january = '2026-01-15T20:00:00.000Z';
  for (let index = 0; index < 3; index += 1) {
    const jobId = `j-${index}`;
    const reserved = await reserve({ ...base, jobId, max: { amount: '0.1', currency: 'USD' }, now: january });
    if (!reserved.ok) throw new Error(`january reserve ${reserved.reason}`);
    const settled = await settle({ ...base, jobId, actual: { amount: '0.1', currency: 'USD' }, now: january });
    if (!settled.ok) throw new Error(`january settle ${settled.reason}`);
  }
  const full = countLines();
  if (full !== ceiling) throw new Error(`expected ${ceiling} lines, saw ${full}`);
  const refused = await reserve({ ...base, jobId: 'j-over', max: { amount: '0.1', currency: 'USD' }, now: january });
  if (refused.ok || refused.reason !== REASONS.ledgerFull) {
    throw new Error(`expected a full-ledger refusal, got ${JSON.stringify(refused)}`);
  }
  if (countLines() !== full) throw new Error('a refused write changed the ledger');
  const still = await monthSpent({ ...base, now: january });
  if (!still.ok || still.counted.amount !== '0.3') throw new Error(`january total ${still.counted?.amount} ${still.reason}`);

  const february = '2026-02-15T20:00:00.000Z';
  const next = await reserve({ ...base, jobId: 'feb', max: { amount: '0.2', currency: 'USD' }, now: february });
  if (!next.ok) throw new Error(`february reserve ${next.reason}`);
  const lines = countLines();
  if (lines > 3) throw new Error(`folding should shrink the file, saw ${lines}`);
  const januaryAfter = await monthSpent({ ...base, now: january });
  if (januaryAfter.counted.amount !== '0.3') throw new Error(`folded january total ${januaryAfter.counted.amount}`);
  parentPort.postMessage({ ok: true, lines });
} catch (error) {
  parentPort.postMessage({ ok: false, error: error.message });
} finally {
  rmSync(dir, { recursive: true, force: true });
}
