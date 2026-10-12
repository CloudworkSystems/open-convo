import type { NativeDocumentContext, NativeHostTransport } from './native-host-client';
import { NATIVE_PROOF_LIMITS } from './native-host-codec';

export type WKHostPostMessage = (envelope: Record<string, unknown>) => Promise<unknown>;
export type WKHostEvents = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
export interface WKHostTransport extends NativeHostTransport {
  readonly context: NativeDocumentContext;
  send(wire: string): Promise<void>;
  dispose(): void;
}

const encoder = new TextEncoder();
const bytes = (value: string) => encoder.encode(value).byteLength;
const failure = () => new TypeError('The native host transport is unavailable or invalid.');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
  && Object.getPrototypeOf(value) === Object.prototype;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const text = (value: unknown): value is string => typeof value === 'string' && bytes(value) <= NATIVE_PROOF_LIMITS.textItemBytes;

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!object(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(descriptors).length === keys.length && keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value');
  });
}

/** Refuse values JSON would silently omit, transform or execute through a getter. */
function serialize(value: unknown): string {
  if (!object(value)) throw failure();
  const ancestors = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean'
      || typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || ancestors.has(item)
      || !object(item) && !(Array.isArray(item) && Object.getPrototypeOf(item) === Array.prototype)) throw failure();
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(descriptors);
    if (Array.isArray(item)) {
      if (keys.length !== item.length + 1) throw failure();
      for (let index = 0; index < item.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure();
        visit(descriptor.value);
      }
    } else {
      for (const key of keys) {
        if (typeof key !== 'string') throw failure();
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw failure();
        visit(descriptor.value);
      }
    }
    ancestors.delete(item);
  };
  visit(value);
  const wire = JSON.stringify(value);
  if (bytes(wire) > NATIVE_PROOF_LIMITS.envelopeBytes) throw failure();
  return wire;
}

/**
 * Explicit WK integration seam; importing it does not inspect or activate a host.
 * Supply a receiver-bound closure, e.g. envelope => handler.postMessage(envelope).
 * Bootstrap identity only correlates replies; native must authenticate its frame,
 * origin and connection registry. A resolved object still needs the strict codec.
 */
export function createWKHostTransport(bootstrap: unknown, postMessage: WKHostPostMessage, events: WKHostEvents): WKHostTransport {
  let context: NativeDocumentContext;
  try {
    if (!exact(bootstrap, ['v', 'connectionId', 'generation']) || bootstrap.v !== 1
      || !text(bootstrap.connectionId) || !bootstrap.connectionId.length || !integer(bootstrap.generation)
      || typeof postMessage !== 'function' || typeof events?.addEventListener !== 'function'
      || typeof events?.removeEventListener !== 'function') throw failure();
    context = Object.freeze({ connectionId: bootstrap.connectionId, documentGeneration: bootstrap.generation });
  } catch { throw failure(); }

  let active = true;
  let subscribed = false;
  let attached = false;
  let receive: ((wire: string) => void) | undefined;
  let revoked: (() => void) | undefined;
  const dispose = () => {
    if (!active) return;
    active = false;
    const notify = revoked;
    receive = undefined;
    revoked = undefined;
    if (attached) {
      attached = false;
      try { events.removeEventListener('trueconvo-host', connectionChanged); } catch { /* Closure remains final. */ }
    }
    try { notify?.(); } catch { /* Do not leak consumer errors or reopen the connection. */ }
  };
  const connectionChanged: EventListener = (event) => {
    try {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!exact(detail, ['type', 'connectionId', 'generation', 'state', 'reason']) || detail.type !== 'host.connection'
        || detail.connectionId !== context.connectionId || detail.generation !== context.documentGeneration
        || !text(detail.reason) || !['ready', 'locked', 'revoked'].includes(detail.state as string)) return;
      if (detail.state === 'locked' || detail.state === 'revoked') dispose();
    } catch { /* Ignore malformed events without retaining or reporting their contents. */ }
  };

  return Object.freeze({
    context,
    dispose,
    listen(reply: (wire: string) => void, onRevoked: () => void) {
      if (subscribed || typeof reply !== 'function' || typeof onRevoked !== 'function') throw failure();
      subscribed = true;
      if (!active) { onRevoked(); return () => {}; }
      receive = reply;
      revoked = onRevoked;
      try {
        attached = true;
        events.addEventListener('trueconvo-host', connectionChanged);
      } catch { dispose(); throw failure(); }
      return dispose;
    },
    async send(wire: string) {
      if (!active || !subscribed) throw failure();
      try {
        if (typeof wire !== 'string' || bytes(wire) > NATIVE_PROOF_LIMITS.envelopeBytes) throw failure();
        const envelope: unknown = JSON.parse(wire);
        serialize(envelope);
        const reply = await postMessage(envelope as Record<string, unknown>);
        if (!active) return;
        const encoded = serialize(reply);
        if (active) receive?.(encoded);
      } catch {
        // Revocation already told the client its outcome is unknown. A late
        // transport failure is consumed and cannot revive that old connection.
        if (active) throw failure();
      }
    },
  });
}
