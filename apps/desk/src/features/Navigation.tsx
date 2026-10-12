import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DeskRoute, DeskState, Goal } from '../domain/types';
import { EmberMark, Icon, type IconName } from '../ui/Icon';
import { useBrowserIdentity } from './useBrowserIdentity';
import { FolderIcon } from '../ui/FolderIcon';

type RowMenu = { kind: 'domain' | 'session'; id: string; title: string; x: number; y: number; origin: HTMLElement };
export type SessionRevealRequest = { sessionId: string; goalId: string | null; token: number };

const routes: { route: DeskRoute; label: string; icon: IconName }[] = [
  { route: 'sessions', label: 'Cloudwork Nexus', icon: 'desk' },
  { route: 'memory', label: 'CONTINUITY', icon: 'memory' },
  { route: 'data', label: 'DATA', icon: 'data' },
];

export function Navigation({ state, onRouteChange, onGoalSelect, onSessionSelect,
  onSessionCreate, onDomainCreate, onDomainRenameRequest, onDomainNoteRequest, onFolderIconRequest, onSessionDrop, onSessionRenameRequest, onSessionMoveRequest, onDomainPin, onSessionPin, onUngroupedSelect, onOptions, compact = false, onRailToggle,
  readOnly = false, idPrefix = 'desktop', onMenuOpenChange, sessionRevealRequest, onSessionRevealComplete,
}: {
  state: DeskState; onRouteChange: (route: DeskRoute) => void;
  onGoalSelect: (id: string) => void; onSessionSelect: (id: string) => void;
  onSessionCreate: (goalId: string | null) => void;
  onDomainCreate: (parentId: string | null, origin?: HTMLElement) => void;
  onDomainRenameRequest: (domainId: string, origin: HTMLElement) => void;
  onDomainNoteRequest?: (domainId: string, origin: HTMLElement) => void;
  onFolderIconRequest: (domainId: string, origin: HTMLElement) => void;
  onSessionDrop: (sessionId: string, goalId: string | null) => void;
  onSessionRenameRequest: (sessionId: string, origin: HTMLElement) => void;
  onSessionMoveRequest: (sessionId: string, origin: HTMLElement) => void;
  onDomainPin: (domainId: string, pinned: boolean) => void;
  onSessionPin: (sessionId: string, pinned: boolean) => void;
  onUngroupedSelect: () => void;
  onOptions: (page: 'help' | 'appearance' | 'user') => void;
  onMenuOpenChange?: (open: boolean) => void;
  sessionRevealRequest?: SessionRevealRequest | null;
  onSessionRevealComplete?: (token: number) => void;
  compact?: boolean; onRailToggle?: () => void; readOnly?: boolean; idPrefix?: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [ungroupedOpen, setUngroupedOpen] = useState(true);
  const { preferences: identity } = useBrowserIdentity();
  const [menu, setMenu] = useState<RowMenu | null>(null);
  const draggingSession = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const sessionMime = 'application/x-true-convo-session';
  const clearDrag = () => { draggingSession.current = null; setDropTarget(null); };
  const validDrag = () => !readOnly && Boolean(draggingSession.current && state.sessions.some((item) => item.id === draggingSession.current));
  const allowDrop = (event: DragEvent<HTMLDivElement>, goalId: string | null) => {
    if (!validDrag()) return;
    event.preventDefault(); event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget(goalId ?? 'ungrouped');
  };
  const dropSession = (event: DragEvent<HTMLDivElement>, goalId: string | null) => {
    const id = draggingSession.current;
    if (!validDrag() || !id || event.dataTransfer.getData(sessionMime) !== id) { clearDrag(); return; }
    event.preventDefault(); event.stopPropagation();
    clearDrag();
    if (goalId !== null && !state.goals.some((item) => item.id === goalId)) return;
    onSessionDrop(id, goalId);
  };
  const menuElement = useRef<HTMLDivElement>(null);
  const navigationElement = useRef<HTMLDivElement>(null);
  const menuOpenCallback = useRef(onMenuOpenChange);
  menuOpenCallback.current = onMenuOpenChange;
  const revealCompleteCallback = useRef(onSessionRevealComplete);
  revealCompleteCallback.current = onSessionRevealComplete;
  const [revealedSessionToken, setRevealedSessionToken] = useState<number | null>(null);
  const closeMenu = (restoreFocus = true) => {
    setMenu(null);
    if (restoreFocus && menu?.origin.isConnected) menu.origin.focus({ preventScroll: true });
  };
  const showMenu = (kind: RowMenu['kind'], id: string, title: string, origin: HTMLElement, point?: { x: number; y: number }) => {
    const bounds = origin.getBoundingClientRect();
    const itemCount = kind === 'domain' ? 4 + Number(Boolean(onDomainNoteRequest)) : 4;
    setMenu({ kind, id, title, origin, x: Math.max(8, Math.min(point?.x ?? bounds.left, window.innerWidth - 208)),
      y: Math.max(8, Math.min(point?.y ?? bounds.bottom, window.innerHeight - (10 + itemCount * 42))) });
  };
  const contextMenu = (event: MouseEvent<HTMLDivElement>, kind: RowMenu['kind'], id: string, title: string) => {
    event.preventDefault();
    const origin = event.target instanceof Element ? event.target.closest<HTMLElement>('button') : null;
    showMenu(kind, id, title, origin ?? event.currentTarget.querySelector<HTMLElement>('.domain-link, .session-link')!, { x: event.clientX, y: event.clientY });
  };
  const keyboardMenu = (event: KeyboardEvent<HTMLDivElement>, kind: RowMenu['kind'], id: string, title: string) => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = event.target instanceof HTMLElement ? event.target : event.currentTarget.querySelector<HTMLElement>('button')!;
    showMenu(kind, id, title, origin);
  };
  useEffect(() => {
    if (!menu) return;
    menuOpenCallback.current?.(true);
    (menuElement.current?.querySelector<HTMLElement>('button:not([disabled])') ?? menuElement.current)?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menuElement.current?.contains(event.target as Node) && !menu.origin.contains(event.target as Node)) setMenu(null);
    };
    const dismiss = () => setMenu(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      menuOpenCallback.current?.(false);
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, [menu]);
  const expandDomainPath = (goalId: string) => setExpanded((value) => {
    const next = { ...value };
    let changed = false;
    let current: string | null = goalId;
    while (current) {
      if (next[current] !== true) { next[current] = true; changed = true; }
      current = state.goals.find((goal) => goal.id === current)?.parentId ?? null;
    }
    return changed ? next : value;
  });
  useEffect(() => {
    if (state.selection.goalId) expandDomainPath(state.selection.goalId);
    else if (state.selection.sessionId) setUngroupedOpen(true);
  }, [state.selection.goalId, state.selection.sessionId]);
  useEffect(() => {
    if (!sessionRevealRequest) return;
    const session = state.sessions.find((item) => item.id === sessionRevealRequest.sessionId);
    if (!session || session.goalId !== sessionRevealRequest.goalId) return;
    if (session.goalId) expandDomainPath(session.goalId);
    else setUngroupedOpen(true);
    setRevealedSessionToken(sessionRevealRequest.token);
  }, [sessionRevealRequest, state.sessions]);
  useEffect(() => {
    if (!sessionRevealRequest || revealedSessionToken !== sessionRevealRequest.token) return;
    const row = navigationElement.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(sessionRevealRequest.sessionId)}"]`);
    if (!row?.getClientRects().length || row.closest('[inert]')) return;
    row.focus();
    revealCompleteCallback.current?.(sessionRevealRequest.token);
  }, [sessionRevealRequest, revealedSessionToken, expanded, ungroupedOpen, compact]);
  const isOpen = (goal: Goal) => expanded[goal.id] ?? true;
  const unassigned = state.sessions.filter((session) => session.goalId === null);
  const menuRecord = !menu ? null : menu.kind === 'domain' ? state.goals.find((item) => item.id === menu.id) : state.sessions.find((item) => item.id === menu.id);
  const sessionButton = (session: DeskState['sessions'][number]) => (
    <div className="session-row" key={session.id}
      onContextMenu={(event) => contextMenu(event, 'session', session.id, session.title)}
      onKeyDown={(event) => keyboardMenu(event, 'session', session.id, session.title)}>
    <button type="button" title={session.title} aria-label={session.title} data-session-id={session.id}
      className={`session-link${state.selection.sessionId === session.id ? ' selected' : ''}`}
      draggable={!readOnly && !compact}
      onDragStart={(event) => {
        if (readOnly || compact) return event.preventDefault();
        setMenu(null); draggingSession.current = session.id;
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(sessionMime, session.id);
      }}
      onDragEnd={clearDrag}
      aria-current={state.selection.sessionId === session.id ? 'true' : undefined}
      onClick={() => onSessionSelect(session.id)}
      onDoubleClick={(event) => { if (!readOnly && !compact) onSessionRenameRequest(session.id, event.currentTarget); }}>
      <span className="session-mark" /><span>{session.title}</span>
    </button>
    <button type="button" className="icon-button row-pin-trigger" aria-label={`${session.pinned ? 'Unpin' : 'Pin'} session ${session.title}`}
      title={`${session.pinned ? 'Unpin' : 'Pin'} session`} aria-pressed={Boolean(session.pinned)} disabled={readOnly}
      onClick={() => onSessionPin(session.id, !session.pinned)}><Icon name={session.pinned ? 'pin-filled' : 'pin'} size={14} /></button>
    <button type="button" className="icon-button row-menu-trigger session-menu-trigger" aria-label={`Session options for ${session.title}`}
      title={`Session options for ${session.title}`} aria-haspopup="menu" aria-expanded={menu?.kind === 'session' && menu.id === session.id}
      onClick={(event) => menu?.kind === 'session' && menu.id === session.id ? closeMenu() : showMenu('session', session.id, session.title, event.currentTarget)}><Icon name="ellipsis" size={15} /></button>
    </div>
  );
  const folders = (parentId: string | null): ReactNode => (
    <ul className="domain-tree">
      {state.goals.filter((goal) => (goal.parentId ?? null) === parentId).map((goal) => (
        <li key={goal.id}>
          <div className={`domain-row${state.selection.goalId === goal.id ? ' selected' : ''}${dropTarget === goal.id ? ' session-drop-target' : ''}`}
            data-drop-goal-id={goal.id}
            onDragOver={(event) => allowDrop(event, goal.id)}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
            onDrop={(event) => dropSession(event, goal.id)}
            onContextMenu={(event) => contextMenu(event, 'domain', goal.id, goal.title)}
            onKeyDown={(event) => keyboardMenu(event, 'domain', goal.id, goal.title)}>
            <button type="button" className="icon-button folder-disclosure"
              aria-label={`${isOpen(goal) ? 'Collapse' : 'Expand'} ${goal.title} folder`}
              aria-expanded={isOpen(goal)} aria-controls={`${idPrefix}-domain-${goal.id}`}
              onClick={() => setExpanded((value) => ({ ...value, [goal.id]: !isOpen(goal) }))}>
              <Icon name="chevron" size={13} />
            </button>
            <button type="button" className="domain-link" title={goal.title} aria-label={goal.title} data-domain-id={goal.id}
              aria-current={state.selection.goalId === goal.id ? 'true' : undefined}
              onClick={() => { onGoalSelect(goal.id); setExpanded((value) => ({ ...value, [goal.id]: true })); }}
              onDoubleClick={(event) => { if (!readOnly && !compact) onDomainRenameRequest(goal.id, event.currentTarget); }}>
              <FolderIcon name={goal.icon} /><span>{goal.title}</span>
            </button>
            <button className="icon-button folder-add" type="button"
              title="Create session" aria-label={`Create session in ${goal.title}`}
              disabled={readOnly} onClick={() => onSessionCreate(goal.id)}><Icon name="plus" size={13} /></button>
            <button type="button" className="icon-button row-pin-trigger" aria-label={`${goal.pinned ? 'Unpin' : 'Pin'} folder ${goal.title}`}
              title={`${goal.pinned ? 'Unpin' : 'Pin'} folder`} aria-pressed={Boolean(goal.pinned)} disabled={readOnly}
              onClick={() => onDomainPin(goal.id, !goal.pinned)}><Icon name={goal.pinned ? 'pin-filled' : 'pin'} size={14} /></button>
            <button type="button" className="icon-button row-menu-trigger" aria-label={`Folder options for ${goal.title}`}
              title={`Folder options for ${goal.title}`} aria-haspopup="menu" aria-expanded={menu?.kind === 'domain' && menu.id === goal.id}
              onClick={(event) => menu?.kind === 'domain' && menu.id === goal.id ? closeMenu() : showMenu('domain', goal.id, goal.title, event.currentTarget)}><Icon name="ellipsis" size={15} /></button>
          </div>
          <div id={`${idPrefix}-domain-${goal.id}`} hidden={!isOpen(goal)} className="domain-contents">
            {folders(goal.id)}
            {state.sessions.filter((session) => session.goalId === goal.id).map(sessionButton)}
            <button className="domain-session-add" type="button" disabled={readOnly}
              aria-label={`New session in ${goal.title}`} onClick={() => onSessionCreate(goal.id)}>
              <Icon name="plus" size={12} /><span>New session</span>
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
  return (
    <div ref={navigationElement} className={`navigation-content${compact ? ' navigation-compact' : ''}`}>
      <div className="brand-lockup">
        {identity.brandImage ? <span className="ember-mark custom-brand-mark" aria-hidden="true"><img src={identity.brandImage} alt="" /></span> : <EmberMark />}
        <div className="brand-copy"><span className="brand-name">{identity.brandName}</span></div>
        {onRailToggle && <button type="button" className="icon-button rail-toggle"
          aria-label={compact ? 'Expand navigation' : 'Collapse navigation'} title={compact ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={!compact} onClick={onRailToggle}>
          <Icon name={compact ? 'rail-closed' : 'rail-open'} size={18} />
        </button>}
      </div>
      <nav className="module-nav" aria-label="Modules">
        {routes.map(({ route, label, icon }) => (
          <button type="button" key={route} title={label}
            className={`module-link${state.selection.route === route || (route === 'sessions' && state.selection.route === 'work') || (route === 'data' && state.selection.route === 'setup') ? ' selected' : ''}`}
            aria-label={label}
            aria-current={state.selection.route === route || (route === 'sessions' && state.selection.route === 'work') || (route === 'data' && state.selection.route === 'setup') ? 'page' : undefined}
            onClick={() => onRouteChange(route)}>
            <Icon name={icon} /><span>{label}</span>
            {(state.selection.route === route || (route === 'sessions' && state.selection.route === 'work')) && <span className="selected-dot" />}
          </button>
        ))}
      </nav>
      <div className="navigation-lists">
        <section className="domain-section" aria-label="Session folders">
          <div className="session-list-heading"><h2>SESSIONS</h2>
            <button className="icon-button" type="button" aria-label="Create folder" title="Create folder"
              disabled={readOnly} onClick={(event) => onDomainCreate(null, event.currentTarget)}><Icon name="plus" size={16} /></button>
          </div>
          <nav aria-label="Session folders">{folders(null)}</nav>
        </section>
        <section className="ungrouped-section" aria-label="Ungrouped sessions">
          <div className={`domain-row ungrouped-folder-row${state.selection.goalId === null && state.selection.route === 'sessions' ? ' selected' : ''}${dropTarget === 'ungrouped' ? ' session-drop-target' : ''}`}
            data-drop-goal-id="ungrouped" onDragOver={(event) => allowDrop(event, null)}
            onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
            onDrop={(event) => dropSession(event, null)}>
            <button type="button" className="icon-button folder-disclosure" aria-label={`${ungroupedOpen ? 'Collapse' : 'Expand'} Ungrouped sessions folder`}
              aria-expanded={ungroupedOpen} aria-controls={`${idPrefix}-ungrouped-sessions`} onClick={() => setUngroupedOpen(!ungroupedOpen)}><Icon name="chevron" size={13} /></button>
            <button type="button" className="domain-link ungrouped-folder-toggle" title="Ungrouped sessions" aria-label="Ungrouped sessions"
              aria-current={state.selection.goalId === null && state.selection.route === 'sessions' ? 'true' : undefined}
              onClick={() => { setUngroupedOpen(true); onUngroupedSelect(); }}><Icon name="folder" size={16} /><span>Ungrouped sessions</span></button>
            <button className="icon-button folder-add" type="button" aria-label="New session" title="New ungrouped session"
              disabled={readOnly} onClick={() => { setUngroupedOpen(true); onSessionCreate(null); }}><Icon name="plus" size={16} /></button>
          </div>
          <nav id={`${idPrefix}-ungrouped-sessions`} hidden={!ungroupedOpen} className="session-list domain-contents" aria-label="Ungrouped session list">
            {unassigned.map(sessionButton)}
            {!unassigned.length && <p className="muted small session-empty">Sessions outside folders appear here.</p>}
          </nav>
        </section>
      </div>
      <div className="navigation-footer">
        <div className="footer-tools">
          <button type="button" className="icon-button" title="Help and application options" aria-label="Help and application options" onClick={() => onOptions('help')}><Icon name="help" /></button>
        </div>
        <div className="user-options-row">
        <button type="button" className="user-options-button" title="User options" aria-label="User options" onClick={() => onOptions('user')}>
          <span className="user-avatar">{identity.avatarImage ? <img src={identity.avatarImage} alt="" /> : <Icon name="user" size={18} />}</span>
          <span className="user-copy"><strong>{identity.displayName}</strong><span>User options</span></span>
        </button>
        {!compact && <button type="button" className="icon-button user-appearance-button" title="Appearance options" aria-label="Appearance options" onClick={() => onOptions('appearance')}><Icon name={state.preferences.theme === 'system' ? 'monitor' : state.preferences.theme === 'dark' ? 'moon' : 'sun'} /></button>}
        </div>
      </div>
      {menu && createPortal(<div ref={menuElement} className="navigation-row-menu" data-navigation-owner={idPrefix} role="menu" tabIndex={-1} aria-label={`${menu.kind === 'domain' ? 'Folder' : 'Session'} options for ${menu.title}`}
        style={{ left: menu.x, top: menu.y }} onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
          else if (event.key === 'Tab') closeMenu();
          else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}>
        <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
          if (!menuRecord) return closeMenu();
          menu.origin.focus({ preventScroll: true });
          if (menu.kind === 'domain') onDomainRenameRequest(menuRecord.id, menu.origin);
          else onSessionRenameRequest(menuRecord.id, menu.origin);
          closeMenu(false);
        }}><Icon name="edit" size={15} />Rename</button>
        <button type="button" role="menuitem" disabled={readOnly || !menuRecord} onClick={() => {
            if (!menuRecord) return closeMenu();
            if (menu.kind === 'domain') onDomainPin(menuRecord.id, !menuRecord.pinned);
            else onSessionPin(menuRecord.id, !menuRecord.pinned);
            closeMenu();
          }}><Icon name={menuRecord?.pinned ? 'pin-filled' : 'pin'} size={15} />{menuRecord?.pinned ? 'Unpin' : 'Pin'}</button>
        {menu.kind === 'session' && <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
            const session = state.sessions.find((item) => item.id === menu.id);
            if (!session) return closeMenu();
            menu.origin.focus({ preventScroll: true });
            onSessionMoveRequest(session.id, menu.origin); closeMenu(false);
          }}><Icon name="folder" size={15} />Move to folder…</button>}
        {menu.kind === 'domain' && onDomainNoteRequest && <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
          const domain = state.goals.find((item) => item.id === menu.id);
          if (!domain) return closeMenu();
          menu.origin.focus({ preventScroll: true }); onDomainNoteRequest(domain.id, menu.origin); closeMenu(false);
        }}><Icon name="edit" size={15} />Edit folder note…</button>}
        {menu.kind === 'domain' && <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
          menu.origin.focus({ preventScroll: true }); onFolderIconRequest(menu.id, menu.origin); closeMenu(false);
        }}><FolderIcon />Change icon…</button>}
        <button type="button" role="menuitem" disabled={readOnly} onClick={() => {
          menu.origin.focus({ preventScroll: true }); onDomainCreate(menu.kind === 'domain' ? menu.id : null, menu.origin); closeMenu(false);
        }}><Icon name="plus" size={15} />Create folder…</button>
      </div>, document.body)}
    </div>
  );
}
