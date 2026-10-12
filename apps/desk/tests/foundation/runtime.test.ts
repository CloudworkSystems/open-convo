import assert from 'node:assert/strict';
import test from 'node:test';
import { createNativeProofRuntime, type RuntimeLifecycle } from '../../src/app/runtime';
import { emptyCanvasLayout } from '../../src/domain/canvas-layout';
import { DEFAULT_IDENTITY } from '../../src/adapters/browser-identity';
import type { WorkspaceRepository } from '../../src/adapters/workspace-repository';
import type { ParticipantChoice } from '../../src/domain/participant-choices';
import type { ParticipantPort } from '../../src/adapters/participant-runtime';
import { NativeParticipantConnection } from '../../src/adapters/native-participant-port';
import { NativeHostClient, type NativeHostTransport } from '../../src/adapters/native-host-client';
import { NativeProofCodec, NATIVE_PROOF_LIMITS, type NativeProofRequest, type NativeProofResult } from '../../src/adapters/native-host-codec';

function fixture(options: Parameters<typeof createNativeProofRuntime>[2] = {}) {
  let active = true;
  let revocations = 0;
  const listeners = new Set<() => void>();
  const host: RuntimeLifecycle = {
    isActive: () => active,
    subscribeInvalidation(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    revoke() { if (!active) return; active = false; revocations++; for (const fn of listeners) fn(); },
  };
  const workspace: WorkspaceRepository = {
    loadLatest: async () => ({ kind: 'unavailable', error: 'Invented unavailable host.' }),
    save: async () => ({ kind: 'unavailable', error: 'Invented unavailable host.' }),
    subscribe: () => () => {},
  };
  return { runtime: createNativeProofRuntime(workspace, host, options), host, revocations: () => revocations };
}

const catalogChoice = (index = 0): ParticipantChoice => ({
  identity: { id: `invented-worker-${index}`, label: 'Invented participant', model: 'Invented model', executionHost: 'Invented host' },
  provider: 'Invented provider', destination: 'Invented cloud', approved: true, available: false,
  unavailableReason: 'Live sending is not connected.',
});

test('an absent runtime catalog retains the legacy injected participant while an empty catalog stays explicitly empty', () => {
  const participant: ParticipantPort = {
    identity: catalogChoice().identity,
    subscribe: () => () => {},
    start: async () => ({ kind: 'not-started' }),
    stop: async () => ({ kind: 'unknown' }),
    reconcile: async () => ({ kind: 'unknown' }),
  };
  const legacy = fixture({ participant });
  const empty = fixture({ participant, participantChoices: [] });
  assert.equal(legacy.runtime.participant, participant);
  assert.equal(legacy.runtime.participantChoices, undefined);
  assert.equal(legacy.runtime.participantAvailabilityChecking, undefined);
  assert.equal(empty.runtime.participant, participant);
  assert.deepEqual(empty.runtime.participantChoices, []);
  assert.equal(Object.isFrozen(empty.runtime.participantChoices), true);
  legacy.runtime.revoke();
  empty.runtime.revoke();
});

test('native runtime hides cached confirmation during a fresh check and after failure, then restores only fresh evidence', async t => {
  const context = { connectionId: 'invented-runtime-availability', documentGeneration: 2 };
  const identity = { id: 'claude-code', label: 'Invented Claude', model: 'invented-model', executionHost: 'this-mac' };
  const confirmation = { state: 'active', confirmedAt: '2026-10-10T12:00:00.000Z', runsLeft: 5 };
  let deliver = (_wire: string) => {};
  let respond!: (body: Record<string, unknown>) => void;
  let seq = 0;
  const transport: NativeHostTransport = {
    listen(reply) { deliver = reply; return () => {}; },
    send(wire) {
      const { payload: _payload, ...base } = JSON.parse(wire);
      respond = (body) => deliver(JSON.stringify({ ...base, ...body }));
    },
  };
  const client = new NativeHostClient<NativeProofRequest, NativeProofResult>(transport, new NativeProofCodec(context, 16),
    { ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 16, timeoutMs: 1000 });
  const nativeParticipants = new NativeParticipantConnection({ client, context, workspaceHandle: 'invented-workspace', events: new EventTarget(),
    requestId: () => `13000000-0000-4000-8000-${String(++seq).padStart(12, '0')}` });
  const { runtime } = fixture({ nativeParticipants });
  t.after(() => { runtime.revoke(); nativeParticipants.dispose(); });
  assert.equal(runtime.participantAvailabilityChecking, false);
  assert.equal(runtime.participantConfirmation, undefined);
  assert.match(runtime.participantAvailabilityMessage!, /not been checked/);
  let check = runtime.refreshParticipants!();
  assert.equal(runtime.participantAvailabilityChecking, true);
  assert.match(runtime.participantAvailabilityMessage!, /Checking participant availability/);
  respond({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null, confirmation }] });
  await check;
  assert.equal(runtime.participantAvailabilityChecking, false);
  assert.deepEqual(runtime.participantConfirmation, confirmation);
  assert.equal(runtime.participantAvailabilityMessage, undefined);
  assert.equal(runtime.participantChoices![0].available, true);
  check = runtime.refreshParticipants!();
  assert.equal(runtime.participantAvailabilityChecking, true);
  assert.equal(runtime.participantConfirmation, undefined, 'A pending check must not present the old five-run confirmation as current.');
  assert.equal(runtime.participantChoices![0].available, false);
  assert.match(runtime.participantChoices![0].unavailableReason!, /Checking participant availability/);
  respond({ outcome: 'refused', reason: 'unknown-connection' });
  await check;
  assert.equal(runtime.participantAvailabilityChecking, false);
  assert.equal(runtime.participantConfirmation, undefined, 'A failed check must not restore cached confirmation.');
  assert.match(runtime.participantAvailabilityMessage!, /could not confirm/);
  assert.deepEqual(runtime.participantChoices![0].identity, identity, 'A failed check keeps the recoverable pin.');
  check = runtime.refreshParticipants!();
  assert.equal(runtime.participantAvailabilityChecking, true);
  respond({ outcome: 'ok', participants: [{ ...identity, available: true, reason: null, confirmation: { ...confirmation, runsLeft: 4 } }] });
  await check;
  assert.equal(runtime.participantAvailabilityChecking, false);
  assert.deepEqual(runtime.participantConfirmation, { ...confirmation, runsLeft: 4 });
  assert.equal(runtime.participantChoices![0].available, true);
  runtime.revoke();
  assert.equal(runtime.participantAvailabilityChecking, undefined);
  assert.equal(runtime.participantConfirmation, undefined);
});

test('runtime captures and freezes catalog metadata and identity before callers can change their supplied objects', () => {
  const original = catalogChoice();
  const supplied = [original];
  const captured = structuredClone(original);
  const { runtime } = fixture({ participantChoices: supplied });
  original.identity.model = 'Different caller model';
  original.identity.executionHost = 'Different caller host';
  original.provider = 'Different caller provider';
  original.destination = 'Different caller destination';
  original.approved = false;
  original.available = true;
  original.unavailableReason = null;
  supplied.push(catalogChoice(1));
  assert.deepEqual(runtime.participantChoices, [captured]);
  assert.equal(Object.isFrozen(runtime.participantChoices), true);
  assert.equal(Object.isFrozen(runtime.participantChoices![0]), true);
  assert.equal(Object.isFrozen(runtime.participantChoices![0].identity), true);
  assert.throws(() => { runtime.participantChoices![0].approved = false; }, TypeError);
  assert.throws(() => { runtime.participantChoices![0].identity.model = 'Mutated model'; }, TypeError);
  assert.deepEqual(runtime.participantChoices, [captured]);
  runtime.revoke();
});

test('runtime refuses malformed identities, contradictory availability and duplicate exact identities', () => {
  const malformed = catalogChoice();
  malformed.identity.model = '';
  const overlong = catalogChoice();
  overlong.identity.executionHost = '🧪'.repeat(65);
  const unavailableWithoutReason = { ...catalogChoice(), unavailableReason: null };
  const availableWithReason = { ...catalogChoice(), available: true };
  for (const participantChoices of [[malformed], [overlong], [unavailableWithoutReason], [availableWithReason],
    [catalogChoice(), catalogChoice()], null]) {
    assert.throws(() => fixture({ participantChoices: participantChoices as ParticipantChoice[] }), /participant/i);
  }
});

test('runtime permits one approved pin and up to 32 total display choices, but never multiple approved identities', () => {
  const displayChoice = (index: number) => ({ ...catalogChoice(index), approved: index === 0 });
  const accepted = fixture({ participantChoices: Array.from({ length: 32 }, (_, index) => displayChoice(index)) });
  assert.equal(accepted.runtime.participantChoices?.length, 32);
  assert.equal(accepted.runtime.participantChoices?.filter((choice) => choice.approved).length, 1);
  accepted.runtime.revoke();
  assert.throws(() => fixture({ participantChoices: Array.from({ length: 33 }, (_, index) => displayChoice(index)) }), /participant/i);
  assert.throws(() => fixture({ participantChoices: [catalogChoice(), catalogChoice(1)] }), /participant/i,
    'two approved entries are refused even when both are currently unavailable');
  assert.throws(() => fixture({ participantChoices: [{ ...catalogChoice(), available: true, unavailableReason: null }, catalogChoice(1)] }), /participant/i,
    'connection availability does not relax the one approved identity boundary');
  const unapproved = fixture({ participantChoices: [1, 2].map((index) => ({ ...catalogChoice(index), approved: false })) });
  assert.equal(unapproved.runtime.participantChoices?.filter((choice) => choice.approved).length, 0);
  unapproved.runtime.revoke();
});

test('runtime refuses sparse catalog slots instead of silently skipping invalid entries', () => {
  assert.throws(() => fixture({ participantChoices: new Array<ParticipantChoice>(1) }), /participant/i);
});

test('catalog capture refuses accessors without invoking their changing values', () => {
  let reads = 0;
  const choice = catalogChoice();
  Object.defineProperty(choice.identity, 'model', { enumerable: true, get: () => ++reads === 1 ? 'Valid model' : '' });
  assert.throws(() => fixture({ participantChoices: [choice] }), /participant/i);
  const array: ParticipantChoice[] = [];
  Object.defineProperty(array, 0, { enumerable: true, get: () => { reads++; return catalogChoice(); } });
  assert.throws(() => fixture({ participantChoices: array }), /participant/i);
  assert.equal(reads, 0, 'catalog evidence is copied from data properties without running getters');
});

test('catalog validation uses the captured array slot and never re-reads a Proxy into different picker evidence', () => {
  const choice = catalogChoice();
  const original = structuredClone(choice);
  let descriptorReads = 0;
  let propertyReads = 0;
  const catalog = new Proxy([choice], {
    get(target, key, receiver) {
      if (key === '0') { propertyReads++; return { ...catalogChoice(), approved: 'changed after validation' }; }
      return Reflect.get(target, key, receiver);
    },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === '0') { descriptorReads++; return { ...descriptor, value: descriptorReads === 1 ? choice : { ...choice, identity: { ...choice.identity, model: '' } } }; }
      return descriptor;
    },
  });
  const { runtime } = fixture({ participantChoices: catalog });
  assert.deepEqual(runtime.participantChoices, [original]);
  assert.equal(descriptorReads, 1);
  assert.equal(propertyReads, 0);
  assert.equal(Object.isFrozen(runtime.participantChoices![0].identity), true);
  choice.identity.model = 'caller changed its source';
  assert.deepEqual(runtime.participantChoices, [original]);
  runtime.revoke();
});

test('a Proxy cannot validate one identity and copy a different invalid value', () => {
  const choice = catalogChoice();
  let propertyReads = 0;
  choice.identity = new Proxy(choice.identity, {
    get(target, key, receiver) { propertyReads++; return key === 'model' ? 'Valid facade model' : Reflect.get(target, key, receiver); },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      return key === 'model' ? { ...descriptor, value: '' } : descriptor;
    },
  });
  assert.throws(() => fixture({ participantChoices: [choice] }), /participant/i,
    'the actual copied data must pass validation even when property reads advertise valid values');
  assert.equal(propertyReads, 0);
});

test('catalog availability requires the exact connected participant instead of an unrelated injected port', () => {
  const choice = { ...catalogChoice(), available: true, unavailableReason: null };
  const participant: ParticipantPort = {
    identity: { ...choice.identity },
    subscribe: () => () => {},
    start: async () => ({ kind: 'not-started' }),
    stop: async () => ({ kind: 'unknown' }),
    reconcile: async () => ({ kind: 'unknown' }),
  };
  const missing = fixture({ participantChoices: [choice] });
  const mismatched = fixture({ participantChoices: [choice], participant: { ...participant,
    identity: { ...participant.identity, model: 'Different invented model' } } });
  const matching = fixture({ participantChoices: [choice], participant });
  for (const { runtime } of [missing, mismatched]) {
    assert.equal(runtime.participantChoices![0].available, false);
    assert.equal(runtime.participantChoices![0].approved, true);
    assert.equal(runtime.participantChoices![0].unavailableReason, 'This participant has no matching connection. No other model will be used.');
    assert.deepEqual(runtime.participantChoices![0].identity, choice.identity);
    runtime.revoke();
  }
  assert.equal(matching.runtime.participantChoices![0].available, true);
  assert.equal(matching.runtime.participantChoices![0].unavailableReason, null);
  assert.equal(choice.available, true, 'Connection checks do not mutate the supplied catalog.');
  matching.runtime.revoke();
});

test('native auxiliary preferences are isolated per runtime and do not become persistent saves', async () => {
  const first = fixture(); const second = fixture();
  const initial = await first.runtime.identity.load();
  assert.equal((await first.runtime.identity.save({ ...DEFAULT_IDENTITY, displayName: 'Invented visit name' }, initial.baseline)).saved, true);
  first.runtime.layout.save({ mode: 'icons', railWidth: 240, inspectorWidth: 280 });
  assert.equal((await first.runtime.identity.load()).preferences.displayName, 'Invented visit name');
  assert.equal((await second.runtime.identity.load()).preferences.displayName, DEFAULT_IDENTITY.displayName);
  assert.equal(second.runtime.layout.load().preferences.mode, 'expanded');
  first.runtime.revoke();
  assert.equal(first.runtime.isActive(), false);
  assert.equal((await first.runtime.identity.load()).preferences.displayName, DEFAULT_IDENTITY.displayName);
  assert.equal((await first.runtime.identity.load()).readOnly, true);
  assert.equal(first.runtime.layout.load().preferences.mode, 'expanded');
  assert.equal(first.revocations(), 1);
  first.runtime.revoke();
  assert.equal(first.revocations(), 1);
  second.runtime.revoke();
});

test('connection-owned Canvas recovery protects route exit and revocation clears it and its unload listener', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  try {
    const { runtime, host } = fixture();
    runtime.canvasVisit.retain({ layout: emptyCanvasLayout(), revision: 0, pending: 1, warning: null });
    const before = new Event('beforeunload', { cancelable: true });
    target.dispatchEvent(before);
    assert.equal(before.defaultPrevented, true, 'Pending layout stays protected even without a mounted Canvas.');
    host.revoke();
    assert.equal(runtime.canvasVisit.temporary, undefined);
    const after = new Event('beforeunload', { cancelable: true });
    target.dispatchEvent(after);
    assert.equal(after.defaultPrevented, false, 'Revocation removes the protection listener with the cleared view.');
    runtime.canvasVisit.retain({ layout: emptyCanvasLayout(), revision: 0, pending: 1, warning: null });
    assert.equal(runtime.canvasVisit.temporary, undefined, 'A late callback cannot restore revoked recovery content.');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
