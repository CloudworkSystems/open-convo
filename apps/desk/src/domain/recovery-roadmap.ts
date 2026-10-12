import type { WorkItem } from './types';

export const ROADMAP_COLUMNS = [
  { id: 'suggested', title: 'Suggested' },
  // Keep the stored ID so existing placements remain valid.
  { id: 'next', title: 'Planned' },
  { id: 'in-progress', title: 'In progress' },
  { id: 'review', title: 'Review & try' },
  { id: 'finished', title: 'Finished' },
] as const;

export type RoadmapColumn = (typeof ROADMAP_COLUMNS)[number]['id'];

export interface RecoveryCard {
  id: string;
  title: string;
  track: string;
  column: RoadmapColumn;
  sourceStatus: string;
  outcome: string;
  checks: string[];
  dependsOn: string[];
  sources: string[];
  notes: string[];
  /** A view of the shared work record, rather than a second copy of its data. */
  workspaceItem?: true;
}

export interface RecoveryRoadmap {
  schemaVersion: 1;
  title: string;
  updatedAt: string;
  cards: RecoveryCard[];
}

export interface RoadmapPlacement {
  schemaVersion: 1;
  columns: Record<RoadmapColumn, string[]>;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 10_000;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(text);
}

export function isRoadmapColumn(value: unknown): value is RoadmapColumn {
  return ROADMAP_COLUMNS.some((column) => column.id === value);
}

/** The shipped project plan is independent of the sample workspace schema. */
export function validateRecoveryRoadmap(value: unknown): RecoveryRoadmap | null {
  if (!object(value) || value.schemaVersion !== 1 || !text(value.title)
    || !text(value.updatedAt) || !Array.isArray(value.cards) || value.cards.length > 500) return null;
  const seen = new Set<string>();
  for (const card of value.cards) {
    if (!object(card) || !text(card.id) || card.id.length > 180 || seen.has(card.id)
      || !text(card.title) || !text(card.track) || !isRoadmapColumn(card.column)
      || !text(card.sourceStatus) || !text(card.outcome) || !strings(card.checks)
      || !strings(card.dependsOn) || !strings(card.sources) || !strings(card.notes)) return null;
    seen.add(card.id);
  }
  return value as unknown as RecoveryRoadmap;
}

export function defaultRoadmapPlacement(cards: readonly RecoveryCard[]): RoadmapPlacement {
  const columns: RoadmapPlacement['columns'] = { suggested: [], next: [], 'in-progress': [], review: [], finished: [] };
  for (const card of cards) columns[card.column].push(card.id);
  return { schemaVersion: 1, columns };
}

/** Accept removed IDs as stale plan entries; they never become visible cards. */
export function reconcileRoadmapPlacement(value: unknown, cards: readonly RecoveryCard[], retainUnknownIds = false): RoadmapPlacement | null {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'columns,schemaVersion'
    || value.schemaVersion !== 1 || !object(value.columns)
    || !['finished,in-progress,next,review', 'finished,in-progress,next,review,suggested'].includes(Object.keys(value.columns).sort().join(','))) return null;
  const seen = new Set<string>();
  const known = new Set(cards.map((card) => card.id));
  const placement = defaultRoadmapPlacement([]);
  for (const { id: column } of ROADMAP_COLUMNS) {
    // Older four-column records are read as-is; loading never saves a migration.
    const ids = column === 'suggested' && value.columns.suggested === undefined ? [] : value.columns[column];
    if (!Array.isArray(ids) || ids.length > 1000) return null;
    for (const id of ids) {
      if (!text(id) || id.length > 180 || seen.has(id)) return null;
      seen.add(id);
      if (known.has(id) || retainUnknownIds) placement.columns[column].push(id);
    }
  }
  for (const card of cards) {
    if (!seen.has(card.id)) placement.columns[card.column].push(card.id);
  }
  return placement;
}

/** Every shared work item participates, independent of the selected folder. */
export function workspaceRoadmapCards(items: readonly WorkItem[]): RecoveryCard[] {
  return items.map((item) => ({
    id: item.id,
    title: item.title,
    track: 'Work',
    column: item.roadmapColumn === 'suggested' ? 'suggested'
      : item.status === 'active' ? 'in-progress' : item.status === 'returned' ? 'review' : 'next',
    sourceStatus: item.roadmapColumn === 'suggested' ? 'Suggested by you'
      : item.status === 'active' ? 'Active work' : item.status === 'returned' ? 'Returned work' : 'Planned work',
    outcome: item.title,
    checks: [],
    dependsOn: [],
    sources: [],
    notes: [],
    workspaceItem: true,
  }));
}

/** Moving a planning card changes no source status, evidence, or workspace record. */
export function moveRoadmapCard(
  placement: RoadmapPlacement,
  cards: readonly RecoveryCard[],
  id: string,
  column: RoadmapColumn,
  beforeId?: string,
): RoadmapPlacement {
  if (!cards.some((card) => card.id === id) || !isRoadmapColumn(column) || beforeId === id) return placement;
  if (beforeId && !placement.columns[column].includes(beforeId)) return placement;
  const next = defaultRoadmapPlacement([]);
  for (const { id: key } of ROADMAP_COLUMNS) next.columns[key] = placement.columns[key].filter((item) => item !== id);
  const target = next.columns[column];
  target.splice(beforeId ? target.indexOf(beforeId) : target.length, 0, id);
  return ROADMAP_COLUMNS.every(({ id: key }) => placement.columns[key].join('\0') === next.columns[key].join('\0'))
    ? placement : next;
}

export function roadmapCardColumn(placement: RoadmapPlacement, id: string): RoadmapColumn | undefined {
  return ROADMAP_COLUMNS.find((column) => placement.columns[column.id].includes(id))?.id;
}

/** A downward drop lands after its target; upward and cross-column drops land before it. */
export function roadmapDropBeforeId(placement: RoadmapPlacement, id: string, column: RoadmapColumn, targetId?: string): string | undefined {
  if (!targetId) return undefined;
  const ids = placement.columns[column];
  const origin = ids.indexOf(id);
  const target = ids.indexOf(targetId);
  return origin >= 0 && target > origin ? ids[target + 1] : targetId;
}

// Evidence links point at Open Convo's own public-safe project files.
export const ROADMAP_EVIDENCE_REF = 'main';
const repositorySources = new Set([
  'PLAN.md',
  'AGENTS.md',
  'apps/desk/README.md',
  'packages/clarity/README.md',
]);

/** Evidence links resolve only recorded project files, never an arbitrary URL. */
export function roadmapEvidenceLink(source: string): string | null {
  const path = source.split(': ', 1)[0];
  if (!repositorySources.has(path)) return null;
  return `https://github.com/CloudworkSystems/open-convo/blob/${ROADMAP_EVIDENCE_REF}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
