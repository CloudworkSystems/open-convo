import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DeskState, MemoryCommand, MemoryDraft, MemoryEntry, MemorySource } from '../domain/types';
import { eligibleMemoryContext, MEMORY_TEXT_LIMIT } from '../domain/memory';
import { folderOptions } from '../domain/folder-paths';
import { Icon } from '../ui/Icon';
import './memory.css';

export interface MemoryPageProps {
  state: DeskState;
  readOnly?: boolean;
  onCommand: (command: MemoryCommand) => void;
  createId?: () => string;
  storageMode?: 'browser' | 'native-proof';
}

const operationLabels = { remember: 'Remember', correct: 'Correct', forget: 'Forget', restore: 'Restore', undo: 'Undo' };

type MemoryFocusTarget = 'card' | 'correction';
type MemoryCardAction = (command: MemoryCommand, memoryId: string, target: MemoryFocusTarget) => void;

function MemoryCard({ entry, state, readOnly, included, onCommand, onAction }: MemoryPageProps & { entry: MemoryEntry; included: boolean; onAction: MemoryCardAction }) {
  const editing = entry.correctionDraft !== undefined;
  const sourceRef = entry.source;
  const source = sourceRef.kind === 'message' ? state.messages.find((message) => message.id === sourceRef.id)
    : sourceRef.kind === 'note' ? state.notes.find((note) => note.id === sourceRef.id) : null;
  const fieldId = `memory-correction-${entry.id}`;
  const send = (command: MemoryCommand) => { if (!readOnly) onCommand(command); };
  const act = (command: MemoryCommand, target: MemoryFocusTarget = 'card') => { if (!readOnly) onAction(command, entry.id, target); };
  return <article className={`memory-card memory-${entry.use}`} data-memory-id={entry.id} tabIndex={-1} aria-label={`Memory: ${entry.body}`}>
    <div className="memory-card-heading">
      <Icon name="memory" size={17} />
      <span>{entry.use === 'trashed' ? 'In Trash' : entry.use === 'view-only' ? 'Viewing only' : included ? 'Available in this folder' : 'Excluded from context'}</span>
    </div>
    <p className="memory-body">{entry.body}</p>
    {editing && entry.use !== 'trashed' && <form className="memory-correction" aria-label="Correct memory" data-preview-refresh-hold="memory-correction"
      onSubmit={(event) => { event.preventDefault(); act({ type: 'correct-memory', memoryId: entry.id, expectedRevision: entry.revision, body: entry.correctionDraft ?? '' }); }}>
      <label htmlFor={fieldId}>Corrected detail</label>
      <textarea id={fieldId} value={entry.correctionDraft ?? ''} maxLength={MEMORY_TEXT_LIMIT} disabled={readOnly}
        onChange={(event) => send({ type: 'set-memory-correction-draft', memoryId: entry.id, expectedRevision: entry.revision, text: event.target.value })} />
      <div className="memory-actions">
        <button className="secondary-button" type="submit" disabled={readOnly || !entry.correctionDraft?.trim()}>Save correction</button>
        <button className="text-button" type="button" disabled={readOnly} onClick={() => act({ type: 'set-memory-correction-draft', memoryId: entry.id, expectedRevision: entry.revision, text: null })}>Cancel correction</button>
      </div>
    </form>}
    <div className="memory-actions">
      {entry.use !== 'trashed' && !editing && <button type="button" className="text-button" disabled={readOnly}
        onClick={() => act({ type: 'set-memory-correction-draft', memoryId: entry.id, expectedRevision: entry.revision, text: entry.body }, 'correction')}>Correct</button>}
      {entry.use !== 'trashed' && <button type="button" className="text-button" disabled={readOnly}
        onClick={() => act({ type: 'forget-memory', memoryId: entry.id, expectedRevision: entry.revision })}>Forget</button>}
      {entry.use !== 'active' && <button type="button" className="text-button" disabled={readOnly}
        onClick={() => act({ type: 'restore-memory', memoryId: entry.id, expectedRevision: entry.revision, use: 'active' })}>Restore for this folder</button>}
      {entry.use === 'trashed' && <button type="button" className="text-button" disabled={readOnly}
        onClick={() => act({ type: 'restore-memory', memoryId: entry.id, expectedRevision: entry.revision, use: 'view-only' })}>Restore for viewing only</button>}
      {entry.undo && <button type="button" className="text-button" disabled={readOnly}
        onClick={() => act({ type: 'undo-memory', memoryId: entry.id, expectedRevision: entry.revision })}>Undo {operationLabels[entry.undo.operation].toLowerCase()}</button>}
    </div>
    <details className="memory-history">
      <summary>Source and changes · {entry.history.length}</summary>
      <p>{entry.source.kind === 'direct' ? 'Direct teaching, explicitly saved.' : 'Selected sample source. Its original remains readable; raw source text is excluded from context.'}</p>
      {source && <details><summary>Read original source</summary><p className="memory-body">{source.body}</p></details>}
      <ol>{entry.history.map((change) => <li key={change.revision}>
        <span>{operationLabels[change.operation]} · {new Date(change.changedAt).toLocaleString()} · {change.use === 'active' ? 'available' : change.use}</span>
        <p className="memory-body">{change.body}</p>
      </li>)}</ol>
    </details>
  </article>;
}

export function MemoryPage({ state, readOnly = false, onCommand, createId, storageMode = 'browser' }: MemoryPageProps) {
  const page = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<{ memoryId: string; target: MemoryFocusTarget; goalId: string | null; selectionId: string | null; before: DeskState; origin: Element | null } | null>(null);
  const [focusVersion, setFocusVersion] = useState(0);
  const [choice, setChoice] = useState<{ selectionId: string | null; goalId: string } | null>(null);
  useEffect(() => { setChoice(null); }, [state.selection.goalId]);
  const goalId = choice?.selectionId === state.selection.goalId && state.goals.some((goal) => goal.id === choice.goalId)
    ? choice.goalId : state.selection.goalId ?? state.goals[0]?.id ?? null;
  const goal = state.goals.find((goal) => goal.id === goalId);
  const onAction: MemoryCardAction = (command, memoryId, target) => {
    // An explicit action may remove its control or move the card between lists.
    // Keep this request above those cards, but consume it on the next render.
    pendingFocus.current = { memoryId, target, goalId, selectionId: state.selection.goalId, before: state, origin: document.activeElement };
    setFocusVersion((version) => version + 1);
    onCommand(command);
  };
  useLayoutEffect(() => {
    const request = pendingFocus.current;
    pendingFocus.current = null;
    if (!request || readOnly || state === request.before || goalId !== request.goalId || state.selection.goalId !== request.selectionId) return;
    // Do not reclaim focus after another control or a different folder took it.
    if (document.activeElement !== request.origin && document.activeElement !== document.body) return;
    const card = page.current?.querySelector<HTMLElement>(`[data-memory-id="${CSS.escape(request.memoryId)}"]`);
    const target = request.target === 'correction' ? card?.querySelector<HTMLTextAreaElement>('.memory-correction textarea') : card;
    // A user may have collapsed populated Trash without changing its records.
    // Reveal an explicitly moved card before focusing it inside that disclosure.
    const trash = target?.closest<HTMLDetailsElement>('.memory-trash');
    if (trash) trash.open = true;
    target?.focus();
  }, [focusVersion, state, goalId, readOnly]);
  const draft = goalId ? state.memoryDrafts?.[goalId] : undefined;
  const entries = (state.memories ?? []).filter((entry) => entry.goalId === goalId);
  const context = useMemo(() => goalId ? eligibleMemoryContext(state, goalId) : null, [state, goalId]);
  const included = new Set(context?.memories.map((entry) => entry.id));
  const sources = useMemo(() => {
    const sessions = new Map(state.sessions.filter((session) => session.goalId === goalId).map((session) => [session.id, session.title]));
    return [
      ...state.notes.filter((note) => note.goalId === goalId).map((note, index) => ({ key: `note:${note.id}`, source: { kind: 'note', id: note.id } as MemorySource, body: note.body, label: `Scratch note ${index + 1}` })),
      ...state.messages.filter((message) => sessions.has(message.sessionId) && message.status === 'complete').map((message, index) => ({ key: `message:${message.id}`, source: { kind: 'message', id: message.id } as MemorySource, body: message.body, label: `Message ${index + 1} · ${message.role} · ${sessions.get(message.sessionId)}` })),
    ];
  }, [state.notes, state.messages, state.sessions, goalId]);
  const sourceKey = draft?.source.kind && draft.source.kind !== 'direct' ? `${draft.source.kind}:${draft.source.id}` : 'direct';
  const sourceExists = sourceKey === 'direct' || sources.some((source) => source.key === sourceKey);
  const updateDraft = (change: Partial<MemoryDraft>) => {
    if (!goalId || readOnly) return;
    const updated: MemoryDraft = { memoryId: draft?.memoryId ?? (createId?.() ?? crypto.randomUUID()), body: draft?.body ?? '', source: draft?.source ?? { kind: 'direct' },
      ...(draft?.sourceBody === undefined ? {} : { sourceBody: draft.sourceBody }), ...change };
    if (updated.source.kind === 'direct') delete updated.sourceBody;
    onCommand({ type: 'set-memory-draft', goalId, draft: updated });
  };
  const current = entries.filter((entry) => entry.use !== 'trashed');
  const trash = entries.filter((entry) => entry.use === 'trashed');
  return <div className="module-page memory-page" ref={page}>
    <div className="memory-page-heading"><h2>Chosen memories</h2><span>{goal?.title ?? 'Choose a session folder'}</span></div>
    <p className="module-notice memory-preview-notice"><Icon name="shield" size={17} /><span>{storageMode === 'native-proof'
      ? 'Invented native workspace · private use unavailable. No AI memory or learning is connected.'
      : 'Invented-data preview · unencrypted browser storage. No AI memory or learning is connected.'}</span></p>
    <form className="memory-teaching" aria-label="Remember a detail" data-preview-refresh-hold={draft && (draft.body || draft.source.kind !== 'direct') ? 'memory-teaching' : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (readOnly || !goalId || !draft || !sourceExists || !draft.body.trim()) return;
        onCommand({ type: 'remember-memory', memoryId: draft.memoryId, goalId, body: draft.body, source: draft.source,
          ...(draft.source.kind === 'direct' ? {} : { expectedSourceBody: draft.sourceBody }) });
      }}>
      <div className="memory-form-selects">
        <div><label htmlFor="memory-folder">Session folder</label><select id="memory-folder" value={goalId ?? ''} disabled={readOnly || !goalId}
          onChange={(event) => setChoice({ selectionId: state.selection.goalId, goalId: event.target.value })}>
          {folderOptions(state.goals).map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
        </select></div>
        <div><label htmlFor="memory-source">Memory source</label><select id="memory-source" value={sourceKey} disabled={readOnly || !goalId}
          onChange={(event) => {
            const source = sources.find((source) => source.key === event.target.value);
            updateDraft(source ? { source: source.source, sourceBody: source.body, body: source.body.length <= MEMORY_TEXT_LIMIT ? source.body : draft?.body ?? '' }
              : { source: { kind: 'direct' } });
          }}>
          <option value="direct">Direct teaching</option>
          {!sourceExists && <option value={sourceKey}>Earlier source · review a current source</option>}
          {sources.map((source) => <option key={source.key} value={source.key}>{source.label}</option>)}
        </select></div>
      </div>
      {draft?.source.kind !== 'direct' && draft?.sourceBody !== undefined && <details className="memory-source-preview"><summary>Review selected sample source</summary><p className="memory-body">{draft.sourceBody}</p></details>}
      {!sourceExists && <p role="status">Your draft is kept. Choose a current source in this folder before saving.</p>}
      <label htmlFor="memory-detail">Detail to remember</label>
      <textarea id="memory-detail" value={draft?.body ?? ''} maxLength={MEMORY_TEXT_LIMIT} disabled={readOnly || !goalId}
        placeholder="Use an invented detail, such as a sample writing preference…"
        onChange={(event) => updateDraft({ body: event.target.value })} />
      <div className="memory-actions"><button type="submit" className="secondary-button" disabled={readOnly || !sourceExists || !draft?.body.trim()}>Save memory</button>
        {draft && <button type="button" className="text-button" disabled={readOnly} onClick={() => goalId && onCommand({ type: 'set-memory-draft', goalId, draft: null })}>Discard draft</button>}
        <span className="muted small">Only this folder. Saving adds no outside permission.</span></div>
    </form>
    <section className="memory-current" aria-label="Chosen memories">
      {current.map((entry) => <MemoryCard key={entry.id} entry={entry} state={state} readOnly={readOnly} included={included.has(entry.id)} onCommand={onCommand} onAction={onAction} />)}
      {!current.length && <p className="muted">No chosen memories in this folder.</p>}
    </section>
    <details className="memory-trash" open={trash.length > 0}><summary>Memory Trash · {trash.length}</summary>
      <p className="muted small">Excluded from context. Restore or Undo is available; automatic expiry and permanent deletion are not active in this preview.</p>
      {trash.map((entry) => <MemoryCard key={entry.id} entry={entry} state={state} readOnly={readOnly} included={false} onCommand={onCommand} onAction={onAction} />)}
    </details>
    <details className="memory-context"><summary>Context preview · simulation only</summary>
      <p className="muted small">Latest available memories for this folder only. Earlier versions, drafts, Trash and selected raw sources are excluded. No context is sent to an AI.</p>
      <ul>{context?.memories.map((entry) => <li key={entry.id}>{entry.body}</li>)}</ul>
      {!context?.memories.length && <p>No memories available for context.</p>}
    </details>
  </div>;
}
