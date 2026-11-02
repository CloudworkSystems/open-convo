import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { MESSAGE_REACTIONS, quickReactionFor } from '../domain/message-marks';
import type { MessageMark, MessageReaction } from '../domain/types';
import { Icon } from '../ui/Icon';
import { EmojiPicker, emojiName } from './EmojiPicker';
import './message-actions.css';

/**
 * What the action row needs from the Desk (plan: docs/plans/desk-message-actions.md).
 * Without it (a transcript shown on its own) the row offers Copy only.
 */
export interface MessageActionsValue {
  marks: ReadonlyMap<string, MessageMark>;
  /** Why ratings and reactions can't be saved right now, such as a read-only Desk. */
  saveBlockedReason?: string;
  onRate: (messageId: string, rating: 'up' | 'down' | null) => void;
  onReact: (messageId: string, reaction: MessageReaction) => void;
  /** Toggles any standard emoji from the full set. */
  onEmoji?: (messageId: string, emoji: string) => void;
  /** Quotes this message at the top of its conversation's draft. Returns false when it couldn't. */
  onReply?: (messageId: string, text: string) => boolean;
  /** Starts a side chat about this message and opens it. */
  onSideChat?: (messageId: string, text: string) => void;
  /** Side chats already started about each message, oldest first. */
  sideChats?: ReadonlyMap<string, readonly { id: string; title: string }[]>;
  onOpenSession?: (sessionId: string) => void;
}

export const MessageActionsContext = createContext<MessageActionsValue | null>(null);

export interface MessageActionsProps {
  messageId: string;
  role: 'user' | 'assistant';
  /** The message text exactly as shown. */
  text: string;
  /** A reply still being written can be copied but not rated or reacted to. */
  ended: boolean;
  /** The latest reply keeps its row visible without hover. */
  latest?: boolean;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function MessageActions({ messageId, role, text, ended, latest = false }: MessageActionsProps) {
  const context = useContext(MessageActionsContext);
  const [copy, setCopy] = useState<CopyState>('idle');
  const [picking, setPicking] = useState(false);
  const [more, setMore] = useState(false);
  const pickerId = useId();
  const statusId = useId();
  const pickerButton = useRef<HTMLButtonElement>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const mark = context?.marks.get(messageId);
  // Plan rule 5: rating and reaction changes are announced. Only a change the
  // owner just asked for here is announced, and only once it is applied.
  const [markNotice, setMarkNotice] = useState('');
  const expecting = useRef<MessageMark | undefined | null>(null);
  const noticeReset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(noticeReset.current), []);
  useEffect(() => {
    const before = expecting.current;
    if (before === null) return;
    const notice = markChangeNotice(before, mark);
    if (!notice) return;
    expecting.current = null;
    clearTimeout(noticeReset.current);
    setMarkNotice(notice);
    noticeReset.current = setTimeout(() => setMarkNotice(''), 4000);
  }, [mark]);
  const rate = (rating: 'up' | 'down' | null) => { expecting.current = mark; context?.onRate(messageId, rating); };
  const react = (reaction: MessageReaction) => { expecting.current = mark; context?.onReact(messageId, reaction); };
  const toggleEmoji = (emoji: string) => { expecting.current = mark; context?.onEmoji?.(messageId, emoji); };
  const closePicker = () => { setPicking(false); setMore(false); pickerButton.current?.focus(); };
  const reply = role === 'assistant';
  const blocked = context?.saveBlockedReason ?? (ended ? undefined : 'Wait until this reply has ended to rate, react or reply to it.');
  const markDisabled = blocked !== undefined;
  const copyText = async () => {
    clearTimeout(reset.current);
    try {
      if (!navigator.clipboard) throw new Error('No clipboard');
      await navigator.clipboard.writeText(text);
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
    reset.current = setTimeout(() => setCopy('idle'), 2500);
  };
  const label = reply ? 'reply' : 'your message';
  const chosen = new Set(mark?.reactions ?? []);
  const chosenEmoji = new Set([...(mark?.emoji ?? []),
    ...MESSAGE_REACTIONS.filter((reaction) => chosen.has(reaction.name)).map((reaction) => reaction.emoji)]);
  const sideChats = context?.sideChats?.get(messageId) ?? [];
  return (
    <div className={`message-actions${latest ? ' message-actions-latest' : ''}${reply ? '' : ' message-actions-user'}`} role="group" aria-label={`Actions for ${label}`}
      data-message-actions={messageId} onKeyDown={(event) => {
        if (event.key === 'Escape' && picking) { event.stopPropagation(); closePicker(); }
      }}>
      <div className="message-actions-row">
        <button type="button" className="message-action" onClick={() => void copyText()} aria-label={`Copy ${label}`} title="Copy">
          <Icon name={copy === 'copied' ? 'check' : 'copy'} size={15} />
        </button>
        {context && reply && <>
          <button type="button" className="message-action" aria-pressed={mark?.rating === 'up'} disabled={markDisabled}
            aria-label="Good reply" title={blocked ?? 'Good reply'} data-rating="up"
            onClick={() => rate(mark?.rating === 'up' ? null : 'up')}>
            <Icon name="thumb-up" size={15} />
          </button>
          <button type="button" className="message-action" aria-pressed={mark?.rating === 'down'} disabled={markDisabled}
            aria-label="Bad reply" title={blocked ?? 'Bad reply'} data-rating="down"
            onClick={() => rate(mark?.rating === 'down' ? null : 'down')}>
            <Icon name="thumb-down" size={15} />
          </button>
        </>}
        {context?.onReply && <button type="button" className="message-action" disabled={markDisabled}
          aria-label={`Reply to ${label}`} title={blocked ?? 'Reply with a quote'} data-reply
          onClick={() => {
            if (context.onReply?.(messageId, text)) {
              const field = document.getElementById('message-draft');
              if (field instanceof HTMLTextAreaElement) requestAnimationFrame(() => {
                field.focus();
                field.setSelectionRange(field.value.length, field.value.length);
              });
            }
          }}>
          <Icon name="reply" size={15} />
        </button>}
        {context?.onSideChat && <button type="button" className="message-action" disabled={markDisabled}
          aria-label={`Start a side chat about ${label}`} title={blocked ?? 'Side chat about this message'} data-side-chat
          onClick={() => context.onSideChat?.(messageId, text)}>
          <Icon name="side-chat" size={15} />
        </button>}
        {context && <button type="button" ref={pickerButton} className="message-action" aria-expanded={picking} aria-controls={pickerId}
          disabled={markDisabled} aria-label="Add a reaction" title={blocked ?? 'Add a reaction'} onClick={() => { setPicking(!picking); setMore(false); }}>
          <Icon name="smile" size={15} />
        </button>}
        <span id={statusId} className="message-action-status" aria-live="polite">
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Couldn’t copy. Select the text and copy it instead.' : ''}
        </span>
        <span className="message-mark-status" aria-live="polite" data-mark-notice>{markNotice}</span>
      </div>
      {context && picking && !markDisabled && <div id={pickerId} className="message-reaction-picker" role="group" aria-label="Reactions">
        {MESSAGE_REACTIONS.map((reaction) => <button key={reaction.name} type="button" className="message-reaction-choice"
          aria-pressed={chosen.has(reaction.name)} aria-label={reaction.label} title={reaction.label}
          onClick={() => { react(reaction.name); closePicker(); }}>
          <span aria-hidden="true">{reaction.emoji}</span>
        </button>)}
        {context.onEmoji && !more && <button type="button" className="message-reaction-more" aria-expanded={false}
          onClick={() => setMore(true)}>More emoji</button>}
        {context.onEmoji && more && <EmojiPicker chosen={chosenEmoji} onPick={(emoji) => {
          const named = quickReactionFor(emoji);
          if (named) react(named);
          else toggleEmoji(emoji);
          closePicker();
        }} />}
      </div>}
      {context && (mark?.reactions?.length || mark?.emoji?.length || mark?.rating) ? <div className="message-marks" aria-label="Your marks">
        {mark?.rating && <span className="message-mark-rating" data-mark-rating={mark.rating}>{mark.rating === 'up' ? 'Rated good' : 'Rated bad'}</span>}
        {MESSAGE_REACTIONS.filter((reaction) => chosen.has(reaction.name)).map((reaction) =>
          <button key={reaction.name} type="button" className="message-mark-chip" disabled={markDisabled}
            aria-label={`Remove reaction: ${reaction.label}`} title={blocked ?? `Remove ${reaction.label}`}
            onClick={() => { react(reaction.name); pickerButton.current?.focus(); }}>
            <span aria-hidden="true">{reaction.emoji}</span>
          </button>)}
        {(mark?.emoji ?? []).map((emoji) =>
          <button key={emoji} type="button" className="message-mark-chip" disabled={markDisabled}
            aria-label={`Remove reaction: ${emojiName(emoji)}`} title={blocked ?? `Remove ${emojiName(emoji)}`}
            onClick={() => { toggleEmoji(emoji); pickerButton.current?.focus(); }}>
            <span aria-hidden="true">{emoji}</span>
          </button>)}
      </div> : null}
      {context?.onOpenSession && sideChats.length > 0 && <div className="message-side-chats">
        {sideChats.map((chat) => <button key={chat.id} type="button" className="message-side-chat-link"
          onClick={() => context.onOpenSession?.(chat.id)}>
          <Icon name="side-chat" size={13} /><span>{chat.title}</span>
        </button>)}
      </div>}
      {context?.saveBlockedReason && mark && <p className="message-actions-note">{context.saveBlockedReason}</p>}
    </div>
  );
}

const reactionLabel = (name: MessageReaction) => MESSAGE_REACTIONS.find((reaction) => reaction.name === name)?.label ?? name;

/** Words for what changed between two marks, or '' when nothing did. */
export function markChangeNotice(before: MessageMark | undefined, after: MessageMark | undefined): string {
  const parts: string[] = [];
  if (before?.rating !== after?.rating) parts.push(after?.rating === 'up' ? 'Rated good' : after?.rating === 'down' ? 'Rated bad' : 'Rating cleared');
  const was = new Set(before?.reactions ?? []);
  const now = new Set(after?.reactions ?? []);
  for (const name of now) if (!was.has(name)) parts.push(`Added reaction: ${reactionLabel(name)}`);
  for (const name of was) if (!now.has(name)) parts.push(`Removed reaction: ${reactionLabel(name)}`);
  const hadEmoji = new Set(before?.emoji ?? []);
  const hasEmoji = new Set(after?.emoji ?? []);
  for (const emoji of hasEmoji) if (!hadEmoji.has(emoji)) parts.push(`Added reaction: ${emojiName(emoji)}`);
  for (const emoji of hadEmoji) if (!hasEmoji.has(emoji)) parts.push(`Removed reaction: ${emojiName(emoji)}`);
  return parts.join('. ');
}
