import type { NativeParticipantConfirmation } from '../adapters/native-participant-codec';
import { Children, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Goal, Message, Session } from '../domain/types';
import { EmberMark, Icon } from '../ui/Icon';
import './composer.css';
import { ParticipantPicker } from './ParticipantPicker';
import type { ParticipantChoice } from '../domain/participant-choices';
import type { ParticipantIdentity } from '../domain/conversation-run-types';
import type { LocalCatalogView } from '../domain/local-participant';
import { useDeskDictationView } from '../app/use-desk-dictation';

const MIN_DRAFT_HEIGHT = 78;
const MIN_MESSAGES_HEIGHT = 120;

export function Conversation({
  goal,
  session,
  messages,
  draft,
  onDraftChange,
  onSend,
  readOnly = false,
  runContent,
  participantLabel,
  participantChoices,
  participantChoiceError, participantConfirmation, participantAvailabilityMessage, participantAvailabilityChecking, onParticipantPickerOpen, onParticipantPickerClose,
  participantLocalNotice, participantSelectedProblem, participantLocalCatalog,
  onParticipantSelect,
  participantBusy = false,
  participantSendUnavailable = false,
  participantSendBlockedReason,
}: {
  goal?: Goal;
  session?: Session;
  messages: Message[];
  draft: string;
  onDraftChange: (sessionId: string, value: string) => void;
  onSend: (sessionId: string) => void;
  readOnly?: boolean;
  runContent?: ReactNode;
  participantLabel?: string;
  participantChoices?: readonly ParticipantChoice[];
  participantChoiceError?: string;
  participantConfirmation?: NativeParticipantConfirmation;
  participantAvailabilityMessage?: string;
  participantAvailabilityChecking?: boolean;
  participantLocalNotice?: string;
  participantSelectedProblem?: string;
  participantLocalCatalog?: LocalCatalogView;
  onParticipantPickerOpen?: () => void;
  onParticipantPickerClose?: () => void;
  onParticipantSelect?: (sessionId: string, participant: ParticipantIdentity) => void;
  participantBusy?: boolean;
  participantSendUnavailable?: boolean;
  participantSendBlockedReason?: string;
}) {
  const conversation = useRef<HTMLElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const scrollSession = useRef(session?.id);
  const composer = useRef<HTMLFormElement>(null);
  const draftField = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const dictation = useDeskDictationView();
  const reportDraftSelection = (field: HTMLTextAreaElement, focused: boolean) => {
    if (!dictation || !session) return;
    dictation.reportComposer(session.id, focused && !readOnly ? { start: field.selectionStart, end: field.selectionEnd } : null);
  };
  const unplaced = dictation?.retained.filter((item) => item.state !== 'saving') ?? [];
  const insertDictated = (deliveryId: string, text: string) => {
    const field = draftField.current;
    if (!field || !session || readOnly) return;
    const start = field.selectionStart;
    const value = field.value.slice(0, start) + text + field.value.slice(field.selectionEnd);
    onDraftChange(session.id, value);
    dictation?.dismiss(deliveryId);
    requestAnimationFrame(() => { if (field.isConnected && field === draftField.current) field.setSelectionRange(start + text.length, start + text.length); });
  };
  // Put the caret after text that dictation just placed in this draft.
  useEffect(() => {
    const caret = dictation?.caret;
    const field = draftField.current;
    if (!caret || !field || caret.sessionId !== session?.id || document.activeElement !== field) return;
    requestAnimationFrame(() => { if (field.isConnected) field.setSelectionRange(caret.position, caret.position); });
  }, [dictation?.caret?.nonce]);
  const drag = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  const [draftHeight, setDraftHeight] = useState(90);
  const [maxDraftHeight, setMaxDraftHeight] = useState(220);
  const participantMode = participantLabel !== undefined;
  const responseRunning = messages.some((message) => message.sessionId === session?.id && message.status === 'running');
  const canSend = !readOnly && Boolean(session) && Boolean(draft.trim()) && !responseRunning
    && !participantBusy && !participantSendUnavailable;
  const resizeDraft = (height: number) => setDraftHeight(Math.round(Math.max(MIN_DRAFT_HEIGHT, Math.min(maxDraftHeight, height))));
  const sendDraft = () => {
    if (!canSend || !session || composing.current) return;
    // An explicit Send asks to see the new message. Passive streaming still
    // respects the position of someone reading earlier messages.
    followLatest.current = true;
    onSend(session.id);
  };

  useEffect(() => {
    const area = scrollArea.current;
    if (!participantMode && area) area.scrollTop = area.scrollHeight;
  }, [participantMode, session?.id, messages.length]);
  useLayoutEffect(() => {
    if (scrollSession.current !== session?.id) {
      scrollSession.current = session?.id;
      followLatest.current = true;
    }
    const area = scrollArea.current;
    if (participantMode && area && followLatest.current) area.scrollTop = area.scrollHeight;
  }, [participantMode, session?.id, messages, runContent, draftHeight]);
  useEffect(() => {
    const area = scrollArea.current;
    if (!participantMode || !area) return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current) area.scrollTop = area.scrollHeight;
    });
    observer.observe(area);
    return () => observer.disconnect();
  }, [participantMode]);
  useEffect(() => {
    const section = conversation.current;
    const form = composer.current;
    const field = draftField.current;
    if (!section || !form || !field) return;
    const measure = () => {
      const style = getComputedStyle(section);
      const heading = section.querySelector<HTMLElement>('.conversation-heading');
      const footnote = section.querySelector<HTMLElement>('.conversation-footnote');
      const available = section.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
        - (heading?.offsetHeight ?? 0) - (footnote?.offsetHeight ?? 0) - MIN_MESSAGES_HEIGHT
        - (form.offsetHeight - field.offsetHeight) - 8;
      const max = Math.max(MIN_DRAFT_HEIGHT, Math.floor(available));
      setMaxDraftHeight(max);
      setDraftHeight((height) => Math.min(height, max));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    observer.observe(form);
    for (const element of section.querySelectorAll('.conversation-heading, .conversation-footnote')) observer.observe(element);
    measure();
    return () => { observer.disconnect(); drag.current = null; };
  }, []);
  useEffect(() => { composing.current = false; drag.current = null; }, [session?.id]);
  return (
    <section className="conversation" aria-label="Conversation" ref={conversation}>
      <div className="conversation-heading">
        <div>
          <span className="eyebrow">CONVERSATION</span>
          <h2>{session?.title ?? 'A fresh start'}</h2>
        </div>
        <span className="provider-label" role={onParticipantPickerOpen ? 'status' : undefined}
          aria-live={onParticipantPickerOpen ? 'polite' : undefined} aria-atomic={onParticipantPickerOpen ? 'true' : undefined}>
          <span className="demo-dot" />
          {participantMode ? participantLabel : 'Demo replies · no model connected'}
        </span>
      </div>
      <div
        className="message-scroll"
        ref={scrollArea}
        role="log"
        aria-label="Messages"
        aria-live={participantMode ? 'off' : 'polite'}
        aria-relevant="additions text"
        onFocusCapture={(event) => {
          // Action handlers reveal the focused status once. Later renders must
          // respect where the reader scrolls, even while that status keeps focus.
          if (participantMode && event.target instanceof HTMLElement && event.target.matches('[data-run-status]')) {
            followLatest.current = false;
          }
        }}
        onScroll={(event) => {
          const area = event.currentTarget;
          followLatest.current = area.scrollHeight - area.scrollTop - area.clientHeight <= 48;
        }}
      >
        {messages.length === 0 && Children.toArray(runContent).length === 0 && (
          <div className="conversation-welcome">
            <EmberMark />
            <span className="eyebrow">A LITTLE LESS SCATTERED.</span>
            <h3>
              A clear next step
              <br />
              starts here.
            </h3>
            <p>
              Bring an idea into focus, then give it somewhere to go. This workspace is yours to try
              with sample details.
            </p>
            <div className="starter-prompts">
              <button
                type="button"
                disabled={readOnly || !session}
                onClick={() =>
                  session &&
                  onDraftChange(
                    session.id,
                    `Help me find the first small step for ${goal?.title ?? 'this idea'}.`,
                  )
                }
              >
                Find a first step <Icon name="arrow" size={15} />
              </button>
              <button
                type="button"
                disabled={readOnly || !session}
                onClick={() =>
                  session &&
                  onDraftChange(session.id, 'Help me turn this sample idea into a simple plan.')
                }
              >
                Shape a simple plan <Icon name="arrow" size={15} />
              </button>
            </div>
          </div>
        )}
        {messages.map((message) => (
          <article
            className={`message message-${message.role}`}
            key={message.id}
            data-message-id={message.id}
          >
            <div className="message-avatar">
              {message.role === 'assistant' ? <EmberMark small /> : 'Y'}
            </div>
            <div className="message-content">
              <div className="message-byline">
                <strong>{message.role === 'assistant' ? 'True Convo' : 'You'}</strong>
                {message.role === 'assistant' && (
                  <span className="message-demo-label">Demo response</span>
                )}
              </div>
              <div className="message-body">
                {message.body ||
                  (message.status === 'interrupted'
                    ? 'This sample response was interrupted.'
                    : 'No response content.')}{' '}
              </div>
              {message.status !== 'complete' && (
                <span className="message-status">{message.status}</span>
              )}
            </div>
          </article>
        ))}
        {runContent}
      </div>
      <form
        className="composer adjustable-composer"
        ref={composer}
        onSubmit={(event) => {
          event.preventDefault();
          sendDraft();
        }}
      >
        <div
          className="composer-resize-handle"
          role="separator"
          tabIndex={0}
          aria-label="Message box height"
          aria-orientation="horizontal"
          aria-valuemin={MIN_DRAFT_HEIGHT}
          aria-valuemax={maxDraftHeight}
          aria-valuenow={draftHeight}
          aria-valuetext={`${draftHeight} pixels. Up grows the message box; down shrinks it.`}
          title="Drag up to grow, down to shrink. Arrow keys also resize."
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, y: event.clientY, height: draftHeight };
          }}
          onPointerMove={(event) => {
            const start = drag.current;
            if (start?.pointerId === event.pointerId) resizeDraft(start.height + start.y - event.clientY);
          }}
          onPointerUp={() => { drag.current = null; }}
          onPointerCancel={() => { drag.current = null; }}
          onLostPointerCapture={() => { drag.current = null; }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && drag.current) {
              const start = drag.current;
              drag.current = null;
              if (event.currentTarget.hasPointerCapture(start.pointerId)) event.currentTarget.releasePointerCapture(start.pointerId);
              resizeDraft(start.height);
              return;
            }
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            resizeDraft(event.key === 'Home' ? MIN_DRAFT_HEIGHT : event.key === 'End' ? maxDraftHeight
              : draftHeight + (event.key === 'ArrowUp' ? 20 : -20));
          }}
        ><span /></div>
        {unplaced.length > 0 && <div className="dictation-held" role="status" aria-live="polite">
          {unplaced.map((item) => <div className="dictation-held-item" key={item.deliveryId}>
            {item.state === 'save-failed'
              ? <p><strong>Dictated words are in your draft but not saved yet.</strong>{' '}{item.reason === 'retry' ? 'Use Retry save above.'
                : item.reason === 'reconcile' ? 'Use Reconcile original save above.'
                : 'Copy them before reloading the saved copy.'} A copy is kept here.</p>
              : <p><strong>Dictated words were not placed in your draft.</strong>{' '}They are kept here until you choose what to do.</p>}
            <blockquote className="dictation-held-text">{item.text}</blockquote>
            <div className="dictation-held-actions">
              <button type="button" className="secondary-button" onClick={() => { void navigator.clipboard?.writeText(item.text).catch(() => {}); }}>Copy</button>
              {/* Already in the draft after a failed save: inserting again would duplicate it. */}
              {item.state === 'not-placed' && <button type="button" className="secondary-button" disabled={readOnly || !session}
                onClick={() => insertDictated(item.deliveryId, item.text)}>Insert at cursor</button>}
              <button type="button" className="secondary-button" onClick={() => dictation?.dismiss(item.deliveryId)}>Dismiss</button>
            </div>
          </div>)}
        </div>}
        <label className="sr-only" htmlFor="message-draft">
          Your message
        </label>
        <textarea
          id="message-draft"
          ref={draftField}
          value={draft}
          style={{ height: `${draftHeight}px` }}
          disabled={!session || readOnly}
          placeholder={participantMode ? 'Write an invented message…' : "What's on your mind? Try a sample idea…"}
          rows={3}
          aria-describedby={participantSendBlockedReason ? 'message-shortcuts send-blocked-reason' : 'message-shortcuts'}
          onChange={(event) => session && onDraftChange(session.id, event.target.value)}
          onFocus={(event) => reportDraftSelection(event.currentTarget, true)}
          onSelect={(event) => reportDraftSelection(event.currentTarget, document.activeElement === event.currentTarget)}
          onBlur={(event) => reportDraftSelection(event.currentTarget, false)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.nativeEvent.isComposing || composing.current || event.nativeEvent.keyCode === 229) return;
            if (event.altKey) return;
            event.preventDefault();
            if (event.shiftKey || event.metaKey || event.ctrlKey) {
              if (readOnly || !session) return;
              const field = event.currentTarget;
              const start = field.selectionStart;
              const value = field.value.slice(0, start) + '\n' + field.value.slice(field.selectionEnd);
              onDraftChange(session.id, value);
              requestAnimationFrame(() => { if (field.isConnected && field === draftField.current) field.setSelectionRange(start + 1, start + 1); });
            } else if (!event.repeat) sendDraft();
          }}
        />
        <div className="composer-actions">
          <span className="composer-hint shortcut-hint" id="message-shortcuts">Enter to send · Ctrl / ⌘ / Shift + Enter for a new line
            {dictation?.status === 'ready' && <span className="dictation-ready"> · Dictation ready</span>}</span>
          <>{participantChoices !== undefined || session?.participantChoice ? <ParticipantPicker key={session?.id}
            choices={participantChoices ?? []} selected={session?.participantChoice}
            error={participantChoiceError} confirmation={participantConfirmation}
            availabilityMessage={participantAvailabilityMessage} availabilityChecking={participantAvailabilityChecking}
            localNotice={participantLocalNotice} selectedProblem={participantSelectedProblem} localCatalog={participantLocalCatalog}
            onOpen={onParticipantPickerOpen} onClose={onParticipantPickerClose}
            disabled={readOnly || !session || !onParticipantSelect}
            onSelect={(participant) => session && onParticipantSelect?.(session.id, participant)} />
            : <button type="button" className="model-harness-slot" disabled
            aria-label={participantMode ? 'Participant connection: invented-data proof' : 'Model and harness picker: demo only'}
            title={participantMode ? 'Participant proof for invented messages only. Do not enter private data.'
              : 'Model and harness connections are being recovered. Demo replies only.'}>
            <Icon name="spark" size={13} />{participantMode ? 'Participant proof' : 'Demo · model / harness'}<Icon name="chevron" size={12} />
          </button>}</>
          {onParticipantPickerOpen && <button
            type="button" className="secondary-button" aria-disabled={participantAvailabilityChecking || undefined}
            onClick={() => { if (!participantAvailabilityChecking) onParticipantPickerOpen(); }}
          >Check participant availability</button>}
          <button
            type="submit"
            className="primary-button send-button"
            disabled={!canSend}
            aria-label={participantMode ? 'Send message' : 'Send demo message'}
            aria-describedby={participantSendBlockedReason ? 'send-blocked-reason' : undefined}
          >
            Send
          </button>
        </div>
      </form>
      <p className="conversation-footnote">
        {participantMode ? 'Participant proof · invented messages only. Do not enter private data.'
          : "A demo reply tests the flow. It doesn't call an AI model."}
        {participantSendBlockedReason && <><br /><span id="send-blocked-reason">{participantSendBlockedReason}</span></>}
      </p>
    </section>
  );
}
