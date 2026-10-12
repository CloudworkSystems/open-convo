import { useEffect, useRef, useState } from 'react';
import type { Activity, Goal, Session } from '../domain/types';
import { SESSION_CREATION_TIME_ZONE } from '../domain/session-naming';
import { Icon } from '../ui/Icon';
import './domain-note.css';

const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'short', timeZone: SESSION_CREATION_TIME_ZONE,
}).format(new Date(value));

export interface GoalPanelProps {
  goal?: Goal;
  session?: Session;
  sessions: Session[];
  activity: Activity[];
  onSessionSelect: (sessionId: string) => void;
  purposeDraft?: string | null;
  onPurposeDraftChange: (goalId: string, value: string | null) => void;
  onPurposeChange: (goalId: string, value: string, expectedPurpose?: string) => void;
  editPurposeRequest?: { goalId: string; token: number } | null;
  onPurposeEditClose?: (goalId: string) => void;
  onSessionIntentDraftChange: (sessionId: string, value: string | null) => void;
  onSessionIntentChange: (sessionId: string, value: string, expectedIntent?: string) => void;
  onSessionRename?: (sessionId: string, origin: HTMLElement) => void;
  onSessionPin?: (sessionId: string, pinned: boolean) => void;
  readOnly?: boolean;
}

export function GoalPanel({
  goal, session, sessions, activity, onSessionSelect,
  purposeDraft = null, onPurposeDraftChange, onPurposeChange, editPurposeRequest, onPurposeEditClose,
  onSessionIntentDraftChange, onSessionIntentChange, onSessionRename, onSessionPin, readOnly = false,
}: GoalPanelProps) {
  const [editingPurposeId, setEditingPurposeId] = useState<string | null>(null);
  const [editingIntentId, setEditingIntentId] = useState<string | null>(null);
  const purposeInput = useRef<HTMLTextAreaElement>(null);
  const intentInput = useRef<HTMLTextAreaElement>(null);
  const editIntentButton = useRef<HTMLButtonElement>(null);
  const editingPurpose = Boolean(goal) && (purposeDraft !== null || editingPurposeId === goal?.id);
  const editingIntent = Boolean(session) && (typeof session?.intentDraft === 'string' || editingIntentId === session?.id);
  const purpose = purposeDraft ?? goal?.purpose ?? '';
  const intent = session?.intentDraft ?? session?.intent ?? '';
  const folderSessions = sessions.filter((item) => item.goalId === (goal?.id ?? null));
  const scopedActivity = activity.filter((item) => session ? item.sessionId === session.id : item.goalId === (goal?.id ?? null))
    .slice().sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));

  useEffect(() => {
    if (goal && editPurposeRequest?.goalId === goal.id) setEditingPurposeId(goal.id);
  }, [editPurposeRequest?.goalId, editPurposeRequest?.token, goal?.id]);
  useEffect(() => {
    if (editingPurpose && editPurposeRequest?.goalId === goal?.id) purposeInput.current?.focus();
  }, [editingPurpose, editPurposeRequest?.goalId, editPurposeRequest?.token, goal?.id]);
  useEffect(() => { if (editingIntent) intentInput.current?.focus(); }, [editingIntent, session?.id]);

  const closePurpose = () => {
    setEditingPurposeId(null);
    if (goal) onPurposeEditClose?.(goal.id);
  };
  const closeIntent = () => {
    setEditingIntentId(null);
    requestAnimationFrame(() => editIntentButton.current?.focus());
  };

  return (
    <aside className="goal-panel session-detail-panel" aria-label="Session details" data-selected-session-id={session?.id}>
      <section className="session-folder-context" aria-label="Session folder">
        <span className="eyebrow">SESSION FOLDER</span>
        <h2>{goal?.title ?? 'Ungrouped sessions'}</h2>
        {goal && <section className="domain-note-card" aria-label="Domain note">
          <div className="domain-note-heading">
            <span className="eyebrow">FOLDER INTENT</span>
            {!editingPurpose && <button type="button" className="icon-button" aria-label="Edit domain note"
              onClick={() => { setEditingPurposeId(goal.id); requestAnimationFrame(() => purposeInput.current?.focus()); }} disabled={readOnly}>
              <Icon name="edit" size={15} />
            </button>}
          </div>
          {editingPurpose ? <form onSubmit={(event) => {
            event.preventDefault();
            if (!readOnly) { onPurposeChange(goal.id, purpose, goal.purpose ?? ''); closePurpose(); }
          }}>
            <label className="sr-only" htmlFor="domain-purpose">Domain note</label>
            <textarea ref={purposeInput} id="domain-purpose" value={purpose} data-autofocus
              onChange={(event) => onPurposeDraftChange(goal.id, event.target.value)}
              placeholder="What belongs here, and what did you have in mind?" rows={4} maxLength={4000} disabled={readOnly} />
            <div className="inline-actions">
              <button type="button" className="text-button" disabled={readOnly}
                onClick={() => { if (purposeDraft !== null) onPurposeDraftChange(goal.id, null); closePurpose(); }}>Cancel</button>
              <button type="submit" className="primary-button compact" disabled={readOnly}>Save domain note</button>
            </div>
          </form> : <p className={goal.purpose ? 'domain-purpose' : 'domain-note-placeholder'}>
            {goal.purpose || 'Optional: describe what belongs in this folder.'}
          </p>}
        </section>}
      </section>

      <div className="session-detail-divider" />

      {session ? <section className="selected-session-context" aria-label="Selected session">
        <div className="session-detail-heading">
          <div><span className="eyebrow">SESSION</span><h3>{session.title}</h3></div>
          <div className="session-detail-actions">
            {onSessionPin && <button type="button" className="icon-button" aria-label={session.pinned ? 'Unpin selected session' : 'Pin selected session'}
              aria-pressed={session.pinned === true} title={session.pinned ? 'Unpin session' : 'Pin session'} disabled={readOnly}
              onClick={() => onSessionPin(session.id, !session.pinned)}><Icon name={session.pinned ? 'pin-filled' : 'pin'} size={17} /></button>}
            {onSessionRename && <button type="button" className="icon-button" aria-label="Rename selected session" title="Rename session" disabled={readOnly}
              onClick={(event) => onSessionRename(session.id, event.currentTarget)}><Icon name="edit" size={16} /></button>}
          </div>
        </div>
        <section className="session-intent-card" aria-label="Session intent">
          <div className="domain-note-heading">
            <h4>Session intent</h4>
            {!editingIntent && <button ref={editIntentButton} type="button" className="icon-button" aria-label="Edit session intent" disabled={readOnly}
              onClick={() => setEditingIntentId(session.id)}><Icon name="edit" size={15} /></button>}
          </div>
          {editingIntent ? <form onSubmit={(event) => {
            event.preventDefault();
            if (!readOnly) { onSessionIntentChange(session.id, intent, session.intent ?? ''); closeIntent(); }
          }}>
            <label className="sr-only" htmlFor="session-intent">Session intent</label>
            <textarea ref={intentInput} id="session-intent" value={intent} data-autofocus onChange={(event) => onSessionIntentDraftChange(session.id, event.target.value)}
              placeholder="Describe the intent for this session." rows={4} maxLength={4000} disabled={readOnly} />
            <div className="inline-actions">
              <button type="button" className="text-button" disabled={readOnly}
                onClick={() => { if (typeof session.intentDraft === 'string') onSessionIntentDraftChange(session.id, null); closeIntent(); }}>Cancel</button>
              <button type="submit" className="primary-button compact" disabled={readOnly}>Save session intent</button>
            </div>
          </form> : <p className={session.intent ? 'session-intent' : 'domain-note-placeholder'}>
            {session.intent || 'Describe the intent for this session.'}
          </p>}
        </section>

        <details className="session-metadata" key={`metadata-${session.id}`}>
          <summary>Details</summary>
          <dl>
            <dt>Session ID</dt><dd className="session-stable-id">{session.id}</dd>
            <dt>Created</dt><dd><time dateTime={session.createdAt}>{formatTime(session.createdAt)}</time><span className="session-timezone">{SESSION_CREATION_TIME_ZONE}</span></dd>
          </dl>
          {!!session.titleHistory?.length && <section aria-label="Session name history">
            <h4>Recorded names</h4>
            <p className="history-explanation">Names recorded from explicit renames; earlier names may be unavailable.</p>
            <ol className="session-history">{session.titleHistory.map((entry, index) => <li key={`${entry.createdAt}-${index}`}>
              <span>{index === 0 ? 'First recorded name' : 'Name changed'}</span><p>{entry.text}</p><time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
            </li>)}</ol>
          </section>}
          {!!session.intentHistory?.length && <section aria-label="Session intent history">
            <h4>Recorded intent</h4>
            <ol className="session-history">{session.intentHistory.map((entry, index) => <li key={`${entry.createdAt}-${index}`}>
              <span>{index === 0 ? 'First recorded intent' : 'Intent updated'}</span><p>{entry.text || 'Intent cleared.'}</p><time dateTime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
            </li>)}</ol>
          </section>}
        </details>
      </section> : <section className="folder-session-list" aria-label="Sessions in this folder">
        <h3>Sessions</h3>
        {folderSessions.length ? <ul>{folderSessions.map((item) => <li key={item.id}>
          <button type="button" data-details-session-id={item.id} onClick={() => onSessionSelect(item.id)}>{item.title}</button>
        </li>)}</ul> : <p className="muted small">No sessions in this folder.</p>}
      </section>}

      <details className="activity-section session-activity" key={`activity-${session?.id ?? goal?.id ?? 'ungrouped'}`}>
        <summary>Activity <span>({scopedActivity.length})</span></summary>
        {scopedActivity.length ? <ol>{scopedActivity.map((item) => <li key={item.id} data-activity-id={item.id}>
          <span className="activity-dot" /><div><p>{item.summary}</p><time dateTime={item.createdAt}>{formatTime(item.createdAt)}</time></div>
        </li>)}</ol> : <p className="muted small">{session ? 'No activity recorded for this session.' : 'No activity recorded for this folder.'}</p>}
      </details>
    </aside>
  );
}
