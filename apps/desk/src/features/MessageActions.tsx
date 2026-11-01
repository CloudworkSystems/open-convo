import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { MESSAGE_REACTIONS } from '../domain/message-marks';
import type { MessageMark, MessageReaction } from '../domain/types';
import { Icon } from '../ui/Icon';
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
  const pickerId = useId();
  const statusId = useId();
  const pickerButton = useRef<HTMLButtonElement>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(reset.current), []);
  const mark = context?.marks.get(messageId);
  const reply = role === 'assistant';
  const blocked = context?.saveBlockedReason ?? (ended ? undefined : 'Wait until this reply has ended to rate or react to it.');
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
  return (
    <div className={`message-actions${latest ? ' message-actions-latest' : ''}${reply ? '' : ' message-actions-user'}`} role="group" aria-label={`Actions for ${label}`}
      data-message-actions={messageId} onKeyDown={(event) => {
        if (event.key === 'Escape' && picking) { event.stopPropagation(); setPicking(false); pickerButton.current?.focus(); }
      }}>
      <div className="message-actions-row">
        <button type="button" className="message-action" onClick={() => void copyText()} aria-label={`Copy ${label}`} title="Copy">
          <Icon name={copy === 'copied' ? 'check' : 'copy'} size={15} />
        </button>
        {context && reply && <>
          <button type="button" className="message-action" aria-pressed={mark?.rating === 'up'} disabled={markDisabled}
            aria-label="Good reply" title={blocked ?? 'Good reply'} data-rating="up"
            onClick={() => context.onRate(messageId, mark?.rating === 'up' ? null : 'up')}>
            <Icon name="thumb-up" size={15} />
          </button>
          <button type="button" className="message-action" aria-pressed={mark?.rating === 'down'} disabled={markDisabled}
            aria-label="Bad reply" title={blocked ?? 'Bad reply'} data-rating="down"
            onClick={() => context.onRate(messageId, mark?.rating === 'down' ? null : 'down')}>
            <Icon name="thumb-down" size={15} />
          </button>
        </>}
        {context && <button type="button" ref={pickerButton} className="message-action" aria-expanded={picking} aria-controls={pickerId}
          disabled={markDisabled} aria-label="Add a reaction" title={blocked ?? 'Add a reaction'} onClick={() => setPicking(!picking)}>
          <Icon name="smile" size={15} />
        </button>}
        <span id={statusId} className="message-action-status" aria-live="polite">
          {copy === 'copied' ? 'Copied' : copy === 'failed' ? 'Couldn’t copy. Select the text and copy it instead.' : ''}
        </span>
      </div>
      {context && picking && !markDisabled && <div id={pickerId} className="message-reaction-picker" role="group" aria-label="Reactions">
        {MESSAGE_REACTIONS.map((reaction) => <button key={reaction.name} type="button" className="message-reaction-choice"
          aria-pressed={chosen.has(reaction.name)} aria-label={reaction.label} title={reaction.label}
          onClick={() => { context.onReact(messageId, reaction.name); setPicking(false); pickerButton.current?.focus(); }}>
          <span aria-hidden="true">{reaction.emoji}</span>
        </button>)}
      </div>}
      {context && (mark?.reactions?.length || mark?.rating) ? <div className="message-marks" aria-label="Your marks">
        {mark?.rating && <span className="message-mark-rating" data-mark-rating={mark.rating}>{mark.rating === 'up' ? 'Rated good' : 'Rated bad'}</span>}
        {MESSAGE_REACTIONS.filter((reaction) => chosen.has(reaction.name)).map((reaction) =>
          <button key={reaction.name} type="button" className="message-mark-chip" disabled={markDisabled}
            aria-label={`Remove reaction: ${reaction.label}`} title={blocked ?? `Remove ${reaction.label}`}
            onClick={() => context.onReact(messageId, reaction.name)}>
            <span aria-hidden="true">{reaction.emoji}</span>
          </button>)}
      </div> : null}
      {context?.saveBlockedReason && mark && <p className="message-actions-note">{context.saveBlockedReason}</p>}
    </div>
  );
}
