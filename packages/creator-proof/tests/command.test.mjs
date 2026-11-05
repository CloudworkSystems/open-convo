import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { StopAfter, main, prospectiveLedger, writeAllBytes } from '../bin/creator-proof.mjs';
import { ENTRY_LIMIT, LEDGER_BYTES } from '../src/errors.mjs';
import { hashEntry, recordOriginal } from '../src/index.mjs';
import { CLOCK, capture, deadPid, tempDir } from './helpers.mjs';

function run(args, extra = {}) {
  const io = capture();
  const clock = extra.clock ?? (() => CLOCK);
  return main(args, { ...io, clock, ...extra, hooks: extra.hooks }).then((code) => ({ code, io }));
}

test('record, verify, amend, report and links round trip', async () => {
  const { dir, remove } = tempDir();
  const previous = process.umask(0o022);
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'meadow.mov');
    const media2 = join(dir, 'lantern.mov');
    writeFileSync(media, 'river-lane meadow morning sample\n');
    writeFileSync(media2, 'river-lane lantern talk sample\n');
    let calls = 0;
    const clock = () => {
      calls += 1;
      return CLOCK;
    };
    const first = await run(['record', media, '--title', 'Meadow morning', '--platform', 'Townstage', '--ledger', ledger], { clock });
    assert.equal(first.code, 0);
    assert.match(first.io.text(), /Started a new proof ledger at/);
    assert.match(first.io.text(), /Keep a copy somewhere safe/);
    assert.match(first.io.text(), /This is your own record\. It shows what you recorded, not when,/);
    assert.equal(calls, 1);
    assert.equal(statSync(ledger).mode & 0o777, 0o600);
    assert.equal(statSync(`${ledger}.head`).mode & 0o777, 0o600);

    const again = await run(['record', media, '--title', 'Meadow morning', '--ledger', ledger], { clock });
    assert.equal(again.code, 1);
    assert.match(again.io.errors(), /This file is already recorded as orig-/);
    assert.equal(calls, 2);

    const verified = await run(['verify', '--ledger', ledger], { clock });
    assert.equal(verified.code, 0);
    assert.match(verified.io.text(), /The file is complete and in order/);
    assert.equal(calls, 2);

    const second = await run(['record', media2, '--title', 'Lantern talk', '--ledger', ledger], { clock });
    assert.equal(second.code, 0);
    assert.doesNotMatch(second.io.text(), /Started a new proof ledger/);
    const entries = JSON.parse(readFileSync(ledger, 'utf8'));
    const id = entries[0].originalId;
    const amended = await run(['amend', id, '--post-url', 'https://social.example/meadow', '--posted-at', 'Tuesday', '--ledger', ledger], { clock });
    assert.equal(amended.code, 1, amended.io.errors());
    assert.match(amended.io.errors(), /postedAt must be an ISO 8601 UTC time/);
    const amendedOk = await run(['amend', id, '--post-url', 'https://social.example/meadow', '--posted-at', '2026-01-02T00:00:00.000Z', '--notes', 'first post', '--ledger', ledger], { clock });
    assert.equal(amendedOk.code, 0, amendedOk.io.errors());
    assert.match(amendedOk.io.text(), /The earlier entry was kept/);
    const after = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.equal(after[0].postUrl, undefined);
    assert.equal(after[2].changes.postUrl, 'https://social.example/meadow');

    const casePath = join(dir, 'case.json');
    const pack = join(dir, 'pack.md');
    writeFileSync(casePath, JSON.stringify({
      kind: 'fake-fundraiser',
      creatorName: 'River Lane',
      originalIds: after.filter((entry) => entry.kind === 'record').map((entry) => entry.originalId),
      copies: [{
        url: 'https://social.example/fake',
        accountName: 'River Lane Official',
        seenAt: '2026-03-02T15:00:00.000Z',
        whatItShows: 'A meadow video with another donation link.',
      }],
      paymentService: { name: 'Northwind Pay', accountShownOnCopy: 'northwind.example/give-river' },
    }));
    const reported = await run(['report', '--case', casePath, '--out', pack, '--ledger', ledger], { clock });
    assert.equal(reported.code, 0, reported.io.errors());
    assert.match(reported.io.text(), /Checklist:/);
    assert.match(reported.io.text(), /Northwind Pay/);
    assert.equal(statSync(pack).mode & 0o777, 0o600);
    const blocked = await run(['report', '--case', casePath, '--out', pack, '--ledger', ledger], { clock });
    assert.equal(blocked.code, 1);
    assert.match(blocked.io.errors(), /already exists/);
    assert.match(blocked.io.errors(), /--force/);
    const forced = await run(['report', '--case', casePath, '--out', pack, '--force', '--ledger', ledger], { clock });
    assert.equal(forced.code, 0, forced.io.errors());

    const links = join(dir, 'links.json');
    const page = join(dir, 'links.html');
    writeFileSync(links, JSON.stringify({
      creatorName: 'River Lane',
      intro: 'Short films about small towns.',
      updatedAt: '2026-03-01',
      links: [
        { label: 'Donation page', url: 'https://give.example/river-lane', kind: 'donate' },
        { label: 'Townstage', url: 'https://social.example/riverlane', kind: 'account' },
      ],
    }));
    const linked = await run(['links', '--links', links, '--out', page, '--ledger', ledger], { clock });
    assert.equal(linked.code, 0, linked.io.errors());
    assert.equal(statSync(page).mode & 0o777, 0o644);
    assert.match(readFileSync(page, 'utf8'), /Proof code:/);
    assert.doesNotMatch(readFileSync(page, 'utf8'), /<script/i);

    chmodSync(ledger, 0o400);
    const kept = await run(['amend', id, '--notes', 'tighter mode', '--ledger', ledger], { clock });
    assert.equal(kept.code, 0, kept.io.errors());
    assert.equal(statSync(ledger).mode & 0o777, 0o400);
    chmodSync(ledger, 0o644);
    chmodSync(`${ledger}.head`, 0o644);
    const narrowed = await run(['amend', id, '--notes', 'narrowed', '--ledger', ledger], { clock });
    assert.equal(narrowed.code, 0, narrowed.io.errors());
    assert.equal(statSync(ledger).mode & 0o777, 0o600);
    assert.equal(statSync(`${ledger}.head`).mode & 0o777, 0o600);
  } finally {
    process.umask(previous);
    remove();
  }
});

test('a short write is finished or refused before the file is renamed', () => {
  const parts = [];
  writeAllBytes(Buffer.from('abcdefghij'), (buffer, offset, length) => {
    const size = Math.min(3, length);
    parts.push(buffer.subarray(offset, offset + size).toString());
    return size;
  });
  assert.equal(parts.join(''), 'abcdefghij');
  assert.throws(() => writeAllBytes(Buffer.from('abc'), () => 0), /short write/);
});

test('report and links will not write over the ledger, its head, or its lock', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'meadow.mov');
    writeFileSync(media, 'sample\n');
    assert.equal((await run(['record', media, '--title', 'Meadow', '--ledger', ledger])).code, 0);
    const before = readFileSync(ledger);
    const headBefore = readFileSync(`${ledger}.head`);
    const casePath = join(dir, 'case.json');
    const links = join(dir, 'links.json');
    const entries = JSON.parse(before.toString('utf8'));
    writeFileSync(casePath, JSON.stringify({
      kind: 'stolen-video',
      creatorName: 'River Lane',
      originalIds: [entries[0].originalId],
      copies: [{ url: 'https://social.example/copy', accountName: 'Copy', seenAt: '2026-03-02T15:00:00.000Z', whatItShows: 'A copy.' }],
    }));
    writeFileSync(links, JSON.stringify({
      creatorName: 'River Lane',
      updatedAt: '2026-03-01',
      links: [{ label: 'Give', url: 'https://give.example/river', kind: 'donate' }],
    }));
    for (const out of [ledger, `${ledger}.head`, `${ledger}.lock`, `${ledger}.lock.reclaim`, `${dir}/./ledger.json`]) {
      const reported = await run(['report', '--case', casePath, '--out', out, '--force', '--ledger', ledger]);
      assert.equal(reported.code, 1);
      assert.match(reported.io.errors(), /proof ledger or its head or lock/);
      const linked = await run(['links', '--links', links, '--out', out, '--force', '--ledger', ledger]);
      assert.equal(linked.code, 1);
      assert.match(linked.io.errors(), /proof ledger or its head or lock/);
    }
    assert.deepEqual(readFileSync(ledger), before);
    assert.deepEqual(readFileSync(`${ledger}.head`), headBefore);
    assert.equal(existsSync(`${ledger}.lock`), false);
  } finally {
    remove();
  }
});

test('two exports to a new file cannot replace each other', async () => {
  const { dir, remove } = tempDir();
  try {
    const media = join(dir, 'meadow.mov');
    writeFileSync(media, 'sample\n');
    const ledgerA = join(dir, 'a.json');
    const ledgerB = join(dir, 'b.json');
    assert.equal((await run(['record', media, '--title', 'Meadow', '--ledger', ledgerA])).code, 0);
    assert.equal((await run(['record', media, '--title', 'Meadow', '--ledger', ledgerB])).code, 0);
    const idA = JSON.parse(readFileSync(ledgerA, 'utf8'))[0].originalId;
    const idB = JSON.parse(readFileSync(ledgerB, 'utf8'))[0].originalId;
    const copy = {
      url: 'https://social.example/copy',
      accountName: 'Copy account',
      seenAt: '2026-03-02T15:00:00.000Z',
      whatItShows: 'A copy.',
    };
    const caseA = join(dir, 'case-a.json');
    const caseB = join(dir, 'case-b.json');
    writeFileSync(caseA, JSON.stringify({
      kind: 'stolen-video', creatorName: 'First Lane', originalIds: [idA], copies: [copy],
    }));
    writeFileSync(caseB, JSON.stringify({
      kind: 'stolen-video', creatorName: 'Second Lane', originalIds: [idB], copies: [copy],
    }));
    const pack = join(dir, 'pack.md');
    let packed = false;
    const firstPack = await run(['report', '--case', caseA, '--out', pack, '--ledger', ledgerA], {
      hooks: {
        beforePublishOut: async () => {
          if (packed) return;
          packed = true;
          const second = await run(['report', '--case', caseB, '--out', pack, '--ledger', ledgerB]);
          assert.equal(second.code, 0, second.io.errors());
        },
      },
    });
    assert.equal(firstPack.code, 1);
    assert.match(firstPack.io.errors(), /already exists/);
    const packText = readFileSync(pack, 'utf8');
    assert.match(packText, /Second Lane/);
    assert.doesNotMatch(packText, /First Lane/);

    const linksA = join(dir, 'links-a.json');
    const linksB = join(dir, 'links-b.json');
    const page = join(dir, 'page.html');
    const link = (name) => ({
      creatorName: name,
      updatedAt: '2026-03-01',
      links: [{ label: 'Give', url: 'https://give.example/river', kind: 'donate' }],
    });
    writeFileSync(linksA, JSON.stringify(link('First Lane')));
    writeFileSync(linksB, JSON.stringify(link('Second Lane')));
    let linked = false;
    const firstPage = await run(['links', '--links', linksA, '--out', page, '--ledger', ledgerA], {
      hooks: {
        beforePublishOut: async () => {
          if (linked) return;
          linked = true;
          const second = await run(['links', '--links', linksB, '--out', page, '--ledger', ledgerB]);
          assert.equal(second.code, 0, second.io.errors());
        },
      },
    });
    assert.equal(firstPage.code, 1);
    assert.match(firstPage.io.errors(), /already exists/);
    const pageText = readFileSync(page, 'utf8');
    assert.match(pageText, /Second Lane/);
    assert.doesNotMatch(pageText, /First Lane/);
  } finally {
    remove();
  }
});

test('a save that would exceed the ledger limits is refused before the head changes', () => {
  assert.throws(
    () => prospectiveLedger('/tmp/invented-ledger.json', new Array(ENTRY_LIMIT + 1)),
    /nothing was added/,
  );
  const small = prospectiveLedger('/tmp/invented-ledger.json', []);
  assert.equal(small, '[]\n');
});

test('an append that would make the ledger unreadable is not saved', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const fileSha256 = 'ab'.repeat(32);
    const [base] = recordOriginal([], {
      title: 'Meadow',
      fileName: 'meadow.mov',
      fileSha256,
      sizeBytes: 4,
    }, { recordedAt: CLOCK, expectedHead: null });
    const bare = { ...base };
    delete bare.notes;
    delete bare.entryHash;
    const emptyRaw = `${JSON.stringify([{ ...bare, notes: '', entryHash: 'x'.repeat(64) }], null, 2)}\n`;
    const oneRaw = `${JSON.stringify([{ ...bare, notes: 'a', entryHash: 'x'.repeat(64) }], null, 2)}\n`;
    const perNote = Buffer.byteLength(oneRaw) - Buffer.byteLength(emptyRaw);
    const room = LEDGER_BYTES - Buffer.byteLength(emptyRaw);
    const notes = 'a'.repeat(Math.floor(room / perNote));
    const entry = { ...bare, notes };
    entry.entryHash = hashEntry(entry);
    const raw = `${JSON.stringify([entry], null, 2)}\n`;
    assert.ok(Buffer.byteLength(raw) <= LEDGER_BYTES);
    assert.ok(LEDGER_BYTES - Buffer.byteLength(raw) < 64);
    writeFileSync(ledger, raw);
    const head = {
      state: 'committed',
      seq: 1,
      entryHash: entry.entryHash,
      prev: null,
    };
    writeFileSync(`${ledger}.head`, `${JSON.stringify(head, null, 2)}\n`);
    const headBefore = readFileSync(`${ledger}.head`);
    const amended = await run(['amend', entry.originalId, '--notes', 'one more fact', '--ledger', ledger]);
    assert.equal(amended.code, 1);
    assert.match(amended.io.errors(), /too large|limit is/);
    assert.match(amended.io.errors(), /nothing was added/);
    assert.equal(readFileSync(ledger, 'utf8'), raw);
    assert.deepEqual(readFileSync(`${ledger}.head`), headBefore);
    const verified = await run(['verify', '--ledger', ledger]);
    assert.equal(verified.code, 0, verified.io.text());
  } finally {
    remove();
  }
});

test('refuses a missing ledger path, a symlink, and a file it cannot read', async () => {
  const { dir, remove } = tempDir();
  try {
    const missing = await run(['verify']);
    assert.equal(missing.code, 1);
    assert.match(missing.io.errors(), /--ledger is required/);

    const media = join(dir, 'video.mov');
    writeFileSync(media, 'sample');
    chmodSync(media, 0o000);
    const ledger = join(dir, 'ledger.json');
    const denied = await run(['record', media, '--title', 'Hidden', '--ledger', ledger]);
    assert.equal(denied.code, 1);
    assert.match(denied.io.errors(), new RegExp(`Can't read ${media.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: permission denied`));
    assert.equal(existsSync(ledger), false);
    chmodSync(media, 0o600);

    const real = join(dir, 'real.json');
    const link = join(dir, 'link.json');
    symlinkSync(real, link);
    const linked = await run(['record', media, '--title', 'Hidden', '--ledger', link]);
    assert.equal(linked.code, 1);
    assert.match(linked.io.errors(), /is a link/);
    assert.equal(existsSync(real), false);
  } finally {
    remove();
  }
});

test('every save write is a temporary file in the same folder, then a rename', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'meadow.mov');
    writeFileSync(media, 'sample bytes\n');
    const seen = [];
    const result = await run(['record', media, '--title', 'Meadow', '--ledger', ledger], {
      hooks: {
        onBeforeRename({ label, tmp, finalPath }) {
          if (label === 'lock-temp') return;
          seen.push(label);
          assert.equal(dirname(tmp), dirname(finalPath));
          assert.notEqual(tmp, finalPath);
          assert.equal(existsSync(tmp), true);
        },
      },
    });
    assert.equal(result.code, 0, result.io.errors());
    assert.deepEqual(seen, ['head-pending', 'ledger', 'head-committed']);
    for (const name of [ledger, `${ledger}.head`]) assert.equal(existsSync(name), true);
  } finally {
    remove();
  }
});

test('a changed file or a changed ledger is not recorded', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'meadow.mov');
    writeFileSync(media, 'stable sample\n');
    const changed = await run(['record', media, '--title', 'Meadow', '--ledger', ledger], {
      hooks: { onBeforeStream() { writeFileSync(media, 'changed while reading\n'); } },
    });
    assert.equal(changed.code, 1);
    assert.match(changed.io.errors(), /This file changed while it was being read/);
    assert.equal(existsSync(ledger), false);

    writeFileSync(media, 'stable sample\n');
    assert.equal((await run(['record', media, '--title', 'Meadow', '--ledger', ledger])).code, 0);
    const before = readFileSync(ledger, 'utf8');
    const other = join(dir, 'other.mov');
    writeFileSync(other, 'another sample\n');
    const raced = await run(['record', other, '--title', 'Other', '--ledger', ledger], {
      hooks: { afterReadLedger() { writeFileSync(ledger, `${before}\n`); } },
    });
    assert.equal(raced.code, 1);
    assert.match(raced.io.errors(), /changed after it was read/);
    assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).length, 1);
  } finally {
    remove();
  }
});

test('a stop at each write is recovered, and a cut-off tail is not called unfinished', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'meadow.mov');
    const media2 = join(dir, 'lantern.mov');
    writeFileSync(media, 'first sample\n');
    writeFileSync(media2, 'second sample\n');
    const pid = deadPid();

    await assert.rejects(
      run(['record', media, '--title', 'Meadow', '--ledger', ledger], { pid, hooks: { stopAfter: 'pending-head' } }),
      (error) => error instanceof StopAfter && error.stage === 'pending-head',
    );
    assert.equal(existsSync(ledger), false);
    const first = await run(['verify', '--ledger', ledger]);
    assert.match(first.io.text(), /Your last record didn't finish, so nothing was added/);
    assert.doesNotMatch(first.io.text(), /The file is complete and in order/);
    assert.equal(existsSync(`${ledger}.head`), false);

    assert.equal((await run(['record', media, '--title', 'Meadow', '--ledger', ledger])).code, 0);
    await assert.rejects(
      run(['record', media2, '--title', 'Lantern', '--ledger', ledger], { pid, hooks: { stopAfter: 'pending-head' } }),
      (error) => error instanceof StopAfter,
    );
    const rolled = await run(['verify', '--ledger', ledger]);
    assert.equal(rolled.code, 0, rolled.io.text());
    assert.match(rolled.io.text(), /didn't finish, so nothing was added/);
    assert.match(rolled.io.text(), /The file is complete and in order/);
    assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).length, 1);

    await assert.rejects(
      run(['record', media2, '--title', 'Lantern', '--ledger', ledger], { pid, hooks: { stopAfter: 'ledger' } }),
      (error) => error instanceof StopAfter && error.stage === 'ledger',
    );
    const saved = await run(['verify', '--ledger', ledger]);
    assert.match(saved.io.text(), /Your last record was saved/);
    assert.doesNotMatch(saved.io.text(), /didn't finish/);
    assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).length, 2);

    const third = join(dir, 'third.mov');
    writeFileSync(third, 'third sample\n');
    await assert.rejects(
      run(['record', third, '--title', 'Third', '--ledger', ledger], { pid, hooks: { stopAfter: 'committed-head' } }),
      (error) => error instanceof StopAfter && error.stage === 'committed-head',
    );
    const done = await run(['verify', '--ledger', ledger]);
    assert.equal(done.code, 0, done.io.text());
    assert.match(done.io.text(), /cleared its lock/);
    assert.match(done.io.text(), /The file is complete and in order/);
    assert.doesNotMatch(done.io.text(), /didn't finish/);
    assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).length, 3);

    const entries = JSON.parse(readFileSync(ledger, 'utf8'));
    writeFileSync(ledger, `${JSON.stringify(entries.slice(0, -1), null, 2)}\n`);
    const cutRecord = await run(['verify', '--ledger', ledger]);
    assert.equal(cutRecord.code, 1);
    assert.match(cutRecord.io.text(), /The ledger ends at entry 2, but your last record was entry 3/);
    assert.doesNotMatch(cutRecord.io.text(), /didn't finish/);

    writeFileSync(ledger, `${JSON.stringify(entries, null, 2)}\n`);
    const id = entries[0].originalId;
    assert.equal((await run(['amend', id, '--notes', 'a note', '--ledger', ledger])).code, 0);
    const withAmend = JSON.parse(readFileSync(ledger, 'utf8'));
    writeFileSync(ledger, `${JSON.stringify(withAmend.slice(0, -1), null, 2)}\n`);
    const cutAmend = await run(['verify', '--ledger', ledger]);
    assert.match(cutAmend.io.text(), /The ledger ends at entry 3, but your last record was entry 4/);
    assert.doesNotMatch(cutAmend.io.text(), /didn't finish/);
  } finally {
    remove();
  }
});

test('locks keep one save, and a reader waits while a save is in progress', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'meadow.mov');
    const other = join(dir, 'other.mov');
    writeFileSync(media, 'one\n');
    writeFileSync(other, 'two\n');
    let overlap = 0;
    const saved = await run(['record', media, '--title', 'One', '--ledger', ledger], {
      hooks: {
        pause: async (stage) => {
          if (stage !== 'locked' || overlap > 0) return;
          overlap += 1;
          const second = await run(['record', other, '--title', 'Two', '--ledger', ledger]);
          assert.equal(second.code, 1);
          assert.match(second.io.errors(), /Another save is running on this ledger/);
        },
      },
    });
    assert.equal(saved.code, 0, saved.io.errors());
    assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).length, 1);

    const stages = [];
    const third = join(dir, 'third.mov');
    writeFileSync(third, 'three\n');
    const continued = await run(['record', third, '--title', 'Three', '--ledger', ledger], {
      hooks: {
        pause: async (stage) => {
          if (!['pending-head', 'ledger', 'committed-head'].includes(stage)) return;
          const ledgerBytes = existsSync(ledger) ? readFileSync(ledger) : null;
          const headBytes = readFileSync(`${ledger}.head`);
          const reader = await run(['verify', '--ledger', ledger]);
          assert.equal(reader.code, 1);
          assert.match(reader.io.errors(), /Another save is running on this ledger/);
          const afterLedger = existsSync(ledger) ? readFileSync(ledger) : null;
          assert.deepEqual(afterLedger, ledgerBytes);
          assert.deepEqual(readFileSync(`${ledger}.head`), headBytes);
          stages.push(stage);
        },
      },
    });
    assert.equal(continued.code, 0, continued.io.errors());
    assert.deepEqual(stages, ['pending-head', 'ledger', 'committed-head']);
    assert.equal(JSON.parse(readFileSync(ledger, 'utf8')).length, 2);
  } finally {
    remove();
  }
});

test('a stale, empty, or foreign lock is handled, and one recoverer wins', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'meadow.mov');
    writeFileSync(media, 'sample\n');
    assert.equal((await run(['record', media, '--title', 'Meadow', '--ledger', ledger])).code, 0);
    const host = hostname();
    const pid = deadPid();

    writeFileSync(`${ledger}.lock`, '');
    const empty = await run(['verify', '--ledger', ledger]);
    assert.equal(empty.code, 0, empty.io.text());
    assert.match(empty.io.text(), /cleared its lock/);
    assert.equal(existsSync(`${ledger}.lock`), false);

    writeFileSync(`${ledger}.lock`, `${JSON.stringify({ pid, host: 'other-computer' })}\n`);
    const foreign = await run(['verify', '--ledger', ledger]);
    assert.equal(foreign.code, 1);
    assert.match(foreign.io.errors(), /Another save is running/);
    assert.equal(existsSync(`${ledger}.lock`), true);

    writeFileSync(`${ledger}.lock`, `${JSON.stringify({ pid, host })}\n`);
    writeFileSync(`${ledger}.lock.reclaim`, `${JSON.stringify({ pid, host })}\n`);
    const stuck = await run(['verify', '--ledger', ledger]);
    assert.equal(stuck.code, 1);
    assert.match(stuck.io.errors(), /unlock --ledger/);
    assert.equal(existsSync(`${ledger}.lock.reclaim`), true);
    const removed = await run(['unlock', '--ledger', ledger]);
    assert.equal(removed.code, 0, removed.io.errors());
    assert.match(removed.io.text(), /Removed the stuck recovery lock/);
    assert.equal(existsSync(`${ledger}.lock.reclaim`), false);
    assert.equal((await run(['verify', '--ledger', ledger])).code, 0);

    writeFileSync(`${ledger}.lock.reclaim`, `${JSON.stringify({ pid: process.pid, host })}\n`);
    const live = await run(['unlock', '--ledger', ledger]);
    assert.equal(live.code, 1);
    assert.match(live.io.errors(), /still running/);
    assert.equal(existsSync(`${ledger}.lock.reclaim`), true);
    // This test planted a live reclaim lock. Remove it so the next check can run.
    unlinkSync(`${ledger}.lock.reclaim`);

    writeFileSync(`${ledger}.lock`, `${JSON.stringify({ pid, host })}\n`);
    let others = 0;
    const winner = await run(['verify', '--ledger', ledger], {
      hooks: {
        onReclaimHeld: async () => {
          others += 1;
          const loser = await run(['verify', '--ledger', ledger]);
          assert.equal(loser.code, 1);
          assert.match(loser.io.errors(), /Another command is recovering/);
        },
      },
    });
    assert.equal(others, 1);
    assert.equal(winner.code, 0, winner.io.text());
    assert.match(winner.io.text(), /cleared its lock/);
    assert.equal(existsSync(`${ledger}.lock`), false);
  } finally {
    remove();
  }
});

test('an empty ledger tells you to record first, and a changed entry is named', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const pack = join(dir, 'pack.md');
    const page = join(dir, 'page.html');
    const casePath = join(dir, 'case.json');
    const links = join(dir, 'links.json');
    writeFileSync(casePath, '{"kind":"stolen-video"}');
    writeFileSync(links, '{"creatorName":"River Lane","updatedAt":"today","links":[]}');
    const reported = await run(['report', '--case', casePath, '--out', pack, '--ledger', ledger]);
    assert.equal(reported.code, 1);
    assert.match(reported.io.text(), /Record at least one original first:/);
    assert.match(reported.io.text(), /creator-proof\.mjs record/);
    assert.equal(existsSync(pack), false);
    const linked = await run(['links', '--links', links, '--out', page, '--ledger', ledger]);
    assert.match(linked.io.text(), /Record at least one original first:/);
    assert.equal(existsSync(page), false);

    const media = join(dir, 'meadow.mov');
    writeFileSync(media, 'sample\n');
    assert.equal((await run(['record', media, '--title', 'Meadow', '--ledger', ledger])).code, 0);
    const raw = readFileSync(ledger, 'utf8');
    writeFileSync(ledger, raw.replace('Meadow', 'Mxdow'));
    const named = await run(['verify', '--ledger', ledger]);
    assert.equal(named.code, 1);
    assert.match(named.io.text(), /Ledger entry 1 was changed after it was recorded, so nothing was added/);
    assert.match(named.io.text(), /Restore the ledger from your copy/);
  } finally {
    remove();
  }
});

test('record streams a file larger than 64 MB', async () => {
  const { dir, remove } = tempDir();
  try {
    const ledger = join(dir, 'ledger.json');
    const media = join(dir, 'large.mov');
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const fd = openSync(media, 'w');
    for (let i = 0; i < 64; i += 1) writeSync(fd, chunk);
    writeSync(fd, Buffer.from([9]));
    closeSync(fd);
    assert.ok(statSync(media).size > 64 * 1024 * 1024);
    const reads = [];
    const result = await run(['record', media, '--title', 'Large reel', '--ledger', ledger], {
      hooks: { onChunk(size) { reads.push(size); } },
    });
    assert.equal(result.code, 0, result.io.errors());
    assert.ok(reads.length > 1);
    assert.ok(reads.every((size) => size <= 64 * 1024));
    const hash = createHash('sha256');
    await new Promise((resolve, reject) => {
      createReadStream(media).on('data', (piece) => hash.update(piece)).on('end', resolve).on('error', reject);
    });
    const entries = JSON.parse(readFileSync(ledger, 'utf8'));
    assert.equal(entries[0].fileSha256, hash.digest('hex'));
    assert.equal(entries[0].sizeBytes, statSync(media).size);
  } finally {
    remove();
  }
});
