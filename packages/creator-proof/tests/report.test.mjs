import assert from 'node:assert/strict';
import { test } from 'node:test';

import { amendOriginal, buildReport, recordOriginal } from '../src/index.mjs';
import { PLAIN_NOTE } from '../src/words.mjs';

const HASH_A = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const HASH_B = 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
const T1 = '2026-01-15T00:00:00.000Z';
const T2 = '2026-02-15T00:00:00.000Z';
const SEEN = '2026-03-02T15:00:00.000Z';

function ledgerWithTwo() {
  let ledger = recordOriginal([], {
    title: 'Meadow morning',
    fileName: 'meadow.mov',
    fileSha256: HASH_A,
    sizeBytes: 12,
    platform: 'Townstage',
    postUrl: 'https://social.example/riverlane/meadow',
    postedAt: '2026-01-02T00:00:00.000Z',
  }, { recordedAt: T1, expectedHead: null });
  ledger = recordOriginal(ledger, {
    title: 'Lantern talk',
    fileName: 'lantern.mov',
    fileSha256: HASH_B,
    sizeBytes: 20,
    platform: 'Townstage',
  }, { recordedAt: T2, expectedHead: { seq: 1, entryHash: ledger[0].entryHash } });
  return ledger;
}

function headOf(ledger) {
  const last = ledger[ledger.length - 1];
  return { seq: last.seq, entryHash: last.entryHash };
}

function baseCase(ledger, extra = {}) {
  return {
    kind: 'stolen-video',
    creatorName: 'River Lane',
    originalIds: ledger.filter((entry) => entry.kind === 'record').map((entry) => entry.originalId),
    copies: [{
      url: 'https://social.example/fake-river/post/1',
      accountName: 'River Lane Official',
      accountUrl: 'https://social.example/fake-river',
      seenAt: SEEN,
      whatItShows: 'The meadow video with a different donation link.',
    }],
    ...extra,
  };
}

function drafted(markdown) {
  return markdown.split('## Drafted reports')[1].split('## Proof ledger')[0];
}

function anchors(markdown) {
  return markdown.split('### Anchors')[1];
}

test('each kind names its places, in time order, without calling the check proof', () => {
  const ledger = ledgerWithTwo();
  const expectedHead = headOf(ledger);
  const stolen = buildReport(ledger, baseCase(ledger), { expectedHead });
  assert.match(stolen.markdown, /This video is mine\.|These 2 videos are mine\./);
  assert.match(stolen.markdown, /These 2 videos are mine\. The account below reposted them\./);
  assert.match(stolen.markdown, /Meta's copyright report form/);
  assert.match(stolen.markdown, /in-app report/);
  assert.doesNotMatch(stolen.markdown, /impersonation report form/);
  const times = [...stolen.markdown.matchAll(/^- (\d{4}-\d{2}-\d{2}T[^ ]+) — /gm)].map((match) => match[1]);
  const sorted = [...times].sort();
  assert.deepEqual(times, sorted);

  const impersonation = buildReport(ledger, baseCase(ledger, { kind: 'impersonation' }), { expectedHead });
  assert.match(impersonation.markdown, /I am River Lane\. The account below is pretending to be me\./);
  assert.match(impersonation.markdown, /Meta's impersonation report form/);
  assert.match(impersonation.markdown, /never goes through True Convo/);
  assert.doesNotMatch(impersonation.markdown, /copyright report form/);

  const fake = buildReport(ledger, baseCase(ledger, {
    kind: 'fake-fundraiser',
    paymentService: { name: 'Northwind Pay', accountShownOnCopy: 'northwind.example/give-river' },
  }), { expectedHead });
  assert.match(fake.markdown, /These 2 videos are mine\. The account below reposted them and asks for donations\./);
  assert.match(fake.markdown, /Northwind Pay/);
  assert.match(fake.markdown, /ReportFraud\.ftc\.gov/);
  assert.match(fake.markdown, /IC3\.gov/);
  assert.ok(fake.checklist.some((item) => item.place === 'Northwind Pay'));
  assert.ok(fake.missing.some((item) => /Lantern talk has no post link/.test(item.message)));
  assert.ok(fake.missing.some((item) => /Lantern talk has no posted date/.test(item.message)));
  assert.match(fake.markdown, /not recorded/);

  for (const report of [stolen, impersonation, fake]) {
    assert.match(report.markdown, new RegExp(PLAIN_NOTE.replace(/[.]/g, '\\.')));
    assert.match(report.markdown, /The file is complete and in order/);
    assert.doesNotMatch(report.markdown, /tamper/i);
    assert.doesNotMatch(report.markdown, /\bproves\b/i);
    const paste = drafted(report.markdown);
    assert.doesNotMatch(paste, /https?:\/\//i);
    assert.doesNotMatch(paste, /facebook\.com|instagram\.com|meta\.com/i);
  }
  assert.match(drafted(fake.markdown), /ReportFraud\.ftc\.gov/);
  assert.match(drafted(fake.markdown), /IC3\.gov/);
});

test('a fake fundraiser without a payment service lists that gap', () => {
  const ledger = ledgerWithTwo();
  const report = buildReport(ledger, baseCase(ledger, { kind: 'fake-fundraiser' }), { expectedHead: headOf(ledger) });
  assert.match(report.markdown, /the payment service on the fake link/);
  assert.ok(report.missing.some((item) => item.field === 'paymentService'));
  assert.ok(report.checklist.some((item) => item.place === 'the payment service on the fake link'));
});

test('unknown originals and unknown anchors are refused', () => {
  const ledger = ledgerWithTwo();
  const expectedHead = headOf(ledger);
  assert.throws(
    () => buildReport(ledger, baseCase(ledger, { originalIds: ['orig-missing'] }), { expectedHead }),
    /No original orig-missing is in this ledger/,
  );
  assert.throws(
    () => buildReport(ledger, baseCase(ledger, {
      anchors: [{ kind: 'email', where: 'a friend', date: '2026-02-20', entryHash: 'a'.repeat(64) }],
    }), { expectedHead }),
    /No ledger entry has the proof code/,
  );
});

test('email, post and page anchors say only what each kind can show', () => {
  let ledger = ledgerWithTwo();
  const firstHash = ledger[0].entryHash;
  ledger = amendOriginal(ledger, ledger[0].originalId, { notes: 'posted that day' }, {
    recordedAt: '2026-02-20T00:00:00.000Z',
    expectedHead: headOf(ledger),
  });
  const expectedHead = headOf(ledger);
  const ids = ledger.filter((entry) => entry.kind === 'record').map((entry) => entry.originalId);

  const emailEarly = buildReport(ledger, baseCase(ledger, {
    anchors: [{ kind: 'email', where: 'Sam\'s inbox', date: '2026-01-16', entryHash: firstHash }],
    originalIds: ids,
  }), { expectedHead });
  const earlyLines = anchors(emailEarly.markdown).split('\n').filter((line) => line.startsWith('- '));
  assert.deepEqual(earlyLines, ['- Meadow morning (orig-0123456789ab)']);
  assert.match(anchors(emailEarly.markdown), /recorded at or before that code/);

  const emailLate = buildReport(ledger, baseCase(ledger, {
    anchors: [{ kind: 'email', where: 'Sam\'s inbox', date: '2026-02-21', entryHash: ledger[2].entryHash }],
    originalIds: ids,
  }), { expectedHead });
  const lateLines = anchors(emailLate.markdown).split('\n').filter((line) => line.startsWith('- '));
  assert.deepEqual(lateLines, [
    '- Meadow morning (orig-0123456789ab)',
    '- Lantern talk (orig-fedcba987654)',
  ]);

  const post = buildReport(ledger, baseCase(ledger, {
    anchors: [{ kind: 'post', where: 'the Townstage post', date: '2026-01-02', entryHash: firstHash }],
  }), { expectedHead });
  assert.match(anchors(post.markdown), /You say this code was in the post when it was first published on 2026-01-02\. Anyone checking will look at the post's edit history\./);
  assert.doesNotMatch(anchors(post.markdown), /recorded at or before/);

  const page = buildReport(ledger, baseCase(ledger, {
    anchors: [{ kind: 'page', where: 'my own site', date: '2026-03-01', entryHash: firstHash }],
  }), { expectedHead });
  assert.match(anchors(page.markdown), /Your page shows this proof code today\./);
  assert.doesNotMatch(anchors(page.markdown), /recorded at or before/);
  assert.doesNotMatch(anchors(page.markdown), /2026-03-01/);
});

test('a copy with no seen date is marked missing and the report is still built', () => {
  const ledger = ledgerWithTwo();
  const report = buildReport(ledger, baseCase(ledger, {
    copies: [{ url: 'https://social.example/fake', accountName: 'River Lane Official', whatItShows: 'A repost.' }],
  }), { expectedHead: headOf(ledger) });
  assert.ok(report.missing.some((item) => /seen date/.test(item.message)));
  assert.match(report.markdown, /Seen date not recorded/);
});
