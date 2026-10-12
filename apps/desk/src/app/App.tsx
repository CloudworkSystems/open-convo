import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { WorkspaceLoadResult, WorkspaceSaveResult } from '../adapters/workspace-repository';
import { DeskRuntimeContext, type DeskRuntime } from './runtime';
import { sameParticipantIdentity } from '../domain/participant-choices';
import { applyCommand, isViewCommand } from '../domain/commands';
import { createDemoState } from '../domain/demo';
import type { DeskCommand, DeskState } from '../domain/types';
import { DeskFoundation } from '../features/DeskFoundation';
import { parsePreviewBuild, retireAnnotationDiagnostics, watchPreviewUpdates } from './preview-updates';
import type { PreviewUpdateNotice } from './preview-updates';
import { useConversationRuns, type WorkspaceAttemptResult } from './use-conversation-runs';

type SaveStatus = { kind: 'saved' | 'saving' | 'error' | 'memory'; message: string };
type Problem = { kind: 'failed' | 'conflict' | 'unknown' | 'unavailable'; message: string };
const runtimeKeys = new WeakMap<DeskRuntime, number>();
let nextRuntimeKey = 0;

const previewBuild = import.meta.env.PROD && typeof __DESK_PREVIEW_BUILD__ !== 'undefined'
  ? parsePreviewBuild(__DESK_PREVIEW_BUILD__) : null;

function useSystemTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const changed = () => setTheme(media.matches ? 'dark' : 'light');
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  return theme;
}

export function App({ runtime }: { runtime: DeskRuntime }) {
  const active = useSyncExternalStore(runtime.subscribeInvalidation, runtime.isActive);
  if (!runtimeKeys.has(runtime)) runtimeKeys.set(runtime, ++nextRuntimeKey);
  return <DeskRuntimeContext.Provider value={runtime}>
    {active ? <DeskApplication key={runtimeKeys.get(runtime)} runtime={runtime} />
      : <main className="recovery-page"><h1>Workspace connection closed</h1><p role="alert">This visit has ended. Unconfirmed local edits have been cleared; reopen through the native host to check what was saved. Private use remains unavailable in this proof.</p></main>}
  </DeskRuntimeContext.Provider>;
}

function DeskApplication({ runtime }: { runtime: DeskRuntime }) {
  const repository = runtime.workspace;
  const tabView = runtime.tabView;
  const nativeProof = runtime.mode === 'native-proof';
  const [initial, setInitial] = useState<WorkspaceLoadResult | null>(null);
  const [state, setState] = useState<DeskState | null>(null);
  const [viewWarning, setViewWarning] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'memory', message: nativeProof ? 'Opening the invented native workspace…' : 'Opening saved sample workspace…' });
  const [problem, setProblem] = useState<Problem | null>(null);
  const [commandError, setCommandError] = useState('');
  const [participantChoiceError, setParticipantChoiceError] = useState<{ sessionId: string; message: string } | null>(null);
  const [previewUpdate, setPreviewUpdate] = useState<PreviewUpdateNotice | null>(null);
  const previewWatcher = useRef<ReturnType<typeof watchPreviewUpdates> | null>(null);
  const stateRef = useRef(state);
  const savedRevision = useRef<number | null>(null);
  const savedState = useRef<DeskState | null>(null);
  const writeProblem = useRef<Problem | null>(null);
  const tail = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const saveEpoch = useRef(0);
  const retrying = useRef(false);
  const [retryPending, setRetryPending] = useState(false);
  const alive = useRef(true);
  const notifyRunSave = useRef<(saved: DeskState) => void>(() => {});
  const isCurrent = () => alive.current && runtime.isActive();
  const savedMessage = nativeProof ? 'Invented workspace saved by the native host' : 'Sample workspace saved in this browser';
  const systemTheme = useSystemTheme();
  const theme = state?.preferences.theme === 'system' || !state ? systemTheme : state.preferences.theme;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  function setWriteProblem(value: Problem) {
    if (!isCurrent()) return;
    writeProblem.current = value;
    setProblem(value);
    setSaveStatus({ kind: 'error', message: nativeProof ? 'Changes kept for this visit · native save needs attention' : 'Changes kept in this tab · save needs attention' });
  }

  function save(snapshot: DeskState): Promise<WorkspaceAttemptResult> {
    // Each queued attempt owns an immutable snapshot. A successful older write
    // must never mark a newer visible draft as saved.
    const captured = structuredClone(snapshot);
    saveEpoch.current += 1;
    pending.current += 1;
    if (!writeProblem.current) setSaveStatus({ kind: 'saving', message: nativeProof ? 'Saving the invented native workspace…' : 'Saving sample workspace…' });
    const operation = tail.current.then(async (): Promise<WorkspaceAttemptResult> => {
      if (!isCurrent()) return { kind: 'unavailable', error: 'The workspace connection is closed.' };
      if (writeProblem.current) return { kind: 'blocked', error: 'This update has not been sent because an earlier save needs attention.' };
      const result = await repository.save(captured, savedRevision.current);
      if (!isCurrent()) return { kind: 'unavailable', error: 'The workspace connection closed before save confirmation.' };
      if (result.kind === 'saved') {
        savedRevision.current = result.state.revision;
        savedState.current = result.state;
        notifyRunSave.current(result.state);
        if (stateRef.current?.revision === result.state.revision && pending.current === 1) {
          setSaveStatus({ kind: 'saved', message: savedMessage });
        }
      } else {
        setWriteProblem({ kind: result.kind, message: result.error });
      }
      return result;
    }).catch((): WorkspaceSaveResult => {
      setWriteProblem({ kind: nativeProof ? 'unavailable' : 'failed', message: nativeProof ? 'The native save outcome is unavailable. Keep this visit open; no new save will be sent.' : 'Saving stopped unexpectedly. Your attempted work is still in this tab.' });
      return { kind: 'unavailable', error: 'The save outcome could not be confirmed.' };
    });
    tail.current = operation.then(() => {}).finally(() => {
      pending.current -= 1;
    });
    return operation;
  }

  function dispatch(command: DeskCommand, reportError?: (message: string) => void) {
    const current = stateRef.current;
    if (!current || !isCurrent()) return;
    const refuse = (message: string) => {
      setCommandError(message);
      reportError?.(message);
    };
    const readOnlyCommand = isViewCommand(command);
    if (writeProblem.current && writeProblem.current.kind !== 'failed' && !readOnlyCommand) {
      // The open picker receives this workspace-wide problem directly. Do
      // not retain a second error after Retry or reconcile resolves it.
      setCommandError(nativeProof ? 'Resolve the native save before making more changes. Your attempted work is kept in this visit.' : 'Download your attempted work or reload the saved copy before making more changes.');
      return;
    }
    try {
      const next = applyCommand(current, command, runtime.createId ? { id: runtime.createId } : undefined);
      if (next === current) return;
      // New edits/checkpoints budget the largest possible view, so tab-only
      // navigation never uses an accepted response's capacity. Older records
      // may lack that reserve; pure views use actual headroom without hiding Stop.
      if (next.schemaVersion === 2 && !runs.canSaveEdits(next, readOnlyCommand ? current : undefined)) {
        refuse(readOnlyCommand
          ? 'This view change would exceed the current proof storage limit. Your current view and conversation records were kept.'
          : 'This workspace has reached its current proof storage limit. The existing records were kept; this edit was not saved.');
        return;
      }
      stateRef.current = next;
      setState(next);
      setCommandError('');
      setViewWarning(tabView.save(next));
      if (!readOnlyCommand && !writeProblem.current) save(next);
    } catch (error) {
      refuse(error instanceof Error ? error.message : 'The change could not be applied.');
    }
  }

  const runs = useConversationRuns({ runtime, state, current: () => stateRef.current, saved: () => savedState.current,
    blocked: () => writeProblem.current !== null,
    present: (next) => { stateRef.current = next; setState(next); },
    save, error: setCommandError,
  });
  notifyRunSave.current = runs.confirmSaved;

  useEffect(() => {
    let active = true;
    alive.current = true;
    let booting = true;
    let changedDuringBootstrap = false;
    let changeRead = 0;
    const changed = () => {
      if (booting) { changedDuringBootstrap = true; return; }
      if (!stateRef.current || !isCurrent() || (nativeProof && writeProblem.current)) return;
      const read = ++changeRead;
      void (async () => {
        // A notification can arrive between our own committed snapshots. Read
        // only after that queue drains, and discard reads overtaken by a new save.
        while (active && pending.current > 0) await tail.current;
        if (!active || !isCurrent() || read !== changeRead) return;
        const epoch = saveEpoch.current;
        const current = await repository.loadLatest();
        if (!active || !isCurrent() || read !== changeRead || !stateRef.current || (nativeProof && writeProblem.current)) return;
        if (epoch !== saveEpoch.current || pending.current > 0) { changed(); return; }
        if (current.kind === 'ready' && current.state.revision === savedRevision.current) return;
        setWriteProblem({
          kind: 'conflict',
          message: nativeProof ? 'The native workspace changed or is unavailable. Your attempted work stays in this visit; resolve it before reloading.' : 'The saved sample workspace changed in another tab or is no longer readable. Your attempted work stays in this tab. Download it before reloading the saved copy.',
        });
      })();
    };
    const unsubscribe = repository.subscribe(changed);
    void (async () => {
      let loaded: WorkspaceLoadResult;
      try { loaded = await repository.loadLatest(); }
      catch { loaded = { kind: 'unavailable', error: 'The workspace authority could not be read. No replacement was created.' }; }
      while (active && changedDuringBootstrap) {
        changedDuringBootstrap = false;
        loaded = await repository.loadLatest();
      }
      if (!active || !isCurrent()) return;
      if (nativeProof && loaded.kind === 'empty') loaded = { kind: 'unavailable', error: 'The native proof workspace is missing. No browser copy or replacement was created.' };
      setInitial(loaded);
      const workspace = loaded.kind === 'ready' ? loaded.state : loaded.kind === 'empty' && !nativeProof ? createDemoState() : null;
      if (workspace) {
        const view = tabView.load(workspace);
        stateRef.current = view.state;
        savedState.current = loaded.kind === 'ready' ? loaded.state : null;
        savedRevision.current = loaded.kind === 'ready' ? loaded.state.revision : null;
        setState(view.state);
        setViewWarning(view.warning);
        setSaveStatus(loaded.kind === 'ready'
          ? { kind: 'saved', message: savedMessage }
          : { kind: 'memory', message: 'Sample workspace not saved yet' });
        booting = false;
        if (loaded.kind === 'empty') save(view.state);
      } else booting = false;
      // Never initialize while the authoritative read is pending or failed.
      // Valid legacy bytes are read-only until a deliberate content save.
    })();
    const leaving = (event: BeforeUnloadEvent) => {
      if (writeProblem.current || pending.current > 0 || runs.hasUnconfirmed()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leaving);
    return () => {
      active = false;
      alive.current = false;
      stateRef.current = null;
      savedRevision.current = null;
      savedState.current = null;
      writeProblem.current = null;
      saveEpoch.current += 1;
      unsubscribe();
      window.removeEventListener('beforeunload', leaving);
    };
  }, [repository, tabView]);

  useEffect(() => {
    // Ordinary development uses Vite's live reload. Only an identified hosted
    // production preview checks for published builds.
    if (nativeProof || !previewBuild) return;
    retireAnnotationDiagnostics(window.location, window.history);
    let lastInteractionAt = Date.now();
    let composing = false;
    let interacting = false;
    const editable = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
    const activity = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest('[data-preview-refresh]')) lastInteractionAt = Date.now();
      if (event.type === 'pointerdown') interacting = true;
      if (event.type === 'pointerup' || event.type === 'pointercancel') interacting = false;
      if (event.type === 'compositionstart') composing = true;
      if (event.type === 'compositionend') composing = false;
      previewWatcher.current?.check();
    };
    const blurred = () => {
      interacting = false;
      composing = false;
      lastInteractionAt = Date.now();
      previewWatcher.current?.check();
    };
    const check = () => previewWatcher.current?.check();
    const resumed = () => {
      lastInteractionAt = Date.now();
      check();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === 'visible') resumed();
      else check();
    };
    const watcher = watchPreviewUpdates({
      loadedBuild: previewBuild,
      safety: () => ({
        workspaceReady: stateRef.current !== null && stateRef.current.revision === savedRevision.current,
        pendingSaves: pending.current,
        saveProblem: writeProblem.current !== null || runtime.canvasVisit.temporary !== undefined || runtime.roadmapVisit.hasUnsaved()
          || document.querySelector('[data-preview-refresh-hold]') !== null,
        retrying: retrying.current,
        visible: document.visibilityState === 'visible' && document.hasFocus(),
        online: navigator.onLine,
        modalOpen: document.querySelector('dialog[open], [role="dialog"], [aria-modal="true"]') !== null,
        composing,
        interacting,
        inputActive: document.activeElement instanceof Element && document.activeElement.matches(editable),
        lastInteractionAt,
      }),
      onNotice: setPreviewUpdate,
      reload: () => window.location.reload(),
      marker: {
        getItem: (key) => window.sessionStorage.getItem(key),
        setItem: (key, value) => window.sessionStorage.setItem(key, value),
      },
    });
    previewWatcher.current = watcher;
    const events = ['input', 'change', 'keydown', 'pointerdown', 'pointerup', 'pointercancel', 'wheel', 'compositionstart', 'compositionend'];
    for (const name of events) document.addEventListener(name, activity, true);
    document.addEventListener('visibilitychange', visibilityChanged);
    window.addEventListener('blur', blurred);
    window.addEventListener('focus', resumed);
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    return () => {
      watcher.stop();
      previewWatcher.current = null;
      for (const name of events) document.removeEventListener(name, activity, true);
      document.removeEventListener('visibilitychange', visibilityChanged);
      window.removeEventListener('blur', blurred);
      window.removeEventListener('focus', resumed);
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
    };
  }, []);

  function downloadAttemptedWork() {
    if (!stateRef.current) return;
    downloadWorkspace(JSON.stringify(stateRef.current, null, 2), 'true-convo-sample-workspace.json');
  }

  function downloadWorkspace(raw: string, filename: string) {
    if (nativeProof || !isCurrent()) return;
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function retrySave() {
    if (!isCurrent() || retrying.current || writeProblem.current?.kind !== 'failed') return;
    retrying.current = true;
    setRetryPending(true);
    try {
      // Drain skipped snapshots first; retry only the latest retained attempt.
      await tail.current;
      if (!isCurrent() || !stateRef.current || writeProblem.current?.kind !== 'failed') return;
      writeProblem.current = null;
      setProblem(null);
      save(stateRef.current);
      await tail.current;
    } finally {
      retrying.current = false;
      if (isCurrent()) setRetryPending(false);
    }
  }

  async function reconcileSave() {
    if (!isCurrent() || retrying.current || writeProblem.current?.kind !== 'unknown' || !repository.reconcilePending) return;
    retrying.current = true;
    setRetryPending(true);
    try {
      await tail.current;
      if (!isCurrent() || writeProblem.current?.kind !== 'unknown') return;
      const result: WorkspaceSaveResult = await repository.reconcilePending();
      if (!isCurrent()) return;
      if (result.kind !== 'saved') {
        setWriteProblem({ kind: result.kind, message: result.error });
        return;
      }
      savedRevision.current = result.state.revision;
      savedState.current = result.state;
      const visible = stateRef.current;
      if (!visible || visible.revision < result.state.revision) {
        setWriteProblem({ kind: 'conflict', message: 'The native result does not match this visit. Keep the attempted work while resolving the difference.' });
        return;
      }
      writeProblem.current = null;
      setProblem(null);
      notifyRunSave.current(result.state);
      if (visible.revision === result.state.revision) setSaveStatus({ kind: 'saved', message: savedMessage });
      else save(visible); // Original outcome is now known; only now save subsequent retained edits.
    } catch {
      setWriteProblem({ kind: 'unknown', message: 'The original save is still unconfirmed. No replacement request was sent.' });
    } finally {
      retrying.current = false;
      if (isCurrent()) setRetryPending(false);
    }
  }

  if (!state) {
    if (!initial) return <main className="recovery-page" aria-busy="true"><p role="status">{nativeProof ? 'Opening the invented native workspace…' : 'Opening saved sample workspace…'}</p></main>;
    const message = initial.kind === 'invalid' || initial.kind === 'unavailable' ? initial.error : 'The workspace cannot be opened.';
    const retained = initial.kind === 'invalid' ? initial.raw : initial.kind === 'unavailable' ? initial.legacyRaw : undefined;
    return (
      <main className="recovery-page">
        <p className="recovery-eyebrow">True Convo · sample-data preview</p>
        <h1>Workspace needs recovery</h1>
        <p role="alert">{message}</p>
        <p>{nativeProof ? 'The native authority is unavailable. No browser fallback or replacement was created.' : 'The existing browser contents have been kept. No empty replacement or private-data import was created.'}</p>
        {!nativeProof && retained !== undefined && <button className="recovery-button" onClick={() => downloadWorkspace(retained, 'true-convo-retained-browser-copy.json')}>Download retained browser copy</button>}
        <button className="recovery-button" onClick={() => window.location.reload()}>Try loading again</button>
      </main>
    );
  }

  return (
    <div className="application-shell">
      {problem && (
        <section className="save-recovery" role="alert" aria-label="Save recovery">
          <div><strong>{problem.kind === 'conflict' ? 'Another copy changed' : 'Your work needs saving'}</strong><p>{problem.message}</p></div>
          <div className="recovery-actions">
            {problem.kind === 'unknown' && repository.reconcilePending && <button className="recovery-button" disabled={retryPending} onClick={() => void reconcileSave()}>Reconcile original save</button>}
            {problem.kind === 'failed' && <button className="recovery-button" disabled={retryPending} onClick={() => void retrySave()}>Retry save</button>}
            {!nativeProof && <button className="recovery-button" onClick={downloadAttemptedWork}>Download sample work</button>}
            {!(nativeProof && problem.kind === 'unknown') && <button className="recovery-button secondary" onClick={() => window.location.reload()}>Reload saved copy</button>}
          </div>
        </section>
      )}
      {commandError && <p className="command-error" role="alert">{commandError}</p>}
      {viewWarning && <p className="command-error" role="status">{viewWarning}</p>}
      {previewUpdate && (
        <section className="save-recovery" role="status" aria-live="polite" aria-label="Preview update">
          <div><strong>Preview update available</strong><p>{previewUpdate.saveProblem
            ? 'Temporary changes are keeping this tab open. Save or finish them before refreshing; reloading will discard changes that could not be saved.'
            : previewUpdate.automaticBlocked
            ? 'Refresh this tab when your work is saved and you are ready.'
            : 'This tab will refresh after your work is saved and you pause outside an input.'}</p></div>
          <button className="recovery-button" data-preview-refresh disabled={!previewUpdate.canRefresh}
            onClick={() => previewWatcher.current?.refresh()}>Refresh preview</button>
        </section>
      )}
      {runs.otherRunControls}
      <div className="workspace-wrap">
        <DeskFoundation
          state={state}
          saveStatus={saveStatus}
          theme={theme}
          readOnly={!!problem && problem.kind !== 'failed'}
          onRouteChange={(route) => dispatch({ type: 'navigate', route })}
          onGoalSelect={(goalId) => dispatch({ type: 'select-goal', goalId })}
          onUngroupedSelect={() => dispatch({ type: 'select-ungrouped' })}
          onSessionSelect={(sessionId) => dispatch({ type: 'select-session', sessionId })}
          onSessionCreate={(goalId) => dispatch({ type: 'create-session', goalId })}
          onGoalCreate={(title, parentId) => dispatch({ type: 'create-goal', title, parentId, empty: true })}
          onDomainRename={(domainId, title) => dispatch({ type: 'rename-domain', domainId, title })}
          onSessionRename={(sessionId, title, expectedTitle) => dispatch({ type: 'rename-session', sessionId, title, expectedTitle })}
          onDomainPin={(domainId, pinned) => dispatch({ type: 'set-domain-pinned', domainId, pinned })}
          onFolderIconChange={(domainId, icon) => dispatch({ type: 'set-folder-icon', domainId, icon })}
          onSessionPin={(sessionId, pinned) => dispatch({ type: 'set-session-pinned', sessionId, pinned })}
          onSessionIntentDraftChange={(sessionId, text) => dispatch({ type: 'set-session-intent-draft', sessionId, text })}
          onSessionIntentChange={(sessionId, intent, expectedIntent) => dispatch({ type: 'edit-session-intent', sessionId, intent, expectedIntent })}
          onSessionMove={(sessionId, goalId) => dispatch({ type: 'move-session', sessionId, goalId })}
          onDraftChange={(sessionId, text) => dispatch({ type: 'set-draft', sessionId, text })}
          runContent={runs.content}
          participantLabel={runs.participantLabel}
          participantChoices={runtime.participantChoices}
          participantConfirmation={runtime.participantConfirmation}
          participantAvailabilityMessage={runtime.participantAvailabilityMessage}
          participantAvailabilityChecking={runtime.participantAvailabilityChecking}
          onParticipantPickerOpen={runtime.refreshParticipants ? () => { void runs.refreshAvailability(); } : undefined}
          participantChoiceError={problem?.message || (participantChoiceError?.sessionId === state.selection.sessionId ? participantChoiceError.message : undefined)}
          onParticipantSelect={(sessionId, participant) => {
            const reportError = (message: string) => {
              if (isCurrent()) setParticipantChoiceError({ sessionId, message });
            };
            reportError('');
            if (runtime.participantChoices?.some((choice) => choice.approved && sameParticipantIdentity(choice.identity, participant))) {
              dispatch({ type: 'set-participant-choice', sessionId, participant }, reportError);
            } else reportError('This participant is not in the approved participant list.');
          }}
          participantBusy={runs.busy}
          participantSendUnavailable={runs.unavailable}
          participantSendBlockedReason={runs.sendBlockedReason}
          onSend={(sessionId) => {
            if (runs.participantLabel !== undefined) runs.send(sessionId);
            else dispatch({ type: 'send-demo', sessionId, expectedDraft: stateRef.current!.drafts[sessionId] });
          }}
          onDomainPurposeChange={(goalId, purpose, expectedPurpose) => dispatch({ type: 'edit-domain-note', goalId, purpose, expectedPurpose })}
          onGoalDraftChange={(goalId, field, value) => dispatch({ type: 'set-goal-draft', goalId, field, value })}
          onWorkCreate={(goalId, title) => dispatch({ type: 'add-work', goalId, title, roadmapColumn: 'suggested' })}
          onMemoryCommand={(command) => dispatch(command)}
          onThemeChange={(theme) => dispatch({ type: 'set-theme', theme })}
          onNexusViewChange={(view) => dispatch({ type: 'set-nexus-view', view })}
        />
      </div>
    </div>
  );
}
