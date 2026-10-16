import type { ConversationRun, ParticipantIdentity } from './conversation-run-types';
import { LOCAL_PARTICIPANT_ID, MAX_CONTEXT_RUNS } from './conversation-runs';

/**
 * Step 3 PR 4a: the page's side of a local model (contract section 20).
 * Pure helpers only: no transport, storage or provider choice lives here.
 */

/** Section 20.3's one limit: earlier turns' text plus the new message, in UTF-8 bytes. */
export const MAX_LOCAL_CONTEXT_BYTES = 262_144;

export type LocalRouteReason = 'ollama-not-running' | 'catalog-unreadable' | 'catalog-too-large' | 'host-not-loopback';

const utf8 = (text: string) => new TextEncoder().encode(text).byteLength;

export function isLocalParticipant(identity: Readonly<ParticipantIdentity> | undefined | null): boolean {
  return identity?.id === LOCAL_PARTICIPANT_ID;
}

/** The model's name, without its digest. Native sends `label` as exactly that name. */
export function localModelName(identity: Readonly<ParticipantIdentity>): string {
  return identity.label;
}

/** Plain-language reason when the whole local route is down (section 20.2). */
export function localRouteMessage(reason: LocalRouteReason | string | null | undefined): string {
  switch (reason) {
    case 'ollama-not-running': return 'Ollama is not running on this Mac. Open Ollama, then check again. Your draft is kept.';
    case 'catalog-unreadable': return 'Ollama answered, but its list of models could not be read. Restart Ollama, then check again. Your draft is kept.';
    case 'catalog-too-large': return 'Ollama lists more than 256 models, so none are shown. Remove some models in Ollama, then check again.';
    case 'host-not-loopback': return 'The local model address did not lead back to this Mac, so nothing will be sent. Check this Mac’s network settings, then check again.';
    default: return 'Local models could not be checked. Your draft is kept; check again.';
  }
}

/** Plain-language reason for one listed model that cannot be used (section 20.2). */
export function localEntryMessage(reason: string | null | undefined): string {
  return reason === 'model-not-local'
    ? 'This model runs on Ollama’s servers, not on this Mac. Only models that stay on this Mac can be used here.'
    : 'This local model is unavailable right now.';
}

/**
 * The one "who receives this" classifier for an Ollama pin (contract section
 * 20.2). Every place that says "stays on this Mac" goes through it.
 * - `local`: the current catalog's route is ready and lists this exact pin
 *   (name and digest) as available, with no `model-not-local` reason, and
 *   the name doesn't end in `:cloud`.
 * - `cloud`: the name ends in `:cloud` (never local, whatever the host says),
 *   or the current catalog lists this exact pin as `model-not-local`.
 * - `unknown`: the current catalog can't classify it (no catalog, route not
 *   ready, pin missing, digest changed). Neither local nor cloud is claimed.
 */
export type OllamaResidency = 'local' | 'cloud' | 'unknown';
export function ollamaResidency(identity: Readonly<ParticipantIdentity>, catalog: LocalCatalogView | undefined): OllamaResidency {
  if (!isLocalParticipant(identity)) return 'unknown';
  if (localModelName(identity).endsWith(':cloud')) return 'cloud';
  if (catalog?.route?.state !== 'ready') return 'unknown';
  const exact = catalog.entries.find((entry) => entry.id === identity.id && entry.label === identity.label
    && entry.model === identity.model && entry.executionHost === identity.executionHost);
  if (!exact) return 'unknown';
  if (exact.reason === 'model-not-local') return 'cloud';
  return exact.available && exact.reason === null ? 'local' : 'unknown';
}

/** The full name of an Ollama pin; "Local · … · stays on this Mac" only when the current catalog says so. */
export function ollamaChoiceTitle(identity: Readonly<ParticipantIdentity>, catalog: LocalCatalogView | undefined): string {
  const name = localModelName(identity);
  switch (ollamaResidency(identity, catalog)) {
    case 'local': return `Local · ${name} · stays on this Mac`;
    case 'cloud': return `Cloud · ${name} · not on this Mac (can’t be used)`;
    default:
      if (catalog?.route?.state === 'ready') {
        return catalog.entries.some((entry) => entry.label === identity.label)
          ? `Ollama · ${name} · changed since you chose it` : `Ollama · ${name} · no longer installed`;
      }
      return `Ollama · ${name} · not available right now`;
  }
}

/** The short name on the picker button. */
export function ollamaChoiceShortName(identity: Readonly<ParticipantIdentity>, catalog: LocalCatalogView | undefined): string {
  const residency = ollamaResidency(identity, catalog);
  return `${residency === 'local' ? 'Local' : residency === 'cloud' ? 'Cloud' : 'Ollama'} · ${localModelName(identity)}`;
}

export interface LocalCatalogView {
  /** Null on a host without a local route (contract revision 3). */
  readonly route: { readonly state: 'ready' | 'unavailable'; readonly reason: string | null } | null;
  readonly entries: readonly (Readonly<ParticipantIdentity> & { readonly available: boolean; readonly reason: string | null })[];
}

/**
 * Why a saved local choice can't be used now, or null when it can. The page
 * derives "missing" and "changed" itself (section 20.2); native never invents
 * an entry for a model it can't list.
 */
export function localChoiceProblem(choice: Readonly<ParticipantIdentity>, catalog: LocalCatalogView): string | null {
  if (!catalog.route) return 'This Mac app does not offer local models yet. No other model will be used.';
  if (catalog.route.state !== 'ready') return localRouteMessage(catalog.route.reason);
  const exact = catalog.entries.find((entry) => entry.id === choice.id && entry.label === choice.label
    && entry.model === choice.model && entry.executionHost === choice.executionHost);
  if (exact) return exact.available ? null : localEntryMessage(exact.reason);
  if (catalog.entries.some((entry) => entry.label === choice.label)) {
    return `${localModelName(choice)} changed in Ollama since you chose it (it was updated or replaced). Choose it again to use the new version.`;
  }
  return `${localModelName(choice)} is no longer installed in Ollama. Choose another model, or install it again.`;
}

export type LocalContextResult =
  | { readonly kind: 'ok'; readonly contextRunIds: string[]; readonly contextBytes: number }
  | { readonly kind: 'too-large' };

/**
 * Section 20.3: the earlier completed runs of this session, oldest first,
 * within one limit over their text plus the new message. The oldest whole
 * runs are left out until it fits; a turn is never cut. Order is the saved
 * record's order, which is the order native checks.
 */
export function selectLocalContext(runs: readonly Readonly<ConversationRun>[], sessionId: string, input: string): LocalContextResult {
  const inputBytes = utf8(input);
  if (inputBytes > MAX_LOCAL_CONTEXT_BYTES) return { kind: 'too-large' };
  const earlier = runs.filter((run) => run.sessionId === sessionId && run.phase === 'completed');
  const chosen: string[] = [];
  let total = inputBytes;
  for (let index = earlier.length - 1; index >= 0 && chosen.length < MAX_CONTEXT_RUNS; index--) {
    const run = earlier[index]!;
    const size = utf8(run.inputChunks.join('')) + utf8(run.outputChunks.join(''));
    if (total + size > MAX_LOCAL_CONTEXT_BYTES) break;
    total += size;
    chosen.push(run.runId);
  }
  return { kind: 'ok', contextRunIds: chosen.reverse(), contextBytes: total - inputBytes };
}

/**
 * A start the host refused, in plain words, or undefined for a reason that
 * isn't local-specific. The guidance follows `retryable`: the controller offers
 * "Start prepared message" only for a retryable refusal, so only those
 * messages point to it; every other one says how to recover without it.
 */
export function localStartRefusalMessage(reason: string, retryable: boolean, identity: Readonly<ParticipantIdentity>): string | undefined {
  const name = localModelName(identity);
  const again = 'Close this message, then use Retry';
  switch (reason) {
    case 'run-mismatch': return retryable
      ? 'The earlier part of this conversation changed before sending, so nothing was sent. Use Start prepared message to try again.'
      : `The earlier part of this conversation changed before sending, so nothing was sent. ${again} to send it again with the conversation as it is now.`;
    case 'participant-changed': return retryable
      ? `${name} changed in Ollama since you chose it, so nothing was sent. Use Start prepared message once it is back.`
      : `${name} changed in Ollama since you chose it, so nothing was sent. Choose a model again, then ${again.charAt(0).toLowerCase()}${again.slice(1)}.`;
    case 'participant-unavailable': return retryable
      ? 'The local model is not ready on this Mac, so nothing was sent. Open Ollama, then use Start prepared message.'
      : `${name} now runs off this Mac, so it can’t be used and nothing was sent. Pick a local model, then ${again.charAt(0).toLowerCase()}${again.slice(1)}.`;
    case 'text-too-large': return retryable
      ? 'This message plus the earlier conversation was too long for the local model, so nothing was sent. Use Start prepared message to try again.'
      : 'This message plus the earlier conversation is too long for the local model, so nothing was sent. Close this message and send a shorter one.';
    default: return undefined;
  }
}

/**
 * Whether the Mac reported that this local reply started (contract section 8:
 * the first event is `started`, or a terminal if the run ends before
 * starting; section 20.4: `started` follows Ollama's HTTP 200). Sequences
 * start at 1 and rise by one, so any event above sequence 1 proves sequence 1
 * was `started`. A saved run keeps no event types; every place it keeps a
 * sequence or text is evidence:
 * - `lastSequence` above 1, or exactly 1 in phase `running` (only `started`
 *   moves a prepared run to running);
 * - any saved reply text (text only follows `started`);
 * - a closure's terminal event above sequence 1, including after a replay
 *   gap that hid `started` itself (`lastSequence` can still be 0 then);
 * - a closure's lost range starting after sequence 1.
 * A stopped or failed ending at sequence 1 never started.
 */
export function localRunStarted(run: Readonly<ConversationRun>): boolean {
  if (run.lastSequence >= 2 || run.lastSequence === 1 && run.phase === 'running') return true;
  if (run.outputChunks.some((chunk) => chunk.length > 0)) return true;
  const closure = run.closure;
  if (closure?.kind === 'interrupted') {
    if (closure.terminalEvent.sequence > 1) return true;
    if (closure.reason === 'replay-lost' && closure.lost.fromSequence > 1) return true;
  }
  return false;
}

/** The ending of a local reply, in plain words, or undefined while it is still open. */
export function localRunOutcome(run: Readonly<ConversationRun>): string | undefined {
  if (run.closure?.kind === 'interrupted') {
    const event = run.closure.terminalEvent;
    if (!localRunStarted(run)) return event.type === 'stopped' ? 'Stopped before any reply started.'
      : 'No reply started: the local model could not be reached or refused the request.';
    if (event.type === 'completed') return 'Reply finished, but some of its updates could not be checked. The text shown may be incomplete.';
    return 'Reply cut off. The text so far is kept.';
  }
  if ((run.phase === 'stopped' || run.phase === 'failed') && !localRunStarted(run)) {
    return run.phase === 'stopped' ? 'Stopped before any reply started.' : 'No reply started: the local model could not be reached or refused the request.';
  }
  if (run.closure?.kind === 'unknown' && run.lastSequence === 0) return 'Closed before any reply arrived. Use Retry to send this message again.';
  if (run.closure?.kind === 'unknown') return 'Reply cut off. The text so far is kept; the Mac never recorded how it ended.';
  switch (run.phase) {
    case 'completed': return 'Reply complete · stayed on this Mac';
    case 'stopped': return 'Stopped. The reply so far is kept.';
    case 'failed':
      switch (run.reason) {
        case 'reply-too-long': return 'Reply cut off: it reached the length limit for one conversation.';
        case 'timeout': return 'Reply cut off: the local model stopped answering in time.';
        default: return 'Reply failed: the connection to Ollama on this Mac broke off. The text so far is kept.';
      }
    default: return undefined;
  }
}

/** Retry is offered only after a local reply ended without completing. It never resends on its own. */
export function canRetryLocalRun(run: Readonly<ConversationRun>): boolean {
  if (!isLocalParticipant(run.participant)) return false;
  if (run.closure) return !(run.closure.kind === 'interrupted' && run.closure.terminalEvent.type === 'completed');
  return run.phase === 'stopped' || run.phase === 'failed';
}
