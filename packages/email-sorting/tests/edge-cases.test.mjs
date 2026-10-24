// One test per choice in the README's "Edge cases" section (E1 to E22):
// cases the plan doesn't name, settled by the RFC 5322 (and RFC 3339, RFC
// 2919, RFC 3834) defaults.

import './guard.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  createScriptedClassifier, formatSummary, parseSettingsFile, sortMessages,
} from '../src/index.mjs';
import { answer, byId, input, mail, pileOf, settings } from './helpers.mjs';

function ask(messages, entries, config = settings()) {
  const classifier = createScriptedClassifier(entries);
  return sortMessages(input(messages), config, classifier).then(result => ({ result, classifier }));
}

const throwsFor = (...ids) => ids.map(id => ({ inbox: 'home', id, throws: true }));

test('E1. header names match without regard to case; same-name keys join in key order', async () => {
  const { result, classifier } = await ask([
    mail({ id: 'a', headers: { 'lIST-iD': '<one.example>' } }),
    mail({ id: 'b', headers: { 'references': '<x1@m.example>', 'REFERENCES': '<x2@m.example>' } }),
    mail({ id: 'c', headers: { 'Message-ID': '<x2@m.example>' } }),
  ], [...throwsFor('a'), { inbox: 'home', id: 'b', answer: answer('people') }]);
  assert.equal(byId(result, 'a').pile, 'newsletters');
  assert.equal(byId(result, 'b').conversation, 'id:x1@m.example');
  assert.equal(byId(result, 'c').conversation, 'id:x1@m.example');
  assert.equal(classifier.questions.find(q => q.ref.id === 'b').facts.isReply, true);
});

test('E2. a header whose values are all blank, or an empty list, counts as absent', async () => {
  const { result } = await ask([
    mail({ id: 'a', headers: { 'List-Id': '   ', 'List-Unsubscribe': [], 'Auto-Submitted': ['', ' '] } }),
  ], throwsFor('a'));
  assert.equal(byId(result, 'a').pile, 'other');
  assert.equal(byId(result, 'a').reason, 'Sorted without the model: no header fact applied');
});

test('E3. Message-ID: the first <...> token, comments ignored; only the first non-empty value counts', async () => {
  const { result } = await ask([
    mail({ id: 'a', inbox: 'home', headers: { 'Message-ID': '<Same@M.example> (sent by a phone)' } }),
    mail({ id: 'b', inbox: 'work', headers: { 'Message-ID': ['', '<same@m.example>', '<other@m.example>'] } }),
    mail({ id: 'c', inbox: 'work', headers: { 'Message-ID': '<>' } }),
    mail({ id: 'd', inbox: 'work', headers: { 'Message-ID': '<>' } }),
  ], [{ inbox: 'home', id: 'a', answer: answer('people') }, { inbox: 'work', id: 'c', answer: answer('people') }, { inbox: 'work', id: 'd', answer: answer('people') }]);
  assert.deepEqual(byId(result, 'a').inboxes, ['home', 'work']);
  // An empty Message-ID is no Message-ID: c and d are not merged.
  assert.equal(byId(result, 'c').conversation, 'msg:["work","c"]');
  assert.equal(byId(result, 'd').conversation, 'msg:["work","d"]');
});

test('E4. Auto-Submitted and Precedence: keyword before ";", any case, first non-empty value', async () => {
  const { result } = await ask([
    mail({ id: 'a', headers: { 'Auto-Submitted': 'NO; reason=test' } }),
    mail({ id: 'b', headers: { 'Auto-Submitted': ['', 'Auto-Notified'] } }),
    mail({ id: 'c', headers: { Precedence: ' LIST ' } }),
  ], throwsFor('a', 'b', 'c'));
  assert.equal(byId(result, 'a').pile, 'other');
  assert.equal(byId(result, 'b').reason, 'Sorted without the model: the message has Auto-Submitted: auto-notified');
  assert.equal(byId(result, 'c').reason, 'Sorted without the model: the message has Precedence: list');
});

test('E5. List-Id: the <...> part, or the whole value without one; lower case', async () => {
  const { result } = await ask([
    mail({ id: 'a', from: { address: 'a@club.example' }, headers: { 'List-Id': 'Club News <News.Club.example>' } }),
    mail({ id: 'b', from: { address: 'b@club.example' }, headers: { 'List-Id': '  news.club.EXAMPLE ' } }),
  ], [{ inbox: 'home', id: 'a', answer: answer('newsletters') }, { inbox: 'home', id: 'b', answer: answer('newsletters') }]);
  const groups = pileOf(result, 'newsletters').groups;
  assert.deepEqual(groups.map(g => [g.key, g.label, g.count]), [['list:news.club.example', 'news.club.example', 2]]);
});

test('E6. dates: lower-case t and z, leap seconds, fractions, and -00:00 are RFC 3339', async () => {
  const { result, classifier } = await ask([
    mail({ id: 'a', from: { address: 'x@a.example' }, date: '2026-10-14t09:00:00.5z', headers: { 'Message-ID': '<d1@m.example>' } }),
    mail({ id: 'b', from: { address: 'y@a.example' }, date: '2026-10-14T09:00:00.25-00:00', headers: { 'Message-ID': '<d2@m.example>', 'In-Reply-To': '<d1@m.example>' } }),
    mail({ id: 'c', from: { address: 'z@a.example' }, date: '2016-12-31T23:59:60Z' }),
  ], [{ inbox: 'home', id: 'a', answer: answer('people') }, { inbox: 'home', id: 'c', answer: answer('people') }]);
  assert.equal(byId(result, 'a').date, '2026-10-14t09:00:00.5z', 'returned as written');
  assert.deepEqual(classifier.questions.map(q => q.ref.id), ['a', 'c'], '.5 is newer than .25');
});

test('E6. a leap second sorts after :59 and before the next day\'s midnight, fractions included', async () => {
  const thread = (id, date, n) => mail({
    id, date, from: { address: `${id}@leap.example` },
    headers: { 'Message-ID': `<${id}@m.example>`, ...(n ? { References: '<root@m.example>' } : {}) },
  });
  const cases = [
    // [older, newer]: ids are chosen so the inbox/id tie-break would pick the older one.
    [['z-leap', '2016-12-31T23:59:60Z'], ['a-midnight', '2017-01-01T00:00:00Z']],
    [['z-leap', '2016-12-31T23:59:60.5Z'], ['a-midnight', '2017-01-01T00:00:00Z']],
    [['z-leap', '2016-12-31T23:59:60.999Z'], ['a-midnight', '2017-01-01T01:00:00+01:00']],
    [['z-59', '2016-12-31T23:59:59.9Z'], ['a-leap', '2016-12-31T23:59:60Z']],
  ];
  for (const [[oldId, oldDate], [newId, newDate]] of cases) {
    const { classifier } = await ask(
      [thread('root', '2016-12-31T12:00:00Z', false), thread(oldId, oldDate, true), thread(newId, newDate, true)],
      [{ inbox: 'home', id: newId, answer: answer('people') }],
    );
    assert.deepEqual(classifier.questions.map(q => q.ref.id), [newId], `${newDate} is newer than ${oldDate}`);
  }
});

test('E7. addresses need text on both sides of "@" and compare trimmed, in lower case', async () => {
  for (const address of ['@x.example', 'name@', ' @ ']) {
    await assert.rejects(ask([mail({ id: 'a', from: { address } })], []), /needs text before and after the "@"/);
  }
  const { result } = await ask([mail({ id: 'a', from: { address: ' Pat@Twin.Example ' } })], [],
    settings({ senderRules: [{ match: 'pat@twin.example', category: 'work' }] }));
  assert.equal(byId(result, 'a').pile, 'work');
});

test('E8. domain rules and work domains match the exact domain, not subdomains', async () => {
  const { result } = await ask([
    mail({ id: 'a', from: { address: 'x@shop.example' } }),
    mail({ id: 'b', from: { address: 'x@mail.shop.example' } }),
  ], throwsFor('b'), settings({ senderRules: [{ match: '@Shop.example', category: 'receipts' }], workDomains: ['SHOP.example'] }));
  assert.equal(byId(result, 'a').pile, 'receipts');
  assert.equal(byId(result, 'b').pile, 'other');
  assert.equal(byId(result, 'b').reason, 'Sorted without the model: no header fact applied');
});

test('E9. a tie on date picks the deciding message by inbox, then id', async () => {
  const at = '2026-10-14T10:00:00Z';
  const { classifier } = await ask([
    mail({ id: 'z', inbox: 'home', date: at, headers: { 'Message-ID': '<t1@m.example>' } }),
    mail({ id: 'b', inbox: 'home', date: '2026-10-14T06:00:00-04:00', headers: { 'Message-ID': '<t2@m.example>', References: '<t1@m.example>' } }),
    mail({ id: 'a', inbox: 'work', date: at, headers: { 'Message-ID': '<t3@m.example>', References: '<t1@m.example>' } }),
  ], [{ inbox: 'home', id: 'b', answer: answer('people') }]);
  assert.deepEqual(classifier.questions.map(q => q.ref), [{ inbox: 'home', id: 'b' }]);
});

test('E10. lengths count Unicode characters (code points), so an emoji is one character', async () => {
  await ask([mail({ id: '😀'.repeat(128), inbox: '🎉'.repeat(40) })], [{ inbox: '🎉'.repeat(40), id: '😀'.repeat(128), answer: answer('people') }]);
  await assert.rejects(ask([mail({ id: '😀'.repeat(129) })], []), /"id" is 129 characters; the limit is 128/);
});

test('E11. control characters are Unicode category Cc: C0, DEL and C1; carriage return is refused', async () => {
  for (const ch of ['\u0000', '\r', '\u007f', '\u0085', '\u009f']) {
    await assert.rejects(ask([mail({ id: 'a', snippet: `x${ch}y` })], []), /"snippet" holds a control character/);
  }
  // Format characters (right-to-left marks, zero-width joiners) are text, not control characters.
  await ask([mail({ id: 'a', snippet: 'a‏‍b‮' })], [{ inbox: 'home', id: 'a', answer: answer('people') }]);
});

test('E12. the 5 MB limit is 5 MiB of bytes, and it applies to the settings file too', () => {
  const big = `{"schemaVersion":1,"workDomains":["${'é'.repeat(2_700_000)}"]}`;
  assert.throws(() => parseSettingsFile(big), /The settings file is \d+ bytes; the limit is 5242880 bytes/);
});

test('E13. the summary escapes backslashes, carriage returns and Unicode line separators too', () => {
  const summary = formatSummary({
    schemaVersion: 1,
    piles: [{ category: 'people', count: 1, groups: [{ key: 'k', label: 'a\\n\u2028\u2029', count: 1, messages: [] }] }],
    problems: ['bad\nthing'],
  });
  assert.equal(summary, 'People: 1 from 1 sender\n  a\\\\n\\u2028\\u2029: 1\nProblems:\n  bad\\nthing\n');
});

test('E14. a blank sender name counts as no name for group labels', async () => {
  const { result } = await ask([
    mail({ id: 'a', from: { name: '  ', address: 'solo@x.example' } }),
    mail({ id: 'b', from: { name: '  ', address: 'solo@x.example' } }),
  ], [{ inbox: 'home', id: 'a', answer: answer('people') }, { inbox: 'home', id: 'b', answer: answer('people') }]);
  assert.equal(pileOf(result, 'people').groups[0].label, 'solo@x.example');
});

test('E15. an answer that arrives after the timeout is ignored, and a late failure is harmless', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release;
  const classifier = {
    classify: () => new Promise((resolve, reject) => { release = { resolve, reject }; }),
  };
  const running = sortMessages(input([mail()]), settings({ timeoutMs: 1000 }), classifier);
  for (let i = 0; i < 20 && !release; i += 1) await new Promise(r => setImmediate(r));
  t.mock.timers.tick(1000);
  const result = await running;
  release.resolve(answer('work'));
  release.reject(new Error('late'));
  assert.equal(byId(result, 'm-1').decidedBy, 'fallback');
});

test('E16. a supplied settings value of null, a list, text or a number is refused; only undefined means defaults', async () => {
  for (const bad of [null, [], 'settings', 0]) {
    await assert.rejects(sortMessages(input([mail()]), bad, createScriptedClassifier([])),
      /^EmailSortError: Settings: the settings file must be a JSON object\.$/);
  }
  for (const text of ['null', '[]', '"x"', '1']) {
    assert.throws(() => parseSettingsFile(text), /the settings file must be a JSON object/);
  }
  const result = await sortMessages(input([mail()]), undefined, createScriptedClassifier([{ inbox: 'home', id: 'm-1', answer: answer('people') }]));
  assert.equal(byId(result, 'm-1').pile, 'people');
});

test('E17. a rule shows in reasons as one trimmed line of at most 80 characters', async () => {
  const padded = `@ \t Shop.example\n${' '.repeat(10_000)}\t`;
  const long = `${'a'.repeat(200)}@long.example`;
  const { result, classifier } = await ask([
    mail({ id: 'a', from: { address: 'x@shop.example' } }),
    mail({ id: 'b', from: { address: 'y@shop.example' } }),
    mail({ id: 'c', from: { address: long } }),
  ], [], settings({ senderRules: [{ match: padded, category: 'receipts' }, { match: ` ${long}\t`, category: 'alerts' }] }));
  assert.equal(classifier.questions.length, 0);
  for (const id of ['a', 'b']) {
    assert.equal(byId(result, id).pile, 'receipts');
    assert.equal(byId(result, id).reason, 'Your rule: mail from @Shop.example goes to Receipts');
  }
  assert.equal(byId(result, 'c').pile, 'alerts');
  assert.equal(byId(result, 'c').reason, `Your rule: mail from ${'a'.repeat(79)}… goes to Alerts`);
  for (const id of ['a', 'b', 'c']) assert.doesNotMatch(byId(result, id).reason, /[\n\t\u2028\u2029]|\s{2}/);
});

test('E19. every reason is one trimmed line of at most 160 characters, whatever text reaches it', async () => {
  // Line feed, tab, U+2028, U+2029 and no-break space: the white space mail
  // text and settings may hold (other control characters are refused).
  const mess = ' \n\t\u2028\u2029\u00a0 ';
  const longDomain = `ctl\n\t\u2028${'d'.repeat(200)}.example`;
  const messages = [
    mail({ id: 'rule', from: { address: 'x@ctl.example' } }),
    mail({ id: 'auto', headers: { 'Auto-Submitted': `auto-${mess}generated${mess}${'g'.repeat(300)}` } }),
    mail({ id: 'prec', headers: { Precedence: `${mess}bulk${mess}` } }),
    mail({ id: 'work', from: { address: `x@${longDomain}` } }),
    mail({ id: 'model' }),
    mail({ id: 'unsure' }),
    mail({ id: 'mine', from: { address: 'me@quillhome.example' } }),
  ];
  const config = settings({
    myAddresses: ['me@quillhome.example'],
    workDomains: [longDomain],
    senderRules: [{ match: `@${mess}ctl.example${mess}${' '.repeat(1000)}`, category: 'receipts' }],
  });
  const { result } = await ask(messages, [
    ...throwsFor('auto', 'prec', 'work'),
    { inbox: 'home', id: 'model', answer: answer('people', 0.9, `${mess}a${mess}b${mess}${'c'.repeat(400)}`) },
    { inbox: 'home', id: 'unsure', answer: answer('work', 0.1, `x${mess}y`) },
  ], config);
  const reasons = Object.fromEntries(messages.map(({ id }) => [id, byId(result, id).reason]));
  assert.deepEqual(Object.fromEntries(messages.map(({ id }) => [id, byId(result, id).decidedBy])), {
    rule: 'rule', auto: 'fallback', prec: 'fallback', work: 'fallback', model: 'model', unsure: 'not-sure', mine: 'owner-only',
  });
  for (const [id, reason] of Object.entries(reasons)) {
    assert.ok([...reason].length <= 160, `${id}: ${reason}`);
    assert.doesNotMatch(reason, /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u00a0]|\s{2}|^\s|\s$/, id);
    assert.doesNotMatch(reason, /[^\S ]/, id);
  }
  assert.equal(reasons.rule, 'Your rule: mail from @ctl.example goes to Receipts');
  assert.equal(reasons.auto, `Sorted without the model: the message has Auto-Submitted: auto- generated ${'g'.repeat(63)}…`);
  assert.equal(reasons.prec, 'Sorted without the model: the message has Precedence: bulk');
  assert.equal(reasons.work, `Sorted without the model: the sender's domain ctl ${'d'.repeat(75)}… is a work domain`);
  assert.equal(reasons.model, `a b ${'c'.repeat(155)}…`);
  for (const line of result.problems) assert.doesNotMatch(line, /[^\S ]/);
});

test('E20. header names match exactly apart from ASCII case; a padded name is an unknown header', async () => {
  const padded = {
    ' List-Id ': '<news.example>', 'List-Unsubscribe ': '<https://u.example/x>', ' Auto-Submitted': 'auto-generated',
    'Precedence\t': 'bulk', ' Message-ID ': '<same@m.example>', ' In-Reply-To': '<root@m.example>', 'References ': '<root@m.example>',
  };
  const { result, classifier } = await ask([
    mail({ id: 'a', headers: padded }),
    mail({ id: 'b', headers: padded }),
    mail({ id: 'c', headers: { 'LIST-id': '<news.example>' } }),
  ], throwsFor('a', 'b', 'c'));
  for (const id of ['a', 'b']) {
    assert.equal(byId(result, id).pile, 'other', id);
    assert.equal(byId(result, id).reason, 'Sorted without the model: no header fact applied');
    assert.equal(byId(result, id).conversation, `msg:${JSON.stringify(['home', id])}`, 'no Message-ID, no merge, no thread');
  }
  const { facts } = classifier.questions.find(q => q.ref.id === 'a');
  assert.deepEqual([facts.hasListId, facts.hasListUnsubscribe, facts.autoSubmitted, facts.precedence, facts.isReply],
    [false, false, null, null, false]);
  assert.equal(byId(result, 'c').pile, 'newsletters', 'letter case alone still matches');
});

test('E21. an ID over 200 characters becomes SHA256: plus its hash: short, distinct and never a real ID', async () => {
  const hash = id => `SHA256:${createHash('sha256').update(Buffer.from(id, 'utf16le')).digest('hex')}`;
  const giant = `${'0'.repeat(100_000)}@m.example`;
  const longA = `${'a'.repeat(191)}@m.example`;
  const longB = `${'a'.repeat(190)}b@m.example`;
  const edge = `${'e'.repeat(190)}@m.example`;
  const list = `${'l'.repeat(300)}.example`;
  const thread = Array.from({ length: 20 }, (_, i) => mail({
    id: `t${i}`, headers: { 'Message-ID': `<t${i}@m.example>`, References: `<${giant}> <t0@m.example>` },
  }));
  const { result } = await ask([
    ...thread,
    mail({ id: 'a1', headers: { 'Message-ID': `<${longA}>` } }),
    mail({ id: 'a2', headers: { 'In-Reply-To': `<${longA.toUpperCase()}>` } }),
    mail({ id: 'b', headers: { 'Message-ID': `<${longB}>` } }),
    mail({ id: 'fake', headers: { 'Message-ID': `<${hash(longA)}>` } }),
    mail({ id: 'edge', headers: { 'Message-ID': `<${edge}>` } }),
    mail({ id: 'news', headers: { 'Message-ID': '<news@m.example>', 'List-Id': `<${list}>` } }),
  ], throwsFor('t0', 'a1', 'b', 'fake', 'edge', 'news'));
  for (const { id } of thread) assert.equal(byId(result, id).conversation, `id:${hash(giant)}`);
  assert.equal(byId(result, 'a1').conversation, `id:${hash(longA)}`);
  assert.equal(byId(result, 'a2').conversation, `id:${hash(longA)}`, 'the same long ID still links, case aside');
  assert.equal(byId(result, 'b').conversation, `id:${hash(longB)}`, 'a different long ID stays apart');
  assert.equal(byId(result, 'fake').conversation, `id:${hash(longA).toLowerCase()}`, 'a real ID never equals a hash');
  assert.equal(byId(result, 'edge').conversation, `id:${edge}`, 'exactly 200 characters is kept as written');
  assert.equal(pileOf(result, 'newsletters').groups[0].key, `list:${hash(list)}`);
  assert.ok(JSON.stringify(result).length < 20_000, 'the giant token is never repeated');
});

test('E22. a leap second is accepted only at 23:59:60 UTC on the last day of a month, after the offset', async () => {
  for (const date of ['2016-06-30T23:59:60Z', '2016-12-31t23:59:60.5z', '2017-01-01T00:59:60+01:00',
    '2016-12-31T18:59:60-05:00', '2016-02-29T23:59:60Z', '2015-02-28T23:59:60-00:00']) {
    const { result } = await ask([mail({ date })], [{ inbox: 'home', id: 'm-1', answer: answer('people') }]);
    assert.equal(byId(result, 'm-1').date, date);
  }
  for (const date of ['2026-10-14T09:12:60Z', '2016-12-30T23:59:60Z', '2016-12-31T23:58:60Z', '2016-12-31T23:59:60+01:00',
    '2016-12-31T22:59:60+01:00', '2017-01-01T00:59:60Z', '2016-02-28T23:59:60Z', '2016-12-31T23:59:61Z']) {
    await assert.rejects(ask([mail({ date })], []), /"date" must be an RFC 3339 date-time/, date);
  }
});
