import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { DESK_ROADMAP_KEY } from '../adapters/browser-roadmap';
import { useDeskRuntime } from '../app/runtime';
import source from '../content/recovery-roadmap.json';
import {
  ROADMAP_COLUMNS,
  defaultRoadmapPlacement,
  isRoadmapColumn,
  moveRoadmapCard,
  reconcileRoadmapPlacement,
  roadmapCardColumn,
  roadmapDropBeforeId,
  roadmapEvidenceLink,
  validateRecoveryRoadmap,
  type RecoveryCard,
  type RecoveryRoadmap,
  type RoadmapColumn,
} from '../domain/recovery-roadmap';
import { Modal } from '../ui/Modal';
import './roadmap.css';

const dragType = 'application/x-true-convo-roadmap-card';
const roadmap = validateRecoveryRoadmap(source);
export function RoadmapBoard({ workspaceCards = [], createCard }: { workspaceCards?: RecoveryCard[]; createCard?: ReactNode }) {
  const combined = useMemo<RecoveryRoadmap>(() => ({
    ...(roadmap ?? { schemaVersion: 1, title: 'Roadmap', updatedAt: 'Unavailable' }),
    cards: [...(roadmap?.cards ?? []), ...workspaceCards],
  }), [workspaceCards]);
  return <>
    {!roadmap && <p className="roadmap-warning" role="alert">The project roadmap could not be read. Your own work cards are still available.</p>}
    <PlanningBoard roadmap={combined} createCard={createCard} />
  </>;
}

function PlanningBoard({ roadmap, createCard }: { roadmap: RecoveryRoadmap; createCard?: ReactNode }) {
  const runtime = useDeskRuntime();
  const repository = runtime.roadmap;
  const visit = runtime.roadmapVisit;
  const [initial] = useState(() => {
    const retained = visit.pendingPlacement ?? visit.temporary?.placement;
    const temporary = retained && reconcileRoadmapPlacement(retained, roadmap.cards);
    return temporary ? { placement: temporary, warning: visit.temporary?.warning ?? null }
      : { placement: defaultRoadmapPlacement(roadmap.cards), warning: null };
  });
  const [storedPlacement, setPlacement] = useState(initial.placement);
  const placement = useMemo(() => reconcileRoadmapPlacement(storedPlacement, roadmap.cards)!, [storedPlacement, roadmap.cards]);
  const [warning, setWarning] = useState(initial.warning);
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(!!visit.pendingPlacement);
  const [ready, setReady] = useState(false);
  const [unsavedPlacement, setUnsavedPlacement] = useState(visit.hasUnsaved());
  const pending = useRef(!!visit.pendingPlacement);
  const dragging = useRef<string | null>(null);
  const moveFocus = useRef<{ id: string; origin: HTMLSelectElement; movedElsewhere: boolean } | null>(null);
  const loadEpoch = useRef(0);
  const cards = new Map(roadmap.cards.map((card) => [card.id, card]));
  const opened = openedId ? cards.get(openedId) : undefined;

  useEffect(() => {
    const focusChanged = (event: FocusEvent) => {
      const target = event.target;
      if (moveFocus.current && target !== moveFocus.current.origin && target !== document.body && target !== document.documentElement) {
        moveFocus.current.movedElsewhere = true;
      }
    };
    const pointerChanged = (event: PointerEvent) => {
      if (moveFocus.current && event.target !== moveFocus.current.origin) moveFocus.current.movedElsewhere = true;
    };
    const keyboardChanged = (event: KeyboardEvent) => {
      if (moveFocus.current && event.key === 'Tab') moveFocus.current.movedElsewhere = true;
    };
    const blurred = () => { if (moveFocus.current) moveFocus.current.movedElsewhere = true; };
    document.addEventListener('focusin', focusChanged, true);
    document.addEventListener('pointerdown', pointerChanged, true);
    document.addEventListener('keydown', keyboardChanged, true);
    window.addEventListener('blur', blurred);
    return () => {
      moveFocus.current = null;
      document.removeEventListener('focusin', focusChanged, true);
      document.removeEventListener('pointerdown', pointerChanged, true);
      document.removeEventListener('keydown', keyboardChanged, true);
      window.removeEventListener('blur', blurred);
    };
  }, []);

  useEffect(() => {
    const ticket = moveFocus.current;
    if (!ticket || saving || pending.current) return;
    const frame = requestAnimationFrame(() => {
      if (moveFocus.current !== ticket) return;
      moveFocus.current = null;
      const active = document.activeElement;
      if (ticket.movedElsewhere || (active !== document.body && active !== document.documentElement && active !== ticket.origin)
        || document.querySelector('[role="dialog"], dialog[open]')) return;
      const control = document.querySelector<HTMLSelectElement>(`.roadmap-card[data-card-id="${CSS.escape(ticket.id)}"] .roadmap-move select`);
      if (control && !control.disabled && control.getClientRects().length) control.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [placement, saving]);

  useEffect(() => {
    let mounted = true;
    const refresh = async () => {
      const epoch = ++loadEpoch.current;
      const latest = await repository.loadLatest(roadmap.cards);
      if (!mounted || !runtime.isActive() || epoch !== loadEpoch.current) return;
      if (!visit.temporary) {
        // Keep the pending request visible across route changes, while still
        // accepting durable independent moves from other tabs.
        const displayed = visit.pendingMove
          ? moveRoadmapCard(latest.placement, roadmap.cards, visit.pendingMove.id, visit.pendingMove.column, visit.pendingMove.beforeId)
          : latest.placement;
        if (visit.pendingMove) visit.pendingPlacement = displayed;
        setPlacement(displayed);
        setWarning(latest.warning);
      }
      setReady(true);
    };
    const changed = (event: StorageEvent) => {
      if (event.key === DESK_ROADMAP_KEY || event.key === null) void refresh();
    };
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const retainedChanged = (settled: boolean) => {
      pending.current = !!visit.pendingPlacement;
      setSaving(!!visit.pendingPlacement);
      setUnsavedPlacement(visit.hasUnsaved());
      if (settled && visit.temporary) {
        setPlacement(reconcileRoadmapPlacement(visit.temporary.placement, roadmap.cards)!);
        setWarning(visit.temporary.warning);
      } else if (settled) void refresh();
    };
    visit.listeners.add(retainedChanged);
    const unsubscribe = repository.subscribe(() => { void refresh(); });
    window.addEventListener('storage', changed);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => {
      mounted = false;
      loadEpoch.current += 1;
      unsubscribe();
      visit.listeners.delete(retainedChanged);
      window.removeEventListener('storage', changed);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [repository, roadmap]);

  async function move(id: string, column: RoadmapColumn, beforeId?: string, focusOrigin?: HTMLSelectElement) {
    if (!ready || pending.current) return;
    const next = moveRoadmapCard(placement, roadmap.cards, id, column, beforeId);
    // A displayed no-op can differ from the latest record in another tab.
    // The transaction decides the move against that authoritative placement.
    moveFocus.current = focusOrigin && focusOrigin === document.activeElement && focusOrigin.closest('.roadmap-card')
      ? { id, origin: focusOrigin, movedElsewhere: false } : null;
    pending.current = true;
    loadEpoch.current += 1;
    setSaving(true);
    setUnsavedPlacement(true);
    setPlacement(next);
    visit.pendingPlacement = next;
    visit.pendingMove = { id, column, ...(beforeId ? { beforeId } : {}) };
    visit.changed(false);
    const result = await repository.saveMove({ id, column, ...(beforeId ? { beforeId } : {}) }, roadmap.cards);
    if (!runtime.isActive()) return;
    let saveWarning = result.kind === 'failed' ? result.warning : null;
    if (result.kind === 'saved') {
      // Another tab may write after our lock releases but before its result
      // reaches this continuation. Read the latest durable view rather than
      // replacing an already received storage update with that older result.
      const epoch = ++loadEpoch.current;
      const latest = await repository.loadLatest(roadmap.cards);
      if (!runtime.isActive()) return;
      saveWarning = latest.warning;
      if (epoch === loadEpoch.current) setPlacement(latest.warning ? result.placement : latest.placement);
      visit.temporary = latest.warning ? { placement: result.placement, warning: latest.warning } : undefined;
      setUnsavedPlacement(!!latest.warning);
    } else {
      loadEpoch.current += 1;
      setPlacement(next);
      visit.temporary = { placement: next, warning: result.warning };
    }
    setWarning(saveWarning);
    const label = ROADMAP_COLUMNS.find((item) => item.id === column)!.title;
    setAnnouncement(`${cards.get(id)!.title} moved to ${label} in your planning view. ${saveWarning ? 'Placement is not saved.' : runtime.mode === 'native-proof' ? 'Placement kept for this visit.' : 'Placement saved in this browser.'}`);
    pending.current = false;
    setSaving(false);
    visit.pendingPlacement = undefined;
    visit.pendingMove = undefined;
    visit.changed(true);
  }

  function closeCard() {
    const id = openedId;
    setOpenedId(null);
    // A move remounts the card in its new column, so the modal's original
    // opener may no longer exist. Restore focus to that card's current button.
    if (id) requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>(`.roadmap-card[data-card-id="${CSS.escape(id)}"] h4 button`)?.focus();
    });
  }

  function acceptsDrag(event: DragEvent) {
    return event.dataTransfer.types.includes(dragType) && !!dragging.current;
  }

  function drop(event: DragEvent, column: RoadmapColumn, targetId?: string) {
    if (!acceptsDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const id = event.dataTransfer.getData(dragType);
    if (id === dragging.current && cards.has(id)) move(id, column, roadmapDropBeforeId(placement, id, column, targetId));
    dragging.current = null;
    setDraggingId(null);
  }

  function moveControl(card: RecoveryCard, className = '') {
    const column = roadmapCardColumn(placement, card.id)!;
    return (
      <label className={`roadmap-move ${className}`}>
        <span>Move to</span>
        <select
          aria-label={`Move ${card.title} to`}
          value={column}
          disabled={saving || !ready}
          onChange={(event) => { if (isRoadmapColumn(event.target.value)) move(card.id, event.target.value, undefined, event.currentTarget); }}
        >
          {ROADMAP_COLUMNS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
      </label>
    );
  }

  return (
    <section className="roadmap-section" aria-label="Roadmap" data-preview-refresh-hold={unsavedPlacement ? 'roadmap-placement' : undefined}>
      <div className="roadmap-toolbar">
        <p>Drag cards between columns, or use Move to. Open a card for its outcome, checks and evidence.</p>
        <span className="roadmap-updated">Source updated {roadmap.updatedAt}</span>
      </div>
      <p className="roadmap-planning-note">Columns are your planning view. Recorded progress stays on each card; moving it does not complete its checks or change an approval.</p>
      {warning && <p className="roadmap-warning" role="alert">{warning}</p>}
      <p className="roadmap-save-status" role="status">{!ready ? 'Loading roadmap placement…' : saving ? 'Saving roadmap placement…' : warning ? 'Roadmap placement is temporary for this visit.' : runtime.mode === 'native-proof' ? 'Roadmap placement lasts for this visit.' : 'Roadmap placement saves in this browser.'}</p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
      <div className="roadmap-board" role="region" aria-label="Roadmap columns" tabIndex={0}>
        {ROADMAP_COLUMNS.map((column) => (
          <section
            className={`roadmap-column${draggingId ? ' roadmap-drop-ready' : ''}`}
            data-column={column.id}
            key={column.id}
            aria-labelledby={`roadmap-column-${column.id}`}
            onDragOver={(event) => { if (acceptsDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } }}
            onDrop={(event) => drop(event, column.id)}
          >
            <div className="roadmap-column-heading">
              <h3 id={`roadmap-column-${column.id}`}>{column.title}</h3>
              <span className="roadmap-count" aria-label={`${placement.columns[column.id].length} cards`}>{placement.columns[column.id].length}</span>
            </div>
            <div className="roadmap-cards">
              {column.id === 'suggested' && createCard}
              {placement.columns[column.id].map((id) => {
                const card = cards.get(id)!;
                return (
                  <article
                    className={`roadmap-card${draggingId === id ? ' roadmap-dragging' : ''}`}
                    data-card-id={id}
                    key={id}
                    draggable={ready && !saving}
                    aria-labelledby={`roadmap-card-${id}`}
                    onDragStart={(event) => {
                      if (!ready || pending.current) { event.preventDefault(); return; }
                      event.dataTransfer.setData(dragType, id);
                      event.dataTransfer.effectAllowed = 'move';
                      dragging.current = id;
                      setDraggingId(id);
                    }}
                    onDragEnd={() => { dragging.current = null; setDraggingId(null); }}
                    onDragOver={(event) => { if (acceptsDrag(event)) { event.preventDefault(); event.stopPropagation(); } }}
                    onDrop={(event) => drop(event, column.id, id)}
                  >
                    <span className="roadmap-track">{card.track}</span>
                    <h4 id={`roadmap-card-${id}`}><button type="button" aria-label={`Open ${card.title}`} onClick={() => setOpenedId(id)}>{card.title}</button></h4>
                    <p className="roadmap-recorded"><strong>Recorded progress</strong>{card.sourceStatus}</p>
                    {moveControl(card)}
                  </article>
                );
              })}
              {!placement.columns[column.id].length && column.id !== 'suggested' && <p className="roadmap-empty">No cards here yet.</p>}
            </div>
          </section>
        ))}
      </div>
      {opened && <Modal title={opened.title} onClose={closeCard}>
        <div className="roadmap-detail">
          <span className="roadmap-track">{opened.track}</span>
          <section><h3>Recorded progress</h3><p>{opened.sourceStatus}</p></section>
          <section><h3>Outcome</h3><p>{opened.outcome}</p></section>
          <section><h3>Checks</h3>{opened.checks.length ? <ul>{opened.checks.map((check, index) => <li key={index}>{check}</li>)}</ul> : <p>No checks recorded.</p>}</section>
          <section>
            <h3>Dependencies</h3>
            {opened.dependsOn.length ? <ul>{opened.dependsOn.map((id, index) => <li key={index}>{cards.has(id)
              ? <button type="button" className="text-button roadmap-dependency" onClick={() => setOpenedId(id)}>Open {cards.get(id)!.title}</button>
              : id}</li>)}</ul> : <p>No dependencies recorded.</p>}
          </section>
          <section><h3>Evidence</h3>{opened.sources.length ? <ul className="roadmap-evidence">{opened.sources.map((item, index) => {
            const href = roadmapEvidenceLink(item);
            return <li key={index}>{href ? <a href={href} target="_blank" rel="noreferrer">{item}</a> : item}</li>;
          })}</ul> : <p>No evidence recorded.</p>}</section>
          {!!opened.notes.length && <section><h3>Notes</h3><ul>{opened.notes.map((note, index) => <li key={index}>{note}</li>)}</ul></section>}
          <div className="roadmap-detail-planning">
            {moveControl(opened)}
            <p>Planning placement only. {opened.workspaceItem ? 'The work record stays in your workspace.' : 'Recorded progress and evidence come from the versioned project plan.'}</p>
            <div className="roadmap-reorder">
              <button
                type="button"
                className="secondary-button"
                disabled={!ready || saving || placement.columns[roadmapCardColumn(placement, opened.id)!].indexOf(opened.id) === 0}
                onClick={() => {
                  const column = roadmapCardColumn(placement, opened.id)!;
                  const ids = placement.columns[column];
                  move(opened.id, column, ids[ids.indexOf(opened.id) - 1]);
                }}
              >Move earlier</button>
              <button
                type="button"
                className="secondary-button"
                disabled={!ready || saving || placement.columns[roadmapCardColumn(placement, opened.id)!].at(-1) === opened.id}
                onClick={() => {
                  const column = roadmapCardColumn(placement, opened.id)!;
                  const ids = placement.columns[column];
                  move(opened.id, column, ids[ids.indexOf(opened.id) + 2]);
                }}
              >Move later</button>
            </div>
          </div>
          {warning && <p className="roadmap-warning" role="alert">{warning}</p>}
        </div>
      </Modal>}
    </section>
  );
}
