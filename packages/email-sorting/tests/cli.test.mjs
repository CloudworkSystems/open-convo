import './guard.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';
import { createKeywordClassifier } from '../src/index.mjs';
import { FIXTURE, FIXTURE_SETTINGS, runCommand } from './helpers.mjs';

test('the command needs --messages and refuses unknown or repeated options', async () => {
  for (const argv of [[], ['--json'], ['--messages'], ['--messages', FIXTURE, '--colour'],
    ['--messages', FIXTURE, '--messages', FIXTURE], ['--messages', FIXTURE, '--settings', '--json']]) {
    const run = await runCommand(main, argv);
    assert.equal(run.code, 1, argv.join(' '));
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^email-sorting: .+\nUsage: node src\/sort\.mjs --messages/);
  }
});

test('the command reports a missing file plainly', async () => {
  const run = await runCommand(main, ['--messages', fileURLToPath(new URL('./no-such-file.json', import.meta.url))]);
  assert.equal(run.code, 1);
  assert.match(run.stderr, /^email-sorting: Couldn't open the messages file\./);
});

test('the command refuses a settings file with a rule naming an unknown pile and prints no result', async () => {
  const run = await runCommand(main, ['--messages', FIXTURE, '--settings', fileURLToPath(new URL('./fixtures/bad-rule-settings.json', import.meta.url))]);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /sender rule 1 names the pile "vip"/);
});

test('the command runs without settings, using the keyword classifier', async () => {
  const run = await runCommand(main, ['--messages', FIXTURE]);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /^People: \d+/);
  assert.ok(run.stdout.endsWith('\n'));
});

test('the keyword classifier is deterministic and answers only from the fixed list', async () => {
  const classifier = createKeywordClassifier();
  const base = {
    ref: { inbox: 'home', id: 'k' }, from: { address: 'a@b.example' }, to: [], date: '2026-10-14T09:12:00Z', messageCount: 1, categories: [],
    facts: { hasListId: false, hasListUnsubscribe: false, autoSubmitted: null, precedence: null, isReply: false, senderIsWorkDomain: false },
  };
  const cases = [
    [{ subject: 'Your verification code', snippet: '' }, 'alerts'],
    [{ subject: 'Your package has shipped', snippet: '' }, 'alerts'],
    [{ subject: 'Invoice 42', snippet: '' }, 'receipts'],
    [{ subject: 'Bordering on silly', snippet: '' }, 'people'],
    [{ subject: 'Hi', snippet: '', facts: { ...base.facts, hasListId: true } }, 'newsletters'],
    [{ subject: 'Hi', snippet: '', facts: { ...base.facts, senderIsWorkDomain: true } }, 'work'],
  ];
  for (const [fields, category] of cases) {
    const first = await classifier.classify({ ...base, ...fields });
    assert.equal(first.category, category, fields.subject);
    assert.deepEqual(await classifier.classify({ ...base, ...fields }), first);
  }
  const plain = await classifier.classify({ ...base, subject: 'Hi', snippet: '' });
  assert.ok(plain.confidence < 0.6, 'no keyword: below the default floor, so "Not sure"');
});

test('the sample settings in fixtures/ are valid and used by the expected output', () => {
  const text = readFileSync(FIXTURE_SETTINGS, 'utf8');
  assert.match(text, /orders@marrowlane\.example/);
});
