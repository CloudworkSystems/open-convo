/**
 * Whether this browser tab has shown the Desk before. A tab that hasn't (a new
 * window or tab) opens on a blank session; a reload of
 * the same tab keeps its own screen. The mark is only "1": it holds no work.
 * Native visits never call this: they keep nothing in the browser.
 *
 * A tab made with the browser's Duplicate command copies its source's
 * session storage, so it keeps the source's screen, like the rest of a
 * duplicate. The Desk itself never opens Desk tabs, and a link opened in a
 * new tab without an opener starts with empty storage, so it opens blank.
 */
export const DESK_TAB_OPENED_KEY = 'true-convo:desk:tab-opened:v1';

let answer: boolean | undefined;

/** Read once per page load, so React's repeated effects get the same answer. Browser preview only. */
export function openedBefore(): boolean {
  answer ??= readMark();
  return answer;
}

function readMark(): boolean {
  try {
    const storage = window.sessionStorage;
    const seen = storage.getItem(DESK_TAB_OPENED_KEY) !== null;
    if (!seen) storage.setItem(DESK_TAB_OPENED_KEY, '1');
    return seen;
  } catch {
    return false;
  }
}

/** The Mac window's mark: the browsing context's name, which outlives a reload. */
export const DESK_NATIVE_OPENED_NAME = 'true-convo-desk-opened';

interface NativeOpenSignals {
  name: string;
  readonly performance?: { getEntriesByType(type: string): ArrayLike<object> };
}

/**
 * Whether this Mac window's web view has shown the Desk before, so a reload
 * (including the host's reload after a crashed web process) keeps the screen
 * while a new window opens blank. Uses only the document's navigation type
 * and the window's name, never browser storage. Sets the name mark.
 */
export function nativeOpenedBefore(win: NativeOpenSignals): boolean {
  let reloaded = false;
  try { reloaded = Array.from(win.performance?.getEntriesByType('navigation') ?? []).some((entry) => (entry as { type?: unknown }).type === 'reload'); }
  catch { reloaded = false; }
  const named = win.name === DESK_NATIVE_OPENED_NAME;
  try { win.name = DESK_NATIVE_OPENED_NAME; } catch { /* keep the answer */ }
  return reloaded || named;
}
