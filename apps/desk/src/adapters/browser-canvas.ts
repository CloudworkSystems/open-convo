import { emptyCanvasLayout, parseCanvasLayout, type CanvasLayoutRecord } from '../domain/canvas-layout';
import { IndexedDBRecord } from './indexeddb-record';

export const DESK_CANVAS_KEY = 'true-convo:desk:canvas-layout:v1';
export const CANVAS_INVALID_WARNING = 'Saved Canvas layout could not be read. Its original contents were kept. Changes here will last only for this visit.';
export const CANVAS_SAVE_WARNING = 'Canvas layout could not be saved. Your changes remain visible for this visit; the previous saved layout was kept.';
export const CANVAS_STALE_WARNING = 'Canvas layout changed in another tab. Your changes remain visible for this visit; the latest saved layout was kept. Reload to use the saved layout.';
export const CANVAS_DATABASE_WARNING = 'Canvas storage is unavailable. Changes here will last only for this visit.';

type RecordAuthority = Pick<IndexedDBRecord, 'read' | 'update' | 'subscribe'>;
export type CanvasSaveResult = { kind: 'saved'; layout: CanvasLayoutRecord } | { kind: 'failed'; warning: string };

/** Separate presentation geometry; never revises workspace records or their IDs. */
export class BrowserCanvas {
  private readonly database: RecordAuthority;
  private blockedWarning: string | null = null;
  private observedSavedRecord = false;

  constructor(database?: RecordAuthority) {
    this.database = database ?? new IndexedDBRecord(DESK_CANVAS_KEY);
  }

  async loadLatest(): Promise<{ layout: CanvasLayoutRecord; warning: string | null }> {
    try {
      const raw = await this.database.read();
      if (raw === null) {
        if (this.observedSavedRecord) {
          this.blockedWarning = CANVAS_STALE_WARNING;
          return { layout: emptyCanvasLayout(), warning: this.blockedWarning };
        }
        return { layout: emptyCanvasLayout(), warning: this.blockedWarning };
      }
      this.observedSavedRecord = true;
      let layout: CanvasLayoutRecord | null = null;
      try { layout = parseCanvasLayout(JSON.parse(raw)); } catch { /* Retain canonical bytes unchanged. */ }
      if (!layout) {
        this.blockedWarning = CANVAS_INVALID_WARNING;
        return { layout: emptyCanvasLayout(), warning: this.blockedWarning };
      }
      return { layout, warning: this.blockedWarning };
    } catch {
      this.blockedWarning = CANVAS_DATABASE_WARNING;
      return { layout: emptyCanvasLayout(), warning: this.blockedWarning };
    }
  }

  subscribe(changed: () => void): () => void { return this.database.subscribe(changed); }

  async save(layout: CanvasLayoutRecord, expectedRevision: number): Promise<CanvasSaveResult> {
    if (this.blockedWarning) return { kind: 'failed', warning: this.blockedWarning };
    // Copy the candidate before waiting for the serialized transaction.
    const candidate = parseCanvasLayout(layout);
    if (!candidate || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return { kind: 'failed', warning: CANVAS_SAVE_WARNING };
    try {
      return await this.database.update<CanvasSaveResult>((raw) => {
        let current: CanvasLayoutRecord | null = raw === null ? emptyCanvasLayout() : null;
        if (raw !== null) {
          this.observedSavedRecord = true;
          try { current = parseCanvasLayout(JSON.parse(raw)); } catch { /* Preserve unreadable bytes. */ }
        }
        const warning = !current ? CANVAS_INVALID_WARNING
          : (raw === null && this.observedSavedRecord) || current.revision !== expectedRevision ? CANVAS_STALE_WARNING : null;
        if (warning) {
          this.blockedWarning = warning;
          return { result: { kind: 'failed', warning } };
        }
        const saved = { ...candidate, revision: expectedRevision + 1 };
        if (!parseCanvasLayout(saved)) return { result: { kind: 'failed', warning: CANVAS_SAVE_WARNING } };
        return { raw: JSON.stringify(saved), result: { kind: 'saved', layout: saved } };
      }).then((result) => {
        if (result.kind === 'saved') this.observedSavedRecord = true;
        return result;
      });
    } catch {
      this.blockedWarning = CANVAS_SAVE_WARNING;
      return { kind: 'failed', warning: this.blockedWarning };
    }
  }
}
