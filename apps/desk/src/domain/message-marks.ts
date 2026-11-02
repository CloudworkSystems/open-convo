import { isConversationRunClosed } from './conversation-runs';
import type { DeskState, MessageMark, MessageMarkCommand, MessageReaction } from './types';

/**
 * The owner's own marks on a message (plan: docs/plans/desk-message-actions.md).
 * They stay in the Desk store beside the conversation, never in a run record,
 * and nothing sends them to a model or uses them as context.
 */
export const MESSAGE_REACTIONS: readonly { name: MessageReaction; emoji: string; label: string }[] = [
  { name: 'heart', emoji: '❤️', label: 'Love' },
  { name: 'party', emoji: '🎉', label: 'Celebrate' },
  { name: 'eyes', emoji: '👀', label: 'Look at later' },
  { name: 'check', emoji: '✅', label: 'Done' },
  { name: 'question', emoji: '❓', label: 'Question' },
  { name: 'idea', emoji: '💡', label: 'Idea' },
];
const reactionOrder = MESSAGE_REACTIONS.map((reaction) => reaction.name);
/** Most emoji from the full set one message can carry. */
export const MESSAGE_EMOJI_LIMIT = 20;
// Only emoji parts, and at least one picture, flag letter or keycap. The `u`
// flag (not `v` and its RGI_Emoji set) keeps this working in the WebKit of
// older supported macOS versions; the picker only offers standard emoji.
const emojiParts = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Component}|\u200D|\uFE0F|\u20E3)+$/u;
const emojiPicture = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20E3/u;

/** True for one emoji such as 🦊, 👍🏽 or 🇨🇦, and false for plain text. */
export function isStandardEmoji(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32 && emojiParts.test(value) && emojiPicture.test(value);
}

/** The quick reaction an emoji stands for, so ❤️ from the full set is the same mark as the heart. */
export function quickReactionFor(emoji: string): MessageReaction | undefined {
  return MESSAGE_REACTIONS.find((reaction) => reaction.emoji === emoji)?.name;
}

export function isMessageReaction(value: unknown): value is MessageReaction {
  return typeof value === 'string' && (reactionOrder as string[]).includes(value);
}

export function isMessageMarkCommand(command: { type: string }): command is MessageMarkCommand {
  return command.type === 'set-message-rating' || command.type === 'toggle-message-reaction' || command.type === 'toggle-message-emoji';
}

export interface MarkableMessage {
  role: 'user' | 'assistant';
  /** A reply still being written can be copied but not marked. */
  ended: boolean;
}

/** Every message the Desk shows: simulated messages and both sides of each run. */
export function markableMessages(state: Pick<DeskState, 'messages' | 'conversationRuns'>): Map<string, MarkableMessage> {
  const found = new Map<string, MarkableMessage>();
  for (const message of state.messages) found.set(message.id, { role: message.role, ended: message.status !== 'running' });
  for (const run of state.conversationRuns ?? []) {
    found.set(run.userMessageId, { role: 'user', ended: true });
    found.set(run.assistantMessageId, { role: 'assistant', ended: isConversationRunClosed(run) });
  }
  return found;
}

export class MessageMarkError extends Error {}

/** Applies a mark change to `next` in place. Returns false when nothing changed. */
export function mutateMessageMark(next: DeskState, command: MessageMarkCommand, now: string): boolean {
  const target = markableMessages(next).get(command.messageId);
  if (!target) throw new MessageMarkError('That message no longer exists. Nothing was changed.');
  if (!target.ended) throw new MessageMarkError('Wait until this reply has ended to rate or react to it.');
  const marks = next.messageMarks ?? [];
  const index = marks.findIndex((mark) => mark.messageId === command.messageId);
  const current: MessageMark = index >= 0 ? marks[index] : { messageId: command.messageId, updatedAt: now };
  const updated: MessageMark = { ...current };
  if (command.type === 'set-message-rating') {
    if (target.role !== 'assistant') throw new MessageMarkError('Only replies can be rated.');
    if ((current.rating ?? null) === command.rating) return false;
    if (command.rating === null) delete updated.rating;
    else updated.rating = command.rating;
  } else {
    const named = command.type === 'toggle-message-reaction' ? command.reaction
      : isStandardEmoji(command.emoji) ? quickReactionFor(command.emoji) : undefined;
    if (command.type === 'toggle-message-emoji' && !named) {
      if (!isStandardEmoji(command.emoji)) throw new MessageMarkError('That emoji is not available.');
      const list = current.emoji ?? [];
      const emoji = list.includes(command.emoji) ? list.filter((value) => value !== command.emoji) : [...list, command.emoji];
      if (emoji.length > MESSAGE_EMOJI_LIMIT) throw new MessageMarkError(`A message can hold up to ${MESSAGE_EMOJI_LIMIT} emoji. Remove one first.`);
      if (emoji.length) updated.emoji = emoji;
      else delete updated.emoji;
    } else {
      if (!isMessageReaction(named)) throw new MessageMarkError('That reaction is not available.');
      const chosen = new Set(current.reactions ?? []);
      if (chosen.has(named)) chosen.delete(named);
      else chosen.add(named);
      const reactions = reactionOrder.filter((name) => chosen.has(name));
      if (reactions.length) updated.reactions = reactions;
      else delete updated.reactions;
    }
  }
  updated.updatedAt = now;
  const empty = updated.rating === undefined && updated.reactions === undefined && updated.emoji === undefined;
  const result = marks.filter((mark) => mark.messageId !== command.messageId);
  if (!empty) result.splice(index >= 0 ? index : result.length, 0, updated);
  if (result.length) next.messageMarks = result;
  else if (next.messageMarks) next.messageMarks = [];
  return true;
}

/** Checks saved marks after messages and runs are known. Rejects; never repairs. */
export function validMessageMarks(value: unknown, messages: Map<string, MarkableMessage>, latest: string): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > messages.size) return false;
  const seen = new Set<string>();
  for (const mark of value) {
    if (mark === null || typeof mark !== 'object' || Array.isArray(mark)) return false;
    const keys = Object.keys(mark);
    if (!keys.includes('messageId') || !keys.includes('updatedAt')
      || keys.some((key) => !['messageId', 'rating', 'reactions', 'emoji', 'updatedAt'].includes(key))) return false;
    const { messageId, rating, reactions, emoji, updatedAt } = mark as Record<string, unknown>;
    if (typeof messageId !== 'string' || seen.has(messageId)) return false;
    seen.add(messageId);
    const target = messages.get(messageId);
    if (!target) return false;
    if (rating !== undefined && (target.role !== 'assistant' || (rating !== 'up' && rating !== 'down'))) return false;
    if (reactions !== undefined) {
      if (!Array.isArray(reactions) || !reactions.length || !reactions.every(isMessageReaction)) return false;
      const ordered = reactionOrder.filter((name) => reactions.includes(name));
      if (ordered.length !== reactions.length || ordered.some((name, i) => reactions[i] !== name)) return false;
    }
    if (emoji !== undefined && (!Array.isArray(emoji) || !emoji.length || emoji.length > MESSAGE_EMOJI_LIMIT
      || !emoji.every((value) => isStandardEmoji(value) && !quickReactionFor(value)) || new Set(emoji).size !== emoji.length)) return false;
    if (rating === undefined && reactions === undefined && emoji === undefined) return false;
    if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))
      || new Date(Date.parse(updatedAt)).toISOString() !== updatedAt || updatedAt > latest) return false;
  }
  return true;
}
