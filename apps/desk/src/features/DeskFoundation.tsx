import type { NativeParticipantConfirmation } from '../adapters/native-participant-codec';
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { DeskRoute, DeskState, GoalDraftField, MemoryCommand, NexusView, ThemePreference } from '../domain/types';
import { snapWidth, type LayoutPreferences } from '../adapters/browser-layout';
import { Icon } from '../ui/Icon';
import { FolderIcon } from '../ui/FolderIcon';
import { folderIconChoices, type FolderIconName } from '../domain/folder-icons';
import { folderOptions as buildFolderOptions } from '../domain/folder-paths';
import { Modal } from '../ui/Modal';
import { ResizeHandle } from '../ui/ResizeHandle';
import { Navigation, type SessionRevealRequest } from './Navigation';
import type { ParticipantChoice } from '../domain/participant-choices';
import type { ParticipantIdentity } from '../domain/conversation-run-types';
import { Conversation } from './Conversation';
import { GoalPanel } from './GoalPanel';
import { Canvas, Atlas } from './NexusViews';
import { UserOptions } from './UserOptions';
import { NexusPrimitives } from './NexusPrimitives';
import { Data, Setup, Work, type SaveStatus } from './Modules';
import { HistoryReader } from './HistoryReader';
import { MemoryPage } from './MemoryPage';
import './workspace-layout.css';
import { useDeskRuntime } from '../app/runtime';

export interface DeskFoundationProps {
  state: DeskState; saveStatus: SaveStatus; theme: 'light' | 'dark'; readOnly?: boolean;
  onRouteChange: (route: DeskRoute) => void; onGoalSelect: (id: string) => void;
  onUngroupedSelect: () => void;
  onSessionSelect: (id: string) => void; onSessionCreate: (goalId: string | null) => void;
  onGoalCreate: (title: string, parentId: string | null) => void;
  onDomainRename: (domainId: string, title: string) => void;
  onSessionRename: (sessionId: string, title: string, expectedTitle?: string) => void;
  onDomainPin: (domainId: string, pinned: boolean) => void;
  onFolderIconChange: (domainId: string, icon: FolderIconName) => void;
  onSessionPin: (sessionId: string, pinned: boolean) => void;
  onSessionIntentDraftChange: (sessionId: string, text: string | null) => void;
  onSessionIntentChange: (sessionId: string, intent: string, expectedIntent?: string) => void;
  onSessionMove: (sessionId: string, goalId: string | null) => void;
  onDraftChange: (sessionId: string, value: string) => void; onSend: (sessionId: string) => void;
  runContent?: ReactNode; participantLabel?: string;
  participantChoices?: readonly ParticipantChoice[];
  participantChoiceError?: string;
  participantConfirmation?: NativeParticipantConfirmation;
  participantAvailabilityMessage?: string;
  participantAvailabilityChecking?: boolean;
  onParticipantPickerOpen?: () => void;
  onParticipantPickerClose?: () => void;
  onParticipantSelect?: (sessionId: string, participant: ParticipantIdentity) => void;
  participantBusy?: boolean; participantSendUnavailable?: boolean; participantSendBlockedReason?: string;
  onDomainPurposeChange: (goalId: string, purpose: string, expectedPurpose?: string) => void;
  onGoalDraftChange: (goalId: string, field: GoalDraftField, value: string | null) => void;
  onWorkCreate: (goalId: string, title: string) => void;
  onMemoryCommand: (command: MemoryCommand) => void;
  onThemeChange: (theme: ThemePreference) => void; onNexusViewChange: (view: NexusView) => void;
}

export function DeskFoundation(props: DeskFoundationProps) {
  const { state, saveStatus, theme, readOnly = false } = props;
  const runtime = useDeskRuntime();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [newDomainOpen, setNewDomainOpen] = useState(false);
  const [domainTitle, setDomainTitle] = useState('');
  const [parentId, setParentId] = useState<string | null>(null);
  const [rename, setRename] = useState<{ kind: 'domain' | 'session'; id: string; title: string; originalTitle: string; origin: HTMLElement; portalRoot: Element | null } | null>(null);
  const [renameError, setRenameError] = useState('');
  const [folderIconEdit, setFolderIconEdit] = useState<{ id: string; icon: FolderIconName; origin: HTMLElement } | null>(null);
  const [move, setMove] = useState<{ id: string; title: string; goalId: string | null; origin: HTMLElement } | null>(null);
  const [sessionRevealRequest, setSessionRevealRequest] = useState<SessionRevealRequest | null>(null);
  const sessionRevealToken = useRef(0);
  const [primitivesOpen, setPrimitivesOpen] = useState(false);
  const [noteRequest, setNoteRequest] = useState<{ goalId: string; token: number } | null>(null);
  const noteOrigin = useRef<HTMLElement | null>(null);
  const createOrigin = useRef<HTMLElement | null>(null);
  const [optionsPage, setOptionsPage] = useState<'help' | 'appearance' | 'user' | null>(null);
  const [historyReaderOpen, setHistoryReaderOpen] = useState(false);
  const [initialLayout] = useState(() => runtime.layout.load());
  const [layout, setLayout] = useState(initialLayout.preferences);
  const [layoutWarning, setLayoutWarning] = useState(initialLayout.warning);
  const [railRevealed, setRailRevealed] = useState(false);
  const railMenuOpen = useRef(false);
  const rail = useRef<HTMLElement>(null);
  const edge = useRef<HTMLButtonElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth);
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 1199px)').matches);
  const [inspectorOpen, setInspectorOpen] = useState(() => !window.matchMedia('(max-width: 1199px)').matches);
  const goal = state.goals.find((item) => item.id === state.selection.goalId);
  const session = state.sessions.find((item) => item.id === state.selection.sessionId);
  // Labels expose the recorded ancestry; option values remain the original IDs.
  const folderOptions = buildFolderOptions(state.goals);
  const messages = state.messages.filter((item) => item.sessionId === session?.id);
  const purposeDraft = goal ? (state.goalDrafts[goal.id]?.purpose ?? null) : null;
  // Earlier tab choices saved Roadmap as a separate module. Read that choice
  // inside Nexus without repairing or rewriting the saved workspace.
  const nexusActive = state.selection.route === 'sessions' || state.selection.route === 'work';
  const nexusView = state.selection.route === 'work' ? 'roadmap' : state.preferences.nexusView ?? 'navigator';
  const roadmapActive = nexusActive && nexusView === 'roadmap';
  const expandedRail = layout.mode === 'expanded' || railRevealed;
  const railSlot = expandedRail ? layout.railWidth : layout.mode === 'hidden' ? 0 : 64;
  const inspectorMax = Math.max(220, Math.min(1100, workspaceWidth - railSlot - 360));
  const inspectorWidth = Math.min(layout.inspectorWidth, inspectorMax);
  const detailsAvailable = state.selection.route === 'sessions' && nexusView === 'navigator';
  const desktopDetails = detailsAvailable && inspectorOpen && !narrow;
  const changeLayout = (value: Partial<LayoutPreferences>) => {
    const next = { ...layout, ...value };
    setLayout(next);
    setLayoutWarning(runtime.layout.save(next));
    if (value.mode) setRailRevealed(false);
  };
  const openDomain = (id: string) => { props.onGoalSelect(id); props.onRouteChange('sessions'); props.onNexusViewChange('navigator'); };
  const restoreFocus = (origin: HTMLElement | null, fallback?: string) => {
    if (origin && rail.current?.contains(origin) && (layout.mode === 'hover' || layout.mode === 'hidden')) setRailRevealed(true);
    const focus = (retry: boolean) => {
      const visible = (element: HTMLElement | null) => element?.isConnected && element.getClientRects().length > 0
        && !element.closest('[inert]') && !element.matches(':disabled, [aria-disabled="true"]');
      const replacement = fallback ? document.querySelector<HTMLElement>(fallback) : null;
      const target = visible(origin) ? origin : visible(replacement) ? replacement : null;
      const parentDialog = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
        .reverse().find((element) => visible(element));
      // Editing state can mount a fallback control after its form closes.
      if (!target && retry && fallback) requestAnimationFrame(() => focus(false));
      else (target ?? parentDialog ?? document.getElementById('desk-main'))?.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => focus(true));
  };
  const openRename = (domainId: string, origin: HTMLElement) => {
    const domain = state.goals.find((item) => item.id === domainId);
    if (readOnly || !domain) return;
    // Keep the host for this editor's lifetime. An external fullscreen exit
    // changes Canvas classes; moving its portal would replace the focused form.
    setRename({ kind: 'domain', id: domain.id, title: domain.title, originalTitle: domain.title, origin,
      portalRoot: origin.closest('.nexus-canvas.canvas-expanded') });
    setRenameError('');
  };
  const openSessionRename = (sessionId: string, origin: HTMLElement) => {
    const item = state.sessions.find((value) => value.id === sessionId);
    if (readOnly || !item) return;
    setRename({ kind: 'session', id: item.id, title: item.title, originalTitle: item.title, origin,
      portalRoot: origin.closest('.nexus-canvas.canvas-expanded') });
    setRenameError('');
  };
  const closeRename = () => {
    const origin = rename?.origin;
    setRename(null);
    restoreFocus(origin ?? null);
  };
  const closeMove = () => { const origin = move?.origin; const id = move?.id; setMove(null); restoreFocus(origin ?? null, id ? `[data-session-id="${CSS.escape(id)}"]` : undefined); };
  const completeSessionMove = (sessionId: string, goalId: string | null) => {
    if (readOnly || !state.sessions.some((item) => item.id === sessionId)) return;
    props.onSessionMove(sessionId, goalId);
    if (window.matchMedia('(min-width: 1000px)').matches) {
      if (layout.mode === 'hover' || layout.mode === 'hidden') setRailRevealed(true);
      setSessionRevealRequest({ sessionId, goalId, token: ++sessionRevealToken.current });
    } else restoreFocus(null, '.mobile-menu');
  };
  const finishMove = () => {
    if (readOnly || !move) return;
    completeSessionMove(move.id, move.goalId);
    setMove(null);
  };
  const closeFolderIcon = () => { const origin = folderIconEdit?.origin ?? null; setFolderIconEdit(null); restoreFocus(origin); };
  const onRailMenuOpenChange = (open: boolean) => {
    railMenuOpen.current = open;
    if (layout.mode !== 'hover' && layout.mode !== 'hidden') return;
    if (open) setRailRevealed(true);
    else requestAnimationFrame(() => {
      if (!railMenuOpen.current && !document.querySelector('[role="dialog"][aria-modal="true"]')
        && !rail.current?.contains(document.activeElement) && !rail.current?.matches(':hover')) setRailRevealed(false);
    });
  };
  const closeNewDomain = () => { setNewDomainOpen(false); restoreFocus(createOrigin.current); createOrigin.current = null; };
  const openDomainNote = (domainId: string, origin: HTMLElement) => {
    const domain = state.goals.find((item) => item.id === domainId);
    if (readOnly || !domain) return;
    openDomain(domainId);
    noteOrigin.current = origin;
    setNoteRequest({ goalId: domainId, token: Date.now() });
    setNavigationOpen(false);
    setInspectorOpen(true);
  };
  const closeDomainNote = () => {
    restoreFocus(narrow ? null : noteOrigin.current, narrow
      ? '.modal[aria-label="Session details"] button[aria-label="Edit domain note"]'
      : '#workspace-details button[aria-label="Edit domain note"]');
    noteOrigin.current = null;
    setNoteRequest(null);
  };
  const onPurposeDraftChange = (goalId: string, value: string | null) => props.onGoalDraftChange(goalId, 'purpose', value);
  useEffect(() => {
    if (!workspace.current) return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width));
    observer.observe(workspace.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const resize = () => {
      if (window.matchMedia('(min-width: 1000px)').matches) setNavigationOpen(false);
      const next = window.matchMedia('(max-width: 1199px)').matches;
      setNarrow((previous) => { if (previous !== next) setInspectorOpen(!next); return next; });
    };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.code !== 'Backslash') return;
      if (document.querySelector('[role="dialog"], dialog[open]')) return;
      event.preventDefault();
      if (layout.mode === 'hover' || layout.mode === 'hidden') {
        if (railRevealed) { setRailRevealed(false); document.getElementById('desk-main')?.focus(); }
        else { setRailRevealed(true); requestAnimationFrame(() => rail.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })); }
      } else changeLayout({ mode: layout.mode === 'expanded' ? 'icons' : 'expanded' });
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [layout, railRevealed]);
  useEffect(() => {
    if (!railRevealed || (layout.mode !== 'hover' && layout.mode !== 'hidden')) return;
    const outside = (event: PointerEvent) => {
      if (railMenuOpen.current || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const bounds = rail.current?.getBoundingClientRect();
      // Opening motion must not treat a pointer headed into the full rail as
      // outside simply because its visible edge has not reached that point yet.
      if (bounds && (event.clientX < 0 || event.clientX > layout.railWidth || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
        setRailRevealed(false);
        if (rail.current?.contains(document.activeElement)) document.getElementById('desk-main')?.focus();
      }
    };
    document.addEventListener('pointermove', outside);
    return () => document.removeEventListener('pointermove', outside);
  }, [layout.mode, layout.railWidth, railRevealed]);
  const navigationProps = {
    state, readOnly,
    onRouteChange: (route: DeskRoute) => {
      if (route === 'sessions' && state.selection.route === 'work') props.onNexusViewChange('roadmap');
      else props.onRouteChange(route);
      setNavigationOpen(false);
    },
    onGoalSelect: (id: string) => { props.onGoalSelect(id); setNavigationOpen(false); },
    onUngroupedSelect: () => { props.onUngroupedSelect(); setNavigationOpen(false); },
    onSessionSelect: (id: string) => { props.onSessionSelect(id); setNavigationOpen(false); },
    onSessionCreate: (goalId: string | null) => { props.onSessionCreate(goalId); setNavigationOpen(false); },
    onDomainRenameRequest: openRename,
    onFolderIconRequest: (domainId: string, origin: HTMLElement) => {
      const item = state.goals.find((value) => value.id === domainId);
      if (!readOnly && item) setFolderIconEdit({ id: item.id, icon: item.icon ?? 'default', origin });
    },
    onSessionDrop: completeSessionMove,
    onSessionRenameRequest: openSessionRename,
    onDomainPin: props.onDomainPin,
    onSessionPin: props.onSessionPin,
    onDomainNoteRequest: openDomainNote,
    onSessionMoveRequest: (sessionId: string, origin: HTMLElement) => {
      const selected = state.sessions.find((item) => item.id === sessionId);
      if (readOnly || !selected) return;
      setMove({ id: selected.id, title: selected.title, goalId: selected.goalId, origin });
      setNavigationOpen(false);
    },
    onDomainCreate: (parent: string | null, origin?: HTMLElement) => { createOrigin.current = origin ?? null; setParentId(parent); setDomainTitle(''); setNewDomainOpen(true); setNavigationOpen(false); },
    onOptions: (page: 'help' | 'appearance' | 'user') => { setOptionsPage(page); setNavigationOpen(false); },
  };
  const routeTitle = nexusActive
    ? nexusView === 'navigator' ? 'Nexus Navigator' : nexusView === 'canvas' ? 'Cloudwork Canvas' : nexusView === 'atlas' ? 'Cloudwork Atlas' : 'Roadmap'
    : state.selection.route === 'memory' ? 'CONTINUITY'
      : state.selection.route === 'setup' ? 'Workspace setup' : 'DATA';
  const moduleTitle = state.selection.route === 'memory' ? 'Cloudwork Continuity' : 'Cloudwork Data';
  const panelProps = {
    goal, session, sessions: state.sessions, activity: state.activity,
    onSessionSelect: props.onSessionSelect,
    purposeDraft, onPurposeDraftChange, onPurposeChange: props.onDomainPurposeChange,
    editPurposeRequest: noteRequest, onPurposeEditClose: closeDomainNote,
    onSessionIntentDraftChange: props.onSessionIntentDraftChange,
    onSessionIntentChange: props.onSessionIntentChange,
    onSessionRename: openSessionRename, onSessionPin: props.onSessionPin, readOnly,
  };
  return (
    <div className="desk-foundation" data-theme={theme}>
      <a className="skip-link" href="#desk-main">Skip to main content</a>
      <div className="cloud-banner"><span className="cloud-banner-dot" /><span>{runtime.mode === 'native-proof' ? 'Native join proof · invented data only' : 'Sample preview · sample data only'}</span><span className="cloud-banner-note">A foundation you can try.</span></div>
      <div ref={workspace} className={`desk-layout rail-${layout.mode}${railRevealed ? ' rail-revealed' : ''}${desktopDetails ? ' details-visible' : ''}`} style={{
        '--rail-width': `${layout.railWidth}px`, '--rail-slot': `${railSlot}px`,
        '--inspector-width': `${inspectorWidth}px`,
      } as CSSProperties}>
        <button ref={edge} type="button" className="rail-edge" aria-label="Reveal navigation" title="Reveal navigation"
          onMouseEnter={() => layout.mode === 'hidden' && setRailRevealed(true)}
          onMouseLeave={(event) => {
            const bounds = rail.current?.getBoundingClientRect();
            if (layout.mode === 'hidden' && !railMenuOpen.current && !document.querySelector('[role="dialog"][aria-modal="true"]') && bounds && (event.clientX > layout.railWidth || event.clientY < bounds.top || event.clientY > bounds.bottom)) setRailRevealed(false);
          }}
          onFocus={() => layout.mode === 'hidden' && setRailRevealed(true)}
          onClick={() => { setRailRevealed(true); requestAnimationFrame(() => rail.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })); }} />
        <aside ref={rail} className="desktop-navigation" aria-label="Navigation rail" inert={layout.mode === 'hidden' && !railRevealed}
          onMouseEnter={() => (layout.mode === 'hover' || layout.mode === 'hidden') && setRailRevealed(true)}
          onMouseLeave={(event) => {
            const bounds = rail.current?.getBoundingClientRect();
            const outside = !event.relatedTarget || bounds && (event.clientX < 0 || event.clientX > layout.railWidth || event.clientY < bounds.top || event.clientY > bounds.bottom);
            if (outside && (layout.mode === 'hover' || layout.mode === 'hidden') && !railMenuOpen.current && !document.querySelector('[role="dialog"][aria-modal="true"]')) { setRailRevealed(false); if (rail.current?.contains(document.activeElement)) document.getElementById('desk-main')?.focus(); }
          }}
          onFocus={() => (layout.mode === 'hover' || layout.mode === 'hidden') && setRailRevealed(true)}
          onBlur={(event) => { if ((layout.mode === 'hover' || layout.mode === 'hidden') && !railMenuOpen.current && !document.querySelector('[role="dialog"][aria-modal="true"]') && !event.currentTarget.contains(event.relatedTarget as Node | null) && !event.currentTarget.matches(':hover')) setRailRevealed(false); }}
          onKeyDown={(event) => { if (event.key === 'Escape' && (layout.mode === 'hover' || layout.mode === 'hidden')) { setRailRevealed(false); document.getElementById('desk-main')?.focus(); } }}>
          <div className="navigation-viewport">
            <Navigation {...navigationProps} compact={layout.mode !== 'hidden' && !expandedRail} onMenuOpenChange={onRailMenuOpenChange}
              sessionRevealRequest={sessionRevealRequest} onSessionRevealComplete={(token) => setSessionRevealRequest((request) => request?.token === token ? null : request)}
              onRailToggle={() => changeLayout({ mode: expandedRail ? 'icons' : 'expanded' })} />
          </div>
          {expandedRail && <ResizeHandle label="Navigation width" value={layout.railWidth} min={200} max={400}
            onChange={(width) => changeLayout({ railWidth: snapWidth(width, 200, 400, [220, 260, 300, 340, 380]) })} />}
        </aside>
        <div className="desk-main-column">
          <header className="desk-header">
            <div className="desk-heading">
              <button type="button" className="icon-button mobile-menu" onClick={() => setNavigationOpen(true)} aria-label="Open navigation" aria-haspopup="dialog" aria-expanded={navigationOpen}><Icon name="menu" size={21} /></button>
              <div>{!nexusActive && <span className="primary-module-heading">{moduleTitle}</span>}
                <h1 className="sr-only">{routeTitle}</h1>
                {nexusActive && <nav className="nexus-view-tabs" aria-label="Nexus views">
                  {(['navigator', 'canvas', 'atlas', 'roadmap'] as const).map((view) => <button type="button" key={view} aria-current={view === nexusView ? 'page' : undefined}
                    className={view === nexusView ? 'selected' : ''} onClick={() => props.onNexusViewChange(view)}>
                    <Icon name={view === 'navigator' ? 'folder' : view === 'roadmap' ? 'work' : view} size={20} />
                    {view === 'navigator' ? 'Nexus Navigator' : view === 'canvas' ? 'Cloudwork Canvas' : view === 'atlas' ? 'Cloudwork Atlas' : 'Roadmap'}
                  </button>)}
                </nav>}
              </div>
            </div>
            <div className="workspace-header-tools">
              {nexusActive && <button type="button" className="text-button primitives-trigger" onClick={() => setPrimitivesOpen(true)}>Work primitives</button>}
              <button type="button" className="icon-button right-rail-toggle" disabled={!detailsAvailable}
                aria-label={detailsAvailable ? inspectorOpen ? 'Hide session details' : 'Show session details' : 'Details rail available in Navigator'}
                title={detailsAvailable ? inspectorOpen ? 'Hide session details' : 'Show session details' : 'Details rail available in Navigator'}
                aria-expanded={detailsAvailable && inspectorOpen} aria-controls={!narrow && detailsAvailable && inspectorOpen ? 'workspace-details' : undefined}
                onClick={() => setInspectorOpen((value) => !value)}><Icon name={detailsAvailable && inspectorOpen ? 'rail-open' : 'rail-closed'} size={18} /></button>
            </div>
          </header>
          <div className={`save-status status-${saveStatus.kind}`} role={saveStatus.kind === 'error' || saveStatus.kind === 'memory' ? 'alert' : 'status'}>
            {saveStatus.kind === 'saved' ? <Icon name="check" size={13} /> : <span className="save-dot" />}
            <span>{saveStatus.message}</span><span className="save-qualifier">{runtime.mode === 'native-proof' ? 'Private use unavailable · auxiliary settings last for this visit' : 'Unencrypted sample workspace'}</span>
          </div>
          {layoutWarning && <p role="status" className="layout-warning">{layoutWarning}</p>}
          <main id="desk-main" tabIndex={-1} className={`desk-main route-${state.selection.route}`}>
            {state.selection.route === 'sessions' && nexusView === 'navigator' && <div className="conversation-layout">
              {session ? <Conversation goal={goal} session={session} messages={messages} draft={state.drafts[session.id] ?? ''}
                onDraftChange={props.onDraftChange} onSend={props.onSend} readOnly={readOnly}
                runContent={props.runContent} participantLabel={props.participantLabel}
                participantChoices={props.participantChoices} onParticipantSelect={props.onParticipantSelect}
                participantChoiceError={props.participantChoiceError} participantConfirmation={props.participantConfirmation}
                participantAvailabilityMessage={props.participantAvailabilityMessage}
                participantAvailabilityChecking={props.participantAvailabilityChecking}
                onParticipantPickerOpen={props.onParticipantPickerOpen} onParticipantPickerClose={props.onParticipantPickerClose}
                participantBusy={props.participantBusy} participantSendUnavailable={props.participantSendUnavailable}
                participantSendBlockedReason={props.participantSendBlockedReason} />
                : <section className="navigator-empty"><FolderIcon name={goal?.icon} size={32} /><span className="eyebrow">SESSION FOLDER</span>
                  <div className="navigator-domain-heading"><h2>{goal?.title ?? 'Ungrouped sessions'}</h2>
                    {goal && <button type="button" className="icon-button domain-title-rename" aria-label="Rename folder" title="Rename folder" disabled={readOnly}
                      onClick={(event) => openRename(goal.id, event.currentTarget)}><Icon name="edit" size={19} /></button>}
                  </div>
                  <p>A folder can hold a goal, a topic, or a group of ideas. Start its first session when you are ready.</p>
                  <button type="button" className="primary-button" disabled={readOnly} onClick={() => props.onSessionCreate(goal?.id ?? null)}><Icon name="plus" size={16} />New session</button>
                </section>}
            </div>}
            {state.selection.route === 'sessions' && nexusView === 'canvas' && <Canvas state={state} onDomain={openDomain} onSession={props.onSessionSelect}
              onDomainRenameRequest={openRename} onSessionRenameRequest={openSessionRename} />}
            {state.selection.route === 'sessions' && nexusView === 'atlas' && <Atlas state={state} onDomain={openDomain} onSession={props.onSessionSelect} />}
            <div className="work-module-mount" hidden={!roadmapActive}>
              <Work state={state} active={roadmapActive} onWorkCreate={props.onWorkCreate} onDraftChange={(goalId, value) => props.onGoalDraftChange(goalId, 'workTitle', value)} readOnly={readOnly} />
            </div>
            {state.selection.route === 'memory' && <MemoryPage state={state} onCommand={props.onMemoryCommand} readOnly={readOnly} createId={runtime.createId} storageMode={runtime.mode} />}
            {state.selection.route === 'data' && <Data saveStatus={saveStatus} onSetup={() => props.onRouteChange('setup')} onReadHistory={runtime.mode === 'browser' ? () => setHistoryReaderOpen(true) : undefined} />}
            {state.selection.route === 'setup' && <Setup onReturn={() => props.onRouteChange('sessions')} />}
          </main>
        </div>
        {desktopDetails && <div id="workspace-details" className="inspector-column workspace-details">
          <ResizeHandle label="Session details width" value={inspectorWidth} min={220} max={inspectorMax} direction={-1}
            onChange={(width) => changeLayout({ inspectorWidth: snapWidth(width, 220, inspectorMax, [240, 294, 340, 420, 480, 640, 800, 960]) })} />
          <GoalPanel {...panelProps} />
        </div>}
      </div>
      {navigationOpen && <Modal title="Navigation" drawer onClose={() => { setNavigationOpen(false); restoreFocus(null, '.mobile-menu'); }}><Navigation {...navigationProps} idPrefix="drawer" /></Modal>}
      {runtime.mode === 'browser' && historyReaderOpen && <HistoryReader onClose={() => setHistoryReaderOpen(false)} />}
      {inspectorOpen && narrow && detailsAvailable && <Modal title="Session details" onClose={() => { setInspectorOpen(false); restoreFocus(null, '.right-rail-toggle'); }}>
        <GoalPanel {...panelProps} />
      </Modal>}
      {primitivesOpen && <NexusPrimitives onClose={() => setPrimitivesOpen(false)} onOpenRoadmap={() => { setPrimitivesOpen(false); props.onNexusViewChange('roadmap'); }} />}
      {newDomainOpen && <Modal title="Create folder" onClose={closeNewDomain}>
        <form className="new-goal-form" onSubmit={(event) => { event.preventDefault(); if (!readOnly && domainTitle.trim()) { props.onGoalCreate(domainTitle.trim(), parentId); closeNewDomain(); } }}>
          <p>Name a topic, project, goal or area of interest. A folder can start empty and take shape later.</p>
          <label htmlFor="new-domain-title">Folder name</label><input id="new-domain-title" data-autofocus value={domainTitle} onChange={(event) => setDomainTitle(event.target.value)} placeholder="e.g. Weekend ideas" maxLength={180} required disabled={readOnly} />
          <label htmlFor="domain-parent">Inside</label><select id="domain-parent" value={parentId ?? ''} onChange={(event) => setParentId(event.target.value || null)} disabled={readOnly}>
            <option value="">Top level</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
          </select>
          <div className="modal-actions"><button type="button" className="text-button" onClick={closeNewDomain}>Cancel</button>
            <button type="submit" className="primary-button" disabled={readOnly || !domainTitle.trim()}>Create folder<Icon name="arrow" size={17} /></button></div>
        </form>
      </Modal>}
      {move && <Modal title="Move session" onClose={closeMove}>
        <form className="new-goal-form" onSubmit={(event) => { event.preventDefault(); finishMove(); }}>
          <p>Choose where to keep “{move.title}”. Its messages and unfinished draft stay with the session.</p>
          <label htmlFor="move-session-domain">Move to folder</label>
          <select id="move-session-domain" data-autofocus value={move.goalId ?? ''} disabled={readOnly} onChange={(event) => setMove({ ...move, goalId: event.target.value || null })}>
            <option value="">Ungrouped sessions</option>{folderOptions.map((folder) => <option key={folder.id} value={folder.id}>{folder.label}</option>)}
          </select>
          <div className="modal-actions"><button type="button" className="text-button" onClick={closeMove}>Cancel</button><button type="submit" className="primary-button" disabled={readOnly}>Move session<Icon name="folder" size={16} /></button></div>
        </form>
      </Modal>}
      {rename && <Modal title={rename.kind === 'domain' ? 'Rename folder' : 'Rename session'} onClose={closeRename}
        portalRoot={rename.portalRoot}>
        <form className="new-goal-form" onSubmit={(event) => {
          event.preventDefault();
          const title = rename.title.trim();
          if (!title || title.length > 180) { setRenameError(`Use a ${rename.kind === 'domain' ? 'folder' : 'session'} name from 1 to 180 characters.`); return; }
          if (!readOnly) {
            if (rename.kind === 'domain') props.onDomainRename(rename.id, title);
            else props.onSessionRename(rename.id, title, rename.originalTitle);
            closeRename();
          }
        }}>
          <label htmlFor="rename-domain-title">{rename.kind === 'domain' ? 'Folder name' : 'Session name'}</label>
          <input id="rename-domain-title" data-autofocus value={rename.title} disabled={readOnly}
            aria-invalid={Boolean(renameError)} aria-describedby="rename-domain-help"
            onChange={(event) => { setRename({ ...rename, title: event.target.value }); setRenameError(''); }} />
          <p id="rename-domain-help" className="domain-name-help">Use 1–180 characters.</p>
          {renameError && <p role="alert" className="domain-name-error">{renameError}</p>}
          <div className="modal-actions"><button type="button" className="text-button" onClick={closeRename}>Cancel</button>
            <button type="submit" className="primary-button" disabled={readOnly}>Save name<Icon name="check" size={16} /></button></div>
        </form>
      </Modal>}
      {folderIconEdit && <Modal title="Folder icon" onClose={closeFolderIcon}>
        <form className="folder-icon-form" onSubmit={(event) => {
          event.preventDefault();
          if (readOnly || !state.goals.some((item) => item.id === folderIconEdit.id)) return;
          props.onFolderIconChange(folderIconEdit.id, folderIconEdit.icon); closeFolderIcon();
        }}>
          <fieldset><legend>Choose an icon</legend><div className="folder-icon-choices">
            {folderIconChoices.map((choice) => <label key={choice.value} className={folderIconEdit.icon === choice.value ? 'selected' : ''}>
              <input type="radio" name="folder-icon" value={choice.value} checked={folderIconEdit.icon === choice.value} disabled={readOnly}
                onChange={() => setFolderIconEdit({ ...folderIconEdit, icon: choice.value })} />
              <FolderIcon name={choice.value} size={24} /><span>{choice.label}</span>
            </label>)}
          </div></fieldset>
          <p className="small muted">Additional icons by Lucide, used under the ISC license.</p>
          <div className="modal-actions"><button type="button" className="text-button" onClick={closeFolderIcon}>Cancel</button>
            <button type="submit" className="primary-button" disabled={readOnly}>Save icon<Icon name="check" size={16} /></button></div>
        </form>
      </Modal>}
      {optionsPage && <UserOptions page={optionsPage} layout={layout} theme={state.preferences.theme} onTheme={props.onThemeChange} onLayout={changeLayout} warning={layoutWarning} onNavigate={setOptionsPage}
        onClose={() => { setOptionsPage(null); if (layout.mode === 'hidden') { setRailRevealed(false); requestAnimationFrame(() => document.getElementById('desk-main')?.focus()); } }} />}
    </div>
  );
}
