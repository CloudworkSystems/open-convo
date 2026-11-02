import { markableMessages } from './message-marks';
import { draftWithReplyQuote } from './reply-quote';
import { agentReaction } from './shared-reactions';
import type { DeskState, Session } from './types';

/**
 * Side chats (plan: docs/plans/desk-message-actions.md, rule 4 and PR 4).
 * A side chat is its own saved conversation, linked to the message it is
 * about. Its first message carries only that message, as a visible quote,
 * and it never adds turns to the main conversation's context.
 */
export const SIDE_CHAT_TITLE_CHARACTERS = 60;

export function sideChatTitle(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  const scalars = [...line];
  const short = scalars.length > SIDE_CHAT_TITLE_CHARACTERS ? `${scalars.slice(0, SIDE_CHAT_TITLE_CHARACTERS).join('').trimEnd()}…` : line;
  return `Side chat: ${short || 'a message'}`;
}

/** Which conversation a shown message belongs to. */
export function messageSessionId(state: Pick<DeskState, 'messages' | 'conversationRuns'>, messageId: string): string | undefined {
  return state.messages.find((message) => message.id === messageId)?.sessionId
    ?? state.conversationRuns?.find((run) => run.userMessageId === messageId || run.assistantMessageId === messageId)?.sessionId;
}

export class SideChatError extends Error {}

/** Adds the side chat to `next` in place and selects it. */
export function createSideChat(next: DeskState, messageId: string, text: string, sessionId: string, now: string): Session {
  const target = markableMessages(next).get(messageId);
  if (!target) throw new SideChatError('That message no longer exists. Nothing was changed.');
  if (!target.ended) throw new SideChatError('Wait until this reply has ended to start a side chat about it.');
  const parentId = messageSessionId(next, messageId);
  const parent = next.sessions.find((session) => session.id === parentId);
  if (!parent) throw new SideChatError('That message’s conversation no longer exists. Nothing was changed.');
  const session: Session = { id: sessionId, goalId: parent.goalId, title: sideChatTitle(text),
    sideOf: { sessionId: parent.id, messageId }, createdAt: now, updatedAt: now };
  // The same saved choice as the main conversation; sending still checks it.
  if (parent.participantChoice) session.participantChoice = structuredClone(parent.participantChoice);
  next.sessions.push(session);
  next.drafts[sessionId] = draftWithReplyQuote('', text);
  next.selection = { goalId: parent.goalId, sessionId, route: 'sessions' };
  next.preferences.nexusView = 'navigator';
  return session;
}

/** Each link points at another saved conversation and a message in it. */
export function validSideChatLinks(state: Pick<DeskState, 'sessions' | 'messages' | 'conversationRuns'>): boolean {
  const shown = markableMessages(state);
  for (const session of state.sessions) {
    const link = (session as { sideOf?: unknown }).sideOf;
    if (link === undefined) continue;
    if (link === null || typeof link !== 'object' || Array.isArray(link)) return false;
    const keys = Object.keys(link);
    if (keys.length !== 2 || !keys.includes('sessionId') || !keys.includes('messageId')) return false;
    const { sessionId, messageId } = link as Record<string, unknown>;
    if (typeof sessionId !== 'string' || typeof messageId !== 'string' || !sessionId || !messageId || sessionId === session.id) return false;
    // The message or the conversation it came from may be gone; the side chat
    // then says so and still works (plan: When It Goes Wrong). A message that
    // is still shown must belong to the linked conversation.
    if (shown.has(messageId) && messageSessionId(state, messageId) !== sessionId) return false;
  }
  // No loops: following the links from any side chat reaches an ordinary conversation.
  const parentOf = new Map(state.sessions.map((session) => [session.id, session.sideOf?.sessionId]));
  for (const session of state.sessions) {
    const seen = new Set([session.id]);
    for (let parent = parentOf.get(session.id); parent; parent = parentOf.get(parent)) {
      if (seen.has(parent)) return false;
      seen.add(parent);
    }
  }
  return true;
}

/** The text of a shown message as the Desk shows it, or null when it is gone. */
export function shownMessageText(state: Pick<DeskState, 'messages' | 'conversationRuns'>, messageId: string): string | null {
  const message = state.messages.find((item) => item.id === messageId);
  if (message) return message.body;
  const run = state.conversationRuns?.find((item) => item.userMessageId === messageId || item.assistantMessageId === messageId);
  if (!run) return null;
  // A reply shows without an agent's reaction line (shared reactions rule 4).
  return run.userMessageId === messageId ? run.inputChunks.join('') : agentReaction(run).text;
}

/**
 * A conversation and every side chat linked to it, root first. Side chats are
 * listed under their parent, so moving any of them to a folder moves the group.
 */
export function linkedSessionIds(state: Pick<DeskState, 'sessions'>, sessionId: string): string[] {
  const byId = new Map(state.sessions.map((session) => [session.id, session]));
  let root = sessionId;
  const climbed = new Set<string>([root]);
  for (let parent = byId.get(root)?.sideOf?.sessionId; parent && byId.has(parent) && !climbed.has(parent); parent = byId.get(root)?.sideOf?.sessionId) {
    root = parent;
    climbed.add(parent);
  }
  const group = [root];
  for (let index = 0; index < group.length; index++) {
    for (const session of state.sessions) {
      if (session.sideOf?.sessionId === group[index] && !group.includes(session.id)) group.push(session.id);
    }
  }
  return group;
}

/**
 * Sessions in list order, each side chat right after its parent (oldest
 * first) with its depth. A side chat whose parent is not in `sessions` is
 * listed on its own at depth 0. Every list of conversations uses this, so a
 * side chat never shows as a separate top-level conversation.
 */
export function withSideChatsNested<T extends Pick<DeskState['sessions'][number], 'id' | 'sideOf'>>(sessions: readonly T[]): { session: T; depth: number }[] {
  const ids = new Set(sessions.map((session) => session.id));
  const out: { session: T; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (session: T, depth: number) => {
    if (seen.has(session.id)) return;
    seen.add(session.id);
    out.push({ session, depth });
    for (const child of sessions) if (child.sideOf?.sessionId === session.id) visit(child, depth + 1);
  };
  for (const session of sessions) if (!session.sideOf || !ids.has(session.sideOf.sessionId)) visit(session, 0);
  return out;
}
