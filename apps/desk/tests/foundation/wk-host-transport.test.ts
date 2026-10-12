import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { NativeHostClient } from '../../src/adapters/native-host-client';
import { NATIVE_PROOF_LIMITS, NativeProofCodec, type NativeProofRequest, type NativeProofResult } from '../../src/adapters/native-host-codec';
import { createWKHostTransport } from '../../src/adapters/wk-host-transport';

const bootstrap = Object.freeze({ v: 1, connectionId: 'invented-wk-connection', generation: 4 });
const context = { connectionId: bootstrap.connectionId, documentGeneration: bootstrap.generation };
const request: NativeProofRequest = { requestId: 'a1000000-0000-4000-8000-000000000001', operation: 'workspace.read',
  payload: { workspaceHandle: 'invented-workspace' } };
const envelope = { v: 1, connectionId: bootstrap.connectionId, generation: bootstrap.generation, ...request };
const wire = JSON.stringify(envelope);
const refusal = { v: 1, connectionId: bootstrap.connectionId, generation: bootstrap.generation,
  requestId: request.requestId, operation: request.operation, outcome: 'refused', reason: 'store-missing' };
const genericError = { name: 'TypeError', message: 'The native host transport is unavailable or invalid.' };

class Events extends EventTarget {
  listeners = new Set<EventListenerOrEventListenerObject>();
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    assert.equal(type, 'trueconvo-host');
    if (callback) this.listeners.add(callback);
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    assert.equal(type, 'trueconvo-host');
    if (callback) this.listeners.delete(callback);
    super.removeEventListener(type, callback, options);
  }
  emit(detail: unknown) { this.dispatchEvent(new CustomEvent('trueconvo-host', { detail })); }
}
const connection = (change: Record<string, unknown> = {}) => ({ type: 'host.connection', connectionId: bootstrap.connectionId,
  generation: bootstrap.generation, state: 'locked', reason: 'invented lock', ...change });
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test('WK module import is inert even when host, network and browser storage access would throw', () => {
  const moduleURL = new URL('../../src/adapters/wk-host-transport.ts', import.meta.url).href;
  execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    for (const key of ['window', 'webkit', 'trueConvoHostBootstrap', 'localStorage', 'sessionStorage', 'indexedDB', 'fetch']) {
      Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error('Unexpected global access: ' + key); } });
    }
    await import(${JSON.stringify(moduleURL)});
  `]);
});

test('explicit WK object request and reply round trip preserves receiver and leaves outcomes to the codec', async () => {
  const events = new Events();
  const sent: Record<string, unknown>[] = [];
  const handler = {
    marker: 'invented receiver',
    async postMessage(value: Record<string, unknown>) {
      assert.equal(this.marker, 'invented receiver');
      sent.push(value);
      return refusal;
    },
  };
  const transport = createWKHostTransport(bootstrap, (value) => handler.postMessage(value), events);
  assert.deepEqual(transport.context, context);
  assert.ok(Object.isFrozen(transport.context));
  assert.equal(events.listeners.size, 0); assert.deepEqual(sent, []);
  const received: string[] = [];
  const detach = transport.listen((reply) => received.push(reply), () => {});
  assert.equal(events.listeners.size, 1);
  await transport.send(wire);
  assert.deepEqual(sent, [envelope]);
  assert.notEqual(sent[0], envelope);
  assert.deepEqual(received.map((reply) => JSON.parse(reply)), [refusal]);
  detach();
  assert.equal(events.listeners.size, 0);
});

test('native refusal is a completed contract outcome while a rejected WK promise is unknown delivery', async () => {
  for (const rejected of [false, true]) {
    const events = new Events();
    let calls = 0;
    const transport = createWKHostTransport(bootstrap, async () => {
      calls += 1;
      if (rejected) throw new Error('INVENTED-PRIVATE-REJECTION');
      return refusal;
    }, events);
    const codec = new NativeProofCodec(context, 5);
    const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec, {
      ...transport.context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 5, timeoutMs: 1_000,
    });
    assert.deepEqual(await client.request(request), rejected ? { kind: 'unknown', reason: 'transport' }
      : { kind: 'completed', result: { operation: 'workspace.read', outcome: 'refused', reason: 'store-missing' } });
    assert.equal(calls, 1);
    client.revoke(); codec.revoke();
    assert.equal(events.listeners.size, 0);
  }
});

test('WK transport passes plain unknown, conflict and unrecognized reply objects without inventing saved results', async () => {
  for (const reply of [{ ...refusal, outcome: 'unknown' }, { ...refusal, outcome: 'conflict', revision: 4 }, { unsupported: true }]) {
    const transport = createWKHostTransport(bootstrap, async () => reply, new Events());
    const received: string[] = [];
    transport.listen((value) => received.push(value), () => {});
    await transport.send(wire);
    assert.deepEqual(received.map((value) => JSON.parse(value)), [reply]);
    transport.dispose();
  }
});

test('bootstrap validation refuses malformed fields and accessors without exposing their contents', () => {
  let getterCalls = 0;
  const getter = { ...bootstrap };
  Object.defineProperty(getter, 'connectionId', { enumerable: true, get() { getterCalls += 1; return 'INVENTED-PRIVATE'; } });
  const malformed = [null, [], 'INVENTED-PRIVATE', { ...bootstrap, v: 2 }, { ...bootstrap, extra: true },
    { ...bootstrap, connectionId: '' }, { ...bootstrap, connectionId: '🙂'.repeat(16_385) },
    { ...bootstrap, generation: -1 }, { ...bootstrap, generation: 1.5 }, { ...bootstrap, generation: Number.MAX_SAFE_INTEGER + 1 }, getter];
  for (const value of malformed) {
    const events = new Events();
    assert.throws(() => createWKHostTransport(value, async () => refusal, events), genericError);
    assert.equal(events.listeners.size, 0);
  }
  assert.equal(getterCalls, 0);
  const mutable: { v: number; connectionId: string; generation: number } = { ...bootstrap };
  const transport = createWKHostTransport(mutable, async () => refusal, new Events());
  mutable.connectionId = 'changed-after-construction'; mutable.generation = 9;
  assert.deepEqual(transport.context, context);
  transport.dispose();
});

test('invalid and oversized wire envelopes never reach WK and errors contain no input', async () => {
  let calls = 0;
  const transport = createWKHostTransport(bootstrap, async () => { calls += 1; return refusal; }, new Events());
  transport.listen(() => {}, () => {});
  for (const value of ['INVENTED-PRIVATE', 'null', '[]', '"text"', '{"value":1e999}',
    JSON.stringify({ text: '🙂'.repeat(NATIVE_PROOF_LIMITS.envelopeBytes / 4) })]) {
    await assert.rejects(transport.send(value), genericError);
  }
  assert.equal(calls, 0);
  transport.dispose();
});

test('unsupported, cyclic, accessor and oversized replies reject generically without being delivered', async () => {
  let getterCalls = 0;
  const getter = { get body() { getterCalls += 1; return 'INVENTED-PRIVATE'; } };
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  const replies: unknown[] = [null, 'INVENTED-PRIVATE', [], { value: undefined }, { value: NaN }, { value: 1n },
    { value: new Date() }, { value: () => 'INVENTED-PRIVATE' }, { value: Symbol('INVENTED-PRIVATE') },
    { value: new Array(2) }, { [Symbol('INVENTED-PRIVATE')]: true }, getter, cyclic,
    { body: '🙂'.repeat(NATIVE_PROOF_LIMITS.envelopeBytes / 4) }];
  for (const reply of replies) {
    const transport = createWKHostTransport(bootstrap, async () => reply, new Events());
    let received = 0;
    transport.listen(() => { received += 1; }, () => {});
    await assert.rejects(transport.send(wire), genericError);
    assert.equal(received, 0);
    transport.dispose();
  }
  assert.equal(getterCalls, 0);
});

test('foreign contexts, malformed events and other host event types do not revoke the connection', async () => {
  const events = new Events(); let revoked = 0; let received = 0;
  const transport = createWKHostTransport(bootstrap, async () => refusal, events);
  transport.listen(() => { received += 1; }, () => { revoked += 1; });
  for (const detail of [null, [], 'INVENTED-PRIVATE', connection({ connectionId: 'foreign' }),
    connection({ generation: 3 }), connection({ generation: '4' }), connection({ state: 'unknown' }),
    connection({ reason: null }), connection({ extra: true }), connection({ type: 'dictation.final' }),
    connection({ type: 'dictation.receipt' }), connection({ state: 'ready' })]) events.emit(detail);
  const malformed = new Event('trueconvo-host');
  Object.defineProperty(malformed, 'detail', { get() { throw new Error('INVENTED-PRIVATE'); } });
  events.dispatchEvent(malformed);
  assert.equal(revoked, 0); assert.equal(events.listeners.size, 1);
  await transport.send(wire); assert.equal(received, 1);
  transport.dispose(); assert.equal(revoked, 1); assert.equal(events.listeners.size, 0);
});

test('lock or revocation before send closes permanently, detaches and cannot be reopened by ready', async () => {
  for (const state of ['locked', 'revoked']) {
    const events = new Events(); let calls = 0; let revoked = 0;
    const transport = createWKHostTransport(bootstrap, async () => { calls += 1; return refusal; }, events);
    const detach = transport.listen(() => {}, () => { revoked += 1; });
    events.emit(connection({ state }));
    assert.equal(revoked, 1); assert.equal(events.listeners.size, 0);
    events.emit(connection({ state: 'ready' }));
    await assert.rejects(transport.send(wire), genericError);
    detach(); transport.dispose();
    assert.equal(calls, 0); assert.equal(revoked, 1);
  }
});

test('inflight reply and rejection after revocation are consumed and never delivered', async () => {
  for (const rejected of [false, true]) {
    const events = new Events(); const pending = deferred(); let received = 0; let revoked = 0;
    const transport = createWKHostTransport(bootstrap, () => pending.promise, events);
    transport.listen(() => { received += 1; }, () => { revoked += 1; });
    const sent = transport.send(wire);
    events.emit(connection());
    assert.equal(events.listeners.size, 0); assert.equal(revoked, 1);
    if (rejected) pending.reject(new Error('INVENTED-PRIVATE-LATE-FAILURE'));
    else pending.resolve(refusal);
    await assert.doesNotReject(sent);
    assert.equal(received, 0);
    events.emit(connection({ state: 'ready' }));
    await assert.rejects(transport.send(wire), genericError);
  }
});

test('client is revoked immediately during a pending native dispatch', async () => {
  const events = new Events(); const pending = deferred();
  const transport = createWKHostTransport(bootstrap, () => pending.promise, events);
  const codec = new NativeProofCodec(context, 5);
  const client = new NativeHostClient(transport, codec, {
    ...transport.context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 5, timeoutMs: 1_000,
  });
  const outcome = client.request(request);
  events.emit(connection());
  assert.deepEqual(await outcome, { kind: 'unknown', reason: 'revoked' });
  pending.resolve(refusal);
  assert.deepEqual(await client.request(request), { kind: 'unavailable', reason: 'revoked' });
  assert.equal(events.listeners.size, 0);
  codec.revoke();
});

test('one lifetime subscription and explicit disposal leave no orphan listeners or callbacks', async () => {
  const events = new Events(); let revoked = 0;
  const transport = createWKHostTransport(bootstrap, async () => refusal, events);
  await assert.rejects(transport.send(wire), genericError);
  const detach = transport.listen(() => {}, () => { revoked += 1; });
  assert.throws(() => transport.listen(() => {}, () => {}), genericError);
  assert.equal(events.listeners.size, 1);
  detach(); detach();
  assert.equal(revoked, 1); assert.equal(events.listeners.size, 0);
  assert.throws(() => transport.listen(() => {}, () => {}), genericError);
  await assert.rejects(transport.send(wire), genericError);

  const disposed = createWKHostTransport(bootstrap, async () => refusal, events);
  disposed.dispose();
  disposed.listen(() => assert.fail('Disposed transport delivered a reply.'), () => { revoked += 1; });
  assert.equal(revoked, 2); assert.equal(events.listeners.size, 0);
});
