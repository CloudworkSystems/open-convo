import type { ParticipantIdentity } from './conversation-run-types';
import { MAX_PARTICIPANT_FIELD_BYTES } from './conversation-runs';

/** Runtime catalog evidence, never saved authority to call a provider. */
export interface ParticipantChoice {
  identity: ParticipantIdentity;
  provider: string;
  destination: string;
  approved: boolean;
  available: boolean;
  unavailableReason: string | null;
}

/** Accept JSON data fields only; do not evaluate accessors or accept hidden fields. */
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => {
    const field = Object.getOwnPropertyDescriptor(value, key);
    return !!field && field.enumerable && Object.hasOwn(field, 'value');
  });
}

function metadata(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_PARTICIPANT_FIELD_BYTES) return false;
  // TextEncoder replaces invalid UTF-16, so reject it before counting UTF-8 bytes.
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(++index);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return new TextEncoder().encode(value).byteLength <= MAX_PARTICIPANT_FIELD_BYTES;
}

export function validParticipantIdentity(value: unknown): value is ParticipantIdentity {
  return exact(value, ['id', 'label', 'model', 'executionHost'])
    && ['id', 'label', 'model', 'executionHost'].every((key) => metadata(value[key]));
}

export function validParticipantChoice(value: unknown): value is ParticipantChoice {
  return exact(value, ['identity', 'provider', 'destination', 'approved', 'available', 'unavailableReason'])
    && validParticipantIdentity(value.identity) && metadata(value.provider) && metadata(value.destination)
    && typeof value.approved === 'boolean' && typeof value.available === 'boolean'
    && (value.available ? value.unavailableReason === null : metadata(value.unavailableReason));
}

export function sameParticipantIdentity(first: Readonly<ParticipantIdentity>, second: Readonly<ParticipantIdentity>): boolean {
  return first.id === second.id && first.label === second.label
    && first.model === second.model && first.executionHost === second.executionHost;
}

/** Tuple encoding prevents collisions from punctuation in literal identity fields. */
export function participantChoiceKey(identity: Readonly<ParticipantIdentity>): string {
  return JSON.stringify([identity.id, identity.label, identity.model, identity.executionHost]);
}
