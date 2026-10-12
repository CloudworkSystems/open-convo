import type { DeskState } from '../domain/types';
import { validateState } from '../domain/validation';
import { IndexedDBRecord } from './indexeddb-record';

export const DESK_STORAGE_KEY = 'true-convo:desk:synthetic:v1';
export const DESK_DATABASE_NAME = DESK_STORAGE_KEY;
const WRITE_LOCK = `${DESK_STORAGE_KEY}:writer`;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type LockRunner = <T>(operation: () => T | Promise<T>) => Promise<T>;
export type LoadResult =
  | { kind: 'empty' }
  | { kind: 'ready'; state: DeskState; source?: 'transactional' | 'legacy' }
  | { kind: 'invalid'; error: string; raw: string }
  | { kind: 'unavailable'; error: string; legacyRaw?: string };
export type SaveResult =
  | { kind: 'saved'; state: DeskState }
  | { kind: 'conflict'; error: string; attemptedState: DeskState; currentState?: DeskState }
  | { kind: 'failed'; error: string; attemptedState: DeskState };

export interface WorkspaceRecord {
  read(): Promise<string | null>;
  update<T>(operation: (raw: string | null) => { result: T; raw?: string }): Promise<T>;
  subscribe?(changed: () => void): () => void;
}

function decode(raw: string | null): LoadResult {
  if (raw === null) return { kind: 'empty' };
  let decoded: unknown;
  try { decoded = JSON.parse(raw); }
  catch {
    return { kind: 'invalid', error: 'The synthetic workspace could not be decoded. Its original contents were kept; no replacement was saved.', raw };
  }
  const result = validateState(decoded);
  return result.valid ? { kind: 'ready', state: result.state } : { kind: 'invalid', error: result.error, raw };
}

function browserLockRunner(): LockRunner | undefined {
  if (typeof window === 'undefined' || typeof navigator === 'undefined' || !navigator.locks) return undefined;
  return <T>(operation: () => T | Promise<T>) => navigator.locks.request(WRITE_LOCK, operation);
}

/** Only the namespaced invented-data store. Never reads the previous Desk store or server API. */
export class BrowserRepository {
  private readonly storage?: StorageLike;
  private readonly withLock?: LockRunner;
  private readonly record?: WorkspaceRecord;
  private primarySeen = false;

  constructor(storage?: StorageLike, withLock?: LockRunner, record?: WorkspaceRecord) {
    if (storage) {
      this.storage = storage;
    } else {
      try {
        this.storage = typeof window === 'undefined' ? undefined : window.localStorage;
      } catch {
        this.storage = undefined;
      }
    }
    // A supplied Map/lock is the deterministic test adapter. The browser uses
    // one transactional record; a Web Lock cannot make renderer storage caches coherent.
    this.record = record ?? (storage ? undefined : new IndexedDBRecord(DESK_DATABASE_NAME));
    this.withLock = this.record ? undefined : withLock ?? browserLockRunner();
  }

  private loadLegacy(): LoadResult {
    if (!this.storage) return { kind: 'unavailable', error: 'Browser storage is unavailable. Changes cannot be saved here.' };
    let raw: string | null;
    try {
      raw = this.storage.getItem(DESK_STORAGE_KEY);
    } catch {
      return { kind: 'unavailable', error: 'Browser storage could not be read. Existing contents were not changed.' };
    }
    return decode(raw);
  }

  /** Synchronous access exists only for injected tests, never the browser authority. */
  load(): LoadResult {
    return this.record
      ? { kind: 'unavailable', error: 'The saved workspace must be opened through its transactional browser storage.' }
      : this.loadLegacy();
  }

  async loadLatest(): Promise<LoadResult> {
    if (!this.record) return this.loadLegacy();
    try {
      const raw = await this.record.read();
      if (raw !== null) this.primarySeen = true;
      // Once a primary record exists, legacy bytes cannot replace or mask it.
      const result = raw === null && !this.primarySeen ? this.loadLegacy() : decode(raw);
      return result.kind === 'ready' ? { ...result, source: raw === null ? 'legacy' : 'transactional' } : result;
    } catch {
      let legacyRaw: string | null = null;
      try { legacyRaw = this.storage?.getItem(DESK_STORAGE_KEY) ?? null; } catch { /* No backup is assumed. */ }
      return {
        kind: 'unavailable',
        error: 'The current transactional browser workspace could not be read. Saving is unavailable; no replacement was created.'
          + (legacyRaw === null ? '' : ' An earlier browser copy is available to download, but it may be older than your current work.'),
        ...(legacyRaw === null ? {} : { legacyRaw }),
      };
    }
  }

  subscribe(changed: () => void): () => void {
    const unsubscribe = this.record?.subscribe?.(changed) ?? (() => {});
    if (typeof window === 'undefined') return unsubscribe;
    const legacyChanged = (event: StorageEvent) => { if (event.key === null || event.key === DESK_STORAGE_KEY) changed(); };
    const visible = () => { if (document.visibilityState === 'visible') changed(); };
    window.addEventListener('storage', legacyChanged);
    window.addEventListener('focus', changed);
    document.addEventListener('visibilitychange', visible);
    return () => {
      unsubscribe();
      window.removeEventListener('storage', legacyChanged);
      window.removeEventListener('focus', changed);
      document.removeEventListener('visibilitychange', visible);
    };
  }

  async save(state: DeskState, expectedRevision: number | null): Promise<SaveResult> {
    // Capture before waiting for another writer; subsequent UI edits cannot change this attempt.
    const attemptedState = structuredClone(state);
    const failed = (error: string): SaveResult => ({ kind: 'failed', error, attemptedState });
    const validation = validateState(attemptedState);
    if (!validation.valid) return failed(`Save refused: ${validation.error}`);
    const attempt = (current: LoadResult): { result: SaveResult; raw?: string } => {
      if (current.kind === 'unavailable' || current.kind === 'invalid') return { result: failed(`Save refused: ${current.error}`) };
      const revision = current.kind === 'ready' ? current.state.revision : null;
      if (revision !== expectedRevision) {
        return { result: { kind: 'conflict', error: 'The saved workspace changed in another tab or was removed. Your attempted work is kept separately; reload or download it before continuing.', attemptedState, ...(current.kind === 'ready' ? { currentState: current.state } : {}) } };
      }
      if (expectedRevision !== null && attemptedState.revision <= expectedRevision) return { result: failed('Save refused: the attempted revision does not advance the saved workspace.') };
      return { result: { kind: 'saved', state: attemptedState }, raw: JSON.stringify(attemptedState) };
    };
    if (this.record) {
      try {
        const result = await this.record.update((raw) => {
          if (raw !== null) this.primarySeen = true;
          return attempt(raw === null && !this.primarySeen ? this.loadLegacy() : decode(raw));
        });
        if (result.kind === 'saved') this.primarySeen = true;
        return result;
      } catch {
        return failed('The browser workspace transaction failed. Your attempted work is still available in this tab; no successful save is claimed.');
      }
    }
    if (!this.withLock) return failed('This browser cannot coordinate safe writes between tabs. The preview is read-only; keep or download your attempted work.');
    try {
      return await this.withLock((): SaveResult => {
        const change = attempt(this.loadLegacy());
        if (change.raw === undefined) return change.result;
        try {
          this.storage!.setItem(DESK_STORAGE_KEY, change.raw);
        } catch {
          return failed('The synthetic workspace could not be saved. Browser storage may be full or blocked. Your attempted work is still available in this tab.');
        }
        return change.result;
      });
    } catch {
      return failed('The browser write lock failed. Your attempted work is still available; no successful save is claimed.');
    }
  }
}
