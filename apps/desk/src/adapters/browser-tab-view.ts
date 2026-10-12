import type { DeskState } from '../domain/types';
import { validateState } from '../domain/validation';
import type { StorageLike } from './browser-repository';

export const DESK_TAB_VIEW_KEY = 'true-convo:desk:synthetic:tab-view:v1';
const warning = 'This tab’s screen and theme may reset on reload. Work saving is handled separately; check the save status.';

/** Reload convenience for this tab only; never writes the shared workspace. */
export class BrowserTabView {
  private readonly storage?: StorageLike;

  constructor(storage?: StorageLike) {
    try {
      this.storage = storage ?? (typeof window === 'undefined' ? undefined : window.sessionStorage);
    } catch {
      this.storage = undefined;
    }
  }

  load(state: DeskState): { state: DeskState; warning: string | null } {
    try {
      if (!this.storage) return { state, warning };
      const raw = this.storage.getItem(DESK_TAB_VIEW_KEY);
      if (raw === null) return { state, warning: null };
      const view: unknown = JSON.parse(raw);
      if (!view || typeof view !== 'object' || Array.isArray(view)
        || Object.keys(view).sort().join(',') !== 'preferences,schemaVersion,selection') {
        return { state, warning };
      }
      const stored = view as { schemaVersion: unknown; selection: unknown; preferences: unknown };
      if (stored.schemaVersion !== 1) return { state, warning };
      // A session may have been refiled by another tab since this view was cached.
      // Its authoritative current folder follows its ID, without a repair write.
      let selection = stored.selection;
      if (selection && typeof selection === 'object' && !Array.isArray(selection)
        && Object.keys(selection).sort().join(',') === 'goalId,route,sessionId') {
        const cached = selection as { goalId: unknown; route: unknown; sessionId: unknown };
        const session = state.sessions.find((session) => session.id === cached.sessionId);
        if (session) selection = { ...cached, goalId: session.goalId };
      }
      const result = validateState({ ...state, selection, preferences: stored.preferences });
      return result.valid ? { state: result.state, warning: null } : { state, warning };
    } catch {
      return { state, warning };
    }
  }

  save(state: DeskState): string | null {
    try {
      if (!this.storage) return warning;
      this.storage.setItem(DESK_TAB_VIEW_KEY, JSON.stringify({
        schemaVersion: 1,
        selection: state.selection,
        preferences: state.preferences,
      }));
      return null;
    } catch {
      return warning;
    }
  }
}
