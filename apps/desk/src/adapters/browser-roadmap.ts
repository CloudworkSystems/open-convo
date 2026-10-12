import {
  defaultRoadmapPlacement,
  isRoadmapColumn,
  moveRoadmapCard,
  reconcileRoadmapPlacement,
  type RecoveryCard,
  type RoadmapPlacement,
  type RoadmapColumn,
} from '../domain/recovery-roadmap';
import type { LockRunner, StorageLike } from './browser-repository';
import { IndexedDBRecord, IndexedDBRecordFormatError } from './indexeddb-record';

export const DESK_ROADMAP_KEY = 'true-convo:desk:roadmap:v1';
export const ROADMAP_INVALID_WARNING = 'Saved roadmap placement could not be read. Its original contents were kept. Changes here will last only for this visit.';
export const ROADMAP_SAVE_WARNING = 'Roadmap placement could not be saved. The previous saved placement was kept; changes here will last only for this visit.';
export const ROADMAP_STALE_WARNING = 'Saved roadmap placement changed in another tab. Its latest placement was kept; changes here will last only for this visit. Reload to use the saved view.';
export const ROADMAP_LOCK_WARNING = 'This browser cannot coordinate roadmap saves between tabs. Changes here will last only for this visit.';
export const ROADMAP_DATABASE_WARNING = 'The roadmap database is unavailable. Changes here will last only for this visit; saved placement was kept.';
export const ROADMAP_RECOVERY_WARNING = 'The current saved roadmap placement is unavailable. This view uses the retained older copy; changes here will last only for this visit.';
const unavailableWarning = 'Browser storage is unavailable for roadmap placement. Changes here will last only for this visit.';
const writeLock = `${DESK_ROADMAP_KEY}:writer`;

export interface RoadmapMove {
  id: string;
  column: RoadmapColumn;
  beforeId?: string;
}

export type RoadmapSaveResult =
  | { kind: 'saved'; placement: RoadmapPlacement }
  | { kind: 'failed'; warning: string };

function browserLockRunner(): LockRunner | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.locks) return undefined;
  return <T>(operation: () => T | Promise<T>) => navigator.locks.request(writeLock, operation);
}

/** This browser's planning view only. Never reads or revises shared sample work. */
export class BrowserRoadmap {
  private readonly storage?: StorageLike;
  private readonly withLock?: LockRunner;
  private readonly database?: IndexedDBRecord;
  private blockedWarning: string | null = null;

  constructor(storage?: StorageLike, withLock?: LockRunner) {
    try {
      this.storage = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    } catch {
      this.storage = undefined;
    }
    this.withLock = withLock ?? browserLockRunner();
    if (!storage && !withLock && typeof window !== 'undefined') {
      let factory: IDBFactory | undefined;
      try { factory = window.indexedDB; } catch { /* Fail closed without a transactional authority. */ }
      this.database = new IndexedDBRecord(DESK_ROADMAP_KEY, factory);
    }
  }

  async loadLatest(cards: readonly RecoveryCard[]): Promise<{ placement: RoadmapPlacement; warning: string | null }> {
    if (!this.database) return this.load(cards);
    try {
      const current = await this.database.read();
      if (current === null) return this.load(cards);
      let placement: RoadmapPlacement | null = null;
      try { placement = reconcileRoadmapPlacement(JSON.parse(current), cards); } catch { /* Preserve invalid canonical bytes. */ }
      if (placement) return { placement, warning: this.withLock ? null : ROADMAP_LOCK_WARNING };
      this.blockedWarning = ROADMAP_INVALID_WARNING;
      return { placement: defaultRoadmapPlacement(cards), warning: this.blockedWarning };
    } catch (error) {
      if (error instanceof IndexedDBRecordFormatError) {
        this.blockedWarning = ROADMAP_INVALID_WARNING;
        return { placement: defaultRoadmapPlacement(cards), warning: this.blockedWarning };
      }
      const backup = this.legacy(cards);
      this.blockedWarning = backup.hasSavedCopy ? ROADMAP_RECOVERY_WARNING : ROADMAP_DATABASE_WARNING;
      return { placement: backup.placement, warning: this.blockedWarning };
    }
  }

  subscribe(changed: () => void): () => void {
    return this.database?.subscribe(changed) ?? (() => undefined);
  }

  load(cards: readonly RecoveryCard[]): { placement: RoadmapPlacement; warning: string | null } {
    const { placement, warning } = this.legacy(cards);
    return { placement, warning };
  }

  private legacy(cards: readonly RecoveryCard[], retainUnknownIds = false): { placement: RoadmapPlacement; warning: string | null; hasSavedCopy: boolean } {
    const fallback = defaultRoadmapPlacement(cards);
    if (!this.storage) return { placement: fallback, warning: unavailableWarning, hasSavedCopy: false };
    try {
      const raw = this.storage.getItem(DESK_ROADMAP_KEY);
      if (raw === null) return { placement: fallback, warning: this.withLock ? null : ROADMAP_LOCK_WARNING, hasSavedCopy: false };
      const placement = reconcileRoadmapPlacement(JSON.parse(raw), cards, retainUnknownIds);
      if (placement) return { placement, warning: this.withLock ? null : ROADMAP_LOCK_WARNING, hasSavedCopy: true };
    } catch { /* Keep unreadable or malformed contents untouched. */ }
    this.blockedWarning = ROADMAP_INVALID_WARNING;
    return { placement: fallback, warning: this.blockedWarning, hasSavedCopy: false };
  }

  async saveMove(move: RoadmapMove, cards: readonly RecoveryCard[]): Promise<RoadmapSaveResult> {
    const failed = (warning: string): RoadmapSaveResult => ({ kind: 'failed', warning });
    if (this.blockedWarning) return failed(this.blockedWarning);
    if (!this.database && !this.storage) return failed(unavailableWarning);
    if (!this.withLock) return failed(ROADMAP_LOCK_WARNING);
    // Capture the request before waiting; never serialize an entire stale board.
    const requested = { ...move };
    if (!cards.some((card) => card.id === requested.id) || !isRoadmapColumn(requested.column)) return failed(ROADMAP_SAVE_WARNING);
    if (this.database) {
      try {
        return await this.withLock(() => this.database!.update<RoadmapSaveResult>((current) => {
          // The old localStorage record is recovery input only. Once the
          // transaction has a canonical record, it never consults that copy.
          let loaded;
          if (current === null) loaded = this.legacy(cards, true);
          else {
            let placement: RoadmapPlacement | null = null;
            try { placement = reconcileRoadmapPlacement(JSON.parse(current), cards, true); } catch { /* Preserve canonical bytes. */ }
            loaded = { placement, warning: null };
          }
          if (loaded.warning || !loaded.placement) {
            this.blockedWarning = loaded.warning ?? ROADMAP_INVALID_WARNING;
            return { result: failed(this.blockedWarning) };
          }
          if (requested.beforeId && !loaded.placement.columns[requested.column].includes(requested.beforeId)) {
            this.blockedWarning = ROADMAP_STALE_WARNING;
            return { result: failed(this.blockedWarning) };
          }
          const placement = moveRoadmapCard(loaded.placement, cards, requested.id, requested.column, requested.beforeId);
          // Another tab may not have received a newly-created shared work item
          // yet. Keep its stored placement without exposing unknown card IDs.
          return { raw: JSON.stringify(placement), result: { kind: 'saved', placement: reconcileRoadmapPlacement(placement, cards)! } };
        }));
      } catch {
        this.blockedWarning = ROADMAP_SAVE_WARNING;
        return failed(this.blockedWarning);
      }
    }
    const write = (): RoadmapSaveResult => {
      try {
        const current = this.storage!.getItem(DESK_ROADMAP_KEY);
        let latest = defaultRoadmapPlacement(cards);
        if (current !== null) {
          let decoded: RoadmapPlacement | null = null;
          try { decoded = reconcileRoadmapPlacement(JSON.parse(current), cards, true); } catch { /* malformed */ }
          if (!decoded) {
            this.blockedWarning = ROADMAP_INVALID_WARNING;
            return failed(this.blockedWarning);
          }
          latest = decoded;
        }
        if (requested.beforeId && !latest.columns[requested.column].includes(requested.beforeId)) {
          this.blockedWarning = ROADMAP_STALE_WARNING;
          return failed(this.blockedWarning);
        }
        const placement = moveRoadmapCard(latest, cards, requested.id, requested.column, requested.beforeId);
        const raw = JSON.stringify(placement);
        this.storage!.setItem(DESK_ROADMAP_KEY, raw);
        return { kind: 'saved', placement: reconcileRoadmapPlacement(placement, cards)! };
      } catch {
        this.blockedWarning = ROADMAP_SAVE_WARNING;
        return failed(this.blockedWarning);
      }
    };
    try {
      return await this.withLock(write);
    } catch {
      this.blockedWarning = ROADMAP_SAVE_WARNING;
      return failed(this.blockedWarning);
    }
  }
}
