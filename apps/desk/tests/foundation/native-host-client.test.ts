import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  NativeHostClient,
  type NativeHostCodec,
  type NativeHostTransport,
  type NativeProofOperation,
} from '../../src/adapters/native-host-client';

// A made-up, deliberately tiny protocol. These fields are not a native agreement.
type Request = { id: string; operation: NativeProofOperation; expectedRevision?: number; text?: string };
type Result = { status: 'saved' | 'conflict' | 'refused'; revision: number };
const context = { connectionId: 'invented-connection', documentGeneration: 2 };
const options = { ...context, maxWireBytes: 4096, maxRetainedRequests: 20, timeoutMs: 60_000 };
const read = (id: string): Request => ({ id, operation: 'workspace.read' });
const commit = (id: string): Request => ({ id, operation: 'workspace.commitProof', expectedRevision: 7, text: 'Invented draft.' });
const codec: NativeHostCodec<Request, Result> = {
  prepare(document, request) {
    if (Object.keys(request).some((key) => !['id', 'operation', 'expectedRevision', 'text'].includes(key))
      || request.operation === 'workspace.commitProof' && (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision! < 0)) {
      throw new Error('Invented private detail that must never be echoed.');
    }
    return { requestId: request.id, operation: request.operation, wire: JSON.stringify({ ...document, ...request }) };
  },
  decode(wire) {
    const reply = JSON.parse(wire);
    if (reply === null || Object.keys(reply).sort().join(',') !== 'connectionId,documentGeneration,operation,requestId,result,type'
      || reply.type !== 'terminal' || typeof reply.result !== 'object' || !reply.result
      || Object.keys(reply.result).sort().join(',') !== 'revision,status'
      || !['saved', 'conflict', 'refused'].includes(reply.result.status)
      || !Number.isSafeInteger(reply.result.revision) || reply.result.revision < 0) return undefined;
    return reply;
  },
};

class Transport implements NativeHostTransport {
  wires: string[] = [];
  reply = (_wire: string) => {};
  revoked = () => {};
  detached = 0;
  onSend?: (wire: string) => void | Promise<void>;
  listen(reply: (wire: string) => void, revoked: () => void) {
    this.reply = reply;
    this.revoked = revoked;
    return () => { this.detached++; };
  }
  send(wire: string) { this.wires.push(wire); return this.onSend?.(wire); }
  deliver(request: Request, overrides: Record<string, unknown> = {}) {
    this.reply(JSON.stringify({ ...context, requestId: request.id, operation: request.operation, type: 'terminal', result: { status: 'saved', revision: 8 }, ...overrides }));
  }
}

function setup(overrides: Partial<typeof options> = {}) {
  const transport = new Transport();
  const client = new NativeHostClient(transport, codec, { ...options, ...overrides });
  return { client, transport };
}

test('native lifecycle is inert until an explicit validated request; only a terminal result completes it', async () => {
  const { client, transport } = setup();
  assert.deepEqual(transport.wires, []);
  const request = commit('one');
  const pending = client.request(request);
  transport.deliver(request, { type: 'received' });
  let finished = false;
  void pending.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false, 'Receipt is not durable completion.');
  transport.deliver(request);
  assert.deepEqual(await pending, { kind: 'completed', result: { status: 'saved', revision: 8 } });
  client.revoke();
});

test('codec refusal or invalid expected revision sends nothing and returns no input or exception detail', async () => {
  const { client, transport } = setup();
  assert.deepEqual(await client.request({ ...commit('one'), expectedRevision: -1 }), { kind: 'refused', reason: 'invalid-request' });
  assert.deepEqual(await client.request({ ...read('two'), arbitrary: 'private' } as Request), { kind: 'refused', reason: 'invalid-request' });
  assert.deepEqual(await client.request({ id: 'three', operation: 'provider.send' as NativeProofOperation }), { kind: 'refused', reason: 'invalid-request' });
  assert.equal(transport.wires.length, 0);
  client.revoke();
});

test('byte bounds reject complete requests without truncating multibyte text', async () => {
  const { client, transport } = setup({ maxWireBytes: 256 });
  const request = { ...commit('one'), text: '🙂'.repeat(50) };
  assert.deepEqual(await client.request(request), { kind: 'refused', reason: 'invalid-request' });
  assert.equal(transport.wires.length, 0);
  assert.equal(request.text, '🙂'.repeat(50));
  client.revoke();
});

test('a snapshot is captured before dispatch and completed results cannot mutate the identity cache', async () => {
  const { client, transport } = setup();
  const request = commit('one');
  const original = structuredClone(request);
  const pending = client.request(request);
  request.text = 'Later edit';
  assert.equal(JSON.parse(transport.wires[0]).text, 'Invented draft.');
  transport.deliver(original);
  const result = await pending;
  assert.equal(result.kind, 'completed');
  if (result.kind === 'completed') assert.throws(() => { result.result.revision = 999; }, TypeError);
  assert.deepEqual(await client.request(original), { kind: 'completed', result: { status: 'saved', revision: 8 } });
  assert.equal(transport.wires.length, 1);
  assert.deepEqual(await client.request(request), { kind: 'refused', reason: 'identity-reused' });
  client.revoke();
});

test('connection, document, request and operation correlation refuse stale or unrelated terminal messages', async () => {
  const { client, transport } = setup();
  const request = commit('one');
  const pending = client.request(request);
  for (const override of [{ connectionId: 'other' }, { documentGeneration: 1 }, { requestId: 'other' }, { operation: 'workspace.read' }]) transport.deliver(request, override);
  transport.reply('not-json');
  transport.reply('null');
  transport.deliver(request, { unexpected: 'field' });
  transport.deliver(request, { result: { status: 'saved', revision: -1 } });
  let finished = false;
  void pending.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  transport.deliver(request, { result: { status: 'conflict', revision: 9 } });
  assert.deepEqual(await pending, { kind: 'completed', result: { status: 'conflict', revision: 9 } });
  client.revoke();
});

test('one unresolved mutation blocks another mutation while reads remain available', async () => {
  const { client, transport } = setup();
  const mutation = commit('one');
  const pending = client.request(mutation);
  assert.deepEqual(await client.request(commit('two')), { kind: 'unavailable', reason: 'mutation-unresolved' });
  const reading = client.request(read('read'));
  transport.deliver(read('read'));
  assert.equal((await reading).kind, 'completed');
  transport.deliver(mutation);
  await pending;
  const second = client.request(commit('two'));
  transport.deliver(commit('two'));
  assert.equal((await second).kind, 'completed');
  client.revoke();
});

test('an already cancelled request is not dispatched; cancelling a dispatched mutation means unknown', async () => {
  const { client, transport } = setup();
  const cancelled = new AbortController();
  cancelled.abort();
  assert.deepEqual(await client.request(commit('one'), cancelled.signal), { kind: 'refused', reason: 'cancelled-before-send' });
  assert.equal(transport.wires.length, 0);
  const controller = new AbortController();
  const pending = client.request(commit('one'), controller.signal);
  controller.abort();
  assert.deepEqual(await pending, { kind: 'unknown', reason: 'cancelled' });
  assert.deepEqual(await client.request(commit('two')), { kind: 'unavailable', reason: 'mutation-unresolved' });
  assert.deepEqual(await client.request(commit('one')), { kind: 'unknown', reason: 'cancelled' });
  assert.equal(transport.wires.length, 1, 'A repeated call must not automatically send again.');
  client.revoke();
});

test('timeout keeps mutation unresolved; explicit reconciliation uses the original request identity and bytes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, transport } = setup({ timeoutMs: 100 });
  const request = commit('one');
  const pending = client.request(request);
  t.mock.timers.tick(100);
  assert.deepEqual(await pending, { kind: 'unknown', reason: 'timeout' });
  assert.deepEqual(await client.request({ ...request, expectedRevision: 8 }), { kind: 'refused', reason: 'identity-reused' });
  const reconciliation = client.reconcile(request.id);
  assert.equal(transport.wires.length, 2);
  assert.equal(transport.wires[0], transport.wires[1]);
  transport.deliver(request);
  assert.equal((await reconciliation).kind, 'completed');
  client.revoke();
});

test('a late terminal reply resolves an unknown request without another dispatch', async () => {
  const { client, transport } = setup();
  const controller = new AbortController();
  const pending = client.request(commit('one'), controller.signal);
  controller.abort();
  await pending;
  transport.deliver(commit('one'));
  assert.deepEqual(await client.reconcile('one'), { kind: 'completed', result: { status: 'saved', revision: 8 } });
  assert.equal(transport.wires.length, 1);
  const second = client.request(commit('two'));
  transport.deliver(commit('two'));
  assert.equal((await second).kind, 'completed');
  client.revoke();
});

test('a transport throw or rejected dispatch cannot claim a mutation was never applied', async () => {
  for (const failure of [() => { throw Error('Private failure detail'); }, () => Promise.reject(Error('Private failure detail'))]) {
    const { client, transport } = setup();
    transport.onSend = failure;
    assert.deepEqual(await client.request(commit('one')), { kind: 'unknown', reason: 'transport' });
    assert.deepEqual(await client.request(commit('two')), { kind: 'unavailable', reason: 'mutation-unresolved' });
    transport.deliver(commit('one'));
    assert.equal((await client.reconcile('one')).kind, 'completed');
    client.revoke();
  }
});

test('a rejected old dispatch cannot settle or erase a new reconciliation attempt', async () => {
  const { client, transport } = setup();
  let rejectFirst!: (error: Error) => void;
  transport.onSend = () => new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  const controller = new AbortController();
  const first = client.request(commit('one'), controller.signal);
  controller.abort();
  await first;
  transport.onSend = undefined;
  const retry = client.reconcile('one');
  rejectFirst(Error('Late dispatch error'));
  await Promise.resolve();
  await Promise.resolve();
  transport.deliver(commit('one'));
  assert.deepEqual(await retry, { kind: 'completed', result: { status: 'saved', revision: 8 } });
  assert.equal((await client.reconcile('one')).kind, 'completed');
  client.revoke();
});

test('duplicate pending requests share one dispatch and one immutable result', async () => {
  const { client, transport } = setup();
  const first = client.request(read('one'));
  const second = client.request(read('one'));
  assert.equal(first, second);
  assert.equal(transport.wires.length, 1);
  transport.deliver(read('one'));
  assert.deepEqual(await first, await second);
  client.revoke();
});

for (const method of ['request', 'reconcile'] as const) {
  test(`cancelling a joined ${method} only stops that waiter and keeps the original mutation pending`, async () => {
    const { client, transport } = setup();
    const request = commit('one');
    const first = client.request(request);
    let firstFinished = false;
    void first.then(() => { firstFinished = true; });
    const controller = new AbortController();
    const joined = method === 'request'
      ? client.request(request, controller.signal) : client.reconcile(request.id, controller.signal);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    controller.abort();
    assert.deepEqual(await joined, { kind: 'unknown', reason: 'cancelled' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(firstFinished, false);
    assert.equal(client.request(request), first, 'The original attempt is still pending.');
    assert.deepEqual(await client.request(commit('two')), { kind: 'unavailable', reason: 'mutation-unresolved' });
    assert.equal(transport.wires.length, 1, 'Joining or cancelling must never resend.');
    transport.deliver(request);
    assert.deepEqual(await first, { kind: 'completed', result: { status: 'saved', revision: 8 } });
    assert.deepEqual(await client.reconcile(request.id), await first);
    const next = client.request(commit('two'));
    transport.deliver(commit('two'));
    assert.equal((await next).kind, 'completed', 'Only the terminal reply releases the mutation barrier.');
    client.revoke();
  });

  test(`an already aborted joined ${method} never cancels or redispatches the original attempt`, async () => {
    const { client, transport } = setup();
    const request = commit('one');
    const first = client.request(request);
    const controller = new AbortController();
    controller.abort();
    const joined = method === 'request'
      ? client.request(request, controller.signal) : client.reconcile(request.id, controller.signal);
    assert.deepEqual(await joined, { kind: 'unknown', reason: 'cancelled' });
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(client.request(request), first);
    assert.deepEqual(await client.request(commit('two')), { kind: 'unavailable', reason: 'mutation-unresolved' });
    assert.equal(transport.wires.length, 1);
    transport.deliver(request);
    assert.deepEqual(await first, { kind: 'completed', result: { status: 'saved', revision: 8 } });
    client.revoke();
  });
}

for (const ending of ['terminal', 'timeout', 'revoke'] as const) {
  test(`joined waiters detach their abort listeners when the original attempt ends by ${ending}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { client, transport } = setup({ timeoutMs: 100 });
    const request = commit('one');
    const firstController = new AbortController();
    const first = client.request(request, firstController.signal);
    const requestController = new AbortController();
    const reconcileController = new AbortController();
    const joinedRequest = client.request(request, requestController.signal);
    const joinedReconcile = client.reconcile(request.id, reconcileController.signal);
    const controllers = [firstController, requestController, reconcileController];
    for (const controller of controllers) assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    if (ending === 'terminal') transport.deliver(request);
    else if (ending === 'timeout') t.mock.timers.tick(100);
    else client.revoke();
    const outcome = await first;
    assert.deepEqual(outcome, ending === 'terminal'
      ? { kind: 'completed', result: { status: 'saved', revision: 8 } }
      : { kind: 'unknown', reason: ending === 'timeout' ? 'timeout' : 'revoked' });
    assert.deepEqual(await joinedRequest, outcome);
    assert.deepEqual(await joinedReconcile, outcome);
    for (const controller of controllers) {
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
      controller.abort();
    }
    assert.deepEqual(await joinedRequest, outcome, 'A late abort cannot replace the settled outcome.');
    if (ending === 'timeout') {
      assert.deepEqual(await client.request(commit('two')), { kind: 'unavailable', reason: 'mutation-unresolved' });
    }
    assert.equal(transport.wires.length, 1);
    client.revoke();
  });
}

test('revocation ends pending waits, releases listener, and refuses new work or late replies permanently', async () => {
  const { client, transport } = setup();
  const pending = client.request(commit('one'));
  transport.revoked();
  assert.deepEqual(await pending, { kind: 'unknown', reason: 'revoked' });
  transport.deliver(commit('one'));
  assert.deepEqual(await client.request(read('read')), { kind: 'unavailable', reason: 'revoked' });
  assert.deepEqual(await client.reconcile('one'), { kind: 'unavailable', reason: 'revoked' });
  client.revoke();
  assert.equal(transport.detached, 1);
  assert.equal(transport.wires.length, 1);
});

test('retained results reject changed payloads while oldest returned results can make room for new work', async () => {
  const { client, transport } = setup({ maxRetainedRequests: 1 });
  const first = client.request(read('one'));
  transport.deliver(read('one'));
  await first;
  assert.deepEqual(await client.request({ ...read('one'), text: 'Changed' }), { kind: 'refused', reason: 'identity-reused' });
  assert.equal((await client.request(read('one'))).kind, 'completed');
  assert.equal(transport.wires.length, 1);
  const second = client.request(read('two'));
  transport.deliver(read('two'));
  assert.equal((await second).kind, 'completed');
  assert.deepEqual(await client.reconcile('one'), { kind: 'refused', reason: 'not-reconcilable' });
  assert.equal(transport.wires.length, 2);
  client.revoke();
});

test('eviction follows terminal completion order and not the order requests were sent', async () => {
  const { client, transport } = setup({ maxRetainedRequests: 2 });
  const slow = client.request(read('slow'));
  const fast = client.request(read('fast'));
  transport.deliver(read('fast'));
  await fast;
  transport.deliver(read('slow'));
  await slow;
  const third = client.request(read('third'));
  assert.deepEqual(await client.reconcile('fast'), { kind: 'refused', reason: 'not-reconcilable' });
  assert.equal((await client.reconcile('slow')).kind, 'completed');
  transport.deliver(read('third'));
  await third;
  client.revoke();
});

test('pending, unknown and unreconciled late results stay pinned under terminal-cache pressure', async () => {
  const { client, transport } = setup({ maxRetainedRequests: 2 });
  const controller = new AbortController();
  const original = commit('original');
  const pending = client.request(original, controller.signal);
  const wire = transport.wires[0];
  for (let n = 0; n < 5; n++) {
    const value = read(`pending-pressure-${n}`);
    const reading = client.request(value);
    transport.deliver(value);
    await reading;
  }
  controller.abort();
  assert.equal((await pending).kind, 'unknown');
  for (let n = 0; n < 5; n++) {
    const value = read(`unknown-pressure-${n}`);
    const reading = client.request(value);
    transport.deliver(value);
    await reading;
  }
  assert.deepEqual(await client.request(commit('blocked')), { kind: 'unavailable', reason: 'mutation-unresolved' });
  const reconciling = client.reconcile(original.id);
  assert.equal(transport.wires.at(-1), wire, 'Unknown attempts retain the original exact wire.');
  transport.deliver(original);
  assert.equal((await reconciling).kind, 'completed');

  const lateController = new AbortController();
  const late = client.request(commit('late'), lateController.signal);
  lateController.abort();
  await late;
  transport.deliver(commit('late'));
  for (let n = 0; n < 5; n++) {
    const value = read(`late-pressure-${n}`);
    const reading = client.request(value);
    transport.deliver(value);
    await reading;
  }
  assert.deepEqual(await client.request(commit('still-blocked')), { kind: 'unavailable', reason: 'mutation-unresolved' });
  const count = transport.wires.length;
  assert.equal((await client.reconcile('late')).kind, 'completed');
  assert.equal(transport.wires.length, count, 'A cached late result is reconciled without dispatch.');
  client.revoke();
});

test('capacity remains a safe refusal when every retained identity is unresolved', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { client, transport } = setup({ maxRetainedRequests: 2, timeoutMs: 100 });
  const mutation = client.request(commit('one'));
  const reading = client.request(read('two'));
  assert.deepEqual(await client.request(read('three')), { kind: 'unavailable', reason: 'request-capacity' });
  t.mock.timers.tick(100);
  await mutation;
  await reading;
  assert.deepEqual(await client.request(read('three')), { kind: 'unavailable', reason: 'request-capacity' });
  transport.deliver(read('two'));
  assert.deepEqual(await client.request(read('three')), { kind: 'unavailable', reason: 'request-capacity' },
    'A late result is still pinned until explicitly reconciled.');
  assert.equal((await client.reconcile('two')).kind, 'completed');
  const third = client.request(read('three'));
  transport.deliver(read('three'));
  await third;
  assert.deepEqual(await client.request(commit('four')), { kind: 'unavailable', reason: 'mutation-unresolved' });
  client.revoke();
});

test('late replies for evicted results cannot complete or release another live mutation', async () => {
  const { client, transport } = setup({ maxRetainedRequests: 1 });
  const first = client.request(commit('old'));
  transport.deliver(commit('old'));
  await first;
  const live = client.request(commit('live'));
  transport.deliver(commit('old'));
  assert.deepEqual(await client.request(commit('third')), { kind: 'unavailable', reason: 'mutation-unresolved' });
  transport.deliver(commit('live'));
  assert.equal((await live).kind, 'completed');
  assert.deepEqual(await client.request({ ...commit('live'), text: 'Changed' }), { kind: 'refused', reason: 'identity-reused' });
  assert.equal(transport.wires.length, 2);
  client.revoke();
});

test('metadata release failure preserves the terminal result and refuses new dispatch safely', async () => {
  const transport = new Transport();
  const client = new NativeHostClient<Request, Result>(transport, {
    ...codec, forget() { throw new Error('Private release detail'); },
  }, { ...options, maxRetainedRequests: 1 });
  const first = client.request(read('one'));
  transport.deliver(read('one'));
  await first;
  assert.deepEqual(await client.request(read('two')), { kind: 'unavailable', reason: 'request-capacity' });
  assert.equal((await client.reconcile('one')).kind, 'completed');
  assert.equal(transport.wires.length, 1);
  client.revoke();
});

test('synchronous terminal dispatch cannot be replaced by a later transport rejection', async () => {
  const { client, transport } = setup();
  transport.onSend = () => { transport.deliver(commit('one')); return Promise.reject(Error('After terminal')); };
  assert.equal((await client.request(commit('one'))).kind, 'completed');
  await Promise.resolve();
  assert.equal((await client.reconcile('one')).kind, 'completed');
  client.revoke();
});

test('subscription failure or immediate revocation leaves a permanently unavailable client', async () => {
  let detached = 0;
  for (const listen of [() => { throw Error('No host'); }, (_reply: (wire: string) => void, revoke: () => void) => { revoke(); return () => { detached++; }; }]) {
    const client = new NativeHostClient({ listen, send: () => { assert.fail('Unavailable transport must never dispatch.'); } }, codec, options);
    assert.deepEqual(await client.request(read('one')), { kind: 'unavailable', reason: 'revoked' });
  }
  assert.equal(detached, 1);
});

test('explicit limits and document generation must be finite and usable', () => {
  for (const bad of [{ connectionId: '' }, { documentGeneration: -1 }, { timeoutMs: Infinity }, { timeoutMs: 2_147_483_648 }, { maxWireBytes: 0 }, { maxRetainedRequests: 0 }]) {
    assert.throws(() => setup(bad), TypeError);
  }
});

test('an oversized response cannot complete a request or bypass its validator', async () => {
  const { client, transport } = setup({ maxWireBytes: 256 });
  const pending = client.request(read('one'));
  // JSON whitespace keeps the reply fully valid for the strict codec while
  // making its wire exceed the transport byte bound.
  const oversized = JSON.stringify({ ...context, requestId: 'one', operation: 'workspace.read', type: 'terminal', result: { status: 'saved', revision: 8 } }) + ' '.repeat(256);
  assert.ok(new TextEncoder().encode(oversized).byteLength > 256);
  assert.ok(codec.decode(oversized), 'The codec must accept this reply without the wire-byte guard.');
  transport.reply(oversized);
  let finished = false;
  void pending.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  transport.deliver(read('one'));
  assert.equal((await pending).kind, 'completed');
  client.revoke();
});

test('revocation during request preparation cannot dispatch into the closed document', async () => {
  const transport = new Transport();
  const client = new NativeHostClient<Request, Result>(transport, {
    ...codec,
    prepare(document, request) {
      transport.revoked();
      return codec.prepare(document, request);
    },
  }, options);
  assert.deepEqual(await client.request(commit('one')), { kind: 'unavailable', reason: 'revoked' });
  assert.equal(transport.wires.length, 0);
});

test('registration is after dispatch gates and is not repeated by joining, completed replay or reconciliation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = new Transport();
  const registered: string[] = [];
  const client = new NativeHostClient<Request, Result>(transport, {
    ...codec, register(request) { registered.push(request.requestId); },
  }, { ...options, maxRetainedRequests: 2, timeoutMs: 100 });
  const stopped = new AbortController();
  stopped.abort();
  assert.equal((await client.request(read('cancelled'), stopped.signal)).kind, 'refused');
  const first = client.request(commit('one'));
  assert.equal((await client.request(commit('blocked'))).kind, 'unavailable');
  const second = client.request(read('two'));
  assert.equal((await client.request(read('capacity'))).kind, 'unavailable');
  transport.deliver(read('two'));
  await second;
  assert.deepEqual(registered, ['one', 'two']);
  t.mock.timers.tick(100);
  await first;
  const reconciliation = client.reconcile('one');
  const joined = client.request(commit('one'));
  transport.deliver(commit('one'));
  await reconciliation;
  await joined;
  await client.request(commit('one'));
  assert.deepEqual(registered, ['one', 'two']);
  client.revoke();
});

test('failed or revoking registration never dispatches or reserves the client mutation slot', async () => {
  const transport = new Transport();
  let fail = true;
  const client = new NativeHostClient<Request, Result>(transport, {
    ...codec, register() { if (fail) throw new Error('Private registration canary'); },
  }, options);
  assert.deepEqual(await client.request(commit('one')), { kind: 'refused', reason: 'invalid-request' });
  assert.equal(transport.wires.length, 0);
  fail = false;
  const next = client.request(commit('one'));
  transport.deliver(commit('one'));
  assert.equal((await next).kind, 'completed');
  client.revoke();

  const revokingTransport = new Transport();
  const revokingClient = new NativeHostClient<Request, Result>(revokingTransport, {
    ...codec, register() { revokingTransport.revoked(); },
  }, options);
  assert.deepEqual(await revokingClient.request(commit('one')), { kind: 'unavailable', reason: 'revoked' });
  assert.equal(revokingTransport.wires.length, 0);
});

test('non-JSON values cannot silently change during serialization or evade immutable snapshots', async () => {
  const { client, transport } = setup();
  for (const text of [new Date(), new Map([['sample', 'value']]), Infinity, undefined]) {
    assert.deepEqual(await client.request({ ...commit('one'), text } as unknown as Request), { kind: 'refused', reason: 'invalid-request' });
  }
  assert.equal(transport.wires.length, 0);
  client.revoke();
});
