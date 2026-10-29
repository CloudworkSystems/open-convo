import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import { NativeProofCodec, NATIVE_PROOF_LIMITS, type NativeProofRequest, type NativeProofResult } from '../../src/adapters/native-host-codec';
import type { NativeParticipantResult } from '../../src/adapters/native-participant-codec';
import { NativeParticipantConnection } from '../../src/adapters/native-participant-port';
import { ConversationRunController, PARTICIPANT_QUIET_POLL_MS, RUN_CHECKPOINT_INTERVAL_MS, type ParticipantPort,
  type ParticipantRuntimeScheduler, type ParticipantStartInput, type ParticipantStartResult,
  type ParticipantStopResult, type ParticipantStatusResult, type ParticipantReconcileResult,
  type ParticipantTarget } from '../../src/adapters/participant-runtime';
import type { ConversationRun, ParticipantIdentity } from '../../src/domain/conversation-run-types';

type Reply<Operation extends 'participant.stop' | 'participant.status' | 'participant.events'> =
  Omit<Extract<NativeParticipantResult, { operation: Operation; outcome: 'ok' }>, 'operation' | 'outcome' | 'runId'>;
type StartReply = { outcome: 'ok' } | { outcome: 'unknown' } | { outcome: 'refused'; reason: string };
type Step = { user: 'start' | 'stop' | 'close-as-unknown' }
  | { start: StartReply } | { stop: Reply<'participant.stop'> } | { status: Reply<'participant.status'> }
  | { events: Reply<'participant.events'> } | { pushed: unknown; admitted?: false };
interface PageCase {
  name: string;
  mode: 'new' | 'restored';
  clock: string;
  run: ConversationRun;
  requires?: string;
  currentPin?: ParticipantIdentity;
  received: Step[];
  expect: { run: ConversationRun; status: string; startAllowed: boolean;
    cleanup: 'none' | 'pending' | 'cleared'; stopAllowed?: boolean; startRequested?: false };
}
const fixture = JSON.parse(readFileSync(new URL('../fixtures/native-participant-v1.json', import.meta.url), 'utf8')) as {
  pageCases: PageCase[];
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean, message: string) {
  for (let turn = 0; turn < 40 && !predicate(); turn++) await tick();
  assert.ok(predicate(), message);
}
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class Clock implements ParticipantRuntimeScheduler {
  private time: number;
  private nextId = 0;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  constructor(at: string) { this.time = Date.parse(at); }
  now() { return this.time; }
  setTimeout(callback: () => void, delay: number) {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(id: unknown) { this.timers.delete(id as number); }
  async yield() { await tick(); }
  async advance(milliseconds: number) {
    const end = this.time + milliseconds;
    for (let count = 0; ; count++) {
      assert.ok(count < 100, 'bounded virtual-clock work');
      const next = [...this.timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
      await tick();
    }
    this.time = end;
    await tick();
  }
}

type Call<Result> = { target: ParticipantTarget & { afterSequence?: number }; result: ReturnType<typeof deferred<Result>>;
  delivery: 'held' | 'fixture' | 'unknown-scaffolding'; afterTerminal: boolean };

/**
 * These vectors describe the controller's subscriber/reply boundary, not a
 * native wire. Every authoritative reply below comes from a received step.
 * Read calls remain logged even when they have no scripted response. An
 * unlisted status read may answer only unknown, including prerequisite
 * recovery reads and case 4's post-terminal status; other unlisted reads
 * remain held. An unknown status supplies no authoritative state.
 * Reply mapping uses the test-local helpers below; production codec/adapter
 * mapping is exercised separately only by the two adapter cases.
 */
class ScriptedPort implements ParticipantPort {
  readonly identity: ParticipantIdentity;
  readonly starts: Call<ParticipantStartResult>[] = [];
  readonly stops: Call<ParticipantStopResult>[] = [];
  readonly statuses: Call<ParticipantStatusResult>[] = [];
  readonly replays: Call<ParticipantReconcileResult>[] = [];
  readonly inputs: ParticipantStartInput[] = [];
  readonly errors: unknown[] = [];
  terminalSeen = false;
  private listener: ((event: unknown) => void) | undefined;
  constructor(private readonly scenario: PageCase) { this.identity = structuredClone(scenario.run.participant); }
  canStart() { return !this.scenario.currentPin || JSON.stringify(this.identity) === JSON.stringify(this.scenario.currentPin); }
  subscribe(listener: (event: unknown) => void) { this.listener = listener; return () => { this.listener = undefined; }; }
  push(value: unknown) { assert.ok(this.listener, 'controller has subscribed'); this.listener(structuredClone(value)); }
  private check(assertion: () => void) {
    try { assertion(); } catch (error) { this.errors.push(error); }
  }
  private call<Result>(calls: Call<Result>[], target: ParticipantTarget & { afterSequence?: number }) {
    // Log before any validation or cloning can throw. Production deliberately
    // catches port errors, so assertions must also survive outside that boundary.
    const call: Call<Result> = { target, result: deferred<Result>(), delivery: 'held', afterTerminal: this.terminalSeen };
    calls.push(call);
    this.check(() => {
      call.target = structuredClone(target);
      assert.equal(target.runId, this.scenario.run.runId);
      assert.equal(target.sessionId, this.scenario.run.sessionId);
    });
    return call.result.promise;
  }
  start(input: ParticipantStartInput, mayDispatch?: () => boolean) {
    const result = this.call(this.starts, input);
    this.check(() => {
      this.inputs.push(structuredClone(input));
      assert.equal(mayDispatch?.(), true, 'the controller still authorizes this explicit dispatch');
    });
    return result;
  }
  stop(target: ParticipantTarget) { return this.call(this.stops, target); }
  status(target: ParticipantTarget) { return this.call(this.statuses, target); }
  reconcile(target: ParticipantTarget & { afterSequence: number }) { return this.call(this.replays, target); }
  held<Result>(calls: Call<Result>[]) { return calls.find((call) => call.delivery === 'held'); }
  deliver<Result>(calls: Call<Result>[], result: Result) {
    const call = this.held(calls);
    assert.ok(call, 'fixture reply must answer an actual outstanding request');
    assert.equal(calls.filter((entry) => entry.delivery === 'held').length, 1, 'fixture delivery has one unambiguous pending request');
    call.delivery = 'fixture';
    call.result.resolve(structuredClone(result));
  }
  unknownStatus() {
    const call = this.held(this.statuses);
    assert.ok(call);
    call.delivery = 'unknown-scaffolding';
    call.result.resolve({ kind: 'unknown' });
  }
  release() {
    for (const calls of [this.starts, this.stops, this.statuses, this.replays]) {
      for (const call of calls) if (call.delivery === 'held') call.result.resolve({ kind: 'unknown' });
    }
  }
}

function startResult(reply: StartReply): ParticipantStartResult {
  if (reply.outcome === 'ok') return { kind: 'accepted' };
  if (reply.outcome === 'unknown') return { kind: 'unknown' };
  // This controller fixture currently supplies one refusal, not a wire-mapping matrix.
  assert.equal(reply.reason, 'participant-busy');
  return { kind: 'not-started', reason: reply.reason, retryable: true };
}
function stopResult(reply: Reply<'participant.stop'>): ParticipantStopResult {
  if (!reply.terminal || reply.state === 'not-owned') return { kind: 'unknown' };
  return reply.state === 'exited' && reply.groupCleared !== false
    ? { kind: 'confirmed', event: reply.terminal }
    : { kind: 'cleanup-uncertain', event: reply.terminal, owned: reply.state === 'cleanup-pending' };
}
function replayResult(reply: Reply<'participant.events'>): ParticipantReconcileResult {
  if (reply.lost) return { kind: 'lost', lost: reply.lost, terminal: reply.terminal };
  assert.notEqual(reply.lastSequence, null, 'successful fixture replay has an authoritative high-water mark');
  return { kind: 'events', events: [...reply.events], more: reply.more };
}
function hasTerminal(step: Step): boolean {
  const values = 'pushed' in step ? [step.pushed] : 'events' in step ? [...step.events.events, step.events.terminal]
    : 'stop' in step ? [step.stop.terminal] : 'status' in step ? [step.status.terminal] : [];
  return values.some((value) => value !== null && typeof value === 'object'
    && ['completed', 'stopped', 'failed'].includes((value as { type: string }).type));
}
function assertExpected(controller: ConversationRunController, scenario: PageCase) {
  const snapshot = controller.snapshot;
  assert.deepEqual(controller.currentRun, scenario.expect.run);
  assert.equal(snapshot.status, scenario.expect.status);
  assert.equal(snapshot.canStart, scenario.expect.startAllowed);
  assert.equal(snapshot.cleanupPending, scenario.expect.cleanup === 'pending');
  // The fixture's pending cases both carry native-owned cleanup proof.
  assert.equal(snapshot.cleanupState, scenario.expect.cleanup === 'pending' ? 'owned' : scenario.expect.cleanup);
  if (scenario.expect.stopAllowed !== undefined) assert.equal(snapshot.canStop, scenario.expect.stopAllowed);
}

test('pageCases inventory retains all fifteen distinct cases, including the nine required cases', () => {
  assert.deepEqual(fixture.pageCases.map((entry) => [entry.name, Boolean(entry.requires)]), [
    ['replay-lost: a validated lost range plus a recorded terminal closes as interrupted, keeping the prefix', true],
    ['lost without a terminal stays open and unknown', false],
    ['lost without a terminal: only an explicit user closure ends it', false],
    ['recoverable delivery gap: an out-of-order terminal is buffered, then replay fills the gap', true],
    ['a refused event, then a real terminal, closes as interrupted event-refused', false],
    ['workspace admission refuses text, then a real terminal closes as interrupted workspace-limit', false],
    ['stop-incomplete records the terminal but keeps cleanup open', true],
    ['stop-incomplete cleanup ends only when native reports the group cleared', true],
    ['a not-started reply followed by events latches a contradiction', false],
    ['restored prepared run: an empty event list grants no Start', false],
    ['restored prepared run: status not-dispatched allows an explicit Start only', true],
    ['a native end with an uncleared group: the status read after the terminal keeps cleanup pending', true],
    ['restored run under an earlier pin: a recovery-only port with the run identity reads and Stops, never Starts', true],
    ['same launch: after an unknown start, status not-dispatched allows an explicit re-Start only', true],
    ['an events result with more:true keeps its events and the controller continues from the new lastSequence', true],
  ]);
});

// Contract section 18, item 4: the named conformance of the nine cases
// marked `requires`. Each runs by its own name in the matrix below through
// the production controller; cases 13 and 15 also run through the
// production port in the adapter checks at the end of this file. The
// `requires` text stays in the fixture as the record of the renderer change
// each case first needed.
const ADAPTER_13 = 'pageCases adapter: historical-pin recovery uses the production port and never dispatches the current pin';
const ADAPTER_15 = 'pageCases adapter: more pages preserve progress with fresh request ids and the accepted cursor';
const REQUIRED_CONFORMANCE: Record<string, readonly string[]> = {
  'replay-lost: a validated lost range plus a recorded terminal closes as interrupted, keeping the prefix': ['matrix'],
  'recoverable delivery gap: an out-of-order terminal is buffered, then replay fills the gap': ['matrix'],
  'stop-incomplete records the terminal but keeps cleanup open': ['matrix'],
  'stop-incomplete cleanup ends only when native reports the group cleared': ['matrix'],
  'restored prepared run: status not-dispatched allows an explicit Start only': ['matrix'],
  'a native end with an uncleared group: the status read after the terminal keeps cleanup pending': ['matrix'],
  'restored run under an earlier pin: a recovery-only port with the run identity reads and Stops, never Starts': ['matrix', ADAPTER_13],
  'same launch: after an unknown start, status not-dispatched allows an explicit re-Start only': ['matrix'],
  'an events result with more:true keeps its events and the controller continues from the new lastSequence': ['matrix', ADAPTER_15],
};

test('each of the nine required pageCases names the tests that execute it', () => {
  const required = fixture.pageCases.filter((entry) => entry.requires).map((entry) => entry.name);
  assert.equal(required.length, 9);
  assert.deepEqual(Object.keys(REQUIRED_CONFORMANCE), required, 'one named entry per required case, in fixture order');
  for (const name of required) assert.ok(REQUIRED_CONFORMANCE[name]!.includes('matrix'), name);
});

for (const source of fixture.pageCases) test(source.name, async () => {
  const original = structuredClone(source);
  const scenario = structuredClone(source);
  const port = new ScriptedPort(scenario);
  const clock = new Clock(scenario.clock);
  let admission = true;
  const controller = new ConversationRunController({ run: scenario.run, mode: scenario.mode, port, scheduler: clock,
    checkpoint: async (record) => ({ kind: 'saved', record: structuredClone(record) }), acceptRun: () => admission });
  const actions: { kind: 'start' | 'stop'; settled: boolean }[] = [];
  const act = (kind: 'start' | 'stop') => {
    const action = { kind, settled: false };
    actions.push(action);
    void controller[kind]().then(() => { action.settled = true; });
  };
  let consumed = 0;
  try {
    if (scenario.mode === 'restored') {
      // Prove the constructor initiates recovery before advancing the clock.
      // A later quiet poll must not conceal missing automatic restore wiring.
      await until(() => !!port.held(port.statuses), 'restore automatically requests status without a driver recovery call');
    }
    for (const step of scenario.received) {
      const previous = scenario.received[consumed - 1];
      const terminalAlreadySeen = port.terminalSeen;
      const delivering = () => { if (hasTerminal(step)) port.terminalSeen = true; };
      if ('user' in step) {
        if (step.user === 'close-as-unknown') {
          assert.equal(controller.snapshot.canCloseAsUnknown, true);
          controller.closeAsUnknown();
        } else act(step.user);
      } else if ('start' in step) {
        await until(() => !!port.held(port.starts), 'explicit Start reaches the port');
        port.deliver(port.starts, startResult(step.start));
      } else if ('stop' in step) {
        await until(() => !!port.held(port.stops), 'explicit or automatic Stop reaches the port');
        delivering();
        port.deliver(port.stops, stopResult(step.stop));
      } else if ('pushed' in step) {
        admission = step.admitted !== false;
        const before = controller.currentRun.lastSequence;
        delivering();
        port.push(step.pushed);
        admission = true;
        const pushed = step.pushed as { sequence: number; type: string };
        if (pushed.type === 'completed' && pushed.sequence > before + 1) {
          assert.equal(controller.currentRun.lastSequence, before, 'a terminal gap does not consume missing output');
          assert.equal(controller.currentRun.closure, undefined);
          assert.deepEqual(controller.snapshot.pendingEvents.map((event) => event.sequence), [3, 4],
            'both the earlier out-of-order text and terminal must be buffered before replay');
        }
      } else if ('status' in step) {
        if (!port.held(port.statuses)) await clock.advance(PARTICIPANT_QUIET_POLL_MS);
        await until(() => !!port.held(port.statuses), 'status reply answers a real recovery read');
        delivering();
        port.deliver(port.statuses, { kind: 'status', ...step.status });
      } else {
        const continuation = previous && 'events' in previous && previous.events.more;
        await tick();
        if (!continuation && !port.held(port.replays)) {
          if (port.held(port.statuses)) { port.unknownStatus(); await tick(); }
          // A buffered gap is replayed by the production quiet timer. Restore
          // and more:true must instead progress from their existing requests.
          if (!port.held(port.replays) && scenario.mode === 'new') {
            await clock.advance(PARTICIPANT_QUIET_POLL_MS);
            if (port.held(port.statuses)) port.unknownStatus();
          }
        }
        await until(() => !!port.held(port.replays), 'replay reply answers a real recovery read');
        delivering();
        port.deliver(port.replays, replayResult(step.events));
      }
      consumed++;
      await tick();
      if (!terminalAlreadySeen && port.terminalSeen) {
        await until(() => port.statuses.some((call) => call.afterTerminal),
          'terminal evidence automatically requests cleanup status before any clock advance');
      }
      if ('status' in step && step.status.state === 'not-dispatched' && scenario.mode === 'restored') {
        assert.equal(controller.snapshot.canStart, false, 'restored status alone cannot bypass the incomplete replay barrier');
        assert.equal(port.starts.length, 0);
      }
    }
    await until(() => actions.every((action) => action.settled), 'all scripted explicit actions settle');
    await clock.advance(RUN_CHECKPOINT_INTERVAL_MS);
    assertExpected(controller, scenario);
    assert.deepEqual(controller.snapshot.savedRecord, scenario.expect.run,
      'production checkpoint scheduling obtains the complete expected in-memory acknowledgement');
    assert.equal(consumed, scenario.received.length);
    const explicitStarts = scenario.received.filter((step) => 'user' in step && step.user === 'start').length;
    assert.equal(port.starts.length, explicitStarts, 'no Start is invented by restore, status or replay');
    const expectedStops = scenario.received.filter((step) => 'stop' in step).length;
    assert.equal(port.stops.length, expectedStops);
    for (const input of port.inputs) assert.deepEqual(input, {
      runId: scenario.run.runId, sessionId: scenario.run.sessionId, userMessageId: scenario.run.userMessageId,
      assistantMessageId: scenario.run.assistantMessageId, participant: scenario.run.participant, inputChunks: scenario.run.inputChunks,
    });
    assert.equal(port.starts.filter((call) => call.delivery === 'fixture').length, explicitStarts);
    assert.equal(port.stops.filter((call) => call.delivery === 'fixture').length, port.stops.length);
    assert.equal(port.statuses.filter((call) => call.delivery === 'fixture').length, scenario.received.filter((step) => 'status' in step).length);
    assert.equal(port.replays.filter((call) => call.delivery === 'fixture').length, scenario.received.filter((step) => 'events' in step).length);
    if (scenario.received.some((step) => 'events' in step && step.events.more)) {
      assert.deepEqual(port.replays.filter((call) => call.delivery === 'fixture').map((call) => call.target.afterSequence), [1, 2]);
    }
    if (scenario.expect.startRequested !== undefined) {
      assert.equal(scenario.expect.startRequested, false);
      assert.ok(actions.filter((action) => action.kind === 'start').every((action) => action.settled));
    }
    // Elapsed virtual time without user actions detects later automatic Start
    // or Stop dispatches. Held reads do not prove completed polling cycles.
    await clock.advance(2 * PARTICIPANT_QUIET_POLL_MS);
    assert.equal(port.starts.length, explicitStarts);
    assert.equal(port.stops.length, expectedStops);
    if (scenario.expect.status === 'terminal') {
      assert.equal(port.terminalSeen, true);
      assert.ok(port.statuses.some((call) => call.afterTerminal), 'terminal recovery request remains in the call log');
    }
    assert.deepEqual(port.errors, [], 'port assertions must not be hidden by production error handling');
    assertExpected(controller, scenario);
    for (const call of [...port.starts, ...port.stops, ...port.statuses, ...port.replays]) {
      assert.equal(call.target.runId, scenario.run.runId);
      assert.equal(call.target.sessionId, scenario.run.sessionId);
    }
    assert.deepEqual(source, original, 'the shared fixture was not mutated');
    assert.deepEqual(scenario, original, 'the runner did not mutate its fixture copy');
  } finally {
    controller.dispose();
    port.release();
    await tick();
    assert.equal(clock.timers.size, 0);
  }
});

type WireRequest = { v: number; requestId: string; connectionId: string; generation: number;
  operation: string; payload: Record<string, unknown> };
function adapter(scenario: PageCase, handler: (request: WireRequest) => Record<string, unknown> | Promise<Record<string, unknown>>) {
  const context = { connectionId: 'invented-page-cases', documentGeneration: 1 };
  const requests: WireRequest[] = [];
  const errors: unknown[] = [];
  let deliver = (_reply: string) => {};
  let nextId = 0;
  const transport: NativeHostTransport = {
    listen(reply) { deliver = reply; return () => {}; },
    async send(wire) {
      try {
        const request = JSON.parse(wire) as WireRequest;
        requests.push(request);
        const response = request.operation === 'participant.availability'
          ? { outcome: 'ok', participants: [{ ...(scenario.currentPin ?? scenario.run.participant), available: true, reason: null }] }
          : await handler(request);
        const { payload: _payload, ...envelope } = request;
        deliver(JSON.stringify({ ...envelope, ...response }));
      } catch (error) {
        // NativeHostClient turns a thrown transport error into unknown. Keep the
        // test failure independently visible, especially for unknown-run cases.
        errors.push(error);
        throw error;
      }
    },
  };
  const codec = new NativeProofCodec(context, 128);
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, codec,
    { ...context, maxRetainedRequests: 128, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, timeoutMs: 1000 });
  const connection = new NativeParticipantConnection({ client, context, workspaceHandle: 'invented-page-workspace', events: new EventTarget(),
    requestId: () => `74000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}` });
  return { connection, port: connection.portFor(scenario.run.participant), requests, errors,
    dispose() { connection.dispose(); client.revoke(); codec.revoke(); } };
}

test(ADAPTER_13, async () => {
  const scenario = fixture.pageCases.find((entry) => entry.currentPin)!;
  assert.ok(scenario);
  const status = scenario.received.find((step) => 'status' in step) as { status: Reply<'participant.status'> };
  const events = scenario.received.find((step) => 'events' in step) as { events: Reply<'participant.events'> };
  const stop = scenario.received.find((step) => 'stop' in step) as { stop: Reply<'participant.stop'> };
  const delivered = new Set<string>();
  const h = adapter(scenario, (request) => {
    assert.equal(request.payload.runId, scenario.run.runId);
    assert.equal(request.payload.sessionId, scenario.run.sessionId);
    const reply = request.operation === 'participant.status' ? status.status
      : request.operation === 'participant.events' ? events.events
      : request.operation === 'participant.stop' ? stop.stop : assert.fail('unexpected native operation');
    // Deliver each listed authoritative reply once. Later quiet reads are held.
    if (delivered.has(request.operation)) return new Promise<Record<string, unknown>>(() => {});
    delivered.add(request.operation);
    return { outcome: 'ok', runId: scenario.run.runId, ...reply };
  });
  const clock = new Clock(scenario.clock);
  let controller: ConversationRunController | undefined;
  try {
    await h.connection.refreshAvailability();
    assert.deepEqual(h.port.identity, scenario.run.participant);
    assert.equal(h.port.canStart?.(), false);
    controller = new ConversationRunController({ run: scenario.run, mode: scenario.mode, port: h.port, scheduler: clock,
      checkpoint: async (record) => ({ kind: 'saved', record: structuredClone(record) }) });
    await until(() => controller!.snapshot.error === 'event-gap' && controller!.snapshot.canCloseAsUnknown,
      'the production codec and adapter deliver decoded lost evidence before Stop');
    assert.equal(controller.snapshot.canStop, true);
    let stopSettled = false;
    const stopping = controller.stop().then(() => { stopSettled = true; });
    // Participant requests have their own host timeout. Require prompt decoding
    // without advancing time so a dropped Stop reply cannot pass after 15s.
    await until(() => stopSettled, 'the decoded Stop reply settles the action within bounded event-loop turns');
    await stopping;
    assertExpected(controller, scenario);
    await controller.start();
    assert.deepEqual(await h.port.start({ runId: scenario.run.runId, sessionId: scenario.run.sessionId,
      userMessageId: scenario.run.userMessageId, assistantMessageId: scenario.run.assistantMessageId,
      participant: scenario.run.participant, inputChunks: scenario.run.inputChunks }),
    { kind: 'not-started', reason: 'participant-changed', retryable: false });
    await clock.advance(2 * PARTICIPANT_QUIET_POLL_MS);
    assert.equal(h.requests.filter((request) => request.operation === 'participant.start').length, 0);
    assert.equal(h.requests.filter((request) => request.operation === 'participant.stop').length, 1);
    assert.deepEqual(controller.currentRun, scenario.expect.run);
    assert.equal(new Set(h.requests.map((request) => request.requestId)).size, h.requests.length);
    assert.deepEqual([...delivered], ['participant.status', 'participant.events', 'participant.stop']);
    for (const request of h.requests.filter((request) => request.operation !== 'participant.availability')) {
      assert.equal(request.payload.workspaceHandle, 'invented-page-workspace');
      assert.equal(request.payload.runId, scenario.run.runId);
      assert.equal(request.payload.sessionId, scenario.run.sessionId);
    }
    assert.deepEqual(h.errors, [], 'transport assertions must not be hidden as native unknown results');
  } finally { controller?.dispose(); h.dispose(); assert.equal(clock.timers.size, 0); }
});

test(ADAPTER_15, async () => {
  const scenario = fixture.pageCases.find((entry) => entry.received.some((step) => 'events' in step && step.events.more))!;
  const pages = scenario.received.filter((step): step is { events: Reply<'participant.events'> } => 'events' in step);
  let nextPage = 0;
  const h = adapter(scenario, (request) => {
    assert.equal(request.operation, 'participant.events');
    assert.equal(request.payload.runId, scenario.run.runId);
    assert.equal(request.payload.sessionId, scenario.run.sessionId);
    assert.equal(request.payload.maxEvents, 64);
    assert.equal(request.payload.workspaceHandle, 'invented-page-workspace');
    const page = pages[nextPage++];
    assert.ok(page, 'the adapter must not fetch an unlisted page');
    return { outcome: 'ok', runId: scenario.run.runId, ...page.events };
  });
  try {
    const result = await h.port.reconcile({ runId: scenario.run.runId, sessionId: scenario.run.sessionId,
      afterSequence: scenario.run.lastSequence });
    assert.deepEqual(result, { kind: 'events', events: pages.flatMap((page) => page.events.events), more: false });
    assert.equal(nextPage, pages.length);
    assert.deepEqual(h.requests.map((request) => request.payload.afterSequence), [1, 2]);
    assert.equal(new Set(h.requests.map((request) => request.requestId)).size, 2);
    assert.deepEqual(h.errors, [], 'transport assertions must not be hidden as native unknown results');
  } finally { h.dispose(); }
});
