import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { run } from '../src/cap/show.mjs';
import {
  acceptCap,
  convertMicros,
  convertQuote,
  fileStore,
  formatMicros,
  memoryStore,
  monthSpent,
  parseDecimal,
  release,
  reserve,
  resetLedger,
  settle,
  signingBytes,
  tighten,
  verifyCap,
} from '../src/cap/index.mjs';
import { REASONS } from '../src/cap/reasons.mjs';
import { atomicWrite } from '../src/cap/files.mjs';
import { withFileLock, withSyncLock } from '../src/cap/lock.mjs';

const capDir = fileURLToPath(new URL('../src/cap/', import.meta.url));
const NOW = '2026-11-15T18:00:00.000Z';
const OCTOBER = '2026-11-01T06:59:59.000Z';
const NOVEMBER = '2026-11-01T07:00:00.000Z';

function pair() {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
}

function cap(over = {}) {
  return {
    revision: 1,
    currency: 'USD',
    timeZone: 'America/Los_Angeles',
    perRun: { amount: '1', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
    paused: false,
    conversion: null,
    ...over,
  };
}

function signRecord(record, privateKey) {
  const bytes = signingBytes(record);
  assert.ok(bytes, 'record can be signed');
  return sign('sha256', bytes, { key: privateKey, dsaEncoding: 'der' });
}

function world(record = cap(), keys = pair()) {
  const dir = mkdtempSync(join(tmpdir(), 'cap-'));
  const signature = signRecord(record, keys.privateKey);
  const store = memoryStore();
  const accepted = acceptCap(store, record, signature, keys.publicKey);
  assert.equal(accepted.ok, true, accepted.reason);
  const base = {
    ledgerDir: dir,
    store,
    record,
    signature,
    publicKey: keys.publicKey,
  };
  return {
    ...base,
    keys,
    dir,
    reserve(over = {}) {
      return reserve({ ...base, capabilityId: 'make-media', routeId: 'own-key', max: { amount: '0.4', currency: 'USD' }, jobId: 'job-1', now: NOW, ...over });
    },
    settle(over = {}) {
      return settle({ ...base, jobId: 'job-1', now: NOW, ...over });
    },
    release(over = {}) {
      return release({ ...base, jobId: 'job-1', now: NOW, ...over });
    },
    spent(over = {}) {
      return monthSpent({ ...base, now: NOW, ...over });
    },
    close() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('a signed cap verifies, and an edited, unsigned, missing or older one is $0', () => {
  const keys = pair();
  const first = cap({ revision: 1, perRun: { amount: '5', currency: 'USD' } });
  const second = cap({ revision: 2, perRun: { amount: '20', currency: 'USD' } });
  const store = memoryStore();
  const firstSig = signRecord(first, keys.privateKey);
  const secondSig = signRecord(second, keys.privateKey);
  // Part 4 signs this way: SHA-256 of the canonical bytes, DER (X9.62).
  assert.equal(verify('sha256', signingBytes(first), { key: keys.publicKey, dsaEncoding: 'der' }, firstSig), true);

  assert.equal(acceptCap(store, first, firstSig, keys.publicKey).ok, true);
  const good = verifyCap(first, firstSig, keys.publicKey, store.read());
  assert.equal(good.ok, true);
  assert.equal(good.perRun.amount, '5');
  assert.equal(good.zero, false);

  const edited = cap({ revision: 1, perRun: { amount: '6', currency: 'USD' } });
  const editedResult = verifyCap(edited, firstSig, keys.publicKey, store.read());
  assert.equal(editedResult.ok, false);
  assert.equal(editedResult.perRun.amount, '0');
  assert.equal(editedResult.reason, REASONS.capDoesNotCheck);

  const unsigned = verifyCap(first, null, keys.publicKey, store.read());
  assert.equal(unsigned.ok, false);
  assert.equal(unsigned.reason, REASONS.capUnsigned);
  assert.equal(unsigned.perRun.amount, '0');

  const missing = verifyCap(null, firstSig, keys.publicKey, store.read());
  assert.equal(missing.ok, false);
  assert.equal(missing.perRun.amount, '0');

  assert.equal(acceptCap(store, second, secondSig, keys.publicKey).ok, true);
  const replay = verifyCap(first, firstSig, keys.publicKey, store.read());
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, REASONS.capOlder);
  assert.equal(replay.perRun.amount, '0');
  assert.equal(acceptCap(store, first, firstSig, keys.publicKey).reason, REASONS.notNewer);
  assert.equal(verifyCap(second, secondSig, keys.publicKey, store.read()).perRun.amount, '20');

  const other = pair();
  const foreign = verifyCap(second, signRecord(second, other.privateKey), keys.publicKey, store.read());
  assert.equal(foreign.reason, REASONS.capDoesNotCheck);
});

test('a tightening lowers and pauses at once, and only a new signed cap clears it', () => {
  const box = world(cap({
    perRun: { amount: '5', currency: 'USD' },
    monthlyByCapability: { amount: '20', currency: 'USD' },
    monthlyAll: { amount: '50', currency: 'USD' },
  }));
  try {
    const lowered = tighten(box.store, { perRun: { amount: '1', currency: 'USD' } }, box.record, box.signature, box.publicKey);
    assert.equal(lowered.ok, true);
    assert.equal(lowered.cap.perRun.amount, '1');
    assert.equal(lowered.cap.monthlyAll.amount, '50');

    const backUp = tighten(box.store, { perRun: { amount: '4', currency: 'USD' } }, box.record, box.signature, box.publicKey);
    assert.equal(backUp.ok, false);
    assert.equal(backUp.reason, REASONS.tightenRaise);
    assert.equal(verifyCap(box.record, box.signature, box.publicKey, box.store.read()).perRun.amount, '1');

    const paused = tighten(box.store, { paused: true }, box.record, box.signature, box.publicKey);
    assert.equal(paused.ok, true);
    assert.equal(paused.cap.paused, true);
    return box.reserve({ max: { amount: '0.5', currency: 'USD' } }).then(async (refused) => {
      assert.equal(refused.reason, REASONS.paused);
      const unpause = tighten(box.store, { paused: false }, box.record, box.signature, box.publicKey);
      assert.equal(unpause.reason, REASONS.tightenUnpause);

      const statePath = join(box.dir, 'state.json');
      writeFileSync(statePath, `${JSON.stringify(box.store.read().core)}\n`);
      const file = fileStore(statePath);
      // The file store has the tightening. Accept needs the same state the
      // memory store already holds, so copy the core across.
      const broken = { ...file.read().core };
      delete broken.tightening;
      writeFileSync(statePath, `${JSON.stringify(broken)}\n`);
      const damaged = verifyCap(box.record, box.signature, box.publicKey, file.read());
      assert.equal(damaged.ok, false);
      assert.equal(damaged.reason, REASONS.tighteningBroken);
      assert.equal(damaged.perRun.amount, '0');

      const smashed = { ...broken, tightening: { paused: false } };
      writeFileSync(statePath, `${JSON.stringify(smashed)}\n`);
      assert.equal(verifyCap(box.record, box.signature, box.publicKey, file.read()).reason, REASONS.tighteningBroken);

      const raised = cap({
        revision: 2,
        perRun: { amount: '5', currency: 'USD' },
        monthlyByCapability: { amount: '20', currency: 'USD' },
        monthlyAll: { amount: '50', currency: 'USD' },
      });
      const raisedSig = signRecord(raised, box.keys.privateKey);
      assert.equal(acceptCap(file, raised, raisedSig, box.publicKey).ok, true);
      const restored = verifyCap(raised, raisedSig, box.publicKey, file.read());
      assert.equal(restored.ok, true);
      assert.equal(restored.paused, false);
      assert.equal(restored.perRun.amount, '5');
    });
  } finally {
    // closed in the promise; also close if assert throws before then
  }
});

test('each cap level refuses a reservation that does not fit', async () => {
  const box = world(cap({
    perRun: { amount: '0.4', currency: 'USD' },
    monthlyByCapability: { amount: '1', currency: 'USD' },
    monthlyAll: { amount: '1.2', currency: 'USD' },
  }));
  try {
    const overRun = await box.reserve({ max: { amount: '0.400001', currency: 'USD' }, jobId: 'too-big' });
    assert.equal(overRun.reason, REASONS.perRun);
    assert.equal((await box.reserve({ max: { amount: '0.4', currency: 'USD' }, jobId: 'run-ok' })).ok, true);

    const monthBox = world(cap({
      perRun: { amount: '1', currency: 'USD' },
      monthlyByCapability: { amount: '1', currency: 'USD' },
      monthlyAll: { amount: '5', currency: 'USD' },
    }));
    try {
      assert.equal((await monthBox.reserve({ max: { amount: '0.6', currency: 'USD' }, jobId: 'a' })).ok, true);
      const overMonth = await monthBox.reserve({ max: { amount: '0.6', currency: 'USD' }, jobId: 'b' });
      assert.equal(overMonth.reason, REASONS.monthCapability);
      const other = await monthBox.reserve({
        capabilityId: 'other-media',
        max: { amount: '0.6', currency: 'USD' },
        jobId: 'c',
      });
      assert.equal(other.ok, true, other.reason);
    } finally {
      monthBox.close();
    }

    const allBox = world(cap({
      perRun: { amount: '1', currency: 'USD' },
      monthlyByCapability: { amount: '10', currency: 'USD' },
      monthlyAll: { amount: '1', currency: 'USD' },
    }));
    try {
      assert.equal((await allBox.reserve({ max: { amount: '0.6', currency: 'USD' }, jobId: 'a' })).ok, true);
      const overAll = await allBox.reserve({
        capabilityId: 'other-media',
        max: { amount: '0.6', currency: 'USD' },
        jobId: 'b',
      });
      assert.equal(overAll.reason, REASONS.monthAll);
    } finally {
      allBox.close();
    }
  } finally {
    box.close();
  }
});

test('twenty reservations started together never add up past any cap', async () => {
  const keys = pair();
  const record = cap({
    perRun: { amount: '0.1', currency: 'USD' },
    monthlyByCapability: { amount: '1', currency: 'USD' },
    monthlyAll: { amount: '1', currency: 'USD' },
  });
  const signature = signRecord(record, keys.privateKey);
  const dir = mkdtempSync(join(tmpdir(), 'cap-race-'));
  const statePath = join(dir, 'state.json');
  const store = fileStore(statePath);
  assert.equal(acceptCap(store, record, signature, keys.publicKey).ok, true);
  const max = { amount: '0.1', currency: 'USD' };
  const pem = keys.publicKey.export({ type: 'spki', format: 'pem' });
  const parentIds = Array.from({ length: 10 }, (_, index) => `job-p-${index}`);
  const worker = (name, ids) => new Promise((resolve, reject) => {
    const child = new Worker(new URL('./reserve-worker.mjs', import.meta.url), {
      workerData: {
        ledgerDir: dir,
        statePath,
        record,
        signatureB64: signature.toString('base64'),
        publicKeyPem: pem,
        jobIds: ids,
        now: NOW,
        max,
      },
    });
    child.once('message', resolve);
    child.once('error', reject);
  });
  try {
    const parent = Promise.all(parentIds.map((jobId) => reserve({
      ledgerDir: dir,
      store,
      record,
      signature,
      publicKey: keys.publicKey,
      capabilityId: 'make-media',
      routeId: 'own-key',
      max,
      jobId,
      now: NOW,
    })));
    const [parentResults, first, second] = await Promise.all([
      parent,
      worker('a', ['job-a-0', 'job-a-1', 'job-a-2', 'job-a-3', 'job-a-4']),
      worker('b', ['job-b-0', 'job-b-1', 'job-b-2', 'job-b-3', 'job-b-4']),
    ]);
    const oks = [...parentResults.map((result) => result.ok), ...first, ...second];
    const successes = oks.filter(Boolean).length;
    assert.equal(oks.length, 20);
    assert.equal(successes, 10);
    const spent = await monthSpent({
      ledgerDir: dir,
      store: fileStore(statePath),
      record,
      signature,
      publicKey: pem,
      now: NOW,
    });
    assert.equal(spent.ok, true);
    assert.equal(spent.counted.amount, '1');
    assert.equal(spent.reserved.amount, '1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting, editing and restoring an older ledger each stop paid runs and say why', async () => {
  const box = world();
  try {
    assert.equal((await box.reserve({ jobId: 'one', max: { amount: '0.2', currency: 'USD' } })).ok, true);
    const early = readFileSync(join(box.dir, 'entries.jsonl'));
    assert.equal((await box.reserve({ jobId: 'two', max: { amount: '0.2', currency: 'USD' } })).ok, true);
    const current = readFileSync(join(box.dir, 'entries.jsonl'));

    unlinkSync(join(box.dir, 'entries.jsonl'));
    const deleted = await box.reserve({ jobId: 'three', max: { amount: '0.2', currency: 'USD' } });
    assert.equal(deleted.ok, false);
    assert.equal(deleted.fullySpent, true);
    assert.equal(deleted.reason, REASONS.ledgerMissing);

    writeFileSync(join(box.dir, 'entries.jsonl'), current);
    const flipped = Buffer.from(current);
    flipped[20] = flipped[20] === 65 ? 66 : 65;
    writeFileSync(join(box.dir, 'entries.jsonl'), flipped);
    const edited = await box.reserve({ jobId: 'four', max: { amount: '0.2', currency: 'USD' } });
    assert.equal(edited.reason, REASONS.ledgerEdited);

    writeFileSync(join(box.dir, 'entries.jsonl'), early);
    const older = await box.reserve({ jobId: 'five', max: { amount: '0.2', currency: 'USD' } });
    assert.equal(older.reason, REASONS.ledgerOlder);

    const stored = await resetLedger(box);
    assert.equal(stored.ok, false);
    assert.equal(stored.reason, REASONS.resetNeedsFresh);
    assert.equal((await box.reserve({ jobId: 'still', max: { amount: '0.2', currency: 'USD' } })).reason, REASONS.ledgerOlder);
    const fresh = { ...box.record, revision: box.record.revision + 1 };
    const freshSig = signRecord(fresh, box.keys.privateKey);
    assert.equal((await resetLedger({ ...box, record: fresh, signature: freshSig })).ok, true);
    const after = await box.reserve({
      jobId: 'six',
      record: fresh,
      signature: freshSig,
      max: { amount: '0.2', currency: 'USD' },
    });
    assert.equal(after.ok, true, after.reason);
  } finally {
    box.close();
  }

  const keys = pair();
  const low = cap({ revision: 1, monthlyAll: { amount: '4', currency: 'USD' } });
  const high = cap({ revision: 2, monthlyAll: { amount: '8', currency: 'USD' } });
  const store = memoryStore();
  const dir = mkdtempSync(join(tmpdir(), 'cap-reset-'));
  try {
    const lowSig = signRecord(low, keys.privateKey);
    const highSig = signRecord(high, keys.privateKey);
    acceptCap(store, low, lowSig, keys.publicKey);
    acceptCap(store, high, highSig, keys.publicKey);
    const args = { ledgerDir: dir, store, record: low, signature: lowSig, publicKey: keys.publicKey };
    assert.equal((await resetLedger(args)).reason, REASONS.capOlder);
    assert.equal((await resetLedger({ ...args, record: high, signature: highSig })).reason, REASONS.resetNeedsFresh);
    const newer = cap({ revision: 3, monthlyAll: { amount: '8', currency: 'USD' } });
    const newerSig = signRecord(newer, keys.privateKey);
    assert.equal((await resetLedger({ ...args, record: newer, signature: newerSig })).ok, true);
    assert.equal((await resetLedger({ ...args, record: newer, signature: newerSig })).reason, REASONS.resetNeedsFresh);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a reset with the stored cap is refused until a new cap is signed', async () => {
  const box = world(cap({
    perRun: { amount: '5', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
  }));
  try {
    await box.reserve({ jobId: 'a', max: { amount: '5', currency: 'USD' } });
    await box.settle({ jobId: 'a', actual: { amount: '5', currency: 'USD' } });
    await box.reserve({ jobId: 'b', max: { amount: '5', currency: 'USD' } });
    await box.settle({ jobId: 'b', actual: { amount: '5', currency: 'USD' } });
    assert.equal((await box.reserve({ jobId: 'c', max: { amount: '5', currency: 'USD' } })).reason, REASONS.monthCapability);

    const healthy = await resetLedger(box);
    assert.equal(healthy.ok, false);
    assert.equal(healthy.reason, REASONS.resetNeedsFresh);
    assert.equal((await box.spent()).counted.amount, '10');
    assert.equal((await box.reserve({ jobId: 'd', max: { amount: '5', currency: 'USD' } })).reason, REASONS.monthCapability);

    const fresh = { ...box.record, revision: box.record.revision + 1 };
    const freshSig = signRecord(fresh, box.keys.privateKey);
    assert.equal((await resetLedger({ ...box, record: fresh, signature: freshSig })).ok, true);
    assert.equal((await box.spent({ record: fresh, signature: freshSig })).counted.amount, '0');
    assert.equal((await box.reserve({
      jobId: 'e',
      record: fresh,
      signature: freshSig,
      max: { amount: '5', currency: 'USD' },
    })).ok, true);
    assert.equal((await resetLedger({ ...box, record: fresh, signature: freshSig })).reason, REASONS.resetNeedsFresh);
  } finally {
    box.close();
  }
});

test('an over-bill counts in full and an estimated settle stays estimated', async () => {
  const box = world(cap({
    perRun: { amount: '2', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '2', currency: 'USD' },
  }));
  try {
    await box.reserve({ jobId: 'bill', max: { amount: '1', currency: 'USD' } });
    const over = await box.settle({ jobId: 'bill', actual: { amount: '1.5', currency: 'USD' }, estimated: false });
    assert.equal(over.routeOff, true);
    assert.equal(over.reason, REASONS.overBill);
    assert.equal(over.amount.amount, '1.5');
    const spent = await box.spent();
    assert.equal(spent.spent.amount, '1.5');
    assert.equal(spent.reserved.amount, '0');
    const next = await box.reserve({ jobId: 'after', max: { amount: '0.6', currency: 'USD' } });
    assert.equal(next.reason, REASONS.monthAll);

    await box.reserve({ jobId: 'guess', max: { amount: '0.4', currency: 'USD' } });
    const estimated = await box.settle({ jobId: 'guess', estimated: true, actual: { amount: '0.1', currency: 'USD' } });
    assert.equal(estimated.estimated, true);
    assert.equal(estimated.routeOff, false);
    assert.equal(estimated.amount.amount, '0.4');
    const line = readFileSync(join(box.dir, 'entries.jsonl'), 'utf8').trim().split('\n').pop();
    assert.equal(JSON.parse(line).estimated, true);
    assert.equal(JSON.parse(line).kind, 'settle');

    await box.reserve({ jobId: 'free', max: { amount: '0.1', currency: 'USD' } });
    const zeroBill = await box.settle({ jobId: 'free', actual: { amount: '0', currency: 'USD' } });
    assert.equal(zeroBill.ok, true, zeroBill.reason);
    assert.equal(zeroBill.routeOff, false);
    assert.equal(zeroBill.amount.amount, '0');
    const afterZero = await box.spent();
    assert.equal(afterZero.reserved.amount, '0');
  } finally {
    box.close();
  }
});

test("the provider's higher figure counts in monthSpent and inside reserve", async () => {
  const box = world(cap({
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '100', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
  }));
  try {
    await box.reserve({ jobId: 'spent', max: { amount: '2', currency: 'USD' } });
    await box.settle({ jobId: 'spent', actual: { amount: '2', currency: 'USD' } });
    const provider = { capabilityId: 'make-media', routeId: 'own-key' };
    assert.equal((await box.spent({ providerTotal: { amount: '9', currency: 'USD' } })).reason, REASONS.providerRoute);
    const higher = await box.spent({ ...provider, providerTotal: { amount: '9', currency: 'USD' } });
    assert.equal(higher.counted.amount, '9');
    assert.equal(higher.providerUsed, true);
    assert.equal(higher.spent.amount, '2');
    const lower = await box.spent({ ...provider, providerTotal: { amount: '1', currency: 'USD' } });
    assert.equal(lower.counted.amount, '2');
    assert.equal(lower.providerUsed, false);
    const refused = await box.reserve({
      jobId: 'more',
      max: { amount: '2', currency: 'USD' },
      providerTotal: { amount: '9', currency: 'USD' },
    });
    assert.equal(refused.reason, REASONS.monthAll);
    const fits = await box.reserve({
      jobId: 'fits',
      max: { amount: '1', currency: 'USD' },
      providerTotal: { amount: '9', currency: 'USD' },
    });
    assert.equal(fits.ok, true, fits.reason);
    // The open $1 still counts on top of the provider's $9.
    const onTop = await box.reserve({
      jobId: 'on-top',
      max: { amount: '0.1', currency: 'USD' },
      providerTotal: { amount: '9', currency: 'USD' },
    });
    assert.equal(onTop.reason, REASONS.monthAll);
    assert.equal((await box.reserve({
      jobId: 'wrong-currency',
      max: { amount: '0.1', currency: 'USD' },
      providerTotal: { amount: '1', currency: 'EUR' },
    })).reason, REASONS.currencyOff);
  } finally {
    box.close();
  }
});

test('a quote in another currency is refused without conversion, and rounded up with one', () => {
  const keys = pair();
  const plain = cap();
  const store = memoryStore();
  const plainSig = signRecord(plain, keys.privateKey);
  acceptCap(store, plain, plainSig, keys.publicKey);
  const quote = { amount: '1', currency: 'EUR' };
  const favorable = { currency: 'EUR', rate: '0.01', margin: '0', asOf: NOW };
  const refused = convertQuote({
    quote,
    record: plain,
    signature: plainSig,
    publicKey: keys.publicKey,
    protectedState: store.read(),
    now: NOW,
    rate: favorable,
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, REASONS.currencyOff);
  assert.equal(refused.rateIgnored, true);

  const converting = cap({
    revision: 2,
    conversion: { currency: 'EUR', rate: '1.000000000001', margin: '0', asOf: NOW },
  });
  const convertingSig = signRecord(converting, keys.privateKey);
  acceptCap(store, converting, convertingSig, keys.publicKey);
  const converted = convertQuote({
    quote,
    record: converting,
    signature: convertingSig,
    publicKey: keys.publicKey,
    protectedState: store.read(),
    now: NOW,
    rate: favorable,
  });
  assert.equal(converted.ok, true);
  assert.equal(converted.quote.amount, '1');
  assert.equal(converted.quote.currency, 'EUR');
  assert.equal(converted.capAmount.amount, '1.000001');
  assert.equal(converted.capAmount.currency, 'USD');
  assert.equal(converted.rate, '1.000000000001');
  assert.notEqual(converted.rate, favorable.rate);

  const exactly = cap({
    revision: 3,
    conversion: { currency: 'EUR', rate: '1', margin: '0', asOf: '2026-11-14T18:00:00.000Z' },
  });
  const exactlySig = signRecord(exactly, keys.privateKey);
  acceptCap(store, exactly, exactlySig, keys.publicKey);
  const onTime = convertQuote({
    quote,
    record: exactly,
    signature: exactlySig,
    publicKey: keys.publicKey,
    protectedState: store.read(),
    now: '2026-11-15T18:00:00.000Z',
  });
  assert.equal(onTime.ok, true);
  assert.equal(onTime.capAmount.amount, '1');

  const late = convertQuote({
    quote,
    record: exactly,
    signature: exactlySig,
    publicKey: keys.publicKey,
    protectedState: store.read(),
    now: '2026-11-15T18:00:00.001Z',
  });
  assert.equal(late.reason, REASONS.rateStale);

  const future = cap({
    revision: 4,
    conversion: { currency: 'EUR', rate: '1', margin: '0', asOf: '2026-11-16T00:00:00.000Z' },
  });
  const futureSig = signRecord(future, keys.privateKey);
  acceptCap(store, future, futureSig, keys.publicKey);
  assert.equal(convertQuote({
    quote,
    record: future,
    signature: futureSig,
    publicKey: keys.publicKey,
    protectedState: store.read(),
    now: NOW,
  }).reason, REASONS.rateBad);

  assert.equal(formatMicros(convertMicros(parseDecimal('1'), '1.1', '0.1')), '1.21');
  const same = convertQuote({
    quote: { amount: '0.4', currency: 'USD' },
    record: future,
    signature: futureSig,
    publicKey: keys.publicKey,
    protectedState: store.read(),
    now: NOW,
  });
  assert.equal(same.ok, true);
  assert.equal(same.capAmount.amount, '0.4');
  assert.equal(same.quote.currency, 'USD');
  const third = convertQuote({
    quote: { amount: '1', currency: 'GBP' },
    record: future,
    signature: futureSig,
    publicKey: keys.publicKey,
    protectedState: store.read(),
    now: NOW,
    rate: favorable,
  });
  assert.equal(third.reason, REASONS.currencyOff);
  assert.equal(third.rateIgnored, true);
});

test('0.1 + 0.2 style sums are exact and never pass through a JavaScript number', async () => {
  assert.equal(typeof parseDecimal('0.1'), 'bigint');
  assert.equal(formatMicros(parseDecimal('0.1') + parseDecimal('0.2')), '0.3');
  assert.equal(formatMicros(parseDecimal('0.10') + parseDecimal('0.20')), '0.3');
  let total = 0n;
  for (const amount of ['0.10', '0.20', '0.30', '0.40', '0.50', '0.60', '0.70', '0.80', '0.90']) {
    total += parseDecimal(amount);
  }
  assert.equal(formatMicros(total), '4.5');
  const money = readFileSync(join(capDir, 'money.mjs'), 'utf8');
  assert.doesNotMatch(money, /parseFloat|\bNumber\s*\(/);

  const box = world(cap({
    perRun: { amount: '1', currency: 'USD' },
    monthlyByCapability: { amount: '1', currency: 'USD' },
    monthlyAll: { amount: '1', currency: 'USD' },
  }));
  try {
    await box.reserve({ jobId: 'a', max: { amount: '0.1', currency: 'USD' } });
    await box.reserve({ jobId: 'b', max: { amount: '0.2', currency: 'USD' } });
    const spent = await box.spent();
    assert.equal(spent.counted.amount, '0.3');
    const raw = readFileSync(join(box.dir, 'entries.jsonl'), 'utf8');
    for (const line of raw.trim().split('\n')) {
      assert.equal(typeof JSON.parse(line).amount.amount, 'string');
    }
  } finally {
    box.close();
  }
});

test('the library does not read the clock', () => {
  const source = readdirSync(capDir)
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => readFileSync(join(capDir, name), 'utf8'))
    .join('\n');
  assert.doesNotMatch(source, /Date\.now\s*\(/);
  assert.doesNotMatch(source, /new Date\s*\(\s*\)/);
  assert.doesNotMatch(source, /(^|[^\w.])Date\s*\(\s*\)/);
  assert.doesNotMatch(source, /child_process|node:net|node:http|node:https|from 'node:dns'/);
});

test('a month follows the cap time zone across a non-UTC boundary', async () => {
  const box = world(cap({
    perRun: { amount: '1', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '1', currency: 'USD' },
  }));
  try {
    assert.equal((await box.reserve({ jobId: 'oct', max: { amount: '0.6', currency: 'USD' }, now: OCTOBER })).ok, true);
    assert.equal((await box.reserve({ jobId: 'nov', max: { amount: '0.6', currency: 'USD' }, now: NOVEMBER })).ok, true);
    const octoberAgain = await box.reserve({ jobId: 'oct-2', max: { amount: '0.5', currency: 'USD' }, now: OCTOBER });
    assert.equal(octoberAgain.reason, REASONS.monthAll);
    assert.equal((await box.reserve({ jobId: 'oct-3', max: { amount: '0.4', currency: 'USD' }, now: OCTOBER })).ok, true);
    await box.settle({ jobId: 'oct', actual: { amount: '0.25', currency: 'USD' }, now: NOVEMBER });
    const october = await box.spent({ now: OCTOBER });
    const november = await box.spent({ now: NOVEMBER });
    assert.equal(october.counted.amount, '0.65');
    assert.equal(november.counted.amount, '0.6');
    assert.equal(october.spent.amount, '0.25');
    assert.equal(november.spent.amount, '0');
  } finally {
    box.close();
  }
});

test('edge cases: release, duplicate jobs, zero max, foreign reserve, show command', async () => {
  const box = world();
  try {
    await box.reserve({ jobId: 'hold', max: { amount: '0.4', currency: 'USD' } });
    assert.equal((await box.release({ jobId: 'hold' })).ok, true);
    assert.equal((await box.spent()).counted.amount, '0');
    assert.equal((await box.reserve({ jobId: 'hold', max: { amount: '0.4', currency: 'USD' } })).reason, REASONS.jobDuplicate);
    assert.equal((await box.settle({ jobId: 'missing', actual: { amount: '0.1', currency: 'USD' } })).reason, REASONS.jobUnknown);
    assert.equal((await box.reserve({ jobId: 'zero', max: { amount: '0', currency: 'USD' } })).reason, REASONS.badAmount);
    assert.equal((await box.reserve({ jobId: 'eur', max: { amount: '0.1', currency: 'EUR' } })).reason, REASONS.currencyOff);
    assert.equal((await box.reserve({ jobId: 'bad-time', now: 'Tuesday' })).reason, REASONS.badNow);

    const statePath = join(box.dir, 'state.json');
    writeFileSync(statePath, `${JSON.stringify(box.store.read().core)}\n`);
    writeFileSync(join(box.dir, 'cap.json'), `${JSON.stringify(box.record)}\n`);
    writeFileSync(join(box.dir, 'cap.signature'), box.signature.toString('base64'));
    writeFileSync(join(box.dir, 'public-key.pem'), box.publicKey.export({ type: 'spki', format: 'pem' }));
    const before = readdirSync(box.dir).sort();
    const report = run(['--ledger', box.dir, '--state', statePath, '--now', NOW]);
    assert.equal(report.code, 0);
    const text = report.lines.join('\n');
    assert.match(text, /Cap per run: 1 USD/);
    assert.match(text, /Paused: no/);
    assert.match(text, /Time zone: America\/Los_Angeles/);
    assert.match(text, /Reserved this month: 0 USD/);
    assert.match(text, /Spent this month: 0 USD/);
    assert.match(text, /Ledger: checks out/);
    assert.deepEqual(readdirSync(box.dir).sort(), before);
    assert.equal(run(['--ledger', box.dir]).code, 1);
  } finally {
    box.close();
  }
});

test('a lock that is already held does not get stolen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-lock-'));
  const lockPath = join(dir, 'ledger.lock');
  let releaseHold;
  const gate = new Promise((resolve) => {
    releaseHold = resolve;
  });
  try {
    const held = withFileLock(lockPath, () => gate, { attempts: 1, waitMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await withFileLock(lockPath, () => 'ran', { attempts: 2, waitMs: 5 });
    assert.equal(second.ok, false);
    releaseHold();
    assert.equal((await held).ok, true);
    const syncHeld = withSyncLock(join(dir, 'state.lock'), () => {
      const secondSync = withSyncLock(join(dir, 'state.lock'), () => 'ran', { attempts: 2, waitMs: 5 });
      assert.equal(secondSync.ok, false);
      return 'held';
    }, { attempts: 1, waitMs: 1 });
    assert.equal(syncHeld.ok, true);
    assert.equal(syncHeld.value, 'held');
  } finally {
    releaseHold();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a finished process is taken, and a live one is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-lock-dead-'));
  // Above every process id macOS or the Linux runners can assign, so it
  // cannot be a running process. The test does not start one.
  const deadPid = 2147483647;
  const token = 'ab'.repeat(16);
  try {
    const ledgerLock = join(dir, 'ledger.lock');
    writeFileSync(ledgerLock, `${deadPid}\n${token}\n`);
    const taken = await withFileLock(ledgerLock, () => 'ran', { attempts: 1, waitMs: 1 });
    assert.equal(taken.ok, true);
    assert.equal(taken.value, 'ran');
    assert.equal(existsSync(ledgerLock), false);

    const stateLock = join(dir, 'state.lock');
    writeFileSync(stateLock, `${deadPid}\n${token}\n`);
    const syncTaken = withSyncLock(stateLock, () => 'ran', { attempts: 1, waitMs: 1 });
    assert.equal(syncTaken.ok, true);
    assert.equal(syncTaken.value, 'ran');
    assert.equal(existsSync(stateLock), false);

    writeFileSync(ledgerLock, '');
    const empty = await withFileLock(ledgerLock, () => 'ran', { attempts: 1, waitMs: 1 });
    assert.equal(empty.ok, true);
    assert.equal(empty.value, 'ran');
    writeFileSync(stateLock, '');
    const emptySync = withSyncLock(stateLock, () => 'ran', { attempts: 1, waitMs: 1 });
    assert.equal(emptySync.ok, true);
    assert.equal(emptySync.value, 'ran');

    writeFileSync(ledgerLock, `${process.pid}\n${token}\n`);
    const live = await withFileLock(ledgerLock, () => 'ran', { attempts: 2, waitMs: 1 });
    assert.equal(live.ok, false);
    assert.equal(readFileSync(ledgerLock, 'utf8'), `${process.pid}\n${token}\n`);

    writeFileSync(stateLock, `${process.pid}\n${token}\n`);
    const liveSync = withSyncLock(stateLock, () => 'ran', { attempts: 2, waitMs: 1 });
    assert.equal(liveSync.ok, false);
    assert.equal(readFileSync(stateLock, 'utf8'), `${process.pid}\n${token}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a short write is retried, and a stalled write leaves the previous file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cap-write-'));
  const path = join(dir, 'entries.jsonl');
  try {
    assert.equal(atomicWrite(path, 'original\n'), true);
    let calls = 0;
    assert.equal(atomicWrite(path, 'abcdef', (fd, data, offset, length) => {
      calls += 1;
      const count = Math.min(2, length);
      writeSync(fd, data, offset, count);
      return count;
    }), true);
    assert.equal(readFileSync(path, 'utf8'), 'abcdef');
    assert.ok(calls >= 3);
    assert.throws(() => atomicWrite(path, 'replacement\n', () => 0), { code: 'EIO' });
    assert.equal(readFileSync(path, 'utf8'), 'abcdef');
    assert.equal(readdirSync(dir).some((name) => name.endsWith('.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('choices the plan leaves open', async () => {
  const paused = world(cap({ paused: true }));
  try {
    const refused = await paused.reserve();
    assert.equal(refused.reason, REASONS.paused);
    assert.equal(verifyCap(paused.record, paused.signature, paused.publicKey, paused.store.read()).ok, true);
  } finally {
    paused.close();
  }

  const zero = world(cap({
    perRun: { amount: '0', currency: 'USD' },
    monthlyByCapability: { amount: '0', currency: 'USD' },
    monthlyAll: { amount: '0', currency: 'USD' },
  }));
  try {
    const verified = verifyCap(zero.record, zero.signature, zero.publicKey, zero.store.read());
    assert.equal(verified.ok, true);
    assert.equal(verified.perRun.amount, '0');
    assert.equal((await zero.reserve()).reason, REASONS.perRun);
  } finally {
    zero.close();
  }

  const box = world();
  try {
    assert.equal(tighten(box.store, {}, box.record, box.signature, box.publicKey).reason, REASONS.tightenNoChange);
    assert.equal(tighten(box.store, { perRun: { amount: '0.5', currency: 'USD' } }, box.record, box.signature, box.publicKey).ok, true);
    assert.equal((await resetLedger(box)).reason, REASONS.resetNeedsFresh);
    assert.equal(verifyCap(box.record, box.signature, box.publicKey, box.store.read()).perRun.amount, '0.5');
    assert.equal(tighten(box.store, { perRun: { amount: '1', currency: 'EUR' } }, box.record, box.signature, box.publicKey).reason, REASONS.currencyOff);
    assert.equal((await box.reserve({ now: '2026-02-31T00:00:00.000Z' })).reason, REASONS.badNow);

    const statePath = join(box.dir, 'state.json');
    const raised = {
      ...box.store.read().core,
      tightening: {
        perRun: { amount: '9', currency: 'USD' },
        monthlyByCapability: { amount: '10', currency: 'USD' },
        monthlyAll: { amount: '10', currency: 'USD' },
        paused: false,
      },
    };
    writeFileSync(statePath, `${JSON.stringify(raised)}\n`);
    const file = fileStore(statePath);
    assert.equal(verifyCap(box.record, box.signature, box.publicKey, file.read()).reason, REASONS.tighteningBroken);

    const linked = world();
    try {
      const { symlinkSync } = await import('node:fs');
      symlinkSync(join(linked.dir, 'elsewhere'), join(linked.dir, 'entries.jsonl'));
      const result = await linked.reserve({ jobId: 'linked' });
      assert.equal(result.ok, false);
      assert.equal(result.reason, REASONS.ledgerEdited);
    } finally {
      linked.close();
    }
  } finally {
    box.close();
  }

  const routes = world(cap({
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '100', currency: 'USD' },
    monthlyAll: { amount: '12', currency: 'USD' },
  }));
  try {
    await routes.reserve({ jobId: 'route-a', routeId: 'own-key', max: { amount: '2', currency: 'USD' } });
    await routes.settle({ jobId: 'route-a', actual: { amount: '2', currency: 'USD' } });
    await routes.reserve({ jobId: 'route-b', routeId: 'other-key', max: { amount: '3', currency: 'USD' } });
    await routes.settle({ jobId: 'route-b', actual: { amount: '3', currency: 'USD' } });
    const refused = await routes.reserve({
      jobId: 'route-a-again',
      routeId: 'own-key',
      max: { amount: '1', currency: 'USD' },
      providerTotal: { amount: '9', currency: 'USD' },
    });
    // Other routes stay in the total: 3 + max(2, 9) + 1 = 13, over the $12 cap.
    assert.equal(refused.reason, REASONS.monthAll);
    const shown = await routes.spent({
      capabilityId: 'make-media',
      routeId: 'own-key',
      providerTotal: { amount: '9', currency: 'USD' },
    });
    // Settled on this route is $2, on the other route $8 would be separate.
    // Here the other route is $3, so counted is max(2, 9) + 3 = 12, not max(5, 9).
    assert.equal(shown.counted.amount, '12');
    assert.equal(shown.spent.amount, '5');
    assert.equal(shown.providerUsed, true);
  } finally {
    routes.close();
  }

  const split = world(cap({
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '20', currency: 'USD' },
    monthlyAll: { amount: '20', currency: 'USD' },
  }));
  try {
    await split.reserve({ jobId: 'this-route', routeId: 'own-key', max: { amount: '2', currency: 'USD' } });
    await split.settle({ jobId: 'this-route', actual: { amount: '2', currency: 'USD' } });
    await split.reserve({ jobId: 'other-route', routeId: 'other-key', max: { amount: '8', currency: 'USD' } });
    await split.settle({ jobId: 'other-route', actual: { amount: '8', currency: 'USD' } });
    const total = await split.spent({
      capabilityId: 'make-media',
      routeId: 'own-key',
      providerTotal: { amount: '9', currency: 'USD' },
    });
    // $9 replaces this route's $2, then the other route's $8 is added: 17.
    // Comparing $9 with the combined $10 would have reported 10.
    assert.equal(total.counted.amount, '17');
    assert.equal(total.spent.amount, '10');
    assert.equal(total.providerUsed, true);
  } finally {
    split.close();
  }
});

test('a write that would make the ledger unreadable is refused before it is saved', async () => {
  const worker = new Worker(new URL('./ledger-ceiling-worker.mjs', import.meta.url));
  const result = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(result.ok, true, result.error);
});

test('a new time zone does not move spend, and a currency change can still be reset', async () => {
  const utc = cap({
    timeZone: 'UTC',
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '100', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
  });
  const box = world(utc);
  try {
    const booked = '2026-11-01T00:30:00.000Z';
    assert.equal((await box.reserve({ jobId: 'nov', max: { amount: '10', currency: 'USD' }, now: booked })).ok, true);
    const la = { ...utc, revision: 2, timeZone: 'America/Los_Angeles' };
    const laSig = signRecord(la, box.keys.privateKey);
    assert.equal(acceptCap(box.store, la, laSig, box.publicKey).ok, true);
    const november = '2026-11-15T20:00:00.000Z';
    const spent = await box.spent({ record: la, signature: laSig, now: november });
    assert.equal(spent.ok, true, spent.reason);
    assert.equal(spent.counted.amount, '10');
    const again = await box.reserve({
      record: la,
      signature: laSig,
      jobId: 'again',
      max: { amount: '10', currency: 'USD' },
      now: november,
    });
    assert.equal(again.reason, REASONS.monthAll);

    const eur = {
      ...la,
      revision: 3,
      currency: 'EUR',
      perRun: { amount: '10', currency: 'EUR' },
      monthlyByCapability: { amount: '100', currency: 'EUR' },
      monthlyAll: { amount: '10', currency: 'EUR' },
    };
    const eurSig = signRecord(eur, box.keys.privateKey);
    assert.equal(acceptCap(box.store, eur, eurSig, box.publicKey).reason, REASONS.currencyReset);
    assert.equal((await box.spent({ record: la, signature: laSig, now: november })).counted.amount, '10');
    assert.equal((await resetLedger({ ...box, record: eur, signature: eurSig })).ok, true);
    const cleared = await box.spent({ record: eur, signature: eurSig, now: november });
    assert.equal(cleared.ok, true, cleared.reason);
    assert.equal(cleared.counted.amount, '0');
    assert.equal((await box.reserve({
      record: eur,
      signature: eurSig,
      jobId: 'fresh',
      max: { amount: '1', currency: 'EUR' },
      now: november,
    })).ok, true);
  } finally {
    box.close();
  }
});

test('a foreign bill is recorded even when paid runs are paused', async () => {
  const record = cap({
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
    conversion: { currency: 'EUR', rate: '1', margin: '0', asOf: NOW },
  });
  const box = world(record);
  try {
    assert.equal((await box.reserve({ jobId: 'flight', max: { amount: '1', currency: 'USD' } })).ok, true);
    assert.equal(tighten(box.store, { paused: true }, box.record, box.signature, box.publicKey).ok, true);
    assert.equal((await box.reserve({ jobId: 'later', max: { amount: '1', currency: 'USD' } })).reason, REASONS.paused);
    const settled = await box.settle({ jobId: 'flight', actual: { amount: '2', currency: 'EUR' } });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(settled.routeOff, true);
    assert.equal(settled.amount.amount, '2');
    assert.equal(settled.amount.currency, 'USD');
    const spent = await box.spent();
    assert.equal(spent.spent.amount, '2');
    assert.equal(spent.reserved.amount, '0');
  } finally {
    box.close();
  }
});

test('a foreign bill uses the rate saved on the reservation, even after that rate is a day old', async () => {
  const record = cap({
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
    conversion: { currency: 'EUR', rate: '2', margin: '0', asOf: NOW },
  });
  const box = world(record);
  const later = '2026-11-16T19:00:00.000Z';
  try {
    assert.equal((await box.reserve({ jobId: 'flight', max: { amount: '1', currency: 'USD' } })).ok, true);
    const saved = JSON.parse(readFileSync(join(box.dir, 'entries.jsonl'), 'utf8'));
    assert.deepEqual(saved.rate, { currency: 'EUR', rate: '2', margin: '0', asOf: NOW });
    const stale = convertQuote({
      quote: { amount: '1', currency: 'EUR' },
      record: box.record,
      signature: box.signature,
      publicKey: box.publicKey,
      protectedState: box.store.read(),
      now: later,
    });
    assert.equal(stale.reason, REASONS.rateStale);
    const next = cap({
      revision: 2,
      perRun: { amount: '10', currency: 'USD' },
      monthlyByCapability: { amount: '10', currency: 'USD' },
      monthlyAll: { amount: '10', currency: 'USD' },
      conversion: { currency: 'EUR', rate: '9', margin: '0', asOf: later },
    });
    const nextSig = signRecord(next, box.keys.privateKey);
    assert.equal(acceptCap(box.store, next, nextSig, box.publicKey).ok, true);
    const settled = await box.settle({
      record: next,
      signature: nextSig,
      jobId: 'flight',
      now: later,
      actual: { amount: '1', currency: 'EUR' },
    });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(settled.routeOff, true);
    assert.equal(settled.amount.amount, '2');
    assert.equal(settled.amount.currency, 'USD');
    assert.equal(settled.bill.amount, '1');
    assert.equal(settled.bill.currency, 'EUR');
    const spent = await box.spent({ record: next, signature: nextSig, now: later });
    assert.equal(spent.spent.amount, '2');
    assert.equal(spent.reserved.amount, '0');
  } finally {
    box.close();
  }
});

test('a stale conversion rate does not block a reservation in the cap currency', async () => {
  const record = cap({
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
    conversion: { currency: 'EUR', rate: '1', margin: '0', asOf: '2026-06-01T00:00:00.000Z' },
  });
  const box = world(record);
  try {
    const reserved = await box.reserve({ jobId: 'native', max: { amount: '1', currency: 'USD' }, now: NOW });
    assert.equal(reserved.ok, true, reserved.reason);
    const saved = JSON.parse(readFileSync(join(box.dir, 'entries.jsonl'), 'utf8').trim().split('\n')[0]);
    assert.equal(saved.rate, null);
    const settled = await box.settle({ jobId: 'native', actual: { amount: '1', currency: 'USD' } });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(settled.routeOff, false);
    const foreign = await box.reserve({ jobId: 'foreign', max: { amount: '1', currency: 'USD' }, now: NOW });
    assert.equal(foreign.ok, true, foreign.reason);
    const refused = await box.settle({ jobId: 'foreign', actual: { amount: '1', currency: 'EUR' } });
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, REASONS.currencyOff);
    assert.equal(refused.routeOff, true);
    const spent = await box.spent();
    assert.equal(spent.ok, true, spent.reason);
    assert.equal(spent.spent.amount, '1');
    assert.equal(spent.reserved.amount, '1');
  } finally {
    box.close();
  }
});

test('a converted bill above the ledger maximum is recorded at that maximum', async () => {
  const record = cap({
    currency: 'JPY',
    perRun: { amount: '1000', currency: 'JPY' },
    monthlyByCapability: { amount: '1000', currency: 'JPY' },
    monthlyAll: { amount: '1000', currency: 'JPY' },
    conversion: { currency: 'USD', rate: '25000', margin: '0', asOf: NOW },
  });
  const box = world(record);
  try {
    assert.equal((await box.reserve({ jobId: 'big', max: { amount: '1', currency: 'JPY' } })).ok, true);
    const settled = await box.settle({ jobId: 'big', actual: { amount: '40000', currency: 'USD' } });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(settled.routeOff, true);
    assert.equal(settled.amount.amount, '999999999.999999');
    assert.equal(settled.amount.currency, 'JPY');
    assert.equal(settled.bill.amount, '40000');
    assert.equal(settled.bill.currency, 'USD');
    const spent = await box.spent();
    assert.equal(spent.ok, true, spent.reason);
    assert.equal(spent.spent.amount, '999999999.999999');
    assert.equal(spent.reserved.amount, '0');
    const again = await box.reserve({ jobId: 'next', max: { amount: '1', currency: 'JPY' } });
    assert.equal(again.reason, REASONS.monthCapability);
  } finally {
    box.close();
  }
});

test('a started run can settle after the cap record is damaged', async () => {
  const record = cap({
    perRun: { amount: '10', currency: 'USD' },
    monthlyByCapability: { amount: '10', currency: 'USD' },
    monthlyAll: { amount: '10', currency: 'USD' },
  });
  const box = world(record);
  try {
    assert.equal((await box.reserve({ jobId: 'flight', max: { amount: '1', currency: 'USD' } })).ok, true);
    assert.equal((await box.reserve({ jobId: 'other', max: { amount: '1', currency: 'USD' } })).ok, true);
    const settled = await box.settle({
      record: null,
      signature: null,
      jobId: 'flight',
      actual: { amount: '4', currency: 'USD' },
    });
    assert.equal(settled.ok, true, settled.reason);
    assert.equal(settled.routeOff, true);
    assert.equal(settled.amount.amount, '4');
    const released = await box.release({
      record: box.record,
      signature: Buffer.alloc(0),
      jobId: 'other',
    });
    assert.equal(released.ok, true, released.reason);
    const spent = await box.spent();
    assert.equal(spent.ok, true, spent.reason);
    assert.equal(spent.spent.amount, '4');
    assert.equal(spent.reserved.amount, '0');
    const blocked = await box.reserve({
      record: null,
      signature: null,
      jobId: 'later',
      max: { amount: '1', currency: 'USD' },
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, REASONS.capDoesNotCheck);
  } finally {
    box.close();
  }
});

test('the show command says why a damaged ledger stopped paid routes', async () => {
  const box = world();
  try {
    await box.reserve({ jobId: 'one', max: { amount: '0.2', currency: 'USD' } });
    const statePath = join(box.dir, 'state.json');
    writeFileSync(statePath, `${JSON.stringify(box.store.read().core)}\n`);
    writeFileSync(join(box.dir, 'cap.json'), `${JSON.stringify(box.record)}\n`);
    writeFileSync(join(box.dir, 'cap.signature'), box.signature.toString('base64'));
    writeFileSync(join(box.dir, 'public-key.pem'), box.publicKey.export({ type: 'spki', format: 'pem' }));
    copyFileSync(join(box.dir, 'entries.jsonl'), join(box.dir, 'early.jsonl'));
    await box.reserve({ jobId: 'two', max: { amount: '0.2', currency: 'USD' } });
    // The memory store moved on. Write the later state, then restore the early file.
    writeFileSync(statePath, `${JSON.stringify(box.store.read().core)}\n`);
    copyFileSync(join(box.dir, 'early.jsonl'), join(box.dir, 'entries.jsonl'));
    const report = run(['--ledger', box.dir, '--state', statePath, '--now', NOW]);
    assert.match(report.lines.join('\n'), /older copy/);
    assert.match(report.lines.join('\n'), /fully spent/);
  } finally {
    box.close();
  }
});
