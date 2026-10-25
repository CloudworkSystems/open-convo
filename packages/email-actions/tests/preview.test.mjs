import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { readFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import {
  COMMON_MAIL_DOMAINS, canonicalActionForm, formatSummary, parseJsonFile, previewActions,
} from '../src/index.mjs';
import { main } from '../src/preview.mjs';
import { clearNetworkCalls, networkCalls } from './network-guard.mjs';
import { action, mail, messages, request, requests, resultMessage } from './helpers.mjs';

const fixtureMessages = JSON.parse(readFileSync(new URL('../fixtures/mailbox.json', import.meta.url), 'utf8'));
const fixtureRequests = JSON.parse(readFileSync(new URL('../fixtures/requests.json', import.meta.url), 'utf8'));

function headerMail(id, sender, value, post, fields = {}) {
  return mail({
    id,
    from: { name: sender, address: `${id}@mailings.example` },
    headers: {
      'Message-ID': `<${id}@mailings.example>`,
      'List-Unsubscribe': value,
      ...(post === undefined ? {} : { 'List-Unsubscribe-Post': post }),
    },
    pile: 'newsletters',
    ...fields,
  });
}

function oneRequest(actionName, target) {
  return requests([request(actionName, target)]);
}

function planFor(message, actionName = 'unsubscribe') {
  return previewActions(messages([message]), oneRequest(actionName, { messages: [{ inbox: message.inbox, id: message.id }] }));
}

function withoutMatchedBy(actions) {
  return actions.map(value => ({
    ...value,
    groups: value.groups.map(group => ({
      ...group,
      messages: group.messages.map(({ matchedBy: _matchedBy, ...message }) => message),
    })),
  }));
}

test('1. complete invented fixtures match a saved exact plan shape', () => {
  const plan = previewActions(fixtureMessages, fixtureRequests);
  const expected = JSON.parse(readFileSync(new URL('./expected/fixture-plan.json', import.meta.url), 'utf8'));
  assert.deepEqual(plan, expected);
  const recomputed = createHash('sha256')
    .update(JSON.stringify(canonicalActionForm(expected.actions, expected.unsubscribe))).digest('hex');
  assert.equal(expected.seal, recomputed);
});

test('2. sender, domain, list and message targets match exactly; pile narrows a sweep', () => {
  const input = messages([
    mail({ id: 'a', from: { address: 'news@orchard.example' }, headers: { 'List-Id': '<list.orchard.example>' }, pile: 'alerts' }),
    mail({ id: 'b', from: { address: 'news@orchard.example' }, headers: { 'List-Id': '<list.orchard.example>' }, pile: 'newsletters' }),
    mail({ id: 'c', from: { address: 'other@orchard.example' }, pile: 'receipts' }),
    mail({ id: 'd', from: { address: 'other@elsewhere.example' }, pile: 'other' }),
  ]);
  const result = previewActions(input, requests([
    request('delete', { sender: 'NEWS@ORCHARD.EXAMPLE' }, 'newsletters'),
    request('spam', { domain: '@orchard.example' }),
    request('unsubscribe', { listId: '<LIST.ORCHARD.EXAMPLE>' }),
    request('delete', { messages: [{ inbox: 'home', id: 'd' }] }),
  ]));
  assert.equal(result.requests[0].matched, 1);
  assert.equal(result.requests[1].matched, 3);
  assert.equal(result.requests[2].matched, 2);
  assert.deepEqual(resultMessage(result, 'delete', 'd').matchedBy, [4]);
});

test('3. People and Work are left out of sweeps, while direct messages may include them', () => {
  const input = messages([
    mail({ id: 'p', from: { address: 'same@fernway.example' }, pile: 'people' }),
    mail({ id: 'w', from: { address: 'same@fernway.example' }, pile: 'work' }),
    mail({ id: 'o', from: { address: 'same@fernway.example' }, pile: undefined }),
  ].map(value => { if (value.pile === undefined) delete value.pile; return value; }));
  const result = previewActions(input, requests([
    request('delete', { sender: 'same@fernway.example' }),
    request('spam', { messages: [{ inbox: 'home', id: 'p' }] }),
  ]));
  assert.deepEqual(result.requests[0].leftOutReasons, [
    { reason: 'In People: pick these messages one by one', count: 1 },
    { reason: 'In Work: pick these messages one by one', count: 1 },
  ]);
  assert.equal(result.requests[0].matched, 1);
  assert.equal(resultMessage(result, 'delete', 'o').pile, 'other');
  assert.equal(resultMessage(result, 'spam', 'p').pile, 'people');
});

test('4. every listed common mail provider is blocked with the named reason', () => {
  for (const domain of COMMON_MAIL_DOMAINS) {
    const result = previewActions(messages([]), oneRequest('delete', { domain: `@${domain}` }));
    assert.deepEqual(result.blocked, [{ position: 1, reason: `This would match everyone who uses ${domain}; choose a sender instead` }]);
  }
});

test('5. nothing matched and addresses that receive mail are blocked', () => {
  const empty = previewActions(messages([]), oneRequest('delete', { sender: 'nobody@fernway.example' }));
  assert.equal(empty.blocked[0].reason, 'Nothing matches this request');
  const input = messages([
    mail({ id: 'from', from: { address: 'target@fernway.example' } }),
    mail({ id: 'to', from: { address: 'someone@elsewhere.example' }, to: [{ address: 'target@fernway.example' }, { address: 'owner@fernway.example' }] }),
  ]);
  assert.match(previewActions(input, oneRequest('delete', { sender: 'target@fernway.example' })).blocked[0].reason, /also receives/);
  assert.match(previewActions(input, oneRequest('delete', { domain: '@fernway.example' })).blocked[0].reason, /also receives/);
});

test('6. spam wins delete with both request positions; unsubscribe stays independent', () => {
  const item = headerMail('overlap', 'Overlap News', '<https://mailings.example/leave>', undefined);
  const result = previewActions(messages([item]), requests([
    request('delete', { messages: [{ inbox: 'home', id: 'overlap' }] }),
    request('spam', { sender: 'overlap@mailings.example' }),
    request('unsubscribe', { sender: 'overlap@mailings.example' }),
  ]));
  assert.equal(action(result, 'delete').count, 0);
  assert.deepEqual(resultMessage(result, 'spam', 'overlap').matchedBy, [1, 2]);
  assert.equal(result.requests[0].kept, 0);
  assert.equal(result.requests[1].kept, 1);
  assert.equal(action(result, 'unsubscribe').count, 1);
  assert.equal(result.unsubscribe[0].method, 'webPage');
});

test('7. unsubscribe methods and preference follow the headers', () => {
  const cases = [
    [headerMail('one', 'One', '<https://mailings.example/one>', 'List-Unsubscribe=One-Click'), 'oneClick'],
    [headerMail('mail', 'Mail', '<mailto:leave@mailings.example?subject=stop&body=please>'), 'mailto'],
    [headerMail('web', 'Web', '<https://mailings.example/web>'), 'webPage'],
    [headerMail('http', 'Http', '<http://mailings.example/http>'), 'none', 'Only an insecure link'],
    [headerMail('credentials', 'Credentials', '<https://user:pass@mailings.example/no>'), 'none'],
    [headerMail('long', 'Long', `<https://mailings.example/${'x'.repeat(2000)}>`), 'none'],
    [headerMail('empty', 'Empty', '   '), 'none'],
    [mail({ id: 'missing', from: { address: 'missing@mailings.example' }, pile: 'newsletters' }), 'none'],
  ];
  for (const [message, method, reason] of cases) {
    const entry = planFor(message).unsubscribe[0];
    assert.equal(entry.method, method, message.id);
    if (reason) assert.equal(entry.reason, reason);
  }
  for (const value of [
    '<mailto:leave@mailings.example>, <https://mailings.example/preferred>',
    '<https://mailings.example/preferred>, <mailto:leave@mailings.example>',
  ]) {
    assert.equal(planFor(headerMail('prefer', 'Prefer', value, 'List-Unsubscribe=One-Click')).unsubscribe[0].method, 'oneClick');
    assert.equal(planFor(headerMail('prefer', 'Prefer', value)).unsubscribe[0].method, 'mailto');
  }
  const mailPlan = planFor(headerMail('fields', 'Fields', '<mailto:a@mailings.example,b@mailings.example?subject=Stop&body=Please>'));
  assert.deepEqual(mailPlan.unsubscribe[0], {
    key: 'address:fields@mailings.example', label: 'Fields', method: 'mailto',
    to: ['a@mailings.example', 'b@mailings.example'], subject: 'Stop', body: 'Please',
  });
  for (const field of ['cc', 'bcc']) {
    assert.equal(planFor(headerMail(field, field, `<mailto:leave@mailings.example?${field}=copy@mailings.example>`)).unsubscribe[0].reason,
      'This unsubscribe address asks to send extra mail fields');
  }
  const changed = planFor(headerMail('fields', 'Fields', '<mailto:a@mailings.example?subject=Changed&body=Please>'));
  assert.notEqual(changed.seal, mailPlan.seal);
  const changedBody = planFor(headerMail('fields', 'Fields', '<mailto:a@mailings.example?subject=Stop&body=Changed>'));
  assert.notEqual(changedBody.seal, mailPlan.seal);
  assert.equal(planFor(headerMail('plus', 'Plus', '<mailto:a@mailings.example?subject=A+B>')).unsubscribe[0].subject, 'A+B');
});

test('8. duplicate Message-ID copies use the first reference as representative and seal every copy', () => {
  const first = headerMail('z', 'Chosen', '<mailto:chosen@mailings.example>', undefined, {
    inbox: 'a', id: 'first', from: { name: 'Chosen', address: 'chosen@mailings.example' }, pile: 'alerts',
    headers: { 'Message-ID': '<same@mailings.example>', 'List-Unsubscribe': '<mailto:chosen@mailings.example>' },
  });
  const second = headerMail('a', 'Ignored', '<https://ignored.example/leave>', undefined, {
    inbox: 'z', id: 'second', from: { name: 'Ignored', address: 'ignored@mailings.example' }, pile: 'newsletters',
    headers: { 'Message-ID': '<SAME@mailings.example>', 'List-Unsubscribe': '<https://ignored.example/leave>' },
  });
  const target = requests([request('unsubscribe', { messages: [{ inbox: 'z', id: 'second' }] })]);
  const left = previewActions(messages([first, second]), target);
  const right = previewActions(messages([second, first]), target);
  assert.deepEqual(left, right);
  assert.equal(action(left, 'unsubscribe').count, 1);
  assert.equal(action(left, 'unsubscribe').copies, 2);
  assert.equal(left.unsubscribe[0].method, 'mailto');
  assert.deepEqual(resultMessage(left, 'unsubscribe', 'first').ids, { a: ['first'], z: ['second'] });
});

test('9. seal changes only with executable work, not order or request positions', () => {
  const one = mail({ id: 'one', inbox: 'a', from: { address: 'one@fernway.example' } });
  const two = headerMail('two', 'Two', '<https://mailings.example/two>', 'List-Unsubscribe=One-Click', { inbox: 'b' });
  const reqs = requests([
    request('delete', { messages: [{ inbox: 'a', id: 'one' }] }),
    request('delete', { sender: 'missing@fernway.example' }),
    request('unsubscribe', { messages: [{ inbox: 'b', id: 'two' }] }),
  ]);
  const base = previewActions(messages([one, two]), reqs);
  assert.equal(base.seal, previewActions(messages([two, one]), reqs).seal);
  const swapped = previewActions(messages([one, two]), requests([
    reqs.requests[1], reqs.requests[0], reqs.requests[2],
  ]));
  assert.equal(base.seal, swapped.seal);
  assert.deepEqual(base.unsubscribe, swapped.unsubscribe);
  assert.deepEqual(withoutMatchedBy(base.actions), withoutMatchedBy(swapped.actions));
  assert.deepEqual(resultMessage(base, 'delete', 'one').matchedBy, [1]);
  assert.deepEqual(resultMessage(swapped, 'delete', 'one').matchedBy, [2]);
  assert.deepEqual(base.blocked, [{ position: 2, reason: 'Nothing matches this request' }]);
  assert.deepEqual(swapped.blocked, [{ position: 1, reason: 'Nothing matches this request' }]);
  assert.deepEqual(swapped.requests, [
    { ...base.requests[1], position: 1 },
    { ...base.requests[0], position: 2 },
    base.requests[2],
  ]);
  const recomputed = createHash('sha256').update(JSON.stringify(canonicalActionForm(base.actions, base.unsubscribe))).digest('hex');
  assert.equal(base.seal, recomputed);
  const oneDelete = previewActions(messages([one]), oneRequest('delete', { messages: [{ inbox: 'a', id: 'one' }] }));
  assert.notEqual(oneDelete.seal, planFor(one, 'spam').seal);
  assert.notEqual(base.seal, oneDelete.seal);
  assert.notEqual(base.seal, previewActions(messages([{ ...one, id: 'changed' }, two]), requests([
    request('delete', { messages: [{ inbox: 'a', id: 'changed' }] }), reqs.requests[1], reqs.requests[2],
  ])).seal);
  const changedUrl = headerMail('two', 'Two', '<https://mailings.example/changed>', 'List-Unsubscribe=One-Click', { inbox: 'b' });
  assert.notEqual(base.seal, previewActions(messages([one, changedUrl]), reqs).seal);

  const duplicateSource = mail({
    id: 'copy-a', inbox: 'a', from: { address: 'copies@fernway.example' },
    headers: { 'Message-ID': '<copies@fernway.example>' },
  });
  const duplicate = { ...duplicateSource, id: 'copy-b', inbox: 'b' };
  const copyRequest = oneRequest('delete', { messages: [{ inbox: 'a', id: 'copy-a' }] });
  const oneCopy = previewActions(messages([duplicateSource]), copyRequest);
  const twoCopies = previewActions(messages([duplicateSource, duplicate]), copyRequest);
  assert.equal(action(oneCopy, 'delete').copies, 1);
  assert.equal(action(twoCopies, 'delete').copies, 2);
  assert.notEqual(oneCopy.seal, twoCopies.seal);
});

test('10. malformed input and request limits are refused with request positions', () => {
  assert.throws(() => previewActions({ schemaVersion: 2, messages: [] }, oneRequest('delete', { sender: 'a@b.example' })), /schemaVersion/);
  assert.throws(() => previewActions(messages([{ ...mail(), extra: true }]), oneRequest('delete', { sender: 'a@b.example' })), /extra/);
  assert.throws(() => previewActions(messages([mail({ pile: 'maybe' })]), oneRequest('delete', { sender: 'a@b.example' })), /pile/);
  assert.throws(() => previewActions(messages([]), requests([request('archive', { sender: 'a@b.example' })])), /^EmailActionsError: Request 1:/);
  assert.throws(() => previewActions(messages([]), requests([{ action: 'delete', target: { sender: 'a@b.example', domain: '@b.example' } }])), /exactly one/);
  assert.throws(() => previewActions(messages([]), requests(Array.from({ length: 201 }, () => request('delete', { sender: 'a@b.example' })))), /1 to 200/);
  assert.throws(() => previewActions(messages([]), oneRequest('delete', { messages: [{ inbox: 'home', id: 'missing' }] })), /Request 1.*isn't in the input/);
  assert.throws(() => previewActions(messages(Array.from({ length: 10_001 }, (_, index) => ({ id: `m-${index}` }))),
    oneRequest('delete', { sender: 'a@b.example' })), /limit is 10000/);
  assert.throws(() => previewActions(messages([mail({ date: '2026-10-24' })]), oneRequest('delete', { sender: 'a@b.example' })), /RFC 3339/);
  assert.throws(() => previewActions(messages([mail({ from: { address: 'missing-at.example' } })]), oneRequest('delete', { sender: 'a@b.example' })), /exactly one/);
  assert.throws(() => previewActions(messages([mail(), mail()]), oneRequest('delete', { sender: 'a@b.example' })), /appears more than once/);
  assert.throws(() => parseJsonFile(' '.repeat(5 * 1024 * 1024 + 1), 'messages'), /limit is 5242880/);
  assert.throws(() => parseJsonFile('{', 'messages'), /isn't valid JSON/);
});

test('11. hostile valid text is unchanged in JSON and escaped onto one summary line', () => {
  const hostile = 'Quote " <script> 😀 \u202eleft\nnext\ttab';
  const item = mail({ id: 'hostile', from: { name: hostile, address: 'hostile@fernway.example' }, subject: hostile });
  const plan = planFor(item, 'delete');
  assert.equal(resultMessage(plan, 'delete', 'hostile').subject, hostile);
  const text = formatSummary(plan);
  assert.ok(text.includes('Quote " <script> 😀 \\u202eleft\\nnext\\ttab'));
  assert.equal(text.split('\n').filter(line => line.includes('<script>')).length, 1);
});

test('12. no clock or local-time method is read', () => {
  const RealDate = Date;
  const methods = ['getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds', 'getTimezoneOffset'];
  class NoClockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) throw new Error('clock read');
      super(...args);
    }
    static now() { throw new Error('clock read'); }
  }
  for (const name of methods) NoClockDate.prototype[name] = () => { throw new Error(`local time read: ${name}`); };
  globalThis.Date = NoClockDate;
  try {
    assert.equal(planFor(mail({ id: 'clock' }), 'delete').schemaVersion, 1);
  } finally {
    globalThis.Date = RealDate;
  }
});

test('edge cases: header names are case-insensitive and duplicate fields use the first non-empty value', () => {
  const item = mail({
    id: 'header-case',
    from: { address: 'headers@mailings.example' },
    pile: 'newsletters',
    headers: {
      'message-id': '<HEADER-CASE@MAILINGS.EXAMPLE>',
      'LIST-UNSUBSCRIBE': '   ',
      'List-Unsubscribe': '<https://mailings.example/chosen>',
      'list-unsubscribe': '<https://mailings.example/later>',
      'list-unsubscribe-post': 'List-Unsubscribe=One-Click',
      ' List-Unsubscribe': '<https://mailings.example/ignored-leading-space>',
    },
  });
  assert.deepEqual(planFor(item).unsubscribe[0], {
    key: 'address:headers@mailings.example',
    label: 'headers@mailings.example',
    method: 'oneClick',
    url: 'https://mailings.example/chosen',
  });
});

test('edge cases: Message-ID and List-Id accept brackets or bare text and mark identifiers over 200 characters', () => {
  const bracketed = mail({ id: 'first', inbox: 'a', headers: { 'Message-ID': 'Name <SAME@MAILINGS.EXAMPLE>' } });
  const bare = mail({ id: 'second', inbox: 'b', headers: { 'message-id': ' same@mailings.example ' } });
  const duplicatePlan = previewActions(messages([bare, bracketed]), oneRequest('delete', {
    messages: [{ inbox: 'a', id: 'first' }],
  }));
  assert.equal(action(duplicatePlan, 'delete').count, 1);
  assert.equal(action(duplicatePlan, 'delete').copies, 2);

  const listMessages = messages([
    mail({ id: 'list-angle', headers: { 'List-Id': 'Roundup <ROUNDUP.LISTS.EXAMPLE>' } }),
    mail({ id: 'list-bare', headers: { 'list-id': ' roundup.lists.example ' } }),
  ]);
  assert.equal(previewActions(listMessages, oneRequest('delete', {
    listId: '<roundup.lists.example>',
  })).requests[0].matched, 2);

  const longId = `${'x'.repeat(201)}.example`;
  const longFirst = mail({
    id: 'long-first', inbox: 'a', pile: 'newsletters',
    headers: { 'Message-ID': `<${longId}>`, 'List-Id': `<${longId}>` },
  });
  const longSecond = mail({
    id: 'long-second', inbox: 'b', pile: 'newsletters',
    headers: { 'message-id': longId, 'list-id': longId },
  });
  const longPlan = previewActions(messages([longSecond, longFirst]), oneRequest('unsubscribe', {
    messages: [{ inbox: 'a', id: 'long-first' }],
  }));
  assert.equal(action(longPlan, 'unsubscribe').count, 1);
  assert.equal(action(longPlan, 'unsubscribe').copies, 2);
  assert.match(action(longPlan, 'unsubscribe').groups[0].key, /^list:SHA256:[0-9a-f]{64}$/);
});

test('edge cases: unsubscribe URIs outside angle brackets are ignored', () => {
  const item = headerMail('outside', 'Outside', 'mailto:leave@mailings.example, https://mailings.example/leave');
  assert.equal(planFor(item).unsubscribe[0].method, 'none');
});

test('edge cases: mailto uses first repeated fields and refuses fragments or malformed encoding', () => {
  const repeated = planFor(headerMail('repeated', 'Repeated',
    '<mailto:first@mailings.example,second@mailings.example?subject=First&subject=Second&body=One&body=Two>'));
  assert.deepEqual(repeated.unsubscribe[0], {
    key: 'address:repeated@mailings.example',
    label: 'Repeated',
    method: 'mailto',
    to: ['first@mailings.example', 'second@mailings.example'],
    subject: 'First',
    body: 'One',
  });
  assert.equal(planFor(headerMail('fragment', 'Fragment',
    '<mailto:leave@mailings.example?subject=Stop#fragment>')).unsubscribe[0].method, 'none');
  assert.equal(planFor(headerMail('encoding', 'Encoding',
    '<mailto:leave@mailings.example?subject=%ZZ>')).unsubscribe[0].method, 'none');
});

test('edge cases: mailto permits empty recipients, subject and body', () => {
  assert.deepEqual(planFor(headerMail('empty-mailto', 'Empty mailto', '<mailto:>')).unsubscribe[0], {
    key: 'address:empty-mailto@mailings.example',
    label: 'Empty mailto',
    method: 'mailto',
    to: [],
    subject: '',
    body: '',
  });
});

test('edge cases: address and domain comparisons trim and use lower case', () => {
  const item = mail({ id: 'normalized', from: { name: 'Original', address: '  News@Orchard.Example  ' } });
  const bySender = previewActions(messages([item]), oneRequest('delete', { sender: ' NEWS@ORCHARD.EXAMPLE ' }));
  assert.equal(bySender.requests[0].matched, 1);
  assert.equal(resultMessage(bySender, 'delete', 'normalized').from.address, '  News@Orchard.Example  ');
  const byDomain = previewActions(messages([item]), oneRequest('delete', { domain: '@ ORCHARD.EXAMPLE ' }));
  assert.equal(byDomain.requests[0].matched, 1);
});

test('edge cases: dates need an offset and equal instants sort by inbox then id', () => {
  assert.throws(() => previewActions(messages([mail({ date: '2026-10-24T12:00:00' })]),
    oneRequest('delete', { sender: 'tessa@fernway.example' })), /RFC 3339/);
  const input = messages([
    mail({ id: 'z', inbox: 'z', date: '2026-10-24T12:00:00Z' }),
    mail({ id: 'b', inbox: 'a', date: '2026-10-24T08:00:00-04:00' }),
    mail({ id: 'a', inbox: 'a', date: '2026-10-24T12:00:00+00:00' }),
  ]);
  const result = previewActions(input, oneRequest('delete', {
    messages: [{ inbox: 'z', id: 'z' }, { inbox: 'a', id: 'b' }, { inbox: 'a', id: 'a' }],
  }));
  const ordered = action(result, 'delete').groups.flatMap(group => group.messages)
    .map(message => [message.inboxes[0], message.ids[message.inboxes[0]][0]]);
  assert.deepEqual(ordered, [['a', 'a'], ['a', 'b'], ['z', 'z']]);
});

test('13. network is denied and the library writes no files or opens message URLs', () => {
  assert.throws(() => fetch('https://example.com/'), /Network blocked/);
  assert.deepEqual(networkCalls, [{ name: 'fetch' }]);
  clearNetworkCalls();
  const writers = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rename', 'renameSync', 'unlink', 'unlinkSync'];
  const promiseWriters = ['writeFile', 'appendFile', 'mkdir', 'rm', 'rename', 'unlink'];
  const saved = [];
  const touched = [];
  function stub(target, label, name) {
    if (typeof target[name] !== 'function') return;
    saved.push([target, name, target[name]]);
    target[name] = () => { touched.push(`${label}.${name}`); throw new Error('write attempted'); };
  }
  for (const name of writers) stub(fs, 'fs', name);
  for (const name of promiseWriters) stub(fsPromises, 'fs/promises', name);
  syncBuiltinESMExports();
  try {
    const item = headerMail('offline', 'Offline', '<https://should-never-open.example/leave>', 'List-Unsubscribe=One-Click');
    assert.equal(planFor(item).unsubscribe[0].method, 'oneClick');
  } finally {
    for (const [target, name, value] of saved) target[name] = value;
    syncBuiltinESMExports();
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(networkCalls, []);
});

test('command prints JSON or safe plain text and returns refusal status without process.exit', () => {
  function run(argv) {
    let stdout = '';
    let stderr = '';
    const code = main(argv, { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
    return { code, stdout, stderr };
  }
  const mailbox = new URL('../fixtures/mailbox.json', import.meta.url).pathname;
  const requestFile = new URL('../fixtures/requests.json', import.meta.url).pathname;
  const json = run(['--messages', mailbox, '--requests', requestFile, '--json']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.stdout).schemaVersion, 1);
  assert.equal(json.stderr, '');
  const plain = run(['--messages', mailbox, '--requests', requestFile]);
  assert.match(plain.stdout, /^Spam: 1 message/);
  const refused = run([]);
  assert.equal(refused.code, 1);
  assert.equal(refused.stdout, '');
  assert.match(refused.stderr, /--messages is required/);
});
