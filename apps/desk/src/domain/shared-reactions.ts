import type { ConversationRun, ParticipantIdentity } from './conversation-run-types';
import { MESSAGE_REACTIONS } from './message-marks';
import { sameParticipantIdentity } from './participant-choices';
import type { DeskState, MessageMark, Session } from './types';

/**
 * Shared reactions (plan: docs/plans/desk-shared-reactions.md, PR 2).
 * With the switch on for this conversation's participant, the owner's
 * reactions travel only inside his next message, as a visible note at the
 * top of the draft. Nothing is sent when he reacts.
 */
export const REACTIONS_NOTE_PREFIX = '[My reactions: ';
/** The marker that, left in a draft while sharing is off, holds Send (rule 8). */
const NOTE_MARKER = '[My reactions:';
const SNIPPET_CHARACTERS = 40;
export const REACTIONS_NOTE_MAX_CHARACTERS = 4000;

export interface ReactionSharing {
  /** The exact participant sharing was turned on for (rule 5). */
  participant: ParticipantIdentity;
  /** Reactions changed after this time, and after the latest Send, go in the note. */
  since: string;
  /** The note as the Desk last wrote it; a different note in the draft means he edited it. */
  note?: string;
}

/** On only while the stored participant is the conversation's current choice. */
export function reactionSharingOn(session: Pick<Session, 'participantChoice' | 'reactionSharing'> | undefined): boolean {
  return !!session?.reactionSharing && !!session.participantChoice
    && sameParticipantIdentity(session.reactionSharing.participant, session.participantChoice);
}

/** The note block at the top of a draft: the block, then the rest. Null when there is none or it is broken. */
export function splitReactionsNote(draft: string): { note: string; rest: string } | null {
  if (!draft.startsWith(REACTIONS_NOTE_PREFIX)) return null;
  const end = draft.indexOf(']', REACTIONS_NOTE_PREFIX.length);
  const newline = draft.indexOf('\n');
  if (end < 0 || (newline >= 0 && newline < end)) return null;
  const note = draft.slice(0, end + 1);
  return { note, rest: draft.slice(end + 1).replace(/^\n{1,2}/, '') };
}

/** True when the text still holds a reactions note, whole or broken. */
export function holdsReactionsNote(text: string): boolean {
  return text.includes(NOTE_MARKER);
}

/** Send is held while sharing is off and a note is left in the draft (rule 8). */
export function reactionsNoteSendHold(session: Session | undefined, draft: string): string | undefined {
  if (!session || reactionSharingOn(session) || !holdsReactionsNote(draft)) return undefined;
  return 'This draft still has a reactions note. Delete it or turn sharing back on.';
}

/** Removes the note block from the draft, edited or not (rule 8). */
export function draftWithoutReactionsNote(draft: string): string {
  const split = splitReactionsNote(draft);
  return split ? split.rest : draft;
}

function snippet(text: string): string {
  const flat = draftWithoutReactionsNote(text).replace(/\s+/g, ' ').trim().replaceAll('"', '”').replaceAll('[', '(').replaceAll(']', ')');
  const scalars = [...flat];
  return scalars.length > SNIPPET_CHARACTERS ? `${scalars.slice(0, SNIPPET_CHARACTERS).join('').trimEnd()}…` : flat;
}

interface SessionMessage { id: string; role: 'user' | 'assistant'; text: string }

function sessionMessages(state: Pick<DeskState, 'messages' | 'conversationRuns'>, sessionId: string): SessionMessage[] {
  const shown: SessionMessage[] = state.messages.filter((message) => message.sessionId === sessionId)
    .map((message) => ({ id: message.id, role: message.role, text: message.body }));
  for (const run of state.conversationRuns ?? []) {
    if (run.sessionId !== sessionId) continue;
    shown.push({ id: run.userMessageId, role: 'user', text: run.inputChunks.join('') },
      { id: run.assistantMessageId, role: 'assistant', text: run.outputChunks.join('') });
  }
  return shown;
}

function markEmoji(mark: MessageMark): string[] {
  const quick = (mark.reactions ?? []).map((name) => MESSAGE_REACTIONS.find((reaction) => reaction.name === name)!.emoji);
  return [...quick, ...(mark.emoji ?? [])];
}

/** When reactions start counting as new: sharing turned on, or the latest Send, whichever is later. */
function pendingSince(state: Pick<DeskState, 'messages' | 'conversationRuns'>, sessionId: string, sharing: ReactionSharing): string {
  let since = sharing.since;
  for (const run of state.conversationRuns ?? []) if (run.sessionId === sessionId && run.createdAt > since) since = run.createdAt;
  for (const message of state.messages) if (message.sessionId === sessionId && message.role === 'user' && message.createdAt > since) since = message.createdAt;
  return since;
}

/** The note for the reactions not yet shared in this conversation, or null when there are none. */
export function reactionsNoteText(state: Pick<DeskState, 'messages' | 'conversationRuns' | 'messageMarks'>, session: Session): string | null {
  const sharing = session.reactionSharing;
  if (!sharing) return null;
  const since = pendingSince(state, session.id, sharing);
  const marks = new Map((state.messageMarks ?? []).map((mark) => [mark.messageId, mark]));
  const parts: string[] = [];
  for (const message of sessionMessages(state, session.id)) {
    const mark = marks.get(message.id);
    if (!mark || mark.updatedAt <= since) continue;
    const emoji = markEmoji(mark);
    if (!emoji.length) continue;
    parts.push(`${emoji.join(' ')} on ${message.role === 'assistant' ? 'your reply' : 'my message'} "${snippet(message.text)}"`);
  }
  if (!parts.length) return null;
  let note = `${REACTIONS_NOTE_PREFIX}${parts.join('; ')}]`;
  while ([...note].length > REACTIONS_NOTE_MAX_CHARACTERS && parts.length > 1) {
    parts.shift();
    note = `${REACTIONS_NOTE_PREFIX}${parts.join('; ')}]`;
  }
  return note;
}

/** The draft's note differs from what the Desk last wrote: he edited it, so it is no longer changed (rule 3). */
export function reactionsNoteEdited(session: Session | undefined, draft: string): boolean {
  if (!session || !reactionSharingOn(session)) return false;
  const split = splitReactionsNote(draft);
  if (split) return split.note !== session.reactionSharing?.note;
  return holdsReactionsNote(draft);
}

/** After a reaction change: keeps the draft's note in step with his reactions until he edits it (rule 3). */
export function syncReactionsNote(next: DeskState, session: Session): void {
  if (!reactionSharingOn(session)) return;
  const sharing = session.reactionSharing!;
  const draft = next.drafts[session.id] ?? '';
  const split = splitReactionsNote(draft);
  if (split ? split.note !== sharing.note : holdsReactionsNote(draft)) return;
  const note = reactionsNoteText(next, session);
  const rest = split ? split.rest : draft;
  next.drafts[session.id] = note ? (rest ? `${note}\n\n${rest}` : `${note}\n\n`) : rest;
  if (note) sharing.note = note;
  else delete sharing.note;
}

/** Turning sharing off, or a participant change turning it off, removes the note and the switch (rule 8). */
export function stopReactionSharing(next: DeskState, session: Session): void {
  const draft = next.drafts[session.id];
  if (draft !== undefined) next.drafts[session.id] = draftWithoutReactionsNote(draft);
  delete session.reactionSharing;
}

/** True when this run's message carried a reactions note. */
export function runHoldsReactionsNote(run: Readonly<ConversationRun>): boolean {
  return holdsReactionsNote(run.inputChunks.join(''));
}

/**
 * The runs Send may name as earlier turns (rule 9): with sharing off for
 * this participant, a turn whose message held a reactions note is left out.
 */
export function contextRunsFor(runs: readonly Readonly<ConversationRun>[], session: Session | undefined): readonly Readonly<ConversationRun>[] {
  if (!session || reactionSharingOn(session)) return runs;
  return runs.filter((run) => run.sessionId !== session.id || run.phase !== 'completed' || !runHoldsReactionsNote(run));
}

/** The line above the box about reactions: where they go, or which earlier turns are left out. */
export function reactionsLine(runs: readonly Readonly<ConversationRun>[], session: Session | undefined, destination: string): string | undefined {
  if (!session?.participantChoice) return undefined;
  if (reactionSharingOn(session)) return `Your reactions in this chat go to ${destination} with your next message.`;
  const left = runs.filter((run) => run.sessionId === session.id && run.phase === 'completed' && runHoldsReactionsNote(run)).length;
  if (!left) return undefined;
  return `${left === 1 ? '1 earlier turn' : `${left} earlier turns`} with reactions you shared ${left === 1 ? 'is' : 'are'} left out, because sharing is off for ${session.participantChoice.label}.`;
}

/** Load check for the saved switch. Rejects; never repairs. */
export function validReactionSharing(value: unknown, validIdentity: (value: unknown) => boolean, latest: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.includes('participant') || !keys.includes('since') || keys.some((key) => !['participant', 'since', 'note'].includes(key))) return false;
  const { participant, since, note } = value as Record<string, unknown>;
  if (!validIdentity(participant)) return false;
  if (typeof since !== 'string' || !Number.isFinite(Date.parse(since)) || new Date(Date.parse(since)).toISOString() !== since || since > latest) return false;
  if (note !== undefined && (typeof note !== 'string' || splitReactionsNote(note)?.note !== note || [...note].length > REACTIONS_NOTE_MAX_CHARACTERS)) return false;
  return true;
}
