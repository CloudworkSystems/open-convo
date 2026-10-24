import './guard.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { createScriptedClassifier, parseMessagesFile, sortMessages } from '../src/index.mjs';
import { answer, input, mail, runCommand, settings } from './helpers.mjs';

function never() {
  return createScriptedClassifier([]);
}

async function refused(messages, pattern) {
  const classifier = never();
  await assert.rejects(sortMessages(input(messages), settings(), classifier), (error) => {
    assert.equal(error.name, 'EmailSortError');
    assert.match(error.message, pattern);
    return true;
  });
  assert.equal(classifier.questions.length, 0, 'a refusal sorts nothing');
}

test('12. an unknown field is refused, naming the field, and its contents appear in no output', async () => {
  const marker = 'MARKER-7f3a-unknown-field';
  const message = { ...mail({ id: 'm-4' }), trackingPixel: marker };
  const classifier = never();
  let caught;
  await sortMessages(input([mail({ id: 'ok' }), message]), settings(), classifier).catch((e) => { caught = e; });
  assert.ok(caught, 'refused');
  assert.match(caught.message, /^Message 2 \(id "m-4"\): the message has a field this version doesn't accept: "trackingPixel"\.$/);
  assert.ok(!caught.message.includes(marker));
  assert.ok(!(caught.stack || '').includes(marker));

  const dir = mkdtempSync(path.join(tmpdir(), 'email-sorting-'));
  try {
    const file = path.join(dir, 'messages.json');
    writeFileSync(file, JSON.stringify(input([message])));
    for (const args of [['--messages', file], ['--messages', file, '--json']]) {
      const run = await runCommand(main, args);
      assert.equal(run.code, 1);
      assert.equal(run.stdout, '');
      assert.ok(!run.stderr.includes(marker));
      assert.match(run.stderr, /trackingPixel/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('12. missing fields, bad dates and bad addresses are refused, naming the message and field', async () => {
  const noSubject = mail({ id: 'm-2' });
  delete noSubject.subject;
  await refused([noSubject], /^Message 1 \(id "m-2"\): the message is missing the required field "subject"\.$/);
  const noHeaders = mail();
  delete noHeaders.headers;
  await refused([noHeaders], /missing the required field "headers"/);

  for (const date of ['2026-10-14', '2026-10-14T09:12:00', '2026-10-14 09:12:00Z', '2026-02-30T09:00:00Z',
    '2026-10-14T24:00:00Z', '2026-10-14T09:12:00+0400', 'Tue, 14 Oct 2026 09:12:00 -0400', 1760440320000]) {
    await refused([mail({ id: 'd-1', date })], /^Message 1 \(id "d-1"\): "date" must be an RFC 3339 date-time with an offset or Z/);
  }
  await refused([mail({ id: 'a-1', from: { address: 'no-at-sign.example' } })], /^Message 1 \(id "a-1"\): "from\.address" must hold exactly one "@"\.$/);
  await refused([mail({ id: 'a-2', from: { address: 'two@@x.example' } })], /"from\.address" must hold exactly one "@"/);
  await refused([mail({ id: 'a-3', to: [{ address: 'ok@x.example' }, { address: 'nope' }] })], /"to\[1\]\.address" must hold exactly one "@"/);
  await refused([mail({ id: 'a-4', from: { name: 'No address' } })], /"from" is missing the required field "address"/);
});

test('12. a repeated id in one inbox is refused; the same id in two inboxes is accepted', async () => {
  await refused([mail({ id: 'dup' }), mail({ id: 'dup' })], /^Message 2 \(id "dup"\): the id "dup" appears more than once in inbox "home"\.$/);
  const classifier = createScriptedClassifier([
    { inbox: 'home', id: 'dup', answer: answer('people') },
    { inbox: 'work', id: 'dup', answer: answer('work') },
  ]);
  const result = await sortMessages(input([mail({ id: 'dup' }), mail({ id: 'dup', inbox: 'work' })]), settings(), classifier);
  assert.equal(result.piles.reduce((n, p) => n + p.count, 0), 2);
});

test('12. control characters are refused in text fields, naming the field; line feed and tab are fine', async () => {
  await refused([mail({ id: 'c-1', subject: 'Hello\u0007there' })], /^Message 1 \(id "c-1"\): "subject" holds a control character/);
  await refused([mail({ id: 'c-2', subject: 'Hello\r\nthere' })], /"subject" holds a control character/);
  await refused([mail({ id: 'c-3', snippet: 'x\u0000' })], /"snippet" holds a control character/);
  await refused([mail({ id: 'c-4', from: { name: 'A\u009bB', address: 'a@b.example' } })], /"from\.name" holds a control character/);
  await refused([mail({ id: 'c-5', headers: { 'List-Id': '<x\u001b@y>' } })], /"headers\.List-Id" holds a control character/);
  const ok = createScriptedClassifier([{ inbox: 'home', id: 'c-6', answer: answer('people') }]);
  await sortMessages(input([mail({ id: 'c-6', subject: 'Line\none\ttab' })]), settings(), ok);
});

test('12. lengths: id, inbox, subject and snippet limits', async () => {
  await refused([mail({ id: '' })], /^Message 1: "id" must have at least 1 character\.$/);
  await refused([mail({ id: 'i'.repeat(129) })], /^Message 1: "id" is 129 characters; the limit is 128\.$/);
  await refused([mail({ id: 'm', inbox: '' })], /"inbox" must have at least 1 character/);
  await refused([mail({ id: 'm', inbox: 'b'.repeat(41) })], /"inbox" is 41 characters; the limit is 40/);
  await refused([mail({ id: 'm', subject: 's'.repeat(1001) })], /"subject" is 1001 characters; the limit is 1000/);
  await refused([mail({ id: 'm', snippet: 's'.repeat(2001) })], /"snippet" is 2001 characters; the limit is 2000/);
  const ok = createScriptedClassifier([{ inbox: 'b'.repeat(40), id: 'i'.repeat(128), answer: answer('people') }]);
  await sortMessages(input([mail({ id: 'i'.repeat(128), inbox: 'b'.repeat(40), subject: '😀'.repeat(1000), snippet: 's'.repeat(2000) })]), settings(), ok);
});

test('12. an oversized file and more than 10,000 messages are refused with a plain message', async () => {
  const big = ' '.repeat(5 * 1024 * 1024 + 1);
  assert.throws(() => parseMessagesFile(big), /^EmailSortError: The messages file is 5242881 bytes; the limit is 5242880 bytes \(5 MB\)\.$/);
  const dir = mkdtempSync(path.join(tmpdir(), 'email-sorting-'));
  try {
    const file = path.join(dir, 'big.json');
    writeFileSync(file, big);
    const run = await runCommand(main, ['--messages', file]);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /The messages file is 5242881 bytes; the limit is 5242880 bytes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const many = Array.from({ length: 10_001 }, (_, i) => ({ id: `m${i}` }));
  await assert.rejects(sortMessages(input(many), settings(), never()), /^EmailSortError: The messages file has 10001 messages; the limit is 10000\.$/);
});

test('12. the file itself: schemaVersion, the messages list and unknown top-level fields', async () => {
  await assert.rejects(sortMessages({ schemaVersion: 2, messages: [] }, settings(), never()), /schemaVersion/);
  await assert.rejects(sortMessages({ schemaVersion: 1 }, settings(), never()), /"messages" list/);
  await assert.rejects(sortMessages({ schemaVersion: 1, messages: [], extra: 1 }, settings(), never()), /field this version doesn't accept: "extra"/);
  await assert.rejects(sortMessages([], settings(), never()), /must be a JSON object/);
  assert.throws(() => parseMessagesFile('{"schemaVersion":1,'), /isn't valid JSON/);
});

test('12. settings: unknown fields, bad addresses, bad timeouts', async () => {
  const run = s => sortMessages(input([mail()]), s, never());
  await assert.rejects(run({ schemaVersion: 1, vipList: [] }), /^EmailSortError: Settings: a field this version doesn't accept: "vipList"\.$/);
  await assert.rejects(run(settings({ myAddresses: ['me.example'] })), /"myAddresses" item 1 must hold exactly one "@"/);
  await assert.rejects(run(settings({ workDomains: ['@x.example'] })), /"workDomains" item 1 must be a domain without "@"/);
  await assert.rejects(run(settings({ senderRules: [{ match: 'nobody', category: 'people' }] })), /sender rule 1's "match" must hold exactly one "@"/);
  await assert.rejects(run(settings({ senderRules: [{ match: '@x.example', category: 'people', note: 1 }] })), /sender rule 1 has a field/);
  for (const timeoutMs of [999, 120_001, 1500.5, '30000']) {
    await assert.rejects(run(settings({ timeoutMs })), /"timeoutMs" must be a whole number from 1000 to 120000/);
  }
  await assert.rejects(run({}), /schemaVersion/);
});
