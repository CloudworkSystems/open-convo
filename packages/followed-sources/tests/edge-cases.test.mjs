// One test per choice listed under "Edge cases" in the README.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run, createScriptedDrafter, createKeywordDrafter, validateSources, InputError } from '../src/index.mjs';
import { SOURCES, item, items, lesson, ok } from './helpers.mjs';

const go = (list, answers, extra = {}) => {
  const drafter = createScriptedDrafter(answers);
  return run({ sources: SOURCES, items: items(...list), drafter, timeoutMs: 50, ...extra }).then(result => ({ result, drafter }));
};

test('an item listed twice in one run is drafted once', async () => {
  const { result, drafter } = await go([item('a', '2026-10-12T00:00:00Z'), item('a', '2026-10-12T00:00:00Z')], { 'news/a': ok(lesson('Once')) });
  assert.equal(drafter.calls.length, 1);
  assert.equal(result.cards.length, 1);
  assert.equal(result.skipped['already-reported'], 1);
});

test('an item from an unknown source is skipped with a problem line', async () => {
  const { result, drafter } = await go([item('a', '2026-10-12T00:00:00Z', { source: 'ghost' })], {});
  assert.equal(drafter.calls.length, 0);
  assert.equal(result.skipped['unknown-source'], 1);
  assert.match(result.problems[0], /^ghost\/a "Issue a": its source isn't in the sources file/);
});

test('a source id listed twice refuses the sources file', () => {
  assert.throws(
    () => validateSources({ schemaVersion: 1, sources: [{ id: 's', name: 'A', kind: 'email' }, { id: 's', name: 'B', kind: 'links' }] }),
    error => error instanceof InputError && /listed twice/.test(error.message),
  );
});

test('a card repeating an earlier card from the same answer is dropped', async () => {
  const { result } = await go([item('a', '2026-10-12T00:00:00Z')], { 'news/a': ok(lesson('Same'), lesson('same!')) });
  assert.equal(result.cards.length, 1);
  assert.match(result.problems[0], /card 2 repeats an earlier card/);
});

test('an item already reported carries the checkpoint forward', async () => {
  const state = { schemaVersion: 1, checkpoints: {}, reported: [{ source: 'news', itemId: 'b' }], failures: [] };
  const { result } = await go([item('a', '2026-10-12T00:00:00Z'), item('b', '2026-10-13T00:00:00Z')], { 'news/a': ok() }, { state });
  assert.equal(result.state.checkpoints.news, '2026-10-13T00:00:00Z');
});

test('state entries for items not in this run are kept', async () => {
  const state = {
    schemaVersion: 1,
    checkpoints: { links: '2026-09-01T00:00:00Z' },
    reported: [{ source: 'links', itemId: 'old' }],
    failures: [{ source: 'links', itemId: 'stuck', runs: 3, gaveUp: true }],
  };
  const { result } = await go([], {}, { state });
  assert.deepEqual(result.state, { schemaVersion: 1, ...state });
});

test('the drafter\'s own red flags are kept beside the engine\'s', async () => {
  const { result } = await go([item('a', '2026-10-12T00:00:00Z')], { 'news/a': ok({ kind: 'red-flag', title: 'Asks for money', body: 'It asks readers to wire a deposit.' }) });
  assert.deepEqual(result.cards.map(card => [card.kind, card.decidedBy]), [['red-flag', 'drafter']]);
});

test('the keyword drafter returns at most three lessons and nothing for plain text', async () => {
  const drafter = createKeywordDrafter();
  const question = text => ({ ref: { source: 'news', itemId: 'a' }, source: { name: 'Example', kind: 'email', topics: [] }, item: { title: 'T', date: '2026-10-12', text }, kinds: {} });
  const many = await drafter.draft(question('Always a. Never b. Check c. Avoid d.'));
  assert.equal(many.cards.length, 3);
  assert.deepEqual(await drafter.draft(question('Nothing to see here.')), { cards: [] });
});

test('run refuses a missing drafter or a bad timeout', async () => {
  await assert.rejects(run({ sources: SOURCES, items: items() }), /drafter/);
  await assert.rejects(run({ sources: SOURCES, items: items(), drafter: createScriptedDrafter(), timeoutMs: 0 }), /timeoutMs/);
});

test('the keyword drafter stays fast on long runs of punctuation', async () => {
  const drafter = createKeywordDrafter();
  const text = `Always check this${'!'.repeat(200000)} and never${'?'.repeat(200000)}`;
  const started = Date.now();
  const answer = await drafter.draft({ ref: { source: 'news', itemId: 'a' }, source: { name: 'Example', kind: 'email', topics: [] }, item: { title: 'T', date: '2026-10-12', text }, kinds: {} });
  assert.ok(Date.now() - started < 1000);
  assert.equal(answer.cards.length, 2);
});

test('links are found in their other common forms, and ordinary words stay', async () => {
  const { stripUrls } = await import('../src/text.mjs');
  assert.equal(stripUrls('Visit evil.com, or https:\\\\evil.com\\x, or evil．example／path today.'), 'Visit or or today.');
  assert.equal(stripUrls('Try evil.example or evil.shop or evil.example?x=1 or evil.example#top now.'), 'Try or or or now.');
  assert.equal(stripUrls('See //evil.com/a, evil。com, evil.com:8080 and someone@evil.example now.'), 'See and now.');
  assert.equal(stripUrls('Upgrade Node.js, e.g. today; the data: it shows a 3.5 ratio.'), 'Upgrade Node.js, e.g. today; the data: it shows a 3.5 ratio.');
});

test('link and text cleaning stay fast on long hostile input', async () => {
  const { stripUrls, clean, safeText } = await import('../src/text.mjs');
  for (const text of ['a.'.repeat(50000), `${'a'.repeat(30)}.`.repeat(3000), '('.repeat(100000), `x${'.,'.repeat(50000)}y`, `\u001b]${'a'.repeat(100000)}`]) {
    const started = Date.now();
    stripUrls(text);
    clean(text);
    safeText(text);
    assert.ok(Date.now() - started < 1000, text.slice(0, 10));
  }
});

test('a datetime with no time zone refuses the items file', async () => {
  const { validateItems } = await import('../src/index.mjs');
  assert.throws(() => validateItems(items(item('a', '2026-10-12T00:00'))), /a time needs Z or an offset/);
  assert.doesNotThrow(() => validateItems(items(item('a', '2026-10-12'), item('b', '2026-10-12T00:00-04:00'))));
});

test('an instruction phrase split across the title and text is not flagged', async () => {
  const { result } = await go([item('a', '2026-10-12T00:00:00Z', { title: 'What we chose to ignore', text: 'Previous results were mixed.' })], { 'news/a': ok() });
  assert.deepEqual(result.cards, []);
});
