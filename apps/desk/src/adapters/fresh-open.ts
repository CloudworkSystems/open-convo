/**
 * Whether this browser tab has shown the Desk before. A tab that hasn't (a new
 * window or tab) opens on a blank session; a reload of
 * the same tab keeps its own screen. The mark is only "1": it holds no work.
 * Native visits never call this: they keep nothing in the browser.
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
