import type { ConversationRun, ParticipantIdentity } from './conversation-run-types';
import { isStandardEmoji, MESSAGE_REACTIONS } from './message-marks';
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
/** PR 3: the one plain sentence that tells the agent how to react back. */
export const REACTION_INVITE = 'You can react to this message by starting your reply with a line like `Reaction: 👍`.';
const REACTION_LINE = /^Reaction: ([^\s]+)$/u;

export interface ReactionSharing {
  /** The exact participant sharing was turned on for (rule 5). */
  participant: ParticipantIdentity;
  /** Reactions changed after this time, and after the latest Send, go in the note. */
  since: string;
  /** The note as the Desk last wrote it; a different note in the draft means he edited it. */
  note?: string;
  /**
   * Each reaction added while sharing is on, with the number of messages he
   * had sent in this chat at that moment. Only the ones added since the
   * latest Send go in the note, so each is shared once (rule 3), even when
   * another reaction on the same message changes later. A count, not a
   * time, so equal saved times can never hide a new reaction.
   */
  added?: SharedReactionAdded[];
}

export interface SharedReactionAdded { messageId: string; emoji: string; sends: number }

/** On only while the stored participant is the conversation's current choice. */
export function reactionSharingOn(session: Pick<Session, 'participantChoice' | 'reactionSharing'> | undefined): boolean {
  return !!session?.reactionSharing && !!session.participantChoice
    && sameParticipantIdentity(session.reactionSharing.participant, session.participantChoice);
}

/**
 * The note block in a draft: the text before it, the block, and the text
 * after it. The block starts a line (usually the first; Reply puts its quote
 * above it). Null when there is none or it is broken.
 */
export function splitReactionsNote(draft: string): { before: string; note: string; after: string; rest: string } | null {
  // Any closed block that starts with the marker, however he edited it
  // inside, so Off still removes it (rule 8). Only an unclosed block can't be
  // found whole.
  const start = draft.startsWith(NOTE_MARKER) ? 0 : draft.indexOf(`\n${NOTE_MARKER}`) + 1;
  if (start === 0 && !draft.startsWith(NOTE_MARKER)) return null;
  const end = draft.indexOf(']', start + NOTE_MARKER.length);
  if (end < 0) return null;
  const before = draft.slice(0, start);
  const after = draft.slice(end + 1).replace(/^\n{1,2}/, '');
  return { before, note: draft.slice(start, end + 1), after, rest: before + after };
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
      { id: run.assistantMessageId, role: 'assistant', text: agentReaction(run).text });
  }
  return shown;
}

export function markEmoji(mark: MessageMark | undefined): string[] {
  if (!mark) return [];
  const quick = (mark.reactions ?? []).map((name) => MESSAGE_REACTIONS.find((reaction) => reaction.name === name)!.emoji);
  return [...quick, ...(mark.emoji ?? [])];
}

/** How many messages he has sent in this chat: each Send adds one run or one message. */
function sendCount(state: Pick<DeskState, 'messages' | 'conversationRuns'>, sessionId: string): number {
  return (state.conversationRuns ?? []).filter((run) => run.sessionId === sessionId).length
    + state.messages.filter((message) => message.sessionId === sessionId && message.role === 'user').length;
}

/** The reactions added since the latest Send that are still on their message. */
function pendingReactions(state: Pick<DeskState, 'messages' | 'conversationRuns' | 'messageMarks'>, session: Session): SharedReactionAdded[] {
  const sharing = session.reactionSharing;
  if (!sharing) return [];
  const sends = sendCount(state, session.id);
  const marks = new Map((state.messageMarks ?? []).map((mark) => [mark.messageId, mark]));
  return (sharing.added ?? []).filter((entry) => entry.sends === sends && markEmoji(marks.get(entry.messageId)).includes(entry.emoji));
}

/** The note for the reactions not yet shared in this conversation, or null when there are none. */
export function reactionsNoteText(state: Pick<DeskState, 'messages' | 'conversationRuns' | 'messageMarks'>, session: Session): string | null {
  const pending = pendingReactions(state, session);
  if (!pending.length) return null;
  const parts: string[] = [];
  for (const message of sessionMessages(state, session.id)) {
    const emoji = pending.filter((entry) => entry.messageId === message.id).map((entry) => entry.emoji);
    if (!emoji.length) continue;
    parts.push(`${emoji.join(' ')} on ${message.role === 'assistant' ? 'your reply' : 'my message'} "${snippet(message.text)}"`);
  }
  if (!parts.length) return null;
  const write = () => `${REACTIONS_NOTE_PREFIX}${parts.join('; ')}. ${REACTION_INVITE}]`;
  let note = write();
  while ([...note].length > REACTIONS_NOTE_MAX_CHARACTERS && parts.length > 1) {
    parts.shift();
    note = write();
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

/**
 * After a reaction change: records which reaction was added or taken off,
 * then keeps the draft's note in step with his reactions until he edits it
 * (rule 3). Entries already shared, or no longer on their message, are dropped.
 */
export function syncReactionsNote(next: DeskState, session: Session, change?: { messageId: string; emoji: string }): void {
  if (!reactionSharingOn(session)) return;
  const sharing = session.reactionSharing!;
  if (change) {
    const list = (sharing.added ?? []).filter((entry) => !(entry.messageId === change.messageId && entry.emoji === change.emoji));
    const mark = (next.messageMarks ?? []).find((item) => item.messageId === change.messageId);
    if (markEmoji(mark).includes(change.emoji)) list.push({ ...change, sends: sendCount(next, session.id) });
    sharing.added = list;
  }
  const kept = pendingReactions(next, session);
  if (kept.length) sharing.added = kept;
  else delete sharing.added;
  const draft = next.drafts[session.id] ?? '';
  const split = splitReactionsNote(draft);
  if (split ? split.note !== sharing.note : holdsReactionsNote(draft)) return;
  const note = reactionsNoteText(next, session);
  // A new note goes at the top; an existing one is replaced where it is.
  const before = split ? split.before : '';
  const after = split ? split.after : draft;
  next.drafts[session.id] = note ? `${before}${note}\n\n${after}` : before + after;
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

/**
 * The line above the box about reactions: where they go, or which earlier
 * turns are left out. `carriedRunIds` are the turns Send would carry with
 * sharing on, chosen by the same context selection Send uses.
 */
export function reactionsLine(runs: readonly Readonly<ConversationRun>[], session: Session | undefined, destination: string,
  carriedRunIds: ReadonlySet<string>): string | undefined {
  if (!session?.participantChoice) return undefined;
  if (reactionSharingOn(session)) return `Your reactions in this chat go to ${destination} with your next message.`;
  // Only turns the next Send would otherwise carry count (rule 9): one too
  // old or too large for the context limit is left out anyway.
  const left = runs.filter((run) => run.sessionId === session.id && run.phase === 'completed'
    && carriedRunIds.has(run.runId) && runHoldsReactionsNote(run)).length;
  if (!left) return undefined;
  return `${left === 1 ? '1 earlier turn' : `${left} earlier turns`} with reactions you shared ${left === 1 ? 'is' : 'are'} left out, because sharing is off for ${session.participantChoice.label}.`;
}

/** Load check for the saved switch. Rejects; never repairs. */
export function validReactionSharing(value: unknown, validIdentity: (value: unknown) => boolean, latest: string): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (!keys.includes('participant') || !keys.includes('since') || keys.some((key) => !['participant', 'since', 'note', 'added'].includes(key))) return false;
  const { participant, since, note, added } = value as Record<string, unknown>;
  if (!validIdentity(participant)) return false;
  if (typeof since !== 'string' || !Number.isFinite(Date.parse(since)) || new Date(Date.parse(since)).toISOString() !== since || since > latest) return false;
  if (note !== undefined && (typeof note !== 'string' || splitReactionsNote(note)?.note !== note || [...note].length > REACTIONS_NOTE_MAX_CHARACTERS)) return false;
  if (added !== undefined && (!Array.isArray(added) || !added.length || !added.every(validAdded))) return false;
  return true;
}

function validAdded(entry: unknown): boolean {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== 3 || !['messageId', 'emoji', 'sends'].every((key) => keys.includes(key))) return false;
  const { messageId, emoji, sends } = entry as Record<string, unknown>;
  return typeof messageId === 'string' && !!messageId && isStandardEmoji(emoji)
    && typeof sends === 'number' && Number.isSafeInteger(sends) && sends >= 0;
}

/**
 * PR 3, rule 4: an agent's reaction is read from the saved reply each time it
 * is shown; nothing is stored. It counts only when his message carried a
 * reactions note (so the agent was told how), and the reply's first line is
 * exactly `Reaction: <one standard emoji>` and complete: a line break came
 * after it, or the reply ended. Otherwise the reply is plain text.
 */
export function agentReaction(run: Readonly<ConversationRun>): { emoji?: string; text: string; offset: number } {
  const output = run.outputChunks.join('');
  const none = { text: output, offset: 0 };
  if (!runHoldsReactionsNote(run)) return none;
  const end = output.indexOf('\n');
  const ended = run.phase === 'completed' || run.phase === 'stopped' || run.phase === 'failed' || !!run.closure;
  if (end < 0 && !ended) return none;
  const line = (end < 0 ? output : output.slice(0, end)).replace(/\r$/, '');
  const match = REACTION_LINE.exec(line);
  if (!match || !isStandardEmoji(match[1])) return none;
  let offset = end < 0 ? output.length : end + 1;
  if (output[offset] === '\r') offset += 1;
  if (output[offset] === '\n') offset += 1;
  return { emoji: match[1], text: output.slice(offset), offset };
}
