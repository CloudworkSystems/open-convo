import assert from 'node:assert/strict';
import test from 'node:test';
import { ConversationRunController, MAX_PENDING_PARTICIPANT_EVENTS, MAX_PENDING_PARTICIPANT_BYTES, RUN_CHECKPOINT_INTERVAL_MS, PARTICIPANT_STOP_TIMEOUT_MS } from '../../src/adapters/participant-runtime';
import type { ParticipantPort, ParticipantStartInput, ParticipantStartResult, ParticipantStopResult,
  ParticipantReconcileResult, ParticipantStatusResult, ParticipantTarget, RunCheckpoint, RunCheckpointResult, ParticipantRuntimeScheduler, ConversationRunControllerOptions } from '../../src/adapters/participant-runtime';
import { appendParticipantEvent, createConversationRun, MAX_RUN_CHUNK_BYTES, isConversationRunClosed } from '../../src/domain/conversation-runs';
import { canAdmitConversationRun, prepareConversationRun, saveConversationRunCheckpoint } from '../../src/domain/conversation-workspace';
import { createDemoState } from '../../src/domain/demo';
import { validateState } from '../../src/domain/validation';
import type { ConversationRun, ParticipantEvent } from '../../src/domain/conversation-run-types';

const participant = { id: 'invented-participant', label: 'Invented participant', model: 'mock-model', executionHost: 'test-only' };
function prepared(): ConversationRun {
  const result = createConversationRun({ runId: '11111111-1111-4111-8111-111111111111',
    sessionId: '22222222-2222-4222-8222-222222222222', userMessageId: '33333333-3333-4333-8333-333333333333',
    assistantMessageId: '44444444-4444-4444-8444-444444444444', participant, input: 'Invented input only.',
    createdAt: '2026-10-09T00:00:00.000Z' });
  assert.equal(result.kind, 'ok');
  if (result.kind !== 'ok') throw new Error('fixture');
  return result.run;
}
function event(sequence: number, type: ParticipantEvent['type'], text = ''): ParticipantEvent {
  return { runId: prepared().runId, sessionId: prepared().sessionId, sequence,
    at: new Date(Date.parse(prepared().createdAt) + sequence).toISOString(), type, ...(type === 'text' ? { text } : {}) } as ParticipantEvent;
}
function withEvents(...events: ParticipantEvent[]): ConversationRun {
  let run = prepared();
  for (const next of events) {
    const result = appendParticipantEvent(run, next);
    assert.equal(result.kind, 'ok');
    if (result.kind === 'ok') run = result.run;
  }
  return run;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const ack = (record: Readonly<ConversationRun>): RunCheckpointResult => ({ kind: 'saved', record: structuredClone(record) });

class InventedPort implements ParticipantPort {
  identity = { ...participant };
  listener: ((event: unknown) => void) | null = null;
  oldListener: ((event: unknown) => void) | null = null;
  unsubscribes = 0;
  starts: ParticipantStartInput[] = [];
  stops: ParticipantTarget[] = [];
  queries: (ParticipantTarget & { afterSequence: number })[] = [];
  order: string[] = [];
  startResult: (input: ParticipantStartInput) => Promise<ParticipantStartResult> = async () => ({ kind: 'accepted' });
  stopResult: () => Promise<ParticipantStopResult> = async () => ({ kind: 'unknown' });
  reconcileResult: () => Promise<ParticipantReconcileResult> = async () => ({ kind: 'unknown' });
  subscribe(listener: (event: unknown) => void) {
    this.order.push('subscribe');
    this.listener = listener;
    this.oldListener = listener;
    return () => { this.unsubscribes++; this.listener = null; };
  }
  start(input: ParticipantStartInput) { this.order.push('start'); this.starts.push(input); return this.startResult(input); }
  stop(target: ParticipantTarget) { this.stops.push(target); return this.stopResult(); }
  reconcile(target: ParticipantTarget & { afterSequence: number }) { this.queries.push(target); return this.reconcileResult(); }
  emit(value: unknown) { this.listener?.(value); }
}
class ManualScheduler implements ParticipantRuntimeScheduler {
  time = Date.parse('2026-10-09T00:00:00.000Z');
  nextId = 0;
  timers = new Map<number, { callback: () => void; at: number }>();
  yields = 0;
  onYield = () => {};
  now() { return this.time; }
  setTimeout(callback: () => void, delayMs: number) { const id = ++this.nextId; this.timers.set(id, { callback, at: this.time + delayMs }); return id; }
  clearTimeout(handle: unknown) { this.timers.delete(handle as number); }
  async yield() { this.yields++; this.onYield(); }
  advance(ms: number) {
    this.time += ms;
    for (const [id, timer] of this.timers) if (timer.at <= this.time) { this.timers.delete(id); timer.callback(); }
  }
}
function setup(checkpoint: RunCheckpoint = async (record) => ack(record), run = prepared(), mode: 'new' | 'restored' = 'new', options: Partial<ConversationRunControllerOptions> = {}) {
  const port = new InventedPort();
  const scheduler = new ManualScheduler();
  const controller = new ConversationRunController({ run, port, checkpoint, mode, scheduler, ...options });
  return { port, controller, scheduler };
}

test('prepared checkpoint must be durably acknowledged before one dispatch; the subscribed, immutable input contains only authorized fields', async () => {
  const save = deferred<RunCheckpointResult>();
  let attempted: Readonly<ConversationRun> | undefined;
  const { controller, port } = setup(async (record) => { attempted = record; return save.promise; });
  const start = controller.start();
  await controller.start();
  await tick();
  assert.equal(port.starts.length, 0);
  assert.equal(attempted?.phase, 'prepared');
  assert.deepEqual(port.order, ['subscribe']);
  save.resolve(ack(attempted!));
  await start;
  assert.deepEqual(port.order, ['subscribe', 'start']);
  assert.equal(port.starts.length, 1);
  assert.equal(controller.snapshot.run.phase, 'prepared', 'accepted ACK is not started event');
  assert.equal(controller.snapshot.run.lastSequence, 0);
  assert.equal(controller.snapshot.status, 'starting');
  assert.equal(controller.snapshot.persistedSequence, 0);
  const input = port.starts[0]!;
  assert.deepEqual(Object.keys(input).sort(), ['assistantMessageId', 'inputChunks', 'participant', 'runId', 'sessionId', 'userMessageId']);
  assert.equal(Object.isFrozen(input), true);
  assert.equal(Object.isFrozen(input.participant), true);
  assert.equal(Object.isFrozen(input.inputChunks), true);
  assert.throws(() => (input.inputChunks as string[]).push('not authorized'));
  port.identity.model = 'changed outside';
  assert.equal(input.participant.model, participant.model);
  await controller.start();
  assert.equal(port.starts.length, 1);
  controller.dispose();
});

test('wrong initial save acknowledgement stays unknown, holds all writes, and requires the exact original checkpoint before explicit start', async () => {
  const attempted: ConversationRun[] = [];
  const { controller, port } = setup(async (record) => {
    attempted.push(structuredClone(record));
    return ack({ ...record, assistantMessageId: '55555555-5555-4555-8555-555555555555' });
  });
  await controller.start();
  assert.equal(port.starts.length, 0);
  assert.equal(controller.snapshot.checkpointState, 'unknown');
  await controller.flush();
  await controller.start();
  assert.equal(attempted.length, 1);
  assert.equal(controller.confirmCheckpoint({ ...attempted[0]!, inputChunks: ['different'] }), false);
  assert.equal(controller.confirmCheckpoint(attempted[0]!), true);
  await tick();
  assert.equal(port.starts.length, 0, 'reconciliation is not automatic dispatch');
  await controller.start();
  assert.equal(port.starts.length, 1);
  assert.equal(attempted.length, 1);
  controller.dispose();
});

test('sequential checkpoints coalesce streaming deltas and acknowledge only the exact saved prefix', async () => {
  const gate = deferred<RunCheckpointResult>();
  const saved: ConversationRun[] = [];
  let active = 0;
  let maximum = 0;
  const { controller, port } = setup(async (record) => {
    active++;
    maximum = Math.max(maximum, active);
    saved.push(structuredClone(record));
    const result = saved.length === 2 ? await gate.promise : ack(record);
    active--;
    return result;
  });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'first\n'));
  void controller.flush();
  await tick();
  assert.equal(saved.length, 2);
  for (let sequence = 3; sequence <= 100; sequence++) port.emit(event(sequence, 'text', ` literal ${sequence} `));
  assert.equal(saved.length, 2, 'no per-delta write queue');
  assert.equal(controller.snapshot.persistedPrefix, '');
  assert.equal(controller.snapshot.unsavedTail, controller.snapshot.outputText);
  const output = controller.snapshot.outputText;
  gate.resolve(ack(saved[1]!));
  await controller.flush();
  assert.equal(saved.length, 3);
  assert.equal(maximum, 1);
  assert.equal(controller.snapshot.run.lastSequence, 100);
  assert.equal(controller.snapshot.persistedSequence, 100);
  assert.equal(controller.snapshot.persistedPrefix, output);
  assert.equal(controller.snapshot.unsavedTail, '');
  assert.deepEqual(saved[2]!.outputChunks, controller.snapshot.run.outputChunks);
  controller.dispose();
});

test('an unknown checkpoint latches while literal later output remains volatile; exact reconciliation releases one coalesced save', async () => {
  const saved: ConversationRun[] = [];
  const { controller, port } = setup(async (record) => {
    saved.push(structuredClone(record));
    return saved.length === 2 ? { kind: 'unknown' } : ack(record);
  });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'A'));
  await controller.flush();
  port.emit(event(3, 'text', '\nB  '));
  port.emit(event(4, 'completed'));
  await controller.flush();
  await tick();
  assert.equal(saved.length, 2);
  assert.equal(controller.snapshot.status, 'terminal');
  assert.equal(controller.snapshot.checkpointState, 'unknown');
  assert.equal(controller.snapshot.outputText, 'A\nB  ');
  assert.equal(controller.snapshot.unsavedTail, 'A\nB  ');
  assert.equal(controller.confirmCheckpoint(controller.snapshot.run as ConversationRun), false, 'newer snapshot is not the uncertain write');
  assert.equal(controller.confirmCheckpoint(saved[1]!), true);
  assert.equal(controller.snapshot.persistedPrefix, 'A');
  assert.equal(controller.snapshot.unsavedTail, '\nB  ');
  await controller.flush();
  assert.equal(saved.length, 3);
  assert.equal(controller.snapshot.run.phase, 'completed');
  assert.equal(controller.snapshot.unsavedTail, '');
  controller.dispose();
});

test('checkpoint throw is unknown; authoritative not-saved reconciliation permits only an explicit retry', async () => {
  const saved: ConversationRun[] = [];
  const { controller, port } = setup(async (record) => {
    saved.push(structuredClone(record));
    if (saved.length === 2) throw new Error('invented transport failure');
    return ack(record);
  });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'retained'));
  await controller.flush();
  assert.equal(controller.snapshot.error, 'checkpoint-unknown');
  assert.equal(controller.resolveCheckpoint({ kind: 'not-saved', record: saved[1]! }), true);
  port.emit(event(3, 'text', ' still retained'));
  await tick();
  assert.equal(saved.length, 2, 'new output does not automatically retry a definite failure');
  assert.equal(controller.snapshot.error, 'checkpoint-failed');
  assert.equal(controller.snapshot.outputText, 'retained still retained');
  await controller.flush();
  assert.equal(saved.length, 3);
  assert.equal(controller.snapshot.persistedPrefix, 'retained still retained');
  controller.dispose();
});

test('stop reaches the owned port immediately during an unresolved prepared save and prevents later dispatch', async () => {
  const save = deferred<RunCheckpointResult>();
  const records: ConversationRun[] = [];
  const { controller, port } = setup(async (record) => {
    records.push(structuredClone(record));
    return records.length === 1 ? save.promise : ack(record);
  });
  port.stopResult = async () => ({ kind: 'confirmed', event: event(1, 'stopped') });
  const start = controller.start();
  await tick();
  const stop = controller.stop();
  assert.equal(port.stops.length, 1);
  assert.equal(port.starts.length, 0);
  await stop;
  assert.equal(controller.snapshot.run.phase, 'stopped');
  assert.equal(controller.snapshot.stopState, 'confirmed');
  save.resolve(ack(records[0]!));
  await start;
  await controller.flush();
  assert.equal(port.starts.length, 0);
  assert.equal(records.length, 2);
  assert.equal(controller.snapshot.savedRecord?.phase, 'stopped');
  controller.dispose();
});

test('stop is independent of an unresolved output save; unknown cancel does not invent stopped', async () => {
  const save = deferred<RunCheckpointResult>();
  const records: ConversationRun[] = [];
  const { controller, port } = setup(async (record) => {
    records.push(structuredClone(record));
    return records.length === 2 ? save.promise : ack(record);
  });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'partial'));
  void controller.flush();
  await tick();
  await controller.stop();
  assert.equal(port.stops.length, 1);
  assert.equal(controller.snapshot.run.phase, 'running');
  assert.equal(controller.snapshot.stopState, 'unknown');
  assert.equal(controller.snapshot.status, 'unknown');
  await controller.stop();
  assert.equal(port.stops.length, 2, 'an explicit retry is allowed after the first Stop remained unknown');
  port.emit(event(3, 'text', ' late'));
  assert.equal(controller.snapshot.status, 'unknown');
  port.emit(event(4, 'stopped'));
  port.emit(event(5, 'text', 'must not revive'));
  assert.equal(controller.snapshot.run.phase, 'stopped');
  assert.equal(controller.snapshot.outputText, 'partial late');
  save.resolve(ack(records[1]!));
  await controller.flush();
  assert.equal(controller.snapshot.persistedPrefix, 'partial late');
  controller.dispose();
});

test('uncertain start never retries dispatch; confirmed events can settle its status', async () => {
  const { controller, port } = setup();
  port.startResult = async () => { throw new Error('invented lost ACK'); };
  await controller.start();
  assert.equal(controller.snapshot.status, 'unknown');
  assert.equal(controller.snapshot.run.phase, 'prepared');
  assert.equal(controller.snapshot.canStart, false, 'unknown dispatch must not become an explicit duplicate start');
  await controller.start();
  await controller.flush();
  assert.equal(port.starts.length, 1);
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'observed despite lost ACK'));
  assert.equal(controller.snapshot.status, 'running');
  await controller.flush();
  assert.equal(controller.snapshot.persistedPrefix, 'observed despite lost ACK');
  controller.dispose();
});

test('restored prepared/running records subscribe and reconcile but never start, including repeated explicit start calls', async () => {
  for (const run of [prepared(), withEvents(event(1, 'started'), event(2, 'text', 'saved'))]) {
    let saves = 0;
    const { controller, port } = setup(async (record) => { saves++; return ack(record); }, run, 'restored');
    assert.equal(controller.snapshot.status, 'unknown');
    assert.equal(controller.snapshot.persistedSequence, run.lastSequence);
    assert.equal(controller.snapshot.canStart, false, 'restored prepared evidence does not prove this controller may start');
    await controller.start();
    await controller.start();
    assert.equal(port.starts.length, 0);
    assert.equal(saves, 0);
    port.reconcileResult = async () => ({ kind: 'events', events: run.phase === 'prepared'
      ? [event(1, 'started'), event(2, 'text', 'recovered'), event(3, 'completed')]
      : [event(2, 'text', 'saved'), event(3, 'text', ' plus recovered'), event(4, 'completed')] });
    await controller.reconcile();
    await controller.flush();
    assert.equal(port.queries[0]!.afterSequence, run.lastSequence);
    assert.equal(controller.snapshot.run.phase, 'completed');
    assert.equal(controller.snapshot.outputText, run.phase === 'prepared' ? 'recovered' : 'saved plus recovered');
    assert.equal(port.starts.length, 0);
    controller.dispose();
  }
});

test('saved unknown records cannot be revived by streamed events and never dispatch again', async () => {
  const known = withEvents(event(1, 'started'), event(2, 'text', 'known'));
  const { controller, port } = setup(undefined, { ...known, phase: 'unknown' }, 'restored');
  port.reconcileResult = async () => ({ kind: 'events', events: [event(3, 'text', 'unknown continuation')] });
  await controller.reconcile();
  assert.equal(controller.snapshot.run.phase, 'unknown');
  assert.equal(controller.snapshot.outputText, 'known');
  port.reconcileResult = async () => ({ kind: 'unknown' });
  await controller.reconcile();
  assert.equal(controller.snapshot.run.phase, 'unknown');
  assert.equal(controller.snapshot.pendingEvents.length, 1);
  await controller.flush();
  assert.equal(port.starts.length, 0);
  controller.dispose();
});

test('foreign IDs are ignored; a sequence gap retains literal text until reconcile supplies the missing event', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit({ ...event(1, 'started'), runId: '55555555-5555-4555-8555-555555555555' });
  assert.equal(controller.snapshot.run.lastSequence, 0);
  port.emit(event(1, 'started'));
  port.emit(event(3, 'text', 'B'));
  assert.equal(controller.snapshot.run.lastSequence, 1);
  assert.equal(controller.snapshot.outputText, '', 'gapped text is not manufactured transcript continuity');
  assert.deepEqual(controller.snapshot.pendingEvents, [event(3, 'text', 'B')]);
  assert.equal(controller.snapshot.pendingEvents.length, 1);
  assert.equal(controller.snapshot.status, 'unknown');
  port.reconcileResult = async () => ({ kind: 'events', events: [event(2, 'text', 'A'), event(3, 'text', 'B')] });
  await controller.reconcile();
  assert.equal(controller.snapshot.outputText, 'AB');
  assert.equal(controller.snapshot.run.lastSequence, 3);
  assert.equal(controller.snapshot.pendingEvents.length, 0);
  await controller.flush();
  controller.dispose();
});

test('overlimit output preserves the exact prefix, stops once, and records later terminal evidence across the gap', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  for (let sequence = 2; sequence <= 16; sequence++) port.emit(event(sequence, 'text', 'x'.repeat(MAX_RUN_CHUNK_BYTES)));
  const prefix = controller.snapshot.outputText;
  port.emit(event(17, 'text', 'y'.repeat(MAX_RUN_CHUNK_BYTES)));
  assert.equal(controller.snapshot.outputText, prefix);
  assert.equal(controller.snapshot.run.lastSequence, 16);
  assert.equal(port.stops.length, 1);
  assert.equal(controller.snapshot.pendingEvents.length, 1);
  const terminal = { ...event(18, 'stopped'), reason: 'reply-too-long' as const };
  port.emit(terminal);
  assert.equal(controller.snapshot.status, 'terminal');
  assert.equal(controller.snapshot.stopState, 'confirmed');
  assert.equal(controller.snapshot.run.phase, 'running', 'the missing sequence is not invented');
  assert.equal(controller.snapshot.run.lastSequence, 16);
  assert.deepEqual(controller.snapshot.run.closure, { kind: 'interrupted', reason: 'event-refused', at: terminal.at, terminalEvent: terminal });
  assert.equal(controller.snapshot.outputText, prefix);
  await controller.flush();
  assert.equal(controller.snapshot.persistedPrefix, prefix);
  assert.equal(controller.snapshot.savedRecord?.closure?.kind, 'interrupted');
  port.emit(event(19, 'text', 'must not revive'));
  assert.equal(controller.snapshot.outputText, prefix);
  controller.dispose();
});

test('a bounded gap flood stops once and remains explicitly incomplete when terminal evidence arrives', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  for (let sequence = 3; sequence < 1000; sequence++) port.emit(event(sequence, 'text', 'x'));
  assert.equal(controller.snapshot.pendingEvents.length, MAX_PENDING_PARTICIPANT_EVENTS);
  assert.equal(controller.snapshot.outputText, '');
  assert.equal(controller.snapshot.eventBufferOverflow, true);
  assert.equal(port.stops.length, 1);
  const totalBytes = controller.snapshot.pendingEvents.reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0);
  assert.ok(totalBytes <= MAX_PENDING_PARTICIPANT_BYTES);
  port.emit(event(1000, 'completed'));
  assert.equal(controller.snapshot.run.lastSequence, 1);
  assert.equal(controller.snapshot.run.phase, 'running');
  assert.equal(controller.snapshot.run.closure?.kind, 'interrupted');
  assert.equal(controller.snapshot.outputText, '');
  assert.equal(controller.snapshot.stopState === 'confirmed', false, 'completion is not Stop confirmation');
  assert.equal(controller.snapshot.pendingEvents.length, MAX_PENDING_PARTICIPANT_EVENTS);
  await controller.flush();
  controller.dispose();
});

test('an external exact retry acknowledgment advances a definitely failed checkpoint without claiming a newer snapshot', async () => {
  const records: ConversationRun[] = [];
  const { controller, port } = setup(async (record) => {
    records.push(structuredClone(record));
    return records.length === 2 ? { kind: 'not-saved' } : ack(record);
  });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'saved by retry'));
  await controller.flush();
  port.emit(event(3, 'text', ' newer'));
  await tick();
  assert.equal(records.length, 2);
  assert.equal(controller.snapshot.checkpointState, 'failed');
  assert.equal(controller.confirmCheckpoint(controller.snapshot.run as ConversationRun), false);
  assert.equal(controller.confirmCheckpoint(records[1]!), true);
  assert.equal(controller.snapshot.persistedPrefix, 'saved by retry');
  assert.equal(controller.snapshot.unsavedTail, ' newer');
  await controller.flush();
  assert.equal(controller.snapshot.persistedPrefix, 'saved by retry newer');
  controller.dispose();
});

test('synchronous subscribe emissions restore evidence safely, but unsolicited new-run emissions cannot authorize a start', async () => {
  class SynchronousPort extends InventedPort {
    override subscribe(listener: (event: unknown) => void) {
      const remove = super.subscribe(listener);
      listener(event(1, 'started'));
      listener(event(2, 'text', 'already observed'));
      return remove;
    }
  }
  const port = new SynchronousPort();
  const controller = new ConversationRunController({ run: prepared(), port, checkpoint: async (run) => ack(run), mode: 'restored' });
  assert.equal(controller.snapshot.outputText, 'already observed');
  assert.equal(port.starts.length, 0);
  await controller.flush();
  controller.dispose();
  assert.equal(port.unsubscribes, 1);
  const freshPort = new SynchronousPort();
  const fresh = new ConversationRunController({ run: prepared(), port: freshPort, checkpoint: async (run) => ack(run), mode: 'new' });
  assert.equal(fresh.snapshot.run.lastSequence, 0);
  assert.equal(fresh.snapshot.outputText, '');
  assert.equal(freshPort.starts.length, 0);
  fresh.dispose();
});

test('dispose unsubscribes once, ignores late callbacks/results, preserves output, and never calls remote stop', async () => {
  const start = deferred<ParticipantStartResult>();
  const save = deferred<RunCheckpointResult>();
  const records: ConversationRun[] = [];
  const { controller, port } = setup(async (record) => {
    records.push(structuredClone(record));
    return records.length === 2 ? save.promise : ack(record);
  });
  port.startResult = () => start.promise;
  const starting = controller.start();
  await tick();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'retained locally'));
  void controller.flush();
  await tick();
  let notices = 0;
  controller.subscribe(() => { notices++; });
  controller.dispose();
  controller.dispose();
  const noticesAfterDispose = notices;
  port.oldListener?.(event(3, 'text', 'late'));
  save.resolve(ack(records[1]!));
  start.reject(new Error('late transport error'));
  await starting;
  await tick();
  assert.equal(port.unsubscribes, 1);
  assert.equal(port.stops.length, 0);
  assert.equal(controller.snapshot.status, 'disposed');
  assert.equal(controller.snapshot.outputText, 'retained locally');
  assert.equal(controller.snapshot.persistedSequence, 0, 'disposed callbacks do not revive persistence claims');
  assert.equal(notices, noticesAfterDispose);
});

test('a synchronous status observer may cancel before start dispatch, and cannot interrupt owned transport by throwing', async () => {
  const { controller, port } = setup();
  controller.subscribe((snapshot) => {
    if (snapshot.status === 'starting') void controller.stop();
    throw new Error('invented observer failure');
  });
  await controller.start();
  assert.equal(port.stops.length, 1);
  assert.equal(port.starts.length, 0);
  controller.dispose();
});

test('terminal restored records are read-only and do not subscribe or dispatch', async () => {
  const run = withEvents(event(1, 'started'), event(2, 'text', 'saved terminal'), event(3, 'completed'));
  const { controller, port } = setup(async () => { throw new Error('must not save'); }, run, 'restored');
  await controller.start();
  await controller.stop();
  await controller.reconcile();
  await controller.flush();
  assert.deepEqual(port.order, []);
  assert.equal(controller.snapshot.status, 'terminal');
  assert.equal(controller.snapshot.persistedPrefix, 'saved terminal');
  assert.equal(port.queries.length, 0);
  controller.dispose();
});

test('participant mismatch refuses construction without opening transport', () => {
  const port = new InventedPort();
  port.identity.model = 'another model';
  assert.throws(() => new ConversationRunController({ run: prepared(), port, checkpoint: async (run) => ack(run), mode: 'new' }),
    /Invalid participant run configuration/);
  assert.deepEqual(port.order, []);
});

test('an exact global retry of failed preparation enables only an explicit first start', async () => {
  let attempted: ConversationRun | undefined;
  const { controller, port } = setup(async (record) => {
    attempted = structuredClone(record);
    return { kind: 'not-saved' };
  });
  assert.equal(controller.snapshot.canStart, false, 'preparation is not yet durable');
  const starting = controller.start();
  assert.equal(controller.snapshot.canStart, false, 'preparing is not a second start opportunity');
  await starting;
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(port.starts.length, 0);
  assert.equal(controller.confirmCheckpoint(attempted!), true);
  assert.equal(controller.snapshot.canStart, true);
  assert.equal(controller.snapshot.status, 'idle', 'an exact Retry save acknowledgment proves only an unsent preparation');
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canCheckStatus, false);
  assert.equal(controller.snapshot.canCloseAsUnknown, false);
  await tick();
  assert.equal(port.starts.length, 0, 'external save acknowledgment never starts a participant');
  await controller.start();
  assert.equal(port.starts.length, 1);
  assert.equal(controller.snapshot.canStart, false);
  await controller.start();
  assert.equal(port.starts.length, 1);
  controller.dispose();
  assert.equal(controller.snapshot.canStart, false);
});

test('a confirmed not-started result permits explicit same-ID start, while an unknown result does not', async () => {
  const { controller, port } = setup();
  port.startResult = async () => ({ kind: 'not-started' });
  await controller.start();
  assert.equal(controller.snapshot.canStart, true);
  assert.equal(controller.snapshot.run.phase, 'prepared');
  assert.equal(port.starts.length, 1);
  port.startResult = async () => ({ kind: 'unknown' });
  await controller.start();
  assert.equal(port.starts.length, 2);
  assert.deepEqual(port.starts[1], port.starts[0], 'explicit retry retains run/session/message IDs and authorized input');
  assert.equal(controller.snapshot.canStart, false);
  await controller.start();
  assert.equal(port.starts.length, 2);
  controller.dispose();
});

test('automatic checkpoints wait five seconds; preparation, explicit flush and terminal saves are immediate', async () => {
  const records: ConversationRun[] = [];
  const { controller, port, scheduler } = setup(async (run) => { records.push(structuredClone(run)); return ack(run); });
  await controller.start();
  assert.equal(records.length, 1);
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'first'));
  await tick();
  assert.equal(records.length, 1);
  scheduler.advance(RUN_CHECKPOINT_INTERVAL_MS - 1);
  await tick();
  assert.equal(records.length, 1);
  scheduler.advance(1);
  await tick();
  assert.equal(records.length, 2);
  assert.equal(records[1]!.outputChunks.join(''), 'first');
  port.emit(event(3, 'text', ' explicit'));
  await controller.flush();
  assert.equal(records.length, 3);
  port.emit(event(4, 'text', ' terminal'));
  port.emit(event(5, 'completed'));
  await tick();
  assert.equal(records.length, 4);
  assert.equal(records[3]!.phase, 'completed');
  assert.equal(scheduler.timers.size, 0);
  controller.dispose();
});

test('an event in checkpoint finalization is drained automatically, with no extra event or manual save', async () => {
  const records: ConversationRun[] = [];
  const { controller, port, scheduler } = setup(async (run) => { records.push(structuredClone(run)); return ack(run); });
  await controller.start();
  let injected = false;
  controller.subscribe((snapshot) => {
    if (!injected && snapshot.saving && snapshot.persistedSequence === 2) {
      injected = true;
      queueMicrotask(() => port.emit(event(3, 'completed')));
    }
  });
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'literal'));
  scheduler.advance(RUN_CHECKPOINT_INTERVAL_MS);
  await tick();
  assert.equal(injected, true);
  assert.equal(records.length, 3);
  assert.equal(controller.snapshot.savedRecord?.phase, 'completed');
  assert.equal(controller.snapshot.persistedSequence, 3);
  assert.equal(controller.snapshot.saving, false);
  controller.dispose();
});

test('blocked is a known unattempted checkpoint, retains streaming output, and accepts only its exact later acknowledgment', async () => {
  const records: ConversationRun[] = [];
  const { controller, port, scheduler } = setup(async (run) => {
    records.push(structuredClone(run));
    return records.length === 2 ? { kind: 'blocked' } : ack(run);
  });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'blocked'));
  await controller.flush();
  assert.equal(controller.snapshot.checkpointState, 'blocked');
  assert.equal(controller.snapshot.error, 'checkpoint-blocked');
  port.emit(event(3, 'text', ' tail'));
  scheduler.advance(10 * RUN_CHECKPOINT_INTERVAL_MS);
  await tick();
  assert.equal(records.length, 2);
  assert.equal(controller.snapshot.outputText, 'blocked tail');
  assert.equal(controller.confirmCheckpoint(controller.currentRun as ConversationRun), false);
  assert.equal(controller.confirmCheckpoint(records[1]!), true);
  assert.equal(controller.snapshot.persistedPrefix, 'blocked');
  assert.equal(controller.snapshot.unsavedTail, ' tail');
  await controller.flush();
  assert.equal(controller.snapshot.persistedPrefix, 'blocked tail');
  controller.dispose();
});

test('explicit unknown closure after an unconfirmed Stop retains saved prefix and gaps without claiming completion', async () => {
  const records: ConversationRun[] = [];
  const { controller, port } = setup(async (run) => {
    records.push(structuredClone(run));
    return records.length === 2 ? { kind: 'unknown' } : ack(run);
  });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'known prefix'));
  await controller.flush();
  port.emit(event(4, 'text', 'gapped'));
  controller.closeAsUnknown();
  assert.equal(controller.currentRun.closure, undefined, 'a gap alone cannot abandon the owned participant');
  await controller.stop();
  controller.closeAsUnknown();
  const closed = controller.currentRun;
  assert.equal(isConversationRunClosed(closed as ConversationRun), true);
  assert.equal(closed.phase, 'running');
  assert.equal(closed.lastSequence, 2);
  assert.deepEqual(closed.closure, { kind: 'unknown', reason: 'user-closed', at: closed.updatedAt });
  assert.equal(controller.snapshot.status, 'unknown');
  assert.equal(controller.snapshot.stopState, 'idle');
  assert.equal(controller.snapshot.pendingEvents.length, 1);
  assert.equal(port.stops.length, 1);
  await controller.flush();
  assert.equal(records.length, 2, 'unknown write remains latched even after explicit local closure');
  assert.equal(controller.confirmCheckpoint(records[1]!), true);
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.closure?.kind, 'unknown');
  assert.equal(controller.snapshot.persistedPrefix, 'known prefix');
  controller.dispose();
  const restored = setup(undefined, closed as ConversationRun, 'restored');
  await restored.controller.start();
  await restored.controller.reconcile();
  assert.equal(restored.port.starts.length, 0);
  assert.equal(restored.port.queries.length, 0);
  assert.equal(restored.controller.snapshot.status, 'unknown');
  restored.controller.dispose();
});

test('pending Stop is deduplicated, unknown Stop permits an explicit retry and status reconciliation', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  const pending = deferred<ParticipantStopResult>();
  port.stopResult = () => pending.promise;
  const stopping = controller.stop();
  await controller.stop();
  assert.equal(port.stops.length, 1);
  pending.resolve({ kind: 'unknown' });
  await stopping;
  await controller.reconcile();
  assert.equal(port.queries.length, 1);
  port.stopResult = async () => ({ kind: 'confirmed', event: { ...event(2, 'stopped'), reason: 'local-stop' } });
  await controller.stop();
  assert.equal(port.stops.length, 2);
  assert.equal(controller.snapshot.run.phase, 'stopped');
  assert.equal(controller.snapshot.run.reason, 'local-stop');
  assert.equal(controller.snapshot.stopState, 'confirmed');
  controller.dispose();
});

test('a subscription failure is unavailable and never saves, dispatches or retains an active timer', async () => {
  const port = new InventedPort();
  const scheduler = new ManualScheduler();
  let saves = 0;
  port.subscribe = (listener) => { port.oldListener = listener; listener(event(1, 'started')); throw new Error('invented unavailable'); };
  const controller = new ConversationRunController({ run: prepared(), port, scheduler, mode: 'new', checkpoint: async (run) => { saves++; return ack(run); } });
  assert.equal(controller.snapshot.available, false);
  assert.equal(controller.snapshot.status, 'unavailable');
  assert.equal(controller.snapshot.error, 'subscription-failed');
  await controller.start();
  await controller.flush();
  await controller.stop();
  port.oldListener?.(event(2, 'text', 'late'));
  assert.equal(saves, 0);
  assert.equal(port.starts.length, 0);
  assert.equal(port.stops.length, 0);
  assert.equal(controller.snapshot.outputText, '');
  assert.equal(scheduler.timers.size, 0);
  controller.dispose();
});

test('workspace admission refusal retains the confirmed prefix and makes later terminal evidence an interrupted closure', async () => {
  const admitted: Readonly<ConversationRun>[] = [];
  const { controller, port } = setup(undefined, prepared(), 'new', { acceptRun: (run) => { admitted.push(run); return admitted.length === 1; } });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'fits'));
  const prefix = controller.currentRun;
  port.emit(event(3, 'text', ' does not fit'));
  assert.equal(Object.isFrozen(admitted[1]), true);
  assert.equal(controller.currentRun, prefix);
  assert.equal(controller.snapshot.outputText, 'fits');
  assert.equal(port.stops.length, 1);
  port.emit(event(4, 'failed'));
  assert.equal(controller.snapshot.run.closure?.kind, 'interrupted');
  assert.equal(controller.snapshot.run.closure?.reason, 'workspace-limit');
  assert.equal(controller.snapshot.run.lastSequence, 2);
  await controller.flush();
  assert.equal(controller.snapshot.persistedPrefix, 'fits');
  controller.dispose();
});

test('contradictory events after not-started prevent resend and retain literal evidence', async () => {
  const { controller, port } = setup();
  port.startResult = async () => ({ kind: 'not-started' });
  await controller.start();
  assert.equal(controller.snapshot.canStart, true);
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'contradictory but observed'));
  assert.equal(controller.snapshot.status, 'unknown');
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(controller.snapshot.outputText, 'contradictory but observed');
  await controller.start();
  assert.equal(port.starts.length, 1);
  port.emit(event(3, 'completed'));
  assert.equal(controller.snapshot.run.closure?.kind, 'interrupted');
  assert.equal(controller.snapshot.run.lastSequence, 2);
  assert.equal(controller.snapshot.canStart, false);
  await controller.flush();
  controller.dispose();
});

test('a conflicting replay of an applied sequence is not silently accepted as a duplicate', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'literal A'));
  port.emit(event(2, 'text', 'literal A'));
  assert.equal(controller.snapshot.status, 'running');
  assert.equal(port.stops.length, 0);
  port.emit(event(2, 'text', 'conflicting B'));
  await tick();
  assert.equal(controller.snapshot.status, 'unknown');
  assert.equal(controller.snapshot.outputText, 'literal A');
  assert.equal(port.stops.length, 1);
  port.emit(event(3, 'stopped'));
  assert.equal(controller.snapshot.run.closure?.kind, 'interrupted');
  assert.equal(controller.snapshot.run.lastSequence, 2);
  await controller.flush();
  controller.dispose();
});

test('a terminal event whose missing start cannot be appended still closes honestly with interrupted evidence', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'completed'));
  assert.equal(controller.snapshot.run.phase, 'prepared');
  assert.equal(controller.snapshot.run.lastSequence, 0);
  assert.equal(controller.snapshot.run.closure?.kind, 'interrupted');
  assert.equal(controller.snapshot.status, 'terminal');
  await controller.flush();
  controller.dispose();
});

test('reconciliation yields between bounded batches so Stop can run before a large replay finishes', async () => {
  const { controller, port, scheduler } = setup(undefined, prepared(), 'restored');
  port.reconcileResult = async () => ({ kind: 'events', events: [event(1, 'started'), ...Array.from({ length: 255 }, (_, index) => event(index + 2, 'text', 'x'))] });
  let sequenceAtStop = 0;
  scheduler.onYield = () => {
    if (!sequenceAtStop) { sequenceAtStop = controller.currentRun.lastSequence; void controller.stop(); }
  };
  await controller.reconcile();
  assert.equal(scheduler.yields, 3);
  assert.equal(sequenceAtStop, 64);
  assert.equal(port.stops.length, 1);
  assert.equal(controller.snapshot.run.lastSequence, 256);
  assert.equal(controller.snapshot.outputText, 'x'.repeat(255));
  controller.dispose();
});

test('snapshots reuse immutable reducer records and disposal clears deferred checkpoint work', async () => {
  const records: ConversationRun[] = [];
  const { controller, port, scheduler } = setup(async (run) => { records.push(run as ConversationRun); return ack(run); });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'literal'));
  assert.equal(controller.currentRun, controller.snapshot.run);
  assert.equal(controller.snapshot.run, controller.snapshot.run);
  assert.equal(Object.isFrozen(controller.currentRun), true);
  assert.equal(Object.isFrozen(controller.currentRun.outputChunks), true);
  assert.equal(scheduler.timers.size, 1);
  controller.dispose();
  assert.equal(scheduler.timers.size, 0);
  scheduler.advance(10 * RUN_CHECKPOINT_INTERVAL_MS);
  await tick();
  assert.equal(records.length, 1);
  assert.equal(port.stops.length, 0);
});

test('an oversized event requests Stop without erasing the prefix; closure time includes the real terminal event clock', async () => {
  const { controller, port, scheduler } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'retained'));
  port.emit(event(3, 'text', 'x'.repeat(MAX_RUN_CHUNK_BYTES + 1)));
  assert.equal(port.stops.length, 1);
  assert.equal(controller.snapshot.outputText, 'retained');
  const terminal = { ...event(4, 'failed'), at: '2026-10-10T01:00:00.000Z', reason: 'process-error' as const };
  assert.ok(scheduler.now() < Date.parse(terminal.at));
  port.emit(terminal);
  assert.equal(controller.snapshot.run.closure?.at, terminal.at);
  assert.equal(controller.snapshot.run.updatedAt, event(2, 'text').at, 'closure does not rewrite accepted event chronology');
  assert.equal(controller.snapshot.run.closure?.kind, 'interrupted');
  const closure = controller.snapshot.run.closure;
  if (closure?.kind === 'interrupted' && closure.terminalEvent.type === 'failed') assert.equal(closure.terminalEvent.reason, 'process-error');
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.closure?.at, terminal.at);
  controller.dispose();
});

test('nonterminal output arriving in finalization schedules the next checkpoint without a new event', async () => {
  const { controller, port, scheduler } = setup();
  await controller.start();
  let injected = false;
  controller.subscribe((snapshot) => {
    if (!injected && snapshot.saving && snapshot.persistedSequence === 2) {
      injected = true;
      queueMicrotask(() => port.emit(event(3, 'text', ' later')));
    }
  });
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'saved'));
  scheduler.advance(RUN_CHECKPOINT_INTERVAL_MS);
  await tick();
  assert.equal(controller.snapshot.unsavedTail, ' later');
  assert.equal(scheduler.timers.size, 1);
  scheduler.advance(RUN_CHECKPOINT_INTERVAL_MS);
  await tick();
  assert.equal(controller.snapshot.persistedPrefix, 'saved later');
  assert.equal(controller.snapshot.unsavedTail, '');
  controller.dispose();
});

test('a terminal gap stays recoverable in new and restored controllers until the missing literal text arrives', async () => {
  for (const mode of ['new', 'restored'] as const) {
    const prefix = withEvents(event(1, 'started'), event(2, 'text', 'A'));
    const { controller, port } = setup(undefined, mode === 'new' ? prepared() : prefix, mode);
    if (mode === 'new') {
      await controller.start();
      port.emit(event(1, 'started'));
      port.emit(event(2, 'text', 'A'));
    }
    const terminal = event(5, 'completed');
    port.emit(terminal);
    assert.equal(isConversationRunClosed(controller.currentRun), false, `${mode}: missing delivery is not refused evidence`);
    assert.equal(controller.snapshot.outputText, 'A');
    assert.equal(controller.snapshot.status, 'unknown');
    assert.equal(controller.snapshot.error, 'event-gap', 'missing delivery has not been refused');
    assert.equal(controller.snapshot.canCheckStatus, true);
    assert.deepEqual(controller.snapshot.pendingEvents, [terminal]);
    assert.equal(port.stops.length, 0, 'a recoverable delivery gap must not automatically stop the participant');
    port.reconcileResult = async () => ({ kind: 'events', events: [event(3, 'text', 'B'), event(4, 'text', 'C'), terminal] });
    await controller.reconcile();
    assert.equal(port.queries[0]?.afterSequence, 2);
    assert.equal(controller.snapshot.outputText, 'ABC');
    assert.equal(controller.currentRun.phase, 'completed');
    assert.equal(controller.currentRun.lastSequence, 5);
    assert.equal(controller.currentRun.closure, undefined, 'contiguous evidence is a normal completion');
    assert.equal(controller.snapshot.pendingEvents.length, 0);
    await controller.flush();
    assert.equal(controller.snapshot.persistedPrefix, 'ABC');
    assert.equal(controller.snapshot.savedRecord?.phase, 'completed');
    assert.equal(port.starts.length, mode === 'new' ? 1 : 0);
    controller.dispose();
  }
});

test('a buffered terminal can close as interrupted only after replay actually refuses missing output', async () => {
  const prefix = withEvents(event(1, 'started'), event(2, 'text', 'A'));
  const { controller, port } = setup(undefined, prefix, 'restored', { acceptRun: () => false });
  const terminal = event(4, 'completed');
  port.emit(terminal);
  assert.equal(controller.currentRun.closure, undefined);
  port.reconcileResult = async () => ({ kind: 'events', events: [event(3, 'text', 'B')] });
  await controller.reconcile();
  assert.equal(controller.snapshot.outputText, 'A');
  assert.equal(controller.currentRun.lastSequence, 2);
  const closure = controller.snapshot.run.closure;
  assert.equal(closure?.kind, 'interrupted');
  assert.equal(closure?.reason, 'workspace-limit');
  if (closure?.kind === 'interrupted') assert.deepEqual(closure.terminalEvent, terminal);
  assert.equal(port.stops.length, 1);
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.closure?.kind, 'interrupted');
  controller.dispose();
});

test('a contradiction received during explicit start flush cannot redispatch a previously not-started run', async () => {
  const { controller, port } = setup();
  port.startResult = async () => ({ kind: 'not-started' });
  await controller.start();
  assert.equal(controller.snapshot.canStart, true);
  const retry = controller.start();
  // Even an already-saved preparation crosses an await in start().
  port.emit(event(2, 'text', 'contradictory gapped evidence'));
  await retry;
  assert.equal(port.starts.length, 1, 'contradictory observed dispatch rules out another dispatch');
  assert.equal(controller.snapshot.status, 'unknown');
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(controller.snapshot.run.lastSequence, 0);
  assert.deepEqual(controller.snapshot.pendingEvents, [event(2, 'text', 'contradictory gapped evidence')]);
  controller.dispose();
});

test('successful direct preparation retry restores unsent idle status without dispatch', async () => {
  let attempts = 0;
  const { controller, port } = setup(async (run) => ++attempts === 1 ? { kind: 'not-saved' } : ack(run));
  await controller.start();
  assert.equal(controller.snapshot.checkpointState, 'failed');
  assert.equal(controller.snapshot.canCloseAsUnknown, false, 'a failed save is not uncertainty about dispatch');
  await controller.flush();
  assert.equal(controller.snapshot.status, 'idle');
  assert.equal(controller.snapshot.canStart, true);
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canCheckStatus, false);
  assert.equal(controller.snapshot.canCloseAsUnknown, false);
  assert.equal(port.starts.length, 0);
  controller.dispose();
});

test('malformed correlated evidence after not-started requests Stop and prevents redispatch', async () => {
  const { controller, port } = setup();
  port.startResult = async () => ({ kind: 'not-started' });
  await controller.start();
  port.emit(event(2, 'text', 'x'.repeat(MAX_RUN_CHUNK_BYTES + 1)));
  await tick();
  assert.equal(port.stops.length, 1);
  assert.equal(controller.snapshot.error, 'event-refused');
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(controller.snapshot.canCloseAsUnknown, true);
  await controller.start();
  assert.equal(port.starts.length, 1);
  controller.dispose();
});

test('healthy preparation, starting and running cannot be locally closed or expose recovery-only controls', async () => {
  const save = deferred<RunCheckpointResult>();
  let attempted!: Readonly<ConversationRun>;
  const { controller, port } = setup(async (run) => { attempted = run; return save.promise; });
  const starting = controller.start();
  await tick();
  for (const phase of ['preparing', 'starting', 'running']) {
    assert.equal(controller.snapshot.status, phase);
    assert.equal(controller.snapshot.canCloseAsUnknown, false);
    assert.equal(controller.snapshot.canCheckStatus, false);
    controller.closeAsUnknown();
    assert.equal(controller.currentRun.closure, undefined);
    if (phase === 'preparing') { save.resolve(ack(attempted)); await starting; }
    if (phase === 'starting') port.emit(event(1, 'started'));
  }
  port.emit(event(2, 'text', 'still owned'));
  assert.equal(controller.snapshot.outputText, 'still owned');
  assert.equal(controller.snapshot.canStop, true);
  controller.dispose();
});

test('Close as unknown is refused during pending Stop and retains a later confirmed stopped event', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  const pending = deferred<ParticipantStopResult>();
  port.stopResult = () => pending.promise;
  const stopping = controller.stop();
  assert.equal(controller.snapshot.stopState, 'pending');
  assert.equal(controller.snapshot.canCloseAsUnknown, false);
  controller.closeAsUnknown();
  assert.equal(controller.currentRun.closure, undefined);
  pending.resolve({ kind: 'confirmed', event: { ...event(2, 'stopped'), type: 'stopped', reason: 'local-stop' } });
  await stopping;
  assert.equal(controller.currentRun.phase, 'stopped');
  assert.equal(controller.currentRun.reason, 'local-stop');
  assert.equal(controller.snapshot.stopState, 'confirmed');
  assert.equal(controller.snapshot.canCloseAsUnknown, false);
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.phase, 'stopped');
  controller.dispose();
});

test('unknown Stop permits an explicit local close that clears obsolete Stop and transport error controls', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  await controller.stop();
  assert.equal(controller.snapshot.canCloseAsUnknown, true);
  assert.equal(controller.snapshot.error, 'stop-unknown');
  controller.closeAsUnknown();
  assert.equal(controller.currentRun.closure?.kind, 'unknown');
  assert.equal(controller.snapshot.stopState, 'idle');
  assert.equal(controller.snapshot.error, null);
  assert.equal(controller.snapshot.canStop, false);
  assert.equal(controller.snapshot.canCheckStatus, false);
  assert.equal(controller.snapshot.canCloseAsUnknown, false);
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.closure?.kind, 'unknown');
  controller.dispose();
});

test('automatic Stop with an unknown answer preserves the real refusal reason', async () => {
  for (const refusal of ['workspace-limit', 'event-refused'] as const) {
    const { controller, port } = setup(undefined, prepared(), 'new', { acceptRun: () => false });
    await controller.start();
    port.emit(event(1, 'started'));
    port.emit(event(2, 'text', refusal === 'workspace-limit' ? 'too much' : 'x'.repeat(MAX_RUN_CHUNK_BYTES + 1)));
    await tick();
    assert.equal(port.stops.length, 1);
    assert.equal(controller.snapshot.stopState, 'unknown');
    assert.equal(controller.snapshot.error, refusal);
    assert.equal(controller.snapshot.canCloseAsUnknown, true);
    controller.dispose();
  }
});

test('an unavailable restored controller can explicitly close without inventing participant availability', async () => {
  const port = new InventedPort();
  port.subscribe = () => { throw new Error('invented disconnected participant'); };
  const controller = new ConversationRunController({ run: withEvents(event(1, 'started')), port, mode: 'restored', checkpoint: async (run) => ack(run) });
  assert.equal(controller.snapshot.canCloseAsUnknown, true);
  controller.closeAsUnknown();
  assert.equal(controller.currentRun.closure?.kind, 'unknown');
  assert.equal(controller.snapshot.available, false);
  assert.equal(controller.snapshot.error, null);
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.closure?.kind, 'unknown');
  assert.equal(port.stops.length, 0);
  controller.dispose();
});

test('a refused event emitted during subscription stops once only after the subscription succeeds', async () => {
  const port = new InventedPort();
  let subscribed = false;
  port.stopResult = async () => { assert.equal(subscribed, true); return { kind: 'unknown' }; };
  port.subscribe = (listener) => {
    listener(event(3, 'text', 'x'.repeat(MAX_RUN_CHUNK_BYTES + 1)));
    subscribed = true;
    return () => {};
  };
  const controller = new ConversationRunController({ run: withEvents(event(1, 'started'), event(2, 'text', 'known')), port,
    mode: 'restored', checkpoint: async (run) => ack(run) });
  await tick();
  assert.equal(port.stops.length, 1);
  assert.equal(controller.snapshot.outputText, 'known');
  assert.equal(controller.snapshot.error, 'event-refused');
  controller.dispose();
});

test('a malformed event on a shared port stops only its matching run and leaves other sessions active', async () => {
  class SharedPort extends InventedPort {
    listeners = new Set<(value: unknown) => void>();
    override subscribe(listener: (value: unknown) => void) {
      this.listeners.add(listener);
      return () => { this.listeners.delete(listener); this.unsubscribes++; };
    }
    override emit(value: unknown) { for (const listener of this.listeners) listener(value); }
  }
  const port = new SharedPort();
  const scheduler = new ManualScheduler();
  const secondRun = { ...prepared(), runId: '55555555-5555-4555-8555-555555555555',
    sessionId: '66666666-6666-4666-8666-666666666666', userMessageId: '77777777-7777-4777-8777-777777777777',
    assistantMessageId: '88888888-8888-4888-8888-888888888888' };
  const first = new ConversationRunController({ run: prepared(), port, scheduler, mode: 'new', checkpoint: async (run) => ack(run) });
  const second = new ConversationRunController({ run: secondRun, port, scheduler, mode: 'new', checkpoint: async (run) => ack(run) });
  try {
    await first.start();
    await second.start();
    port.emit(event(1, 'started'));
    port.emit({ ...event(1, 'started'), runId: secondRun.runId, sessionId: secondRun.sessionId });
    port.emit(event(2, 'text', 'x'.repeat(MAX_RUN_CHUNK_BYTES + 1)));
    assert.deepEqual(port.stops, [{ runId: prepared().runId, sessionId: prepared().sessionId }]);
    await tick();
    assert.equal(first.snapshot.status, 'unknown');
    assert.equal(second.snapshot.status, 'running');
    for (const value of [null, 'malformed', {}, { runId: secondRun.runId },
      { runId: secondRun.runId, sessionId: prepared().sessionId, type: 'text' }]) port.emit(value);
    let getterCalls = 0;
    port.emit({ get runId() { getterCalls++; return secondRun.runId; }, sessionId: secondRun.sessionId });
    assert.equal(getterCalls, 0, 'unusable target accessors are not evaluated');
    assert.equal(port.stops.length, 1, 'missing or mismatched correlation cannot stop any other session');
    port.emit({ ...event(2, 'text', 'Other session continues'), runId: secondRun.runId, sessionId: secondRun.sessionId });
    assert.equal(second.snapshot.outputText, 'Other session continues');
    assert.equal(second.snapshot.status, 'running');
    port.emit(event(3, 'stopped'));
    assert.equal(first.snapshot.run.closure?.kind, 'interrupted');
    assert.equal(second.snapshot.status, 'running');
  } finally { first.dispose(); second.dispose(); }
});


test('restored, gapped and contradictory possibly-running participants cannot be abandoned before Stop', async () => {
  for (const condition of ['restored', 'gap', 'contradictory'] as const) {
    const { controller, port } = setup(undefined, condition === 'restored' ? withEvents(event(1, 'started')) : prepared(), condition === 'restored' ? 'restored' : 'new');
    if (condition !== 'restored') {
      if (condition === 'contradictory') port.startResult = async () => ({ kind: 'not-started' });
      await controller.start();
      port.emit(event(1, 'started'));
      if (condition === 'gap') port.emit(event(3, 'text', 'later text'));
    }
    assert.equal(controller.snapshot.canCloseAsUnknown, false, condition);
    controller.closeAsUnknown();
    assert.equal(controller.currentRun.closure, undefined, condition);
    assert.equal(controller.snapshot.canStop, true, condition);
    assert.equal(controller.snapshot.canCheckStatus, true, condition);
    await controller.stop();
    assert.equal(port.stops.length, 1, condition);
    assert.equal(controller.snapshot.canCloseAsUnknown, true, condition);
    controller.dispose();
  }
});

test('confirmed Stop across a replayable text gap stays confirmed and recovers all missing text', async () => {
  const { controller, port } = setup();
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'A'));
  const terminal = { ...event(5, 'stopped'), type: 'stopped' as const, reason: 'local-stop' as const };
  port.stopResult = async () => ({ kind: 'confirmed', event: terminal });
  await controller.stop();
  assert.equal(controller.snapshot.stopState, 'confirmed');
  assert.equal(controller.snapshot.canStop, false);
  assert.equal(controller.snapshot.canCloseAsUnknown, true, 'a user may keep the confirmed Stop and abandon unavailable replay');
  assert.equal(controller.snapshot.canCheckStatus, true);
  assert.equal(controller.snapshot.error, 'event-gap');
  assert.deepEqual(controller.snapshot.pendingEvents, [terminal]);
  await controller.stop();
  assert.equal(port.stops.length, 1);
  port.reconcileResult = async () => ({ kind: 'events', events: [event(3, 'text', 'B'), event(4, 'text', 'C')] });
  await controller.reconcile();
  await controller.flush();
  assert.equal(controller.snapshot.outputText, 'ABC');
  assert.equal(controller.snapshot.run.phase, 'stopped');
  assert.equal(controller.snapshot.savedRecord?.lastSequence, 5);
  assert.equal(controller.snapshot.stopState, 'confirmed');
  controller.dispose();
});

test('a never-settling Stop times out to reachable recovery while late confirmations survive retries', async () => {
  const { controller, port, scheduler } = setup();
  const first = deferred<ParticipantStopResult>();
  const second = deferred<ParticipantStopResult>();
  await controller.start();
  port.emit(event(1, 'started'));
  port.stopResult = () => port.stops.length === 1 ? first.promise : second.promise;
  const stopping = controller.stop();
  scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS - 1);
  assert.equal(controller.snapshot.stopState, 'pending');
  scheduler.advance(1);
  await stopping;
  assert.equal(controller.snapshot.stopState, 'unknown');
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canCheckStatus, true);
  assert.equal(controller.snapshot.canCloseAsUnknown, false, 'outstanding Stop evidence must not be discarded');
  await controller.reconcile();
  assert.equal(port.queries.length, 1);
  const retry = controller.stop();
  assert.equal(port.stops.length, 2);
  first.resolve({ kind: 'confirmed', event: event(2, 'stopped') });
  await tick();
  assert.equal(controller.snapshot.stopState, 'confirmed', 'the older request can still prove Stop');
  assert.equal(controller.currentRun.phase, 'stopped');
  second.resolve({ kind: 'unknown' });
  await retry;
  assert.equal(controller.snapshot.stopState, 'confirmed', 'a newer unknown result cannot erase terminal evidence');
  assert.equal(controller.snapshot.error, null);
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.phase, 'stopped');
  controller.dispose();
  assert.equal(scheduler.timers.size, 0);
});

test('Stop timeout and retry remain independent of an unresolved output checkpoint', async () => {
  const save = deferred<RunCheckpointResult>();
  const records: Readonly<ConversationRun>[] = [];
  const { controller, port, scheduler } = setup(async (run) => { records.push(run); return records.length === 2 ? save.promise : ack(run); });
  const stop = deferred<ParticipantStopResult>();
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'retained'));
  void controller.flush();
  await tick();
  port.stopResult = () => stop.promise;
  const stopping = controller.stop();
  assert.equal(port.stops.length, 1);
  scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS);
  await stopping;
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canCheckStatus, true);
  assert.equal(controller.snapshot.saving, true);
  stop.resolve({ kind: 'confirmed', event: event(3, 'stopped') });
  await tick();
  assert.equal(controller.snapshot.stopState, 'confirmed');
  save.resolve(ack(records[1]!));
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.phase, 'stopped');
  controller.dispose();
});

function cleanupStatus(terminal: Extract<ParticipantEvent, { type: 'stopped' | 'failed' | 'completed' }>,
  state: 'exited' | 'cleanup-pending', groupCleared: boolean | null): ParticipantStatusResult {
  return { kind: 'status', state, lastSequence: terminal.sequence, terminal, groupCleared, unknownReason: null };
}

test('stop-incomplete keeps cleanup controls and immutable text until matching native status confirms cleanup', async () => {
  const port = new InventedPort();
  const terminal = { ...event(3, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  let status: ParticipantStatusResult = cleanupStatus(terminal, 'cleanup-pending', false);
  const nativePort = Object.assign(port, { status: async () => status });
  const { controller } = setup(undefined, prepared(), 'new', { port: nativePort });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(event(2, 'text', 'retained prefix'));
  port.stopResult = async () => ({ kind: 'cleanup-uncertain', event: terminal, owned: true });
  await controller.stop();
  await tick();
  await controller.flush();
  const ended = controller.currentRun;
  assert.equal(ended.phase, 'stopped');
  assert.equal(ended.reason, 'stop-incomplete');
  assert.equal(controller.snapshot.stopState, 'unknown');
  assert.equal(controller.snapshot.cleanupState, 'owned');
  assert.equal(controller.snapshot.cleanupPending, true);
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canCheckStatus, true);
  assert.equal(controller.snapshot.canCloseAsUnknown, false);
  port.stopResult = async () => ({ kind: 'confirmed', event: terminal });
  await controller.stop();
  await tick();
  assert.equal(controller.snapshot.cleanupPending, true, 'a legacy result alone cannot confirm incomplete cleanup');
  status = cleanupStatus(terminal, 'exited', true);
  await controller.reconcile();
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.equal(controller.snapshot.stopState, 'confirmed');
  assert.equal(controller.snapshot.canStop, false);
  assert.equal(controller.currentRun, ended, 'cleanup status must never rewrite transcript evidence');
  assert.equal(controller.snapshot.persistedPrefix, 'retained prefix');
  controller.dispose();
});

test('malformed, foreign, and contradictory cleanup status never release ownership', async () => {
  const terminal = { ...event(2, 'failed'), type: 'failed' as const, reason: 'process-error' as const };
  const invalid: ParticipantStatusResult[] = [
    { kind: 'unknown' },
    { ...cleanupStatus(terminal, 'exited', true), terminal: { ...terminal, runId: '55555555-5555-4555-8555-555555555555' } } as ParticipantStatusResult,
    { ...cleanupStatus(terminal, 'exited', true), terminal: { ...terminal, reason: 'timeout' } } as ParticipantStatusResult,
    { ...cleanupStatus(terminal, 'exited', true), lastSequence: 99 } as ParticipantStatusResult,
    { kind: 'status', state: 'exited', terminal, lastSequence: 2 } as ParticipantStatusResult,
    cleanupStatus(terminal, 'cleanup-pending', true),
  ];
  const port = new InventedPort();
  let status: ParticipantStatusResult = cleanupStatus(terminal, 'cleanup-pending', false);
  const { controller } = setup(undefined, prepared(), 'new', { port: Object.assign(port, { status: async () => status }) });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(terminal);
  await tick();
  assert.equal(controller.snapshot.cleanupState, 'owned', 'even a failed terminal can retain cleanup ownership');
  for (const result of invalid) {
    status = result;
    await controller.reconcile();
    assert.equal(controller.snapshot.cleanupState, 'owned');
    assert.equal(controller.snapshot.canStop, true);
    assert.equal(controller.snapshot.canCloseAsUnknown, false);
  }
  controller.dispose();
});

test('a restored incomplete terminal is recoverable and earlier-launch uncertainty does not claim confirmed Stop', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const run = withEvents(event(1, 'started'), terminal);
  const { controller, port } = setup(undefined, run, 'restored');
  assert.equal(controller.snapshot.cleanupState, 'unknown');
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canCheckStatus, false, 'a terminal cannot be checked without a status capability');
  await controller.reconcile();
  assert.equal(port.queries.length, 0, 'event replay cannot establish process cleanup');
  assert.equal(port.order[0], 'subscribe');
  port.stopResult = async () => ({ kind: 'cleanup-uncertain', event: terminal, owned: false });
  await controller.stop();
  assert.equal(controller.snapshot.cleanupState, 'unowned');
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.equal(controller.snapshot.stopState, 'unknown');
  assert.equal(controller.snapshot.canStop, false);
  assert.equal(controller.snapshot.canCloseAsUnknown, false);
  assert.deepEqual(controller.currentRun, run);
  controller.dispose();
});


test('late cleanup-uncertain Stop cannot reverse a later authoritative cleared status', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const port = new InventedPort();
  let status: ParticipantStatusResult = cleanupStatus(terminal, 'cleanup-pending', false);
  const { controller } = setup(undefined, prepared(), 'new', { port: Object.assign(port, { status: async () => status }) });
  await controller.start();
  port.emit(event(1, 'started'));
  port.emit(terminal);
  await tick();
  const stop = deferred<ParticipantStopResult>();
  port.stopResult = () => stop.promise;
  const stopping = controller.stop();
  status = cleanupStatus(terminal, 'exited', true);
  await controller.reconcile();
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  stop.resolve({ kind: 'cleanup-uncertain', event: terminal, owned: true });
  await stopping;
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  assert.equal(controller.snapshot.stopState, 'confirmed');
  controller.dispose();
});

test('disposing pending Stop and cleanup status cancels their local timeout work', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const port = new InventedPort();
  const status = deferred<ParticipantStatusResult>();
  const { controller, scheduler } = setup(undefined, withEvents(event(1, 'started'), terminal), 'restored',
    { port: Object.assign(port, { status: () => status.promise }) });
  const stop = deferred<ParticipantStopResult>();
  port.stopResult = () => stop.promise;
  const stopping = controller.stop();
  assert.equal(scheduler.timers.size, 2);
  controller.dispose();
  await stopping;
  await tick();
  assert.equal(scheduler.timers.size, 0);
  status.resolve(cleanupStatus(terminal, 'exited', true));
  stop.resolve({ kind: 'confirmed', event: terminal });
  await tick();
  assert.equal(controller.snapshot.status, 'disposed');
  assert.equal(controller.snapshot.cleanupPending, true, 'disposed callbacks never invent new evidence');
});


test('ordinary confirmed Stop clears cleanup despite a failed status read', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'local-stop' as const };
  const port = new InventedPort();
  const { controller } = setup(undefined, prepared(), 'new', { port: Object.assign(port,
    { status: async (): Promise<ParticipantStatusResult> => ({ kind: 'unknown' }) }) });
  await controller.start();
  port.emit(event(1, 'started'));
  port.stopResult = async () => ({ kind: 'confirmed', event: terminal });
  await controller.stop();
  await tick();
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.equal(controller.snapshot.stopState, 'confirmed');
  assert.equal(controller.snapshot.canStop, false);
  assert.equal(controller.snapshot.canCheckStatus, false);
  assert.equal(controller.snapshot.run.reason, 'local-stop');
  controller.dispose();
});

test('stale pending cleanup status cannot undo a newer confirmed Stop', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'local-stop' as const };
  const status = deferred<ParticipantStatusResult>();
  const port = new InventedPort();
  const { controller } = setup(undefined, prepared(), 'new', { port: Object.assign(port, { status: () => status.promise }) });
  await controller.start();
  port.emit(event(1, 'started'));
  const stop = deferred<ParticipantStopResult>();
  port.stopResult = () => stop.promise;
  const stopping = controller.stop();
  port.emit(terminal);
  assert.equal(controller.snapshot.cleanupState, 'none', 'a normal terminal alone does not invent pending cleanup');
  stop.resolve({ kind: 'confirmed', event: terminal });
  await stopping;
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  status.resolve(cleanupStatus(terminal, 'cleanup-pending', false));
  await tick();
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.equal(controller.snapshot.stopState, 'confirmed');
  assert.equal(controller.snapshot.canStop, false);
  controller.dispose();
});

test('an unreplayable gap can close locally with the confirmed Stop and literal prefix durable across restore', async () => {
  for (const mode of ['new', 'restored'] as const) {
    const prefix = withEvents(event(1, 'started'), event(2, 'text', 'literal prefix'));
    const { controller, port } = setup(undefined, mode === 'restored' ? prefix : prepared(), mode);
    if (mode === 'new') {
      await controller.start();
      port.emit(event(1, 'started'));
      port.emit(event(2, 'text', 'literal prefix'));
    }
    const terminal = { ...event(5, 'stopped'), type: 'stopped' as const, reason: 'local-stop' as const };
    port.stopResult = async () => ({ kind: 'confirmed', event: terminal });
    await controller.stop();
    await controller.reconcile();
    assert.equal(controller.snapshot.canCloseAsUnknown, true);
    controller.closeAsUnknown();
    await controller.flush();
    const saved = controller.snapshot.savedRecord!;
    assert.equal(saved.lastSequence, 2);
    assert.equal(saved.outputChunks.join(''), 'literal prefix');
    assert.equal(saved.closure?.kind, 'interrupted');
    if (saved.closure?.kind === 'interrupted') assert.deepEqual(saved.closure.terminalEvent, terminal);
    assert.equal(controller.snapshot.stopState, 'confirmed');
    assert.equal(port.stops.length, 1);
    assert.equal(port.starts.length, mode === 'new' ? 1 : 0);
    controller.dispose();
    const restored = setup(undefined, saved, 'restored');
    assert.equal(restored.controller.snapshot.stopState, 'confirmed');
    assert.equal(restored.controller.snapshot.cleanupPending, false);
    assert.equal(restored.controller.snapshot.canStop, false);
    assert.deepEqual(restored.controller.currentRun, saved);
    restored.controller.dispose();
  }
});

test('restored terminal status correlates evidence even when its clock precedes logical updatedAt', async () => {
  const terminal = { ...event(3, 'stopped'), at: '2026-10-08T23:59:00.000Z', type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const run = withEvents(event(1, 'started'), event(2, 'text', 'clock-skew prefix'), terminal);
  assert.notEqual(run.updatedAt, terminal.at);
  for (const restored of [false, true]) {
    const port = new InventedPort();
    let status: ParticipantStatusResult = { kind: 'unknown' };
    const { controller } = setup(undefined, restored ? run : prepared(), restored ? 'restored' : 'new',
      { port: Object.assign(port, { status: async () => status }) });
    if (!restored) {
      await controller.start(); port.emit(event(1, 'started')); port.emit(event(2, 'text', 'clock-skew prefix')); port.emit(terminal);
    }
    await tick();
    assert.equal(controller.snapshot.cleanupPending, true);
    const invalid = [
      { ...terminal, sequence: 4 },
      { ...terminal, reason: 'local-stop' as const },
      { ...terminal, sessionId: '55555555-5555-4555-8555-555555555555' },
      { ...terminal, at: '2026-10-10T00:00:00.000Z' },
    ];
    for (const other of invalid) {
      status = cleanupStatus(other, 'exited', true);
      await controller.reconcile();
      assert.equal(controller.snapshot.cleanupPending, true);
    }
    status = cleanupStatus(terminal, 'exited', true);
    await controller.reconcile();
    assert.equal(controller.snapshot.cleanupState, 'cleared');
    assert.equal(controller.snapshot.stopState, 'confirmed');
    assert.deepEqual(controller.currentRun, run);
    controller.dispose();
  }
});

test('normal completion never creates speculative cleanup controls or a send barrier while status is unavailable', async () => {
  const terminal = { ...event(3, 'completed'), type: 'completed' as const };
  const run = withEvents(event(1, 'started'), event(2, 'text', 'complete reply'), terminal);
  for (const restored of [false, true]) {
    const port = new InventedPort();
    const status = deferred<ParticipantStatusResult>();
    const { controller, scheduler } = setup(undefined, restored ? run : prepared(), restored ? 'restored' : 'new',
      { port: Object.assign(port, { status: () => status.promise }) });
    if (!restored) {
      await controller.start(); port.emit(event(1, 'started')); port.emit(event(2, 'text', 'complete reply')); port.emit(terminal);
    }
    assert.equal(controller.snapshot.cleanupState, 'none');
    assert.equal(controller.snapshot.cleanupPending, false);
    assert.equal(controller.snapshot.canStop, false);
    assert.equal(controller.snapshot.canCheckStatus, false);
    assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false);
    scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS);
    await tick();
    assert.equal(controller.snapshot.cleanupPending, false);
    status.resolve({ kind: 'unknown' });
    await tick();
    assert.equal(controller.snapshot.cleanupState, 'none');
    assert.deepEqual(controller.currentRun, run);
    controller.dispose();
  }
});

test('completed output does retain an owned cleanup barrier when native supplies matching proof', async () => {
  const terminal = { ...event(2, 'completed'), type: 'completed' as const };
  const run = withEvents(event(1, 'started'), terminal);
  const port = new InventedPort();
  const status = deferred<ParticipantStatusResult>();
  const { controller } = setup(undefined, run, 'restored', { port: Object.assign(port, { status: () => status.promise }) });
  assert.equal(controller.snapshot.cleanupPending, false);
  status.resolve(cleanupStatus(terminal, 'cleanup-pending', false));
  await tick();
  assert.equal(controller.snapshot.cleanupState, 'owned');
  assert.equal(controller.snapshot.cleanupPending, true);
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false);
  controller.acknowledgeUnreachableCleanup();
  assert.deepEqual(controller.currentRun, run);
  controller.dispose();
});

test('unreachable closed cleanup requires a durable explicit acknowledgment and preserves the terminal on restore', async () => {
  const terminal = { ...event(3, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const run = withEvents(event(1, 'started'), event(2, 'text', 'retained'), terminal);
  const save = deferred<RunCheckpointResult>();
  let pending!: Readonly<ConversationRun>;
  const { controller } = setup(async (record) => { pending = record; return save.promise; }, run, 'restored');
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, true);
  controller.acknowledgeUnreachableCleanup();
  await tick();
  assert.equal(controller.snapshot.cleanupPending, true, 'unsaved acknowledgment cannot release the global barrier');
  assert.equal(controller.snapshot.cleanupState, 'unknown');
  save.resolve(ack(pending));
  await controller.flush();
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.equal(controller.snapshot.stopState, 'unknown');
  assert.equal(controller.snapshot.canStop, true, 'recovery remains reachable after acknowledgment');
  const saved = controller.snapshot.savedRecord!;
  assert.equal(saved.phase, 'stopped');
  assert.equal(saved.reason, 'stop-incomplete');
  assert.equal(saved.lastSequence, run.lastSequence);
  assert.deepEqual(saved.outputChunks, run.outputChunks);
  assert.equal(saved.cleanupAcknowledgment?.kind, 'unreachable');
  controller.dispose();
  const restored = setup(undefined, saved, 'restored');
  assert.equal(restored.controller.snapshot.cleanupState, 'unknown');
  assert.equal(restored.controller.snapshot.cleanupPending, false);
  assert.equal(restored.controller.snapshot.stopState, 'unknown');
  assert.equal(restored.controller.snapshot.canAcknowledgeUnreachableCleanup, false);
  restored.controller.dispose();
});

test('late owned status after a timed-out check overrides a saved cleanup acknowledgment', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const port = new InventedPort();
  const status = deferred<ParticipantStatusResult>();
  const { controller, scheduler } = setup(undefined, withEvents(event(1, 'started'), terminal), 'restored',
    { port: Object.assign(port, { status: () => status.promise }) });
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false, 'an active status query must settle or time out first');
  controller.acknowledgeUnreachableCleanup();
  assert.equal(controller.currentRun.cleanupAcknowledgment, undefined);
  scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS);
  await tick();
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, true);
  controller.acknowledgeUnreachableCleanup();
  await controller.flush();
  assert.equal(controller.snapshot.cleanupPending, false);
  status.resolve(cleanupStatus(terminal, 'cleanup-pending', false));
  await tick();
  assert.equal(controller.snapshot.cleanupState, 'owned');
  assert.equal(controller.snapshot.cleanupPending, true);
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.canCheckStatus, true);
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false);
  controller.dispose();
});

test('cleanup acknowledgment cannot discard an outstanding Stop or bypass refused persistence', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const run = withEvents(event(1, 'started'), terminal);
  const { controller, port, scheduler } = setup(async () => ({ kind: 'not-saved' }), run, 'restored');
  const stop = deferred<ParticipantStopResult>();
  port.stopResult = () => stop.promise;
  const stopping = controller.stop();
  scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS);
  await stopping;
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false);
  controller.acknowledgeUnreachableCleanup();
  assert.equal(controller.currentRun.cleanupAcknowledgment, undefined);
  stop.resolve({ kind: 'unknown' });
  await tick();
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, true);
  controller.acknowledgeUnreachableCleanup();
  await controller.flush();
  assert.equal(controller.snapshot.checkpointState, 'failed');
  assert.equal(controller.snapshot.cleanupPending, true);
  assert.equal(controller.snapshot.savedRecord?.cleanupAcknowledgment, undefined);
  controller.dispose();
});

test('closed cleanup can save an honest local acknowledgment despite a failed subscription', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const port = new InventedPort();
  port.subscribe = () => { throw new Error('invented unreachable participant'); };
  const { controller } = setup(undefined, withEvents(event(1, 'started'), terminal), 'restored', { port });
  assert.equal(controller.snapshot.available, false);
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, true);
  controller.acknowledgeUnreachableCleanup();
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.cleanupAcknowledgment?.kind, 'unreachable');
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.equal(controller.snapshot.cleanupState, 'unknown');
  assert.equal(controller.snapshot.available, false);
  assert.equal(port.starts.length, 0);
  assert.equal(port.stops.length, 0);
  controller.dispose();
});

test('refused admission and mismatched save acknowledgments cannot waive cleanup', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const run = withEvents(event(1, 'started'), terminal);
  const denied = setup(undefined, run, 'restored', { acceptRun: () => false });
  denied.controller.acknowledgeUnreachableCleanup();
  await denied.controller.flush();
  assert.equal(denied.controller.currentRun.cleanupAcknowledgment, undefined);
  assert.equal(denied.controller.snapshot.cleanupPending, true);
  assert.equal(denied.controller.snapshot.error, 'recovery-size-limit');
  assert.equal(denied.controller.snapshot.canAcknowledgeUnreachableCleanup, true, 'a refused acknowledgment keeps its retry available');
  denied.controller.dispose();
  const { controller } = setup(async () => ack(run), run, 'restored');
  controller.acknowledgeUnreachableCleanup();
  await controller.flush();
  assert.equal(controller.snapshot.checkpointState, 'unknown');
  assert.equal(controller.snapshot.cleanupPending, true);
  assert.equal(controller.snapshot.savedRecord?.cleanupAcknowledgment, undefined);
  controller.dispose();
});


test('cleanup acknowledgment respects a saved interrupted closure when the host clock is behind it', async () => {
  const future = '2026-10-10T00:00:00.000Z';
  const terminal = { ...event(4, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const, at: future };
  const run: ConversationRun = { ...withEvents(event(1, 'started'), event(2, 'text', 'retained prefix')),
    closure: { kind: 'interrupted', reason: 'event-refused', at: future, terminalEvent: terminal } };
  const { controller, port } = setup(undefined, run, 'restored');
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, true);
  controller.acknowledgeUnreachableCleanup();
  await controller.flush();
  assert.equal(controller.snapshot.savedRecord?.cleanupAcknowledgment?.at, future);
  assert.deepEqual(controller.snapshot.savedRecord?.closure, run.closure);
  assert.deepEqual(controller.snapshot.savedRecord?.outputChunks, run.outputChunks);
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.deepEqual(port.starts, []);
  assert.deepEqual(port.stops, []);
  controller.dispose();
});

test('an acknowledgment cannot overtake an unsaved interrupted closure and later text across any checkpoint barrier', async () => {
  for (const outcome of ['blocked', 'not-saved', 'unknown', 'in-flight'] as const) {
    const initial = prepared();
    let nextId = 0;
    const state = createDemoState({ now: () => initial.createdAt, id: () => ++nextId === 2 ? initial.sessionId
      : `90000000-0000-4000-8000-${String(nextId).padStart(12, '0')}` });
    state.drafts[initial.sessionId] = initial.inputChunks.join('');
    let workspace = prepareConversationRun(state, initial, state.drafts[initial.sessionId]!);
    const prefix = withEvents(event(1, 'started'), event(2, 'text', 'saved prefix'));
    workspace = saveConversationRunCheckpoint(workspace, prefix, 0);
    const attempts: Readonly<ConversationRun>[] = [];
    const gate = deferred<RunCheckpointResult>();
    let allowSave = false;
    const { controller, port } = setup(async (run) => {
      attempts.push(run);
      if (!allowSave) return outcome === 'in-flight' ? gate.promise : { kind: outcome };
      const previous = workspace.conversationRuns!.find((record) => record.runId === run.runId)!;
      workspace = saveConversationRunCheckpoint(workspace, run, previous.lastSequence);
      return ack(workspace.conversationRuns!.find((record) => record.runId === run.runId)!);
    }, prefix, 'restored', { acceptRun: (run) => canAdmitConversationRun(workspace, run) });

    port.emit(event(3, 'text', ' earlier unsaved'));
    const firstFlush = controller.flush();
    await tick();
    assert.equal(attempts.length, 1);
    port.emit(event(4, 'text', ' late tail'));
    port.emit(event(5, 'text', 'x'.repeat(MAX_RUN_CHUNK_BYTES + 1)));
    const terminal = { ...event(6, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
    port.emit(terminal);
    await tick();
    assert.equal(controller.currentRun.closure?.kind, 'interrupted');
    assert.equal(controller.snapshot.cleanupState, 'unknown');
    assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false, outcome);
    controller.acknowledgeUnreachableCleanup();
    assert.equal(controller.currentRun.cleanupAcknowledgment, undefined, `${outcome}: no early acknowledgment enters the pending record`);
    assert.equal(controller.snapshot.unsavedTail, ' earlier unsaved late tail');
    assert.deepEqual(workspace.conversationRuns![0], prefix);

    if (outcome === 'in-flight') gate.resolve({ kind: 'not-saved' });
    await firstFlush;
    if (outcome === 'unknown') assert.equal(controller.resolveCheckpoint({ kind: 'not-saved', record: attempts[0]! }), true);
    allowSave = true;
    await controller.flush();
    const saved = workspace.conversationRuns![0]!;
    assert.equal(saved.outputChunks.join(''), 'saved prefix earlier unsaved late tail');
    assert.equal(saved.lastSequence, 4);
    assert.equal(saved.closure?.kind, 'interrupted');
    if (saved.closure?.kind === 'interrupted') assert.deepEqual(saved.closure.terminalEvent, terminal);
    assert.equal(saved.cleanupAcknowledgment, undefined, 'the closure and its full literal tail become durable first');
    assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, true);
    controller.acknowledgeUnreachableCleanup();
    assert.equal(controller.snapshot.cleanupPending, true, 'the acknowledgment itself still needs a save');
    await controller.flush();
    assert.equal(controller.snapshot.checkpointState, 'saved');
    assert.equal(controller.snapshot.cleanupPending, false);
    const reloaded = JSON.parse(JSON.stringify(workspace));
    assert.equal(validateState(reloaded).valid, true);
    assert.equal(reloaded.conversationRuns[0].outputChunks.join(''), 'saved prefix earlier unsaved late tail');
    assert.deepEqual(reloaded.conversationRuns[0].closure, saved.closure);
    assert.equal(reloaded.conversationRuns[0].cleanupAcknowledgment.kind, 'unreachable');
    assert.equal(port.starts.length, 0);
    controller.dispose();
  }
});

test('buffered unsolicited stopped evidence can close a gap while unresolved cleanup stays explicit', async () => {
  for (const reason of ['local-stop', 'stop-incomplete'] as const) {
    const prefix = withEvents(event(1, 'started'), event(2, 'text', 'literal prefix'));
    const terminal = { ...event(5, 'stopped'), type: 'stopped' as const, reason };
    const { controller, port } = setup(undefined, prefix, 'restored');
    port.emit(terminal);
    assert.equal(controller.snapshot.canCloseAsUnknown, true);
    assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false);
    controller.closeAsUnknown();
    assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false, 'the interrupted closure is not yet saved');
    await controller.flush();
    assert.equal(controller.currentRun.closure?.kind, 'interrupted');
    if (controller.currentRun.closure?.kind === 'interrupted') assert.deepEqual(controller.currentRun.closure.terminalEvent, terminal);
    assert.equal(controller.snapshot.persistedPrefix, 'literal prefix');
    assert.equal(controller.snapshot.cleanupPending, reason === 'stop-incomplete');
    assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, reason === 'stop-incomplete');
    assert.equal(port.stops.length, 0);
    assert.equal(port.starts.length, 0);
    controller.dispose();
  }
});

test('normal stopped and failed terminals do not invent cleanup pending merely because status is available', async () => {
  for (const type of ['stopped', 'failed'] as const) {
    const terminal = { ...event(3, type), type, reason: type === 'stopped' ? 'local-stop' as const : 'process-error' as const };
    const run = withEvents(event(1, 'started'), event(2, 'text', 'saved output'), terminal);
    for (const restored of [false, true]) {
      const port = new InventedPort();
      const status = deferred<ParticipantStatusResult>();
      const { controller, scheduler } = setup(undefined, restored ? run : prepared(), restored ? 'restored' : 'new',
        { port: Object.assign(port, { status: () => status.promise }) });
      if (!restored) {
        await controller.start(); port.emit(event(1, 'started')); port.emit(event(2, 'text', 'saved output')); port.emit(terminal);
      }
      assert.equal(controller.snapshot.cleanupState, 'none');
      assert.equal(controller.snapshot.cleanupPending, false);
      assert.equal(controller.snapshot.canStop, false);
      assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false);
      scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS);
      await tick();
      assert.equal(controller.snapshot.cleanupPending, false);
      status.resolve(cleanupStatus(terminal, 'cleanup-pending', false));
      await tick();
      assert.equal(controller.snapshot.cleanupState, 'owned', 'a delayed matching ownership report still establishes the barrier');
      assert.equal(controller.snapshot.cleanupPending, true);
      assert.equal(controller.snapshot.canStop, true);
      assert.deepEqual(controller.currentRun, run);
      controller.dispose();
    }
  }
});

test('unowned cleanup offers no unnecessary acknowledgment and never claims its saved terminal changed', async () => {
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const run = withEvents(event(1, 'started'), terminal);
  const { controller } = setup(undefined, run, 'restored', { port: Object.assign(new InventedPort(),
    { status: async () => cleanupStatus(terminal, 'exited', false) }) });
  await tick();
  assert.equal(controller.snapshot.cleanupState, 'unowned');
  assert.equal(controller.snapshot.cleanupPending, false);
  assert.equal(controller.snapshot.canAcknowledgeUnreachableCleanup, false);
  controller.acknowledgeUnreachableCleanup();
  await controller.flush();
  assert.deepEqual(controller.currentRun, run);
  controller.dispose();
});

test('a timed-out cleanup status cannot replace evidence from a newer check', async () => {
  for (const newerState of ['owned', 'unowned', 'unknown'] as const) {
    const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
    const stale = deferred<ParticipantStatusResult>();
    let reads = 0;
    const { controller, scheduler } = setup(undefined, withEvents(event(1, 'started'), terminal), 'restored',
      { port: Object.assign(new InventedPort(), { status: async () => ++reads === 1 ? stale.promise
        : newerState === 'unknown' ? { kind: 'unknown' as const }
          : cleanupStatus(terminal, newerState === 'owned' ? 'cleanup-pending' : 'exited', false) }) });
    scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS);
    await tick();
    await controller.reconcile();
    assert.equal(reads, 2);
    assert.equal(controller.snapshot.cleanupState, newerState);
    stale.resolve(cleanupStatus(terminal, newerState === 'owned' ? 'exited' : 'cleanup-pending', false));
    await tick();
    assert.equal(controller.snapshot.cleanupState, newerState === 'unknown' ? 'owned' : newerState,
      'newer authoritative evidence wins, while a newer unknown result cannot discard an older owned report');
    controller.dispose();
  }
});

test('cleanup status may correlate an exact legacy stopped paid-overflow record without admitting that new event', async () => {
  const prefix = withEvents(event(1, 'started'), event(2, 'text', 'legacy literal prefix'));
  const terminal = { ...event(3, 'stopped'), type: 'stopped' as const, reason: 'paid-overflow' as const };
  const run: ConversationRun = { ...prefix, phase: 'stopped', reason: 'paid-overflow', lastSequence: 3, updatedAt: terminal.at };
  let status = cleanupStatus(terminal, 'cleanup-pending', false);
  const port = Object.assign(new InventedPort(), { status: async () => status });
  const { controller } = setup(undefined, run, 'restored', { port });
  await tick();
  assert.equal(controller.snapshot.cleanupState, 'owned');
  for (const invalid of [{ ...terminal, at: '2026-10-10T00:00:00.000Z' }, { ...terminal, sequence: 4 },
    { ...terminal, sessionId: '55555555-5555-4555-8555-555555555555' }, { ...terminal, reason: 'local-stop' as const },
    { ...terminal, text: 'not a terminal field' }]) {
    status = cleanupStatus(invalid, 'exited', true);
    await controller.reconcile();
    assert.equal(controller.snapshot.cleanupState, 'owned', 'correlation rejects changed legacy evidence');
  }
  status = cleanupStatus(terminal, 'exited', true);
  await controller.reconcile();
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  assert.deepEqual(controller.currentRun, run);
  assert.equal(port.starts.length, 0);
  controller.dispose();

  const fresh = setup(undefined, prefix, 'restored');
  fresh.port.emit(terminal);
  await tick();
  assert.equal(fresh.controller.currentRun.phase, 'running');
  assert.equal(fresh.controller.currentRun.lastSequence, 2);
  assert.equal(fresh.controller.snapshot.error, 'event-refused');
  assert.equal(fresh.port.stops.length, 1);
  fresh.controller.dispose();
});

const notDispatched = (): ParticipantStatusResult => ({ kind: 'status', state: 'not-dispatched',
  lastSequence: 0, terminal: null, groupCleared: null, unknownReason: null });

test('native restore reads status and events, grants no automatic start, and rechecks status during explicit Start', async () => {
  const port = new InventedPort();
  const order: string[] = [];
  let result = notDispatched();
  port.reconcileResult = async () => { order.push('events'); return { kind: 'events', events: [], more: false }; };
  const { controller } = setup(undefined, prepared(), 'restored', { port: Object.assign(port,
    { status: async () => { order.push('status'); return result; } }) });
  await tick();
  assert.deepEqual(order, ['status', 'events']);
  assert.equal(controller.snapshot.canStart, true);
  assert.equal(port.starts.length, 0);
  result = { kind: 'status', state: 'unknown', lastSequence: null, terminal: null,
    groupCleared: null, unknownReason: 'start-uncertain' };
  await controller.start();
  assert.equal(port.starts.length, 0, 'an older not-dispatched result is not fresh authorization');
  assert.equal(controller.snapshot.canStart, false);
  result = notDispatched();
  await controller.reconcile();
  assert.equal(port.starts.length, 0);
  await controller.start();
  assert.equal(port.starts.length, 1);
  assert.equal(order.at(-1), 'status');
  assert.equal(controller.snapshot.canStart, false);
  controller.dispose();
});

test('an unknown start needs fresh not-dispatched evidence and another explicit Start, while recovery-only availability never dispatches', async () => {
  const port = new InventedPort();
  let available = true;
  const { controller } = setup(undefined, prepared(), 'new', { port: Object.assign(port,
    { status: async () => notDispatched(), canStart: () => available }) });
  port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
  port.startResult = async () => ({ kind: 'unknown' });
  await controller.start();
  assert.equal(controller.snapshot.canStart, false);
  await controller.start();
  assert.equal(port.starts.length, 1);
  await controller.reconcile();
  assert.equal(controller.snapshot.canStart, true);
  assert.equal(port.starts.length, 1);
  available = false;
  assert.equal(controller.snapshot.canStart, false);
  await controller.start();
  assert.equal(port.starts.length, 1);
  assert.equal(controller.snapshot.canStop, true, 'unavailable Start never hides recovery Stop');
  available = true;
  port.startResult = async () => ({ kind: 'accepted' });
  await controller.start();
  assert.equal(port.starts.length, 2);
  controller.dispose();
});

test('native retryable and permanent refusals preserve their exact reason without automatic retries', async () => {
  for (const retryable of [false, true]) {
    const { controller, port } = setup();
    port.startResult = async () => ({ kind: 'not-started', reason: retryable ? 'participant-busy' : 'participant-changed', retryable });
    await controller.start();
    assert.deepEqual(controller.snapshot.startRefusal, { reason: retryable ? 'participant-busy' : 'participant-changed', retryable });
    assert.equal(controller.snapshot.canStart, retryable);
    await tick();
    assert.equal(port.starts.length, 1);
    await controller.start();
    assert.equal(port.starts.length, retryable ? 2 : 1);
    assert.equal(controller.currentRun.lastSequence, 0);
    controller.dispose();
  }
});

test('run-not-prepared means stopped before starting and recovers the real sequence-one terminal without manufacturing one', async () => {
  const port = new InventedPort();
  const status = deferred<ParticipantStatusResult>();
  const terminal = { ...event(1, 'stopped'), type: 'stopped' as const, reason: 'local-stop' as const };
  const { controller } = setup(undefined, prepared(), 'new', { port: Object.assign(port, { status: () => status.promise }) });
  port.startResult = async () => ({ kind: 'not-started', reason: 'run-not-prepared', retryable: false });
  await controller.start();
  assert.equal(controller.snapshot.startRefusal?.reason, 'run-not-prepared');
  assert.equal(controller.currentRun.lastSequence, 0);
  assert.equal(controller.currentRun.phase, 'prepared');
  assert.equal(controller.snapshot.canStart, false);
  status.resolve(cleanupStatus(terminal, 'exited', true));
  await tick();
  assert.equal(controller.currentRun.phase, 'stopped');
  assert.equal(controller.currentRun.lastSequence, 1);
  assert.equal(controller.currentRun.closure, undefined);
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  await controller.start();
  assert.equal(port.starts.length, 1);
  controller.dispose();
});

test('more pages retain every accepted event and a validated lost range closes only the missing suffix', async () => {
  const prefix = withEvents(event(1, 'started'), event(2, 'text', 'retained'));
  const { controller, port } = setup(undefined, prefix, 'restored');
  const terminal = { ...event(7, 'completed'), type: 'completed' as const };
  let page = 0;
  port.reconcileResult = async () => ++page === 1
    ? { kind: 'events', events: [event(3, 'text', ' + replayed')], more: true }
    : { kind: 'lost', lost: { fromSequence: 4, throughSequence: 6, reason: 'restarted' }, terminal };
  await controller.reconcile();
  assert.deepEqual(port.queries.map((query) => query.afterSequence), [2, 3]);
  assert.equal(controller.currentRun.outputChunks.join(''), 'retained + replayed');
  assert.equal(controller.currentRun.lastSequence, 3);
  assert.equal(controller.currentRun.closure?.reason, 'replay-lost');
  await controller.flush();
  assert.deepEqual(controller.snapshot.savedRecord, controller.currentRun);
  const saved = structuredClone(controller.currentRun);
  controller.dispose();
  const restored = setup(undefined, saved, 'restored');
  assert.deepEqual(restored.controller.currentRun, saved);
  assert.equal(restored.port.starts.length, 0);
  restored.controller.dispose();
});

test('lost without a terminal permits explicit unknown closure; a status terminal or malformed range alone cannot claim missing text', async () => {
  const prefix = withEvents(event(1, 'started'), event(2, 'text', 'literal prefix'));
  const port = new InventedPort();
  const terminal = { ...event(5, 'completed'), type: 'completed' as const };
  const { controller } = setup(undefined, prefix, 'restored', { port: Object.assign(port,
    { status: async () => cleanupStatus(terminal, 'exited', true) }) });
  port.reconcileResult = async () => ({ kind: 'lost', lost: { fromSequence: 3, throughSequence: 3, reason: 'locked' }, terminal });
  await tick();
  assert.equal(controller.currentRun.closure, undefined, 'inexact lost range cannot close the prefix');
  assert.equal(controller.currentRun.lastSequence, 2);
  assert.equal(controller.snapshot.outputText, 'literal prefix');
  port.reconcileResult = async () => ({ kind: 'lost', lost: { fromSequence: 3, throughSequence: null, reason: 'restarted' }, terminal: null });
  await controller.reconcile();
  assert.equal(controller.currentRun.closure, undefined);
  assert.equal(controller.snapshot.canCloseAsUnknown, true);
  controller.closeAsUnknown();
  assert.equal(controller.snapshot.run.closure?.kind, 'unknown');
  assert.equal(controller.currentRun.lastSequence, 2);
  assert.equal(port.starts.length, 0);
  controller.dispose();
});

test('a more reply with no accepted progress stops the read loop instead of spinning forever', async () => {
  const { controller, port } = setup(undefined, prepared(), 'restored');
  port.reconcileResult = async () => ({ kind: 'events', events: [], more: true });
  await controller.reconcile();
  assert.equal(port.queries.length, 1);
  assert.equal(controller.snapshot.error, 'reconcile-unknown');
  controller.dispose();
});

test('quiet polling reads status then replay, restarts its quiet period on pushes, and disposes all timers', async () => {
  const port = new InventedPort();
  let reads = 0;
  const { controller, scheduler } = setup(undefined, prepared(), 'restored', { port: Object.assign(port,
    { status: async (): Promise<ParticipantStatusResult> => { reads++; return { kind: 'status', state: 'running',
      lastSequence: 1, terminal: null, groupCleared: null, unknownReason: null }; } }) });
  port.reconcileResult = async () => ({ kind: 'events', events: [event(1, 'started')], more: false });
  await tick();
  assert.equal(reads, 1);
  scheduler.advance(10_000);
  port.emit(event(2, 'text', 'push resets quiet clock'));
  scheduler.advance(5_000);
  await tick();
  assert.equal(reads, 1);
  scheduler.advance(10_000);
  await tick();
  assert.equal(reads, 2);
  assert.equal(port.queries.at(-1)?.afterSequence, 2);
  controller.dispose();
  assert.equal(scheduler.timers.size, 0);
  scheduler.advance(60_000);
  await tick();
  assert.equal(reads, 2);
});

test('failed native end keeps status polling through unknown and unowned false evidence until cleared', async () => {
  const terminal = { ...event(2, 'failed'), type: 'failed' as const, reason: 'process-error' as const };
  const port = new InventedPort();
  let reads = 0;
  let result: ParticipantStatusResult = { kind: 'unknown' };
  const { controller, scheduler } = setup(undefined, withEvents(event(1, 'started'), terminal), 'restored',
    { port: Object.assign(port, { status: async () => { reads++; return result; } }) });
  await tick();
  assert.equal(reads, 1);
  assert.equal(controller.snapshot.cleanupState, 'none');
  result = cleanupStatus(terminal, 'exited', false);
  scheduler.advance(15_000);
  await tick();
  assert.equal(reads, 2);
  assert.equal(controller.snapshot.cleanupState, 'unowned');
  assert.equal(controller.snapshot.canStop, false);
  result = cleanupStatus(terminal, 'exited', true);
  scheduler.advance(15_000);
  await tick();
  assert.equal(reads, 3);
  assert.equal(controller.snapshot.cleanupState, 'cleared');
  scheduler.advance(30_000);
  await tick();
  assert.equal(reads, 3);
  controller.dispose();
});

test('older Stop ownership cannot replace a newer status proving cleanup is unowned', async () => {
  const terminal = { ...event(2, 'failed'), type: 'failed' as const, reason: 'process-error' as const };
  const port = new InventedPort();
  let result = cleanupStatus(terminal, 'cleanup-pending', false);
  const { controller } = setup(undefined, withEvents(event(1, 'started'), terminal), 'restored',
    { port: Object.assign(port, { status: async () => result }) });
  await tick();
  const stop = deferred<ParticipantStopResult>();
  port.stopResult = () => stop.promise;
  const stopping = controller.stop();
  result = cleanupStatus(terminal, 'exited', false);
  await controller.reconcile();
  assert.equal(controller.snapshot.cleanupState, 'unowned');
  stop.resolve({ kind: 'cleanup-uncertain', event: terminal, owned: true });
  await stopping;
  assert.equal(controller.snapshot.cleanupState, 'unowned');
  assert.equal(controller.snapshot.canStop, false);
  controller.dispose();
});

test('a global unsaved-work barrier that appears during the final status await prevents dispatch', async () => {
  const port = new InventedPort();
  const pending = deferred<ParticipantStatusResult>();
  let block = false;
  let reads = 0;
  const { controller } = setup(undefined, prepared(), 'restored', {
    canDispatch: () => !block, port: Object.assign(port, { status: () => ++reads === 1 ? Promise.resolve(notDispatched()) : pending.promise }),
  });
  port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
  await tick();
  assert.equal(controller.snapshot.canStart, true);
  const starting = controller.start();
  await tick();
  block = true;
  pending.resolve(notDispatched());
  await starting;
  assert.equal(port.starts.length, 0);
  assert.equal(controller.snapshot.canStart, true, 'intrinsic readiness remains visible while the UI disables the globally blocked action');
  await controller.start();
  assert.equal(port.starts.length, 0, 'even direct calls cannot bypass the global policy');
  controller.dispose();
});

test('a permanent refusal can be explicitly closed locally without claiming that a provider started or stopped', async () => {
  const { controller, port } = setup();
  port.startResult = async () => ({ kind: 'not-started', reason: 'unknown-run', retryable: false });
  await controller.start();
  assert.equal(controller.snapshot.canCloseAsUnknown, true);
  controller.closeAsUnknown();
  await controller.flush();
  assert.equal(controller.currentRun.lastSequence, 0);
  assert.equal(controller.currentRun.closure?.kind, 'unknown');
  assert.equal(controller.snapshot.savedRecord?.closure?.kind, 'unknown');
  assert.equal(port.stops.length, 0);
  assert.equal(port.starts.length, 1);
  controller.dispose();
});

test('contradictory lost terminals and accessor ranges cannot replace buffered evidence', async () => {
  const { controller, port } = setup(undefined, withEvents(event(1, 'started'), event(2, 'text', 'kept')), 'restored');
  const terminal = { ...event(5, 'completed'), type: 'completed' as const };
  port.emit(terminal);
  let getterCalls = 0;
  port.reconcileResult = async () => ({ kind: 'lost', terminal,
    lost: { get fromSequence() { getterCalls++; return 3; }, throughSequence: 4, reason: 'restarted' } });
  await controller.reconcile();
  assert.equal(getterCalls, 0);
  assert.equal(controller.currentRun.closure, undefined);
  port.reconcileResult = async () => ({ kind: 'lost', terminal: { ...event(6, 'failed'), type: 'failed', reason: 'process-error' },
    lost: { fromSequence: 3, throughSequence: 5, reason: 'restarted' } });
  await controller.reconcile();
  assert.equal(controller.currentRun.closure, undefined);
  assert.equal(controller.snapshot.outputText, 'kept');
  assert.deepEqual(controller.snapshot.pendingEvents, [terminal]);
  controller.dispose();
});

test('newer unknown status cannot discard an earlier late terminal and owned cleanup evidence', async () => {
  const port = new InventedPort();
  const old = deferred<ParticipantStatusResult>();
  let reads = 0;
  const { controller, scheduler } = setup(undefined, prepared(), 'restored', { port: Object.assign(port,
    { status: () => ++reads === 1 ? old.promise : Promise.resolve<ParticipantStatusResult>({ kind: 'status', state: 'unknown',
      terminal: null, lastSequence: null, groupCleared: null, unknownReason: 'store-unreadable' }) }) });
  port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
  await tick();
  scheduler.advance(PARTICIPANT_STOP_TIMEOUT_MS);
  await tick();
  await controller.reconcile();
  const terminal = { ...event(1, 'failed'), type: 'failed' as const, reason: 'process-error' as const };
  old.resolve(cleanupStatus(terminal, 'cleanup-pending', false));
  await tick();
  assert.equal(controller.currentRun.phase, 'failed');
  assert.equal(controller.snapshot.cleanupState, 'owned');
  assert.equal(controller.snapshot.canStop, true);
  controller.dispose();
});

test('the dispatch-boundary callback sees global work and disposal after an adapter availability await', async () => {
  for (const end of ['global-work', 'dispose', 'stop'] as const) {
    const port = new InventedPort();
    let allowed = true;
    let gate: (() => boolean) | undefined;
    const adapter = deferred<ParticipantStartResult>();
    port.start = async (_input, mayDispatch?: () => boolean) => { gate = mayDispatch; return adapter.promise; };
    const { controller } = setup(undefined, prepared(), 'new', { port, canDispatch: () => allowed });
    const starting = controller.start();
    await tick();
    assert.equal(gate?.(), true);
    if (end === 'global-work') allowed = false;
    if (end === 'dispose') controller.dispose();
    if (end === 'stop') await controller.stop();
    assert.equal(gate?.(), false, end);
    adapter.resolve({ kind: 'not-started', reason: 'dispatch-blocked', retryable: true });
    await starting;
    controller.dispose();
  }
});

test('cross-controller startBarrier reads local evidence without invoking dispatch policy or snapshots', async () => {
  let policyReads = 0;
  const gate = deferred<RunCheckpointResult>();
  let attempted!: Readonly<ConversationRun>;
  const { controller } = setup(async (run) => { attempted = run; return gate.promise; }, prepared(), 'new',
    { canDispatch: () => { policyReads++; return true; } });
  assert.equal(controller.startBarrier, true, 'unconfirmed preparation blocks other dispatch');
  assert.equal(policyReads, 0);
  const starting = controller.start();
  await tick();
  const readsDuringSave = policyReads;
  assert.equal(controller.startBarrier, true);
  assert.equal(policyReads, readsDuringSave);
  gate.resolve(ack(attempted));
  await starting;
  const readsAfterSave = policyReads;
  assert.equal(controller.startBarrier, false);
  assert.equal(policyReads, readsAfterSave);
  controller.dispose();
  const terminal = { ...event(2, 'stopped'), type: 'stopped' as const, reason: 'stop-incomplete' as const };
  const restored = setup(undefined, withEvents(event(1, 'started'), terminal), 'restored',
    { canDispatch: () => { throw Error('barrier must not invoke policy'); } });
  assert.equal(restored.controller.startBarrier, true, 'saved transcript with unresolved cleanup remains a barrier');
  restored.controller.dispose();
});

test('prepared readiness remains visible under another run cleanup barrier but Start never dispatches', async () => {
  let blocked = false;
  const { controller, port } = setup(undefined, prepared(), 'new', { canDispatch: () => !blocked });
  port.startResult = async () => ({ kind: 'not-started', reason: 'participant-busy', retryable: true });
  await controller.start();
  assert.equal(controller.snapshot.canStart, true);
  blocked = true;
  assert.equal(controller.snapshot.canStart, true, 'the UI retains its disabled Start button for prepared work');
  assert.equal(controller.snapshot.status, 'idle');
  await controller.start();
  assert.equal(port.starts.length, 1);
  blocked = false;
  await controller.start();
  assert.equal(port.starts.length, 2, 'only a later unblocked user action dispatches again');
  controller.dispose();
});

test('restored buffered terminal and incomplete replay block another Start until all literal output is saved', async () => {
  const port = new InventedPort();
  const replay = deferred<ParticipantReconcileResult>();
  const save = deferred<RunCheckpointResult>();
  let attempted!: Readonly<ConversationRun>;
  const prefix = withEvents(event(1, 'started'), event(2, 'text', 'kept'));
  const terminal = { ...event(4, 'completed'), type: 'completed' as const };
  port.reconcileResult = () => replay.promise;
  const first = setup(async (run) => { attempted = run; return save.promise; }, prefix, 'restored',
    { port: Object.assign(port, { status: async () => cleanupStatus(terminal, 'exited', true) }) });
  const second = setup(undefined, { ...prepared(), runId: '55555555-5555-4555-8555-555555555555',
    sessionId: '66666666-6666-4666-8666-666666666666' }, 'new', { canDispatch: () => !first.controller.startBarrier });
  assert.equal(first.controller.startBarrier, true, 'restoring alone cannot prove replay complete');
  await tick();
  assert.equal(first.controller.snapshot.cleanupState, 'cleared');
  assert.deepEqual(first.controller.snapshot.pendingEvents, [terminal]);
  assert.equal(first.controller.snapshot.checkpointState, 'saved', 'the old prefix is saved, but the tail is not');
  assert.equal(first.controller.startBarrier, true);
  await second.controller.start();
  assert.equal(second.port.starts.length, 0);
  replay.resolve({ kind: 'events', events: [event(3, 'text', ' plus recovered')], more: false });
  await tick();
  assert.equal(first.controller.currentRun.phase, 'completed');
  assert.equal(first.controller.snapshot.outputText, 'kept plus recovered');
  assert.equal(first.controller.startBarrier, true, 'replayed text and terminal still await their save');
  await second.controller.start();
  assert.equal(second.port.starts.length, 0);
  save.resolve(ack(attempted));
  await first.controller.flush();
  assert.equal(first.controller.snapshot.persistedPrefix, 'kept plus recovered');
  assert.equal(first.controller.startBarrier, false);
  await second.controller.start();
  assert.equal(second.port.starts.length, 1);
  first.controller.dispose(); second.controller.dispose();
});

test('unknown restore replay stays a barrier without pending events; complete replay or a saved permitted closure releases it', async () => {
  const port = new InventedPort();
  const { controller } = setup(undefined, prepared(), 'restored', { port: Object.assign(port,
    { status: async () => notDispatched() }) });
  await tick();
  assert.equal(controller.snapshot.pendingEvents.length, 0);
  assert.equal(controller.snapshot.checkpointState, 'saved');
  assert.equal(controller.startBarrier, true);
  assert.equal(controller.snapshot.canStart, false, 'no Start before unresolved restore replay');
  port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
  await controller.reconcile();
  assert.equal(controller.startBarrier, false);
  assert.equal(controller.snapshot.canStart, true);
  controller.dispose();

  const lost = setup(undefined, withEvents(event(1, 'started'), event(2, 'text', 'saved prefix')), 'restored');
  const terminal = { ...event(5, 'completed'), type: 'completed' as const };
  lost.port.emit(terminal);
  lost.port.reconcileResult = async () => ({ kind: 'lost', terminal,
    lost: { fromSequence: 3, throughSequence: 4, reason: 'replaced' } });
  await lost.controller.reconcile();
  await lost.controller.flush();
  assert.equal(lost.controller.currentRun.closure?.reason, 'replay-lost');
  assert.equal(lost.controller.snapshot.pendingEvents.length, 1, 'recovery evidence may remain visible after permitted closure');
  assert.equal(lost.controller.startBarrier, false, 'saved loss is explicit and cannot deadlock the workspace');
  lost.controller.dispose();
});

test('not-dispatched status spanning a pending Start neither enables a duplicate nor contradicts a valid reply', async () => {
  for (const origin of ['restored', 'unknown-retry', 'refusal-retry'] as const) {
    for (const replyOrder of ['status-first', 'start-first'] as const) {
      const port = new InventedPort();
      let status: () => Promise<ParticipantStatusResult> = async () => notDispatched();
      port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
      const { controller } = setup(undefined, prepared(), origin === 'restored' ? 'restored' : 'new',
        { port: Object.assign(port, { status: () => status() }) });
      if (origin === 'restored') await tick();
      else {
        port.startResult = async () => origin === 'unknown-retry' ? { kind: 'unknown' }
          : { kind: 'not-started', reason: 'participant-busy', retryable: true };
        await controller.start();
        if (origin === 'unknown-retry') await controller.reconcile();
      }
      assert.equal(controller.snapshot.canStart, true, origin);
      const startReply = deferred<ParticipantStartResult>();
      port.startResult = () => startReply.promise;
      const starting = controller.start();
      await tick();
      const starts = port.starts.length;
      const statusReply = deferred<ParticipantStatusResult>();
      status = () => statusReply.promise;
      const checking = controller.reconcile();
      await tick();
      if (replyOrder === 'status-first') {
        statusReply.resolve(notDispatched());
        await checking;
        assert.equal(controller.snapshot.status, 'starting', origin);
        assert.equal(controller.snapshot.error, null, origin);
        assert.equal(controller.snapshot.canStart, false, origin);
        await controller.start();
        assert.equal(port.starts.length, starts, 'one outstanding Start owns the action');
        startReply.resolve({ kind: 'accepted' });
        await starting;
      } else {
        startReply.resolve({ kind: 'accepted' });
        await starting;
        statusReply.resolve(notDispatched());
        await checking;
      }
      assert.equal(controller.snapshot.canStart, false, `${origin}/${replyOrder}`);
      assert.equal(controller.snapshot.error, null, `${origin}/${replyOrder}`);
      port.emit(event(1, 'started'));
      port.emit(event(2, 'text', 'valid reply'));
      port.emit(event(3, 'completed'));
      await controller.flush();
      assert.equal(controller.currentRun.phase, 'completed');
      assert.equal(controller.currentRun.closure, undefined, 'a pre-dispatch status cannot falsify later valid events');
      assert.equal(controller.snapshot.persistedPrefix, 'valid reply');
      assert.equal(port.starts.length, starts);
      controller.dispose();
    }
  }
});

test('a status begun before Start cannot authorize retry after that Start returns unknown', async () => {
  const port = new InventedPort();
  const pendingStatus = deferred<ParticipantStatusResult>();
  let status: () => Promise<ParticipantStatusResult> = () => pendingStatus.promise;
  const { controller } = setup(undefined, prepared(), 'new',
    { port: Object.assign(port, { status: () => status() }) });
  port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
  port.startResult = async () => ({ kind: 'not-started', reason: 'participant-busy', retryable: true });
  await controller.start();
  const checking = controller.reconcile();
  await tick();
  port.startResult = async () => ({ kind: 'unknown' });
  await controller.start();
  pendingStatus.resolve(notDispatched());
  await checking;
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(controller.snapshot.error, 'start-unknown');
  status = async () => notDispatched();
  await controller.reconcile();
  assert.equal(controller.snapshot.canStart, true, 'only a new read after the settled Start can authorize retry');
  controller.dispose();
});

test('Stop during Start records a real never-dispatched cancellation after any definite no-start result', async () => {
  for (const reason of ['workspace-not-ready', 'participant-busy', 'participant-unavailable']) {
    for (const firstReply of ['start', 'stop']) {
      const { controller, port } = setup();
      const startReply = deferred<ParticipantStartResult>();
      const stopReply = deferred<ParticipantStopResult>();
      port.startResult = () => startReply.promise;
      port.stopResult = () => stopReply.promise;
      const starting = controller.start();
      await tick();
      const stopping = controller.stop();
      const terminal = { ...event(1, 'stopped'), type: 'stopped' as const, reason: 'local-stop' as const };
      if (firstReply === 'start') {
        startReply.resolve({ kind: 'not-started', reason, retryable: true });
        await starting;
        stopReply.resolve({ kind: 'confirmed', event: terminal });
        await stopping;
      } else {
        stopReply.resolve({ kind: 'confirmed', event: terminal });
        await stopping;
        startReply.resolve({ kind: 'not-started', reason, retryable: true });
        await starting;
      }
      await controller.flush();
      assert.equal(controller.currentRun.phase, 'stopped', `${reason}/${firstReply}`);
      assert.equal(controller.currentRun.lastSequence, 1);
      assert.equal(controller.currentRun.reason, 'local-stop');
      assert.equal(controller.currentRun.closure, undefined);
      assert.equal(controller.snapshot.error, null);
      assert.equal(controller.snapshot.stopState, 'confirmed');
      assert.equal(controller.snapshot.savedRecord?.phase, 'stopped');
      assert.equal(controller.snapshot.canStart, false);
      assert.equal(port.starts.length, 1);
      controller.dispose();
    }
  }
});

test('an unavailable prepared participant remains stoppable without fabricating a cancellation', async () => {
  const port = new InventedPort();
  const { controller } = setup(undefined, prepared(), 'new',
    { port: Object.assign(port, { canStart: () => false }) });
  await controller.flush();
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(controller.snapshot.canStop, true);
  await controller.stop();
  assert.equal(controller.currentRun.phase, 'prepared', 'unknown Stop does not manufacture terminal evidence');
  assert.equal(controller.snapshot.canCloseAsUnknown, true);
  port.stopResult = async () => ({ kind: 'confirmed', event: { ...event(1, 'stopped'), type: 'stopped', reason: 'local-stop' } });
  await controller.stop();
  await controller.flush();
  assert.equal(controller.currentRun.phase, 'stopped');
  assert.equal(controller.currentRun.closure, undefined);
  assert.equal(port.starts.length, 0);
  controller.dispose();
});

test('fresh native availability can supersede its display cache but never bypass save or Stop latches', async () => {
  for (const blocker of ['none', 'global', 'stop']) {
    const port = new InventedPort();
    let available = true;
    let global = true;
    let gate!: (evidence?: { availabilityConfirmed: true }) => boolean;
    const startReply = deferred<ParticipantStartResult>();
    port.start = async (_input, mayDispatch?: (evidence?: { availabilityConfirmed: true }) => boolean) => {
      gate = mayDispatch!;
      return startReply.promise;
    };
    const { controller } = setup(undefined, prepared(), 'new',
      { port: Object.assign(port, { canStart: () => available }), canDispatch: () => global });
    const starting = controller.start();
    await tick();
    available = false;
    if (blocker === 'global') global = false;
    if (blocker === 'stop') await controller.stop();
    assert.equal(gate(), false, 'generic ports still use the current availability check');
    assert.equal(gate({ availabilityConfirmed: true }), blocker === 'none');
    startReply.resolve({ kind: 'not-started', reason: 'participant-unavailable', retryable: true });
    await starting;
    controller.dispose();
  }
});

test('quiet polling does not restore a completed initial replay barrier, while new buffered evidence still blocks Start', async () => {
  const port = new InventedPort();
  port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
  const first = setup(undefined, prepared(), 'restored', { port: Object.assign(port,
    { status: async () => notDispatched() }) });
  await tick();
  assert.equal(first.controller.startBarrier, false);
  const poll = deferred<ParticipantReconcileResult>();
  port.reconcileResult = () => poll.promise;
  first.scheduler.advance(15_000);
  await tick();
  assert.equal(port.queries.length, 2);
  assert.equal(first.controller.startBarrier, false, 'a quiet in-flight read has no new evidence to save');
  const second = setup(undefined, { ...prepared(), runId: '55555555-5555-4555-8555-555555555555',
    sessionId: '66666666-6666-4666-8666-666666666666' }, 'new', { canDispatch: () => !first.controller.startBarrier });
  second.port.startResult = async () => ({ kind: 'not-started', reason: 'participant-busy', retryable: true });
  await second.controller.start();
  assert.equal(second.port.starts.length, 1, 'a completed restore cannot arbitrarily block overlapping explicit Start');
  port.emit(event(2, 'text', 'new gapped evidence'));
  assert.equal(first.controller.startBarrier, true, 'actual buffered output still holds the workspace barrier');
  await second.controller.start();
  assert.equal(second.port.starts.length, 1);
  poll.resolve({ kind: 'unknown' });
  await tick();
  assert.equal(first.controller.startBarrier, true);
  first.controller.dispose(); second.controller.dispose();
});

test('a definite busy refusal leaves an available prepared run stoppable, and only real Stop evidence closes it', async () => {
  const { controller, port } = setup();
  port.startResult = async () => ({ kind: 'not-started', reason: 'participant-busy', retryable: true });
  await controller.start();
  assert.equal(controller.snapshot.canStart, true);
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(controller.snapshot.status, 'idle');
  assert.equal(controller.currentRun.phase, 'prepared');
  port.stopResult = async () => ({ kind: 'confirmed', event: { ...event(1, 'stopped'), type: 'stopped', reason: 'local-stop' } });
  await controller.stop();
  await controller.flush();
  assert.equal(controller.currentRun.phase, 'stopped');
  assert.equal(controller.currentRun.closure, undefined);
  assert.equal(controller.snapshot.error, null);
  assert.equal(controller.snapshot.savedRecord?.phase, 'stopped');
  assert.equal(port.starts.length, 1);
  controller.dispose();
});

test('idle prepared runs retain explicit native status checks even when their participant cannot start', async () => {
  for (const mode of ['new', 'restored'] as const) {
    const port = new InventedPort();
    let reads = 0;
    port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
    const { controller } = setup(undefined, prepared(), mode, { port: Object.assign(port,
      { canStart: () => false, status: async () => { reads++; return notDispatched(); } }) });
    await tick();
    await controller.flush();
    assert.equal(controller.snapshot.status, 'idle');
    assert.equal(controller.snapshot.canStart, false);
    assert.equal(controller.snapshot.canCheckStatus, true, 'the controller needs no current-pin knowledge to expose read-only recovery');
    const previousReads = reads;
    await controller.reconcile();
    assert.equal(reads, previousReads + 1);
    assert.equal(controller.snapshot.canCheckStatus, true);
    assert.deepEqual(controller.currentRun, prepared());
    assert.equal(port.starts.length, 0);
    controller.dispose();
  }
});

test('availability loss while Start saves settles the prepared run to idle without leaving an outstanding action', async () => {
  const port = new InventedPort();
  const save = deferred<RunCheckpointResult>();
  let available = true;
  let attempted!: Readonly<ConversationRun>;
  const { controller } = setup(async (run) => { attempted = run; return save.promise; }, prepared(), 'new',
    { port: Object.assign(port, { canStart: () => available }) });
  const starting = controller.start();
  await tick();
  assert.equal(controller.snapshot.status, 'preparing');
  available = false;
  save.resolve(ack(attempted));
  await starting;
  assert.equal(controller.snapshot.status, 'idle');
  assert.equal(controller.snapshot.saving, false);
  assert.equal(controller.snapshot.canStart, false);
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(port.starts.length, 0);
  available = true;
  await controller.start();
  assert.equal(port.starts.length, 1, 'the aborted preparation did not retain the outstanding-Start latch');
  controller.dispose();
});

test('an available prepared run abandoned before dispatch keeps Stop without a start refusal', async () => {
  for (const interruption of ['availability-during-save', 'barrier-at-dispatch'] as const) {
    const port = new InventedPort();
    const save = deferred<RunCheckpointResult>();
    let available = true;
    let allowed = true;
    let attempted!: Readonly<ConversationRun>;
    let firstSave = true;
    const { controller } = setup(async (run) => {
      if (!firstSave) return ack(run);
      firstSave = false; attempted = run; return save.promise;
    }, prepared(), 'new', { port: Object.assign(port, { canStart: () => available }), canDispatch: () => allowed });
    controller.subscribe((snapshot) => {
      if (interruption === 'barrier-at-dispatch' && snapshot.status === 'starting') allowed = false;
    });
    const starting = controller.start();
    await tick();
    assert.equal(controller.snapshot.canStop, true, 'Stop remains available while preparation saves');
    if (interruption === 'availability-during-save') available = false;
    save.resolve(ack(attempted));
    await starting;
    available = true;
    assert.equal(controller.snapshot.status, 'idle', interruption);
    assert.equal(controller.snapshot.startRefusal, null);
    assert.equal(controller.snapshot.checkpointState, 'saved');
    assert.equal(controller.snapshot.canStart, true);
    assert.equal(controller.snapshot.canStop, true, interruption);
    assert.equal(controller.snapshot.canCloseAsUnknown, false, 'an abandoned Start is not a recorded cancellation');
    assert.deepEqual(controller.currentRun, prepared());
    assert.equal(port.starts.length, 0);

    const stopReply = deferred<ParticipantStopResult>();
    port.stopResult = () => stopReply.promise;
    const stopping = controller.stop();
    assert.equal(controller.snapshot.stopState, 'pending');
    assert.equal(controller.snapshot.canStop, false, 'only one Stop request is outstanding');
    assert.equal(controller.snapshot.canCloseAsUnknown, false);
    assert.deepEqual(port.stops, [{ runId: prepared().runId, sessionId: prepared().sessionId }]);
    allowed = true;
    await controller.start();
    stopReply.resolve({ kind: 'not-prepared' });
    await stopping;
    assert.deepEqual(controller.currentRun, prepared(), 'not-prepared does not fabricate a terminal or discard the message');
    assert.equal(controller.snapshot.canStart, false, 'the Stop latch survives restored availability and dispatch permission');
    assert.equal(controller.snapshot.canStop, true);
    await controller.start();

    port.stopResult = async () => ({ kind: 'confirmed', event: { ...event(1, 'stopped'), type: 'stopped', reason: 'local-stop' } });
    await controller.stop();
    await controller.flush();
    assert.equal(controller.currentRun.phase, 'stopped');
    assert.equal(controller.currentRun.reason, 'local-stop');
    assert.equal(controller.currentRun.closure, undefined);
    assert.deepEqual(controller.currentRun.inputChunks, prepared().inputChunks);
    assert.deepEqual(controller.currentRun.outputChunks, []);
    assert.deepEqual(controller.snapshot.savedRecord, controller.currentRun);
    assert.equal(controller.snapshot.canStart, false);
    assert.equal(controller.snapshot.canStop, false);
    assert.equal(port.starts.length, 0, 'recovery never dispatches the abandoned message');
    controller.dispose();
  }
});

test('availability loss during a restored Start status await preserves truthful idle, unknown and native process states', async () => {
  for (const outcome of ['not-dispatched', 'unknown', 'starting', 'running'] as const) {
    const port = new InventedPort();
    let available = true;
    let status = async (): Promise<ParticipantStatusResult> => notDispatched();
    port.reconcileResult = async () => ({ kind: 'events', events: [], more: false });
    const { controller } = setup(undefined, prepared(), 'restored', { port: Object.assign(port,
      { canStart: () => available, status: () => status() }) });
    await tick();
    const reply = deferred<ParticipantStatusResult>();
    status = () => reply.promise;
    const starting = controller.start();
    await tick();
    assert.equal(controller.snapshot.status, 'preparing');
    available = false;
    reply.resolve(outcome === 'not-dispatched' ? notDispatched() : outcome === 'unknown' ? { kind: 'unknown' }
      : { kind: 'status', state: outcome, lastSequence: outcome === 'running' ? 1 : 0,
        terminal: null, groupCleared: null, unknownReason: null });
    await starting;
    assert.equal(controller.snapshot.status, outcome === 'not-dispatched' ? 'idle' : outcome);
    assert.equal(controller.snapshot.canStart, false);
    assert.equal(controller.snapshot.canStop, true);
    assert.equal(controller.snapshot.canCheckStatus, true);
    assert.equal(port.starts.length, 0);
    controller.dispose();
  }
});

test('availability revoked by the starting publication resets only the local pending dispatch label', async () => {
  const port = new InventedPort();
  let available = true;
  const { controller } = setup(undefined, prepared(), 'new', { port: Object.assign(port, { canStart: () => available }) });
  controller.subscribe((snapshot) => { if (snapshot.status === 'starting') available = false; });
  await controller.start();
  assert.equal(controller.snapshot.status, 'idle');
  assert.equal(controller.snapshot.canStop, true);
  assert.equal(port.starts.length, 0);
  controller.dispose();
});

test('availability-aborted preparation preserves Stop and terminal transitions while its save settles', async () => {
  for (const completion of ['pending', 'confirmed'] as const) {
    const port = new InventedPort();
    const save = deferred<RunCheckpointResult>();
    let available = true;
    let attempted!: Readonly<ConversationRun>;
    let firstSave = true;
    const { controller } = setup(async (run) => {
      if (!firstSave) return ack(run);
      firstSave = false; attempted = run; return save.promise;
    }, prepared(), 'new', { port: Object.assign(port, { canStart: () => available }) });
    const starting = controller.start();
    await tick();
    const stop = deferred<ParticipantStopResult>();
    port.stopResult = () => stop.promise;
    const stopping = controller.stop();
    available = false;
    if (completion === 'confirmed') {
      stop.resolve({ kind: 'confirmed', event: { ...event(1, 'stopped'), type: 'stopped', reason: 'local-stop' } });
      await stopping;
    }
    save.resolve(ack(attempted));
    await starting;
    assert.equal(controller.snapshot.status, completion === 'confirmed' ? 'terminal' : 'stopping');
    assert.equal(port.starts.length, 0);
    if (completion === 'pending') { stop.resolve({ kind: 'unknown' }); await stopping; }
    controller.dispose();
  }
});
