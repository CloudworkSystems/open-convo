import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import { FolderIcon } from '../ui/FolderIcon';
import type { DeskState } from '../domain/types';
import { useDeskRuntime, type TemporaryCanvas } from '../app/runtime';
import { canvasConnectorPath, emptyCanvasLayout, nodeAnchor, roundedNodePath, shapeBounds, zoomCanvasView, type CanvasLayoutRecord, type CanvasNodeLayout, type CanvasNodeShape, type CanvasView } from '../domain/canvas-layout';

interface ViewProps {
  state: DeskState;
  onDomain: (id: string) => void;
  onSession: (id: string) => void;
  onDomainRenameRequest?: (id: string, origin: HTMLElement) => void;
  onSessionRenameRequest?: (id: string, origin: HTMLElement) => void;
}

type CanvasNodeKind = 'domain' | 'session' | 'work' | 'note' | 'next-step';
interface CanvasNode extends CanvasNodeLayout {
  id: string;
  recordId: string;
  kind: CanvasNodeKind;
  title: string;
  status?: string;
}
interface CanvasLink { source: string; target: string; kind: 'inside' | 'belongs-to' }

/** A view of saved records, with no inferred relationships or new stored identities. */
export function buildCanvasScene(state: DeskState, layout = emptyCanvasLayout()): { nodes: CanvasNode[]; links: CanvasLink[]; width: number; height: number } {
  const nodes: CanvasNode[] = [];
  const links: CanvasLink[] = [];
  const defaults = { height: 96, shape: 'rectangle' as const, positionLocked: false, shapeLocked: false };
  let nextY = 20;
  for (const domain of state.goals) {
    const domainNode = { ...defaults, id: `domain:${domain.id}`, recordId: domain.id, kind: 'domain' as const, title: domain.title, x: 90, y: nextY, width: 250 };
    nodes.push(domainNode);
    const records = [
      ...(domain.nextStep ? [{ id: `next-step:${domain.id}`, recordId: domain.id, kind: 'next-step' as const, title: domain.nextStep }] : []),
      ...state.sessions.filter((session) => session.goalId === domain.id).map((session) => ({ id: `session:${session.id}`, recordId: session.id, kind: 'session' as const, title: session.title })),
      ...state.workItems.filter((item) => item.goalId === domain.id).map((item) => ({ id: `work:${item.id}`, recordId: item.id, kind: 'work' as const, title: item.title, status: item.status })),
      ...state.notes.filter((note) => note.goalId === domain.id).map((note) => ({ id: `note:${note.id}`, recordId: note.id, kind: 'note' as const, title: note.body })),
    ];
    for (const record of records) {
      nodes.push({ ...defaults, ...record, x: 440, y: nextY, width: 325 });
      links.push({ source: domainNode.id, target: record.id, kind: 'belongs-to' });
      nextY += 116;
    }
    nextY += records.length ? 24 : 120;
  }
  for (const domain of state.goals) {
    if (domain.parentId && state.goals.some((parent) => parent.id === domain.parentId)) {
      links.push({ source: `domain:${domain.parentId}`, target: `domain:${domain.id}`, kind: 'inside' });
    }
  }
  for (const session of state.sessions.filter((item) => item.goalId === null)) {
    nodes.push({ ...defaults, id: `session:${session.id}`, recordId: session.id, kind: 'session', title: session.title, status: 'ungrouped', x: 440, y: nextY, width: 325 });
    nextY += 116;
  }
  const placed = nodes.map((node) => ({ ...node, ...layout.nodes[node.id] }));
  return { nodes: placed, links, width: Math.max(840, ...placed.map((node) => node.x + node.width + 40)), height: Math.max(240, ...placed.map((node) => node.y + node.height + 40)) };
}

const nodeLabels: Record<CanvasNodeKind, string> = { domain: 'Folder', session: 'Session', work: 'Work', note: 'Note / idea', 'next-step': 'Next step' };
const shapes: CanvasNodeShape[] = ['rectangle', 'square', 'circle', 'triangle'];
const nodeLayout = ({ x, y, width, height, shape, positionLocked, shapeLocked }: CanvasNode): CanvasNodeLayout => ({ x, y, width, height, shape, positionLocked, shapeLocked });
const bounded = (value: number) => Math.max(0, Math.min(20_000, value));
interface CanvasMenu { id: string; x: number; y: number; origin: HTMLElement }
interface CanvasGesture {
  pointerId: number;
  capture: HTMLElement;
  clientX: number;
  clientY: number;
  kind: 'pan' | 'move' | 'resize';
  id?: string;
  initial?: CanvasNodeLayout;
  view: CanvasView;
  moved: boolean;
  previousTemporary?: TemporaryCanvas;
}

/** Reads workspace identities and keeps geometry in the selected runtime. */
export function Canvas({ state, onDomain, onSession, onDomainRenameRequest, onSessionRenameRequest }: ViewProps) {
  const runtime = useDeskRuntime();
  const repository = runtime.canvas;
  const visit = runtime.canvasVisit;
  const [layout, setLayout] = useState(() => visit.temporary?.layout ?? emptyCanvasLayout());
  const layoutRef = useRef(layout);
  const revision = useRef(visit.temporary?.revision ?? 0);
  const [ready, setReady] = useState(!!visit.temporary);
  const readyRef = useRef(ready);
  const [warning, setWarning] = useState<string | null>(visit.temporary?.warning ?? null);
  const warningRef = useRef<string | null>(visit.temporary?.warning ?? null);
  const [pending, setPending] = useState(visit.temporary?.pending ?? 0);
  const pendingRef = useRef(visit.temporary?.pending ?? 0);
  const [editing, setEditing] = useState(false);
  const epoch = useRef(0);
  const tail = useRef(Promise.resolve());
  const mounted = useRef(true);
  const [view, setView] = useState<CanvasView>({ x: 0, y: 0, scale: 1 });
  const viewRef = useRef(view);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const spaceRef = useRef(false);
  const [expanded, setExpanded] = useState(false);
  // Map selection is local to this view; opening a record still uses the
  // shared navigation callbacks and does not create another workspace identity.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(() => state.selection.sessionId
    ? `session:${state.selection.sessionId}` : state.selection.goalId ? `domain:${state.selection.goalId}` : null);
  const [menu, setMenu] = useState<CanvasMenu | null>(null);
  const section = useRef<HTMLElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<CanvasGesture | null>(null);
  const suppressClick = useRef(false);
  const scene = useMemo(() => buildCanvasScene(state, layout), [state, layout]);
  const points = new Map(scene.nodes.map((node) => [node.id, node]));
  const menuNode = menu && points.get(menu.id);

  useEffect(() => {
    setSelectedNodeId(state.selection.sessionId ? `session:${state.selection.sessionId}`
      : state.selection.goalId ? `domain:${state.selection.goalId}` : null);
  }, [state.selection.goalId, state.selection.sessionId]);

  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    const refresh = async () => {
      if (visit.temporary) {
        layoutRef.current = visit.temporary.layout;
        revision.current = visit.temporary.revision;
        pendingRef.current = visit.temporary.pending;
        warningRef.current = visit.temporary.warning;
        setLayout(visit.temporary.layout); setPending(visit.temporary.pending); setWarning(visit.temporary.warning); readyRef.current = true; setReady(true);
        return;
      }
      if (warningRef.current || pendingRef.current || gesture.current) return;
      const before = epoch.current;
      const loaded = await repository.loadLatest();
      if (stopped || !runtime.isActive() || before !== epoch.current || pendingRef.current || gesture.current) return;
      layoutRef.current = loaded.layout;
      revision.current = loaded.layout.revision;
      setLayout(loaded.layout);
      warningRef.current = loaded.warning;
      setWarning(loaded.warning);
      readyRef.current = true; setReady(true);
    };
    void refresh();
    const temporaryChanged = () => {
      if (!visit.temporary) { readyRef.current = false; setReady(false); }
      pendingRef.current = visit.temporary?.pending ?? 0;
      setPending(pendingRef.current);
      void refresh();
    };
    visit.listeners.add(temporaryChanged);
    const unsubscribe = repository.subscribe(() => { void refresh(); });
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      mounted.current = false;
      unsubscribe();
      visit.listeners.delete(temporaryChanged);
      if (gesture.current) cancelGesture();
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [repository]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
    const outside = (event: globalThis.PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [menu]);

  useEffect(() => {
    const release = () => { spaceRef.current = false; setSpaceHeld(false); };
    const keyReleased = (event: globalThis.KeyboardEvent) => { if (event.key === ' ') release(); };
    window.addEventListener('blur', release);
    window.addEventListener('keyup', keyReleased);
    const changed = () => {
      if (!document.fullscreenElement) {
        setExpanded(false);
        // Native browser Escape may leave fullscreen before Rename receives
        // the key; that browser exit keeps the editor open. Preserve its focus
        // and let the shared dialog handle Cancel, Save and later Escape.
        if (!document.querySelector('[role="dialog"][aria-modal="true"]')) fullscreenButton.current?.focus();
      }
    };
    document.addEventListener('fullscreenchange', changed);
    return () => {
      window.removeEventListener('blur', release);
      window.removeEventListener('keyup', keyReleased);
      document.removeEventListener('fullscreenchange', changed);
      if (document.fullscreenElement === section.current) void document.exitFullscreen().catch(() => undefined);
    };
  }, []);

  const showLayout = (next: CanvasLayoutRecord) => { layoutRef.current = next; setLayout(next); };
  const changeNode = (id: string, change: Partial<CanvasNodeLayout>, save = true) => {
    const node = buildCanvasScene(state, layoutRef.current).nodes.find((item) => item.id === id);
    if (!node || !readyRef.current || pendingRef.current) return;
    const next = { ...layoutRef.current, nodes: { ...layoutRef.current.nodes, [id]: { ...nodeLayout(node), ...change } } };
    showLayout(next);
    if (save) persist(next);
    else if (gesture.current?.moved) { visit.retain({ layout: next, warning: warningRef.current, revision: revision.current, pending: 0 }); setEditing(true); }
  };
  const persist = (next: CanvasLayoutRecord) => {
    epoch.current += 1;
    if (warningRef.current) { visit.retain({ layout: next, warning: warningRef.current, revision: revision.current, pending: 0 }); return; }
    pendingRef.current += 1;
    setPending(pendingRef.current);
    visit.retain({ layout: next, warning: null, revision: revision.current, pending: pendingRef.current });
    tail.current = tail.current.then(async () => {
      const result = await repository.save(next, revision.current);
      if (!runtime.isActive()) return;
      if (result.kind === 'saved') revision.current = result.layout.revision;
      else warningRef.current = result.warning;
      pendingRef.current -= 1;
      visit.retain(result.kind === 'saved' ? undefined : { layout: next, warning: result.warning, revision: revision.current, pending: 0 });
      if (mounted.current) {
        setPending(pendingRef.current);
        if (result.kind === 'failed') setWarning(result.warning);
      }
    });
  };
  const updateView = (next: CanvasView) => { viewRef.current = next; setView(next); };
  const zoom = (scale: number, point?: { x: number; y: number }) => {
    const bounds = viewport.current?.getBoundingClientRect();
    const center = point ?? { x: (bounds?.width ?? 800) / 2, y: (bounds?.height ?? 500) / 2 };
    updateView(zoomCanvasView(viewRef.current, center, scale));
  };
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.metaKey && !event.ctrlKey) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      updateView(zoomCanvasView(viewRef.current, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, viewRef.current.scale * Math.exp(-delta * .002)));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);

  const toggleFullscreen = async () => {
    if (expanded) {
      if (document.fullscreenElement === section.current) await document.exitFullscreen().catch(() => undefined);
      setExpanded(false);
      fullscreenButton.current?.focus();
      return;
    }
    setExpanded(true);
    // A denied/unsupported browser API still gives a reversible full-window view.
    try { await section.current?.requestFullscreen?.(); } catch { /* Full-window fallback remains active. */ }
    viewport.current?.focus();
  };
  const openMenu = (node: CanvasNode, origin: HTMLElement, clientX?: number, clientY?: number) => {
    const bounds = origin.getBoundingClientRect();
    setMenu({ id: node.id, origin, x: Math.max(8, Math.min(clientX ?? bounds.left + 12, window.innerWidth - 240)), y: Math.max(8, Math.min(clientY ?? bounds.top + 12, window.innerHeight - 355)) });
  };
  const closeMenu = (restore = true) => { if (restore) menu?.origin.focus(); setMenu(null); };
  const openNode = (node: CanvasNode) => {
    closeMenu(false);
    if (node.kind === 'domain') onDomain(node.recordId);
    else if (node.kind === 'session') onSession(node.recordId);
  };
  const begin = (event: ReactPointerEvent<HTMLElement>, kind: CanvasGesture['kind'], node?: CanvasNode) => {
    if (event.button !== 0 || (kind !== 'pan' && (!readyRef.current || !!pendingRef.current))) return;
    if (spaceRef.current) kind = 'pan';
    if (kind === 'resize' && node?.shapeLocked) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, capture: event.currentTarget, clientX: event.clientX, clientY: event.clientY, kind, id: node?.id, initial: node && nodeLayout(node), view: viewRef.current, moved: false, previousTemporary: visit.temporary };
    suppressClick.current = false;
    setMenu(null);
  };
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const dx = event.clientX - active.clientX;
    const dy = event.clientY - active.clientY;
    if (!active.moved && Math.hypot(dx, dy) < 4) return;
    active.moved = true;
    suppressClick.current = true;
    if (active.kind === 'pan') updateView({ ...active.view, x: active.view.x + dx, y: active.view.y + dy });
    else if (active.id && active.initial) {
      const start = active.initial;
      if (active.kind === 'move' && start.positionLocked) return;
      if (active.kind === 'move') changeNode(active.id, { x: bounded(start.x + dx / active.view.scale), y: bounded(start.y + dy / active.view.scale) }, false);
      else {
        const rx = dx / active.view.scale;
        const ry = dy / active.view.scale;
        const side = Math.abs(rx) >= Math.abs(ry) ? rx : ry;
        const equal = start.shape === 'square' || start.shape === 'circle';
        changeNode(active.id, shapeBounds(start.shape, start.width + (equal ? side : rx), start.height + (equal ? side : ry)), false);
      }
    }
  };
  const cancelGesture = () => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = null;
    if (active.capture.hasPointerCapture(active.pointerId)) active.capture.releasePointerCapture(active.pointerId);
    if (active.kind === 'pan') updateView(active.view);
    else if (active.id && active.initial) changeNode(active.id, active.initial, false);
    suppressClick.current = active.moved;
    setEditing(false);
    visit.retain(active.previousTemporary);
  };
  const end = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    if (cancelled) { cancelGesture(); return; }
    gesture.current = null;
    setEditing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (active.moved && active.kind !== 'pan' && !(active.kind === 'move' && active.initial?.positionLocked)) {
      persist(layoutRef.current);
    }
  };
  const nodeKey = (event: KeyboardEvent<HTMLElement>, node: CanvasNode) => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault(); event.stopPropagation(); openMenu(node, event.currentTarget); return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || spaceRef.current || node.positionLocked || !readyRef.current) return;
    const directions: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const direction = directions[event.key];
    if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    const step = event.shiftKey ? 32 : 12;
    changeNode(node.id, { x: bounded(node.x + direction[0] * step), y: bounded(node.y + direction[1] * step) });
  };
  const viewportKey = (event: KeyboardEvent<HTMLElement>) => {
    if (expanded && !menu && event.key === 'Tab') {
      const controls = [...(section.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]') ?? [])].filter((element) => element.getClientRects().length);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); controls.at(-1)?.focus(); }
      else if (!event.shiftKey && index === controls.length - 1) { event.preventDefault(); controls[0]?.focus(); }
    }
    if (event.key === ' ' && !menu && (event.target === viewport.current || (event.target as HTMLElement).closest('.canvas-node, .canvas-resize'))) { event.preventDefault(); spaceRef.current = true; setSpaceHeld(true); }
    if ((event.metaKey || event.ctrlKey) && (event.key === '+' || event.key === '=' || event.key === '-')) {
      event.preventDefault(); zoom(viewRef.current.scale * (event.key === '-' ? 1 / 1.2 : 1.2));
    }
    if (event.key === 'Escape') {
      if (menu) closeMenu();
      else if (gesture.current) cancelGesture();
      else if (expanded) void toggleFullscreen();
    }
  };
  const menuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); closeMenu(); return; }
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)')];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (current + 1) % items.length : event.key === 'ArrowUp' ? (current + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); items[next]?.focus(); }
  };

  return <section ref={section} className={`nexus-canvas${expanded ? ' canvas-expanded' : ''}`} aria-label="Canvas" data-preview-refresh-hold={pending || editing || visit.temporary ? 'canvas-layout' : undefined} onKeyDown={viewportKey} onKeyUp={(event) => { if (event.key === ' ') { spaceRef.current = false; setSpaceHeld(false); } }}>
    <div className="canvas-toolbar" role="toolbar" aria-label="Canvas view controls">
      <span className="canvas-toolbar-title">Cloudwork Canvas</span>
      <div className="canvas-zoom-controls">
        <button type="button" aria-label="Zoom out" title="Zoom out (⌘ / Ctrl −)" onClick={() => zoom(viewRef.current.scale / 1.2)} disabled={view.scale <= .25}>−</button>
        <output aria-live="polite" aria-label="Canvas zoom">{Math.round(view.scale * 100)}%</output>
        <button type="button" aria-label="Zoom in" title="Zoom in (⌘ / Ctrl +)" onClick={() => zoom(viewRef.current.scale * 1.2)} disabled={view.scale >= 3}>+</button>
        <button type="button" className="canvas-fit" onClick={() => {
          const bounds = viewport.current?.getBoundingClientRect();
          const scale = Math.max(.25, Math.min(1, ((bounds?.width ?? 800) - 40) / scene.width, ((bounds?.height ?? 500) - 40) / scene.height));
          updateView({ x: 20, y: 20, scale });
        }}>Fit</button>
      </div>
      <button ref={fullscreenButton} type="button" className="canvas-fullscreen" aria-label={expanded ? 'Exit fullscreen Canvas' : 'Fullscreen Canvas'} title={expanded ? 'Exit fullscreen (Esc)' : 'Fullscreen Canvas'} onClick={() => { void toggleFullscreen(); }}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d={expanded ? 'M4 9h5V4M15 4v5h5M20 15h-5v5M9 20v-5H4' : 'M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5'} /></svg>
      </button>
    </div>
    <div ref={viewport} className={`canvas-map${spaceHeld ? ' canvas-hand' : ''}`} tabIndex={0} aria-label="Canvas viewport" aria-describedby="canvas-shortcuts"
      onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target as Element).tagName === 'svg' || spaceRef.current) begin(event, 'pan'); }}
      onPointerMove={move} onPointerUp={(event) => end(event)} onPointerCancel={(event) => end(event, true)} onLostPointerCapture={() => { if (gesture.current) cancelGesture(); }}>
      <svg width="100%" height="100%" role="group" aria-label="Recorded workspace relationships">
        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          <g className="canvas-links">{scene.links.map((link) => <path key={`${link.source}-${link.target}`} data-source={link.source} data-target={link.target} data-link-kind={link.kind} d={canvasConnectorPath(points.get(link.source)!, points.get(link.target)!)} />)}</g>
          {scene.nodes.map((node) => {
            const rounded = node.shape === 'square' || node.shape === 'triangle';
            const clipId = `canvas-clip-${node.id.replace(':', '-')}`;
            const resizeAnchor = nodeAnchor(node, { x: node.x + node.width, y: node.y + node.height });
            const content = <><span className="canvas-node-kind">{node.kind === 'domain' && <FolderIcon name={state.goals.find((folder) => folder.id === node.recordId)?.icon} size={13} />}{nodeLabels[node.kind]}{node.status && <span className="canvas-node-status">{node.status}</span>}{(node.positionLocked || node.shapeLocked) && <span className="canvas-lock-indicator" aria-label={`${node.positionLocked ? 'Position locked' : ''}${node.positionLocked && node.shapeLocked ? ', ' : ''}${node.shapeLocked ? 'Shape locked' : ''}`} role="img"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg></span>}</span><span className="canvas-node-title">{node.title}</span></>;
            const current = selectedNodeId === node.id;
            const shared = {
              className: `canvas-node ${node.kind}-node canvas-shape-${node.shape}${current ? ' current' : ''}`,
              style: { clipPath: rounded ? `url(#${clipId})` : undefined,
                padding: node.shape === 'triangle' ? `${node.height * .4}px ${node.width * .29}px ${node.height * .08}px` : undefined },
              title: `${node.title}\n${node.kind === 'domain' || node.kind === 'session' ? 'Click to select; double-click or Enter to open. ' : ''}Right-click for options; arrow keys move`,
              onContextMenu: (event: MouseEvent<HTMLElement>) => { event.preventDefault(); event.stopPropagation(); openMenu(node, event.currentTarget, event.clientX, event.clientY); },
              onKeyDown: (event: KeyboardEvent<HTMLElement>) => nodeKey(event, node),
              onPointerDown: (event: ReactPointerEvent<HTMLElement>) => begin(event, 'move', node),
              onPointerMove: move,
              onPointerUp: (event: ReactPointerEvent<HTMLElement>) => end(event),
              onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => end(event, true),
            };
            return <g key={node.id} className={`canvas-item${current ? ' current' : ''}`} data-node-id={node.id} data-shape={node.shape} data-position-locked={node.positionLocked} data-shape-locked={node.shapeLocked}>
              {rounded && <defs><clipPath id={clipId} clipPathUnits="objectBoundingBox"><path d={roundedNodePath({ ...node, x: 0, y: 0, width: 1, height: 1 })} /></clipPath></defs>}
              {node.shape === 'circle' ? <circle className={`canvas-node-outline ${node.kind}-outline`} cx={node.x + node.width / 2} cy={node.y + node.height / 2} r={node.width / 2} />
                : rounded ? <path className={`canvas-node-outline ${node.kind}-outline`} d={roundedNodePath(node)} />
                : <rect className={`canvas-node-outline ${node.kind}-outline`} x={node.x} y={node.y} width={node.width} height={node.height} />}
              <foreignObject x={node.x} y={node.y} width={node.width} height={node.height} data-node-id={node.id} data-record-id={node.recordId} data-node-kind={node.kind}>
                {node.kind === 'domain' || node.kind === 'session'
                  ? <button {...shared} type="button" aria-label={`Open ${node.kind === 'domain' ? 'folder' : 'session'} ${node.title}`} aria-current={current ? 'true' : undefined} aria-describedby="canvas-shortcuts" onClick={(event) => {
                      // A drag's click may be followed by dblclick in the same
                      // sequence. Keep its suppression until the next press.
                      if (suppressClick.current && event.detail > 0) return;
                      if (event.detail === 0) openNode(node);
                      else setSelectedNodeId(node.id);
                    }} onDoubleClick={() => { if (!suppressClick.current) openNode(node); }}>{content}</button>
                  : <article {...shared} tabIndex={0} aria-label={`${nodeLabels[node.kind]}: ${node.title}`}>{content}</article>}
              </foreignObject>
              {!node.shapeLocked && <foreignObject className="canvas-resize-object" x={resizeAnchor.x - 12} y={resizeAnchor.y - 12} width="22" height="22">
                <button type="button" className="canvas-resize" aria-label={`Resize ${nodeLabels[node.kind].toLowerCase()} ${node.title}`} title="Drag to resize; arrow keys resize" disabled={!ready || !!pending}
                  onPointerDown={(event) => begin(event, 'resize', node)} onPointerMove={move} onPointerUp={(event) => end(event)} onPointerCancel={(event) => end(event, true)}
                  onKeyDown={(event) => {
                    const amount = event.shiftKey ? 32 : 12;
                    const dw = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
                    const dh = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
                    if (!dw && !dh) return;
                    event.preventDefault(); event.stopPropagation();
                    const equal = node.shape === 'square' || node.shape === 'circle';
                    changeNode(node.id, shapeBounds(node.shape, node.width + (equal ? dw || dh : dw), node.height + (equal ? dw || dh : dh)));
                  }}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M4 12 12 4M8 12l4-4" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
              </foreignObject>}
            </g>;
          })}
        </g>
      </svg>
      {!scene.nodes.length && <p className="canvas-empty muted">Create a folder or session in Navigator to begin a map.</p>}
    </div>
    <div className="canvas-footer"><span id="canvas-shortcuts">Click to select · Double-click or Enter to open · ⌘ / Ctrl + scroll to zoom · Hold Space and drag to pan · Right-click an item for options</span>{warning && visit.temporary && <button type="button" className="canvas-reload" onClick={() => window.location.reload()}>Reload saved layout</button>}<span className="canvas-save-status" role="status">{warning ?? (editing ? 'Editing Canvas layout…' : pending ? 'Saving Canvas layout…' : ready ? layout.revision > 0 ? runtime.mode === 'native-proof' ? 'Canvas layout kept for this visit' : 'Canvas layout saved in this browser' : 'Canvas layout ready' : 'Loading Canvas layout…')}</span></div>
    {menu && menuNode && <div ref={menuRef} className="canvas-context-menu" role="menu" aria-label={`Canvas options for ${menuNode.title}`} style={{ left: menu.x, top: menu.y }} onKeyDown={menuKey}>
      {(menuNode.kind === 'domain' || menuNode.kind === 'session') && <button type="button" role="menuitem" onClick={() => openNode(menuNode)}>Open</button>}
      {(menuNode.kind === 'domain' && onDomainRenameRequest || menuNode.kind === 'session' && onSessionRenameRequest) && <button type="button" role="menuitem" onClick={() => {
        const origin = menu.origin; const id = menuNode.recordId; const kind = menuNode.kind;
        closeMenu(false);
        if (kind === 'domain') onDomainRenameRequest?.(id, origin); else onSessionRenameRequest?.(id, origin);
      }}>Rename…</button>}
      <button type="button" role="menuitemcheckbox" aria-checked={menuNode.positionLocked} disabled={!ready || !!pending} onClick={() => { changeNode(menuNode.id, { positionLocked: !menuNode.positionLocked }); closeMenu(); }}>{menuNode.positionLocked ? 'Unlock position' : 'Lock position'}</button>
      <button type="button" role="menuitemcheckbox" aria-checked={menuNode.shapeLocked} disabled={!ready || !!pending} onClick={() => { changeNode(menuNode.id, { shapeLocked: !menuNode.shapeLocked }); closeMenu(); }}>{menuNode.shapeLocked ? 'Unlock shape' : 'Lock shape'}</button>
      <div className="canvas-menu-label">Shape</div>
      {shapes.map((shape) => <button key={shape} type="button" role="menuitemradio" aria-checked={menuNode.shape === shape} disabled={!ready || !!pending || menuNode.shapeLocked} onClick={() => {
        changeNode(menuNode.id, { shape, ...shapeBounds(shape, menuNode.width, menuNode.height) }); closeMenu();
      }}>{shape[0].toUpperCase() + shape.slice(1)}</button>)}
    </div>}
  </section>;
}

export function Atlas(_props: ViewProps) {
  return <section className="nexus-atlas" aria-label="Atlas">
    <div className="nexus-view-intro"><span className="eyebrow">CLOUDWORK ATLAS · PLANNED</span><h2>A 3D map of what you know.</h2>
      <p>The intended Atlas connects concepts, source notes and evidence in an Obsidian-like knowledge graph.</p></div>
    <div className="atlas-planned">
      <div className="atlas-planned-heading"><span className="quiet-badge">Planned · not connected</span></div>
      <h3>Explore the knowledge behind your work.</h3>
      <p>The planned Atlas brings together a 3D graph, a Karpathy-style LLM wiki and graph retrieval (RAG), with sources you can inspect.</p>
      <dl className="atlas-capabilities">
        <div><dt>3D knowledge graph</dt><dd>Explore how concepts and evidence connect.</dd></div>
        <div><dt>Source-linked wiki</dt><dd>Keep explanations and their supporting notes together.</dd></div>
        <div><dt>Graph retrieval</dt><dd>Find relevant knowledge to support a conversation.</dd></div>
      </dl>
      <p className="atlas-scope">These capabilities are planned. This sample has no connected 3D graph, wiki index or RAG service. Your recorded folder and session map is in Canvas.</p>
    </div>
  </section>;
}
