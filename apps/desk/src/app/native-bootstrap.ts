import { NativeHostClient, type NativeHostTransport } from '../adapters/native-host-client';
import { NativeProofCodec, NATIVE_PROOF_LIMITS, NATIVE_PROOF_OPERATIONS, type NativeProofRequest, type NativeProofResult } from '../adapters/native-host-codec';
import { NativeProofRepository } from '../adapters/native-proof-repository';
import { createWKHostTransport } from '../adapters/wk-host-transport';
import { NativeParticipantConnection } from '../adapters/native-participant-port';
import { NATIVE_PARTICIPANT_OPERATIONS } from '../adapters/native-participant-codec';
import { NativeDictationLane } from '../adapters/native-dictation';
import { createNativeProofRuntime, type DeskRuntime, type RuntimeLifecycle } from './runtime';

const participantHostOperations = [
  ...NATIVE_PROOF_OPERATIONS, 'workspace.reconcile', 'dictation.receipt', ...NATIVE_PARTICIPANT_OPERATIONS,
];

export interface NativeProofEnvironment {
  readonly bootstrap: unknown;
  readonly postMessage: (envelope: Record<string, unknown>) => Promise<unknown>;
  readonly events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

export type NativeInitialization =
  | { readonly kind: 'ready'; readonly runtime: DeskRuntime }
  | { readonly kind: 'unavailable'; readonly message: string };

/** getRandomValues also works where a custom scheme lacks randomUUID(). */
export function nativeProofId(): string {
  const values = new Uint8Array(16);
  globalThis.crypto.getRandomValues(values);
  values[6] = (values[6]! & 0x0f) | 0x40;
  values[8] = (values[8]! & 0x3f) | 0x80;
  const hex = Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Explicit entry for an invented-data native build. Never called by the browser
 * entry because a global, URL parameter or lookalike object happens to exist.
 * Native WKWebView/frame/origin checks provide authority; this bootstrap only
 * correlates messages. There is no browser fallback or private-readiness claim.
 */
export async function initializeNativeProof(
  environment: NativeProofEnvironment,
  options: { requestId?: () => string; timeoutMs?: number; maxRetainedRequests?: number } = {},
): Promise<NativeInitialization> {
  const unavailable = (): NativeInitialization => ({ kind: 'unavailable',
    message: 'The native proof could not open. Reopen it from the Mac app. Existing work was not replaced.' });
  let active = true;
  const listeners = new Set<() => void>();
  let transport: ReturnType<typeof createWKHostTransport> | undefined;
  let codec: NativeProofCodec | undefined;
  let client: NativeHostClient<NativeProofRequest, NativeProofResult> | undefined;
  let repository: NativeProofRepository | undefined;
  let participantTransport: ReturnType<typeof createWKHostTransport> | undefined;
  let participantCodec: NativeProofCodec | undefined;
  let participantClient: NativeHostClient<NativeProofRequest, NativeProofResult> | undefined;
  let participants: NativeParticipantConnection | undefined;
  let dictationTransport: ReturnType<typeof createWKHostTransport> | undefined;
  let dictationCodec: NativeProofCodec | undefined;
  let dictationClient: NativeHostClient<NativeProofRequest, NativeProofResult> | undefined;
  let dictation: NativeDictationLane | undefined;
  const lifecycle: RuntimeLifecycle = {
    isActive: () => active,
    subscribeInvalidation(listener) {
      if (!active) { listener(); return () => {}; }
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    revoke() {
      if (!active) return;
      active = false;
      dictation?.revoke();
      dictationClient?.revoke();
      dictationCodec?.revoke();
      dictationTransport?.dispose();
      participants?.dispose();
      participantClient?.revoke();
      participantCodec?.revoke();
      participantTransport?.dispose();
      repository?.revoke();
      client?.revoke();
      codec?.revoke();
      transport?.dispose();
      for (const listener of listeners) {
        try { listener(); } catch { /* One consumer cannot prevent revocation. */ }
      }
      listeners.clear();
    },
  };
  try {
    const requestId = options.requestId ?? nativeProofId;
    const maxRetainedRequests = options.maxRetainedRequests ?? 256;
    transport = createWKHostTransport(environment.bootstrap, environment.postMessage, environment.events);
    const selected = transport;
    const observed: NativeHostTransport = {
      send: (wire) => selected.send(wire),
      listen: (reply, revoked) => selected.listen(reply, () => {
        lifecycle.revoke();
        revoked();
      }),
    };
    codec = new NativeProofCodec(selected.context, maxRetainedRequests);
    client = new NativeHostClient(observed, codec, {
      ...selected.context, maxRetainedRequests,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes,
    });
    const reply = await client.request({ requestId: requestId(), operation: 'host.capabilities', payload: {} });
    if (!active || reply.kind !== 'completed' || reply.result.operation !== 'host.capabilities'
      || reply.result.outcome !== 'ok' || reply.result.capabilities.store !== 'ready'
      || reply.result.capabilities.lock !== 'unlocked') {
      lifecycle.revoke();
      return unavailable();
    }
    const capabilities = reply.result.capabilities;
    const supportsParticipants = NATIVE_PARTICIPANT_OPERATIONS.every((name) => capabilities.operations.includes(name));
    if (supportsParticipants && (capabilities.operations.length !== participantHostOperations.length
      || participantHostOperations.some((name, index) => capabilities.operations[index] !== name))) {
      lifecycle.revoke();
      return unavailable();
    }
    if (supportsParticipants) {
      participantTransport = createWKHostTransport(environment.bootstrap, environment.postMessage, environment.events);
      const participantSelected = participantTransport;
      const participantObserved: NativeHostTransport = {
        send: (wire) => participantSelected.send(wire),
        listen: (receive, revoked) => participantSelected.listen(receive, () => { lifecycle.revoke(); revoked(); }),
      };
      participantCodec = new NativeProofCodec(participantSelected.context, maxRetainedRequests);
      participantClient = new NativeHostClient(participantObserved, participantCodec, {
        ...participantSelected.context, maxRetainedRequests,
        timeoutMs: options.timeoutMs ?? 15_000, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes,
        ...(options.timeoutMs === undefined ? {} : {
          operationTimeoutMs: Object.fromEntries(NATIVE_PARTICIPANT_OPERATIONS.map((name) => [name, options.timeoutMs!])),
        }),
      });
      participants = new NativeParticipantConnection({ client: participantClient, context: participantSelected.context,
        workspaceHandle: capabilities.workspaceHandle, events: environment.events, requestId,
        onRevoked: () => lifecycle.revoke(),
      });
    }
    if (capabilities.operations.includes('dictation.bindDraft') && capabilities.operations.includes('dictation.unbindDraft')) {
      // Its own client, so binding never waits behind (or blocks) a workspace save.
      dictationTransport = createWKHostTransport(environment.bootstrap, environment.postMessage, environment.events);
      const dictationSelected = dictationTransport;
      const dictationObserved: NativeHostTransport = {
        send: (wire) => dictationSelected.send(wire),
        listen: (receive, revoked) => dictationSelected.listen(receive, () => { lifecycle.revoke(); revoked(); }),
      };
      dictationCodec = new NativeProofCodec(dictationSelected.context, maxRetainedRequests);
      dictationClient = new NativeHostClient(dictationObserved, dictationCodec, {
        ...dictationSelected.context, maxRetainedRequests,
        timeoutMs: options.timeoutMs ?? 10_000, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes,
      });
      dictation = new NativeDictationLane({ client: dictationClient, context: dictationSelected.context,
        workspaceHandle: capabilities.workspaceHandle, events: environment.events, requestId,
        onRevoked: () => lifecycle.revoke() });
    }
    repository = new NativeProofRepository(client, capabilities.workspaceHandle, requestId, () => lifecycle.revoke(),
      { participants: supportsParticipants });
    const runtime = createNativeProofRuntime(repository, lifecycle, { createId: requestId, nativeParticipants: participants,
      dictation });
    if (!active || !runtime.isActive()) { runtime.revoke(); return unavailable(); }
    // Availability must not delay opening saved work. Later checks are tied to
    // focus/visibility, Send, picker actions and explicit Start, never an idle page timer.
    void participants?.refreshAvailability();
    if (!active) return unavailable();
    return { kind: 'ready', runtime };
  } catch {
    lifecycle.revoke();
    return unavailable();
  }
}
