import './guard.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createKeywordClassifier, createScriptedClassifier, formatSummary, sortMessages,
} from '../src/index.mjs';
import { FIXTURE, FIXTURE_SETTINGS, answer, byId, input, mail, readJson, settings } from './helpers.mjs';

// ------------------------------------------------------------------ test 13
test('13. hostile but valid text comes back unchanged in the JSON and on one line in the summary', async () => {
  const hostile = [
    'He said "hi" & left',
    '<script>alert(1)</script>',
    '&amp; &lt;b&gt;',
    'Party 🎉🎂 time',
    'שלום עולם مرحبا ‮evil‬',
    `Long ${'w'.repeat(990)}`,
    'Two\nlines\tand tab',
    'back\\slash and \u2028 separator',
  ];
  const messages = hostile.map((text, i) => mail({
    id: `x-${i}`, subject: text, snippet: text,
    from: { name: text.slice(0, 200), address: `sender${i}@hostile.example` },
  }));
  const classifier = createScriptedClassifier(messages.map(m => ({ inbox: 'home', id: m.id, answer: answer('people') })));
  const result = await sortMessages(input(messages), settings(), classifier);
  hostile.forEach((text, i) => {
    const out = byId(result, `x-${i}`);
    assert.equal(out.subject, text);
    assert.equal(out.from.name, text.slice(0, 200));
  });
  const json = JSON.stringify(result);
  assert.deepEqual(JSON.parse(json), result);

  const summary = formatSummary(result);
  const lines = summary.split('\n');
  assert.equal(lines.at(-1), '', 'ends with one newline');
  // 6 pile lines + 8 group lines; every group line is one line of text.
  assert.equal(lines.length - 1, 6 + hostile.length);
  assert.ok(summary.includes('  Two\\nlines\\tand tab: 1'));
  assert.ok(summary.includes('  back\\\\slash and \\u2028 separator: 1'));
  assert.ok(summary.includes('  <script>alert(1)</script>: 1'));
  assert.ok(summary.includes('Party 🎉🎂 time'));
  for (const line of lines) assert.doesNotMatch(line, /[\r\u2028\u2029]/);
});

// ------------------------------------------------------------------ test 14
test('14. the same input twice gives byte-identical JSON, and shuffling gives the same result', async () => {
  const mailbox = readJson(FIXTURE);
  const config = readJson(FIXTURE_SETTINGS);
  const first = JSON.stringify(await sortMessages(mailbox, config, createKeywordClassifier()));
  const second = JSON.stringify(await sortMessages(mailbox, config, createKeywordClassifier()));
  assert.equal(first, second);
  const reversed = { ...mailbox, messages: [...mailbox.messages].reverse() };
  const interleaved = { ...mailbox, messages: mailbox.messages.filter((_, i) => i % 2).concat(mailbox.messages.filter((_, i) => !(i % 2))) };
  for (const shuffled of [reversed, interleaved]) {
    assert.equal(JSON.stringify(await sortMessages(shuffled, config, createKeywordClassifier())), first);
  }
});

test('14. the engine reads no clock and no local time', async (t) => {
  const RealDate = globalThis.Date;
  const boom = (name) => () => { throw new Error(`clock read: ${name}`); };
  const localMethods = [
    'getDate', 'getDay', 'getFullYear', 'getHours', 'getMilliseconds', 'getMinutes', 'getMonth', 'getSeconds',
    'getTime', 'getTimezoneOffset', 'getYear', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString',
    'toString', 'toDateString', 'toTimeString', 'valueOf',
  ];
  const saved = Object.fromEntries(localMethods.map(name => [name, RealDate.prototype[name]]));
  const savedNow = RealDate.now;
  function NoClockDate(...args) {
    if (args.length === 0) throw new Error('clock read: new Date()');
    return new.target ? Reflect.construct(RealDate, args, new.target) : RealDate(...args);
  }
  NoClockDate.prototype = RealDate.prototype;
  NoClockDate.UTC = RealDate.UTC;
  NoClockDate.parse = RealDate.parse;
  NoClockDate.now = boom('Date.now');
  t.after(() => {
    globalThis.Date = RealDate;
    RealDate.now = savedNow;
    for (const name of localMethods) RealDate.prototype[name] = saved[name];
  });
  globalThis.Date = NoClockDate;
  RealDate.now = boom('Date.now');
  for (const name of localMethods) RealDate.prototype[name] = boom(`Date.prototype.${name}`);

  assert.throws(() => Date.now(), /clock read/);
  assert.throws(() => new Date(), /clock read/);
  assert.throws(() => new RealDate(0).getHours(), /clock read/);

  const result = await sortMessages(readJson(FIXTURE), readJson(FIXTURE_SETTINGS), createKeywordClassifier());
  const summary = formatSummary(result);
  globalThis.Date = RealDate;
  RealDate.now = savedNow;
  for (const name of localMethods) RealDate.prototype[name] = saved[name];
  assert.equal(result.piles.reduce((n, p) => n + p.count, 0), 18);
  assert.ok(summary.startsWith('People: '));
});
