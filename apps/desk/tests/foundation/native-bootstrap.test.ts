import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeNativeProof, nativeProofId } from '../../src/app/native-bootstrap';

const vectors = JSON.parse(readFileSync(new URL('../fixtures/native-host-v1.json', import.meta.url), 'utf8'));
const bootstrap = { v: 1, connectionId: vectors.context.connectionId, generation: vectors.context.documentGeneration };
const nextIds = () => {
  let index = 0;
  return () => `a0000000-0000-4000-8000-${String(++index).padStart(12, '0')}`;
};
const replyFor = (envelope: Record<string, unknown>) => {
  const found = vectors.cases.find((entry: { name: unknown }) => entry.name === envelope.operation);
  return { ...structuredClone(found.reply), requestId: envelope.requestId, connectionId: envelope.connectionId,
    generation: envelope.generation };
};
function lock(events: EventTarget) {
  events.dispatchEvent(Object.assign(new Event('trueconvo-host'), {
    detail: { type: 'host.connection', connectionId: bootstrap.connectionId, generation: bootstrap.generation,
      state: 'locked', reason: 'locked' },
  }));
}

test('native initialization negotiates capabilities, then reads through the same native workspace port', async () => {
  const events = new EventTarget();
  const sent: Record<string, unknown>[] = [];
  const result = await initializeNativeProof({ bootstrap, events, postMessage: async (envelope) => {
    sent.push(envelope); return replyFor(envelope);
  } }, { requestId: nextIds(), timeoutMs: 100 });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.equal(result.runtime.mode, 'native-proof');
  assert.deepEqual(sent.map((request) => request.operation), ['host.capabilities']);
  const loaded = await result.runtime.workspace.loadLatest();
  assert.equal(loaded.kind, 'ready');
  if (loaded.kind === 'ready') assert.equal(loaded.state.goals[0]!.id, 'A1000000-0000-1000-8000-000000000001');
  assert.deepEqual(sent.map((request) => request.operation), ['host.capabilities', 'workspace.read']);
  assert.match(result.runtime.createId!(), /^[0-9a-f-]{36}$/);
  result.runtime.revoke();
  assert.equal(result.runtime.isActive(), false);
  assert.equal((await result.runtime.workspace.loadLatest()).kind, 'unavailable');
  assert.equal(sent.length, 2);
});

for (const condition of ['missing', 'corrupt', 'locked', 'refused', 'malformed'] as const) {
  test(`native ${condition} capability state never mounts a runtime or seeds a replacement`, async () => {
    const operations: unknown[] = [];
    const result = await initializeNativeProof({ bootstrap, events: new EventTarget(), postMessage: async (envelope) => {
      operations.push(envelope.operation);
      const reply = replyFor(envelope);
      if (condition === 'refused') {
        delete reply.capabilities; reply.outcome = 'refused'; reply.reason = 'store-locked';
      } else if (condition === 'malformed') reply.capabilities.unexpected = 'not accepted';
      else if (condition === 'locked') reply.capabilities.lock = 'locked';
      else reply.capabilities.store = condition;
      return reply;
    } }, { requestId: nextIds(), timeoutMs: 10 });
    assert.equal(result.kind, 'unavailable');
    assert.deepEqual(operations, ['host.capabilities']);
  });
}

test('missing or failed host transport exposes no native details and selects no browser authority', async () => {
  let sends = 0;
  const postMessage = async () => { ++sends; throw new Error('invented private diagnostic must stay out of UI'); };
  const invalid = await initializeNativeProof({ bootstrap: undefined, events: new EventTarget(), postMessage });
  assert.equal(invalid.kind, 'unavailable');
  assert.equal(sends, 0);
  const failed = await initializeNativeProof({ bootstrap, events: new EventTarget(), postMessage }, { requestId: nextIds() });
  assert.equal(failed.kind, 'unavailable');
  assert.equal(sends, 1);
  assert.ok(!JSON.stringify(failed).includes('private diagnostic'));
});

test('lock during capability negotiation remains unavailable after the late response', async () => {
  const events = new EventTarget();
  let release!: (reply: unknown) => void;
  let envelope!: Record<string, unknown>;
  const pending = initializeNativeProof({ bootstrap, events, postMessage: (value) => {
    envelope = value; return new Promise((resolve) => { release = resolve; });
  } }, { requestId: nextIds(), timeoutMs: 100 });
  lock(events);
  assert.equal((await pending).kind, 'unavailable');
  release(replyFor(envelope));
  await Promise.resolve();
  assert.equal((await pending).kind, 'unavailable');
});

test('lock clears runtime and repository while a read is still pending', async () => {
  const events = new EventTarget();
  let release!: (reply: unknown) => void;
  let readEnvelope!: Record<string, unknown>;
  const result = await initializeNativeProof({ bootstrap, events, postMessage: async (envelope) => {
    if (envelope.operation === 'host.capabilities') return replyFor(envelope);
    readEnvelope = envelope;
    return new Promise((resolve) => { release = resolve; });
  } }, { requestId: nextIds(), timeoutMs: 100 });
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  let invalidations = 0;
  result.runtime.subscribeInvalidation(() => { ++invalidations; });
  const read = result.runtime.workspace.loadLatest();
  lock(events);
  assert.equal(result.runtime.isActive(), false);
  assert.equal(invalidations, 1);
  assert.equal((await read).kind, 'unavailable');
  release(replyFor(readEnvelope));
  await Promise.resolve();
  assert.equal(result.runtime.isActive(), false);
  assert.equal(invalidations, 1);
});

test('native request IDs are canonical UUIDv4 without depending on randomUUID', () => {
  assert.match(nativeProofId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

for (const operation of ['workspace.read', 'workspace.commitProof'] as const) {
  test(`${operation} lock refusal clears the runtime without a separate host event and ignores a late read`, async () => {
    for (const reason of ['store-locked', 'locked']) {
      const events = new EventTarget();
      const sent: Record<string, unknown>[] = [];
      let reads = 0;
      let release!: (reply: unknown) => void;
      let retainedRead!: Record<string, unknown>;
      const result = await initializeNativeProof({ bootstrap, events, postMessage: async (envelope) => {
        sent.push(envelope);
        if (envelope.operation === 'workspace.read' && ++reads === 2) {
          retainedRead = envelope;
          return new Promise((resolve) => { release = resolve; });
        }
        if (envelope.operation === operation && (operation === 'workspace.commitProof' || reads === 3)) {
          return { v: 1, connectionId: envelope.connectionId, generation: envelope.generation,
            requestId: envelope.requestId, operation, outcome: 'refused', reason };
        }
        return replyFor(envelope);
      } }, { requestId: nextIds(), timeoutMs: 100 });
      assert.equal(result.kind, 'ready');
      if (result.kind !== 'ready') return;
      const loaded = await result.runtime.workspace.loadLatest();
      assert.equal(loaded.kind, 'ready');
      if (loaded.kind !== 'ready') return;
      let invalidations = 0;
      result.runtime.subscribeInvalidation(() => { ++invalidations; result.runtime.revoke(); });
      const pendingRead = result.runtime.workspace.loadLatest();
      const changed = structuredClone(loaded.state);
      changed.revision++;
      const locked = operation === 'workspace.read' ? result.runtime.workspace.loadLatest()
        : result.runtime.workspace.save(changed, loaded.state.revision);
      for (const reply of await Promise.all([locked, pendingRead])) {
        assert.equal(reply.kind, 'unavailable');
        assert.deepEqual(Object.keys(reply).sort(), ['error', 'kind']);
      }
      assert.equal(result.runtime.isActive(), false);
      assert.equal(invalidations, 1);
      release(replyFor(retainedRead));
      await Promise.resolve();
      assert.equal(result.runtime.isActive(), false);
      assert.equal(invalidations, 1);
      assert.equal((await result.runtime.workspace.loadLatest()).kind, 'unavailable');
      assert.equal((await result.runtime.workspace.save(changed, loaded.state.revision)).kind, 'unavailable');
      assert.equal(sent.length, 4);
      result.runtime.revoke();
      assert.equal(invalidations, 1);
    }
  });
}
