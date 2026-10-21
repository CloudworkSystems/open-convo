// Decides whether Codex has given an affirmative, clean result for a pull
// request's current head commit. Pure function: no network, easy to test.
//
// Only signals authored by Codex's own GitHub App count. Resolved review
// threads never count, because any account with write access can resolve them.
//
// Any account with write access can also edit Codex's comments (GitHub still
// shows Codex as the author). So a Codex comment counts only if Codex itself
// made every edit to it. Comments edited by anyone else, or whose editors
// can't be fully checked, are ignored: the gate fails closed.

export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
// The same app as GitHub's GraphQL API reports it: type Bot, no "[bot]" suffix.
// Only GitHub Apps are of type Bot, so a person can't pose as this editor.
export const CODEX_BOT_LOGIN = 'chatgpt-codex-connector';
// The owner's account. Only its dismissal of a Codex review clears the finding:
// any account with write access (the builder bot included) can dismiss reviews.
export const OWNER_LOGIN = 'CloudworkSystems';

const CLEAN_PHRASE = /didn['’]t find any major issues/i;
const REVIEWED_COMMIT = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i;
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
// Codex's machine-readable review state, kept in its summary comment.
const REVIEW_STATE = /<!--\s*codex-review-state:v1\s+(\{.*?\})\s*-->/s;
// Captures the completion time and the reviewed commit from the summary's
// "Code Review | ✅ Completed <time> | `commit`" row.
const SUMMARY_CODE_ROW = /Code Review\*\*\s*\|\s*✅\s*\*\*Completed\*\*\s*(?:<relative-time datetime="([^"]+)">)?[^|]*\|\s*`([0-9a-f]{7,40})`/i;

// GitHub usernames can't contain "[", so only the app itself can carry this
// login. (The reactions API reports the app's type as "User", so type isn't used.)
const isCodex = (user) => Boolean(user) && user.login === CODEX_LOGIN;
const matchesHead = (short, head) => Boolean(short) && short.length >= 7 && head.toLowerCase().startsWith(short.toLowerCase());
const time = (value) => Date.parse(value ?? '') || 0;
const isCodexEditor = (actor) => Boolean(actor) && actor.__typename === 'Bot' && actor.login === CODEX_BOT_LOGIN;

/**
 * True only if nobody but Codex ever edited this comment.
 *
 * `edit_history` is the comment's GraphQL edit record, attached by
 * codex-approved.mjs: { lastEditedAt, editor, userContentEdits: { totalCount,
 * nodes: [{ editor, deletedAt }] } }. The REST API alone can't name an editor,
 * so without that record a comment counts only if it was never edited at all.
 */
export function editedOnlyByCodex(comment) {
  const history = comment.edit_history;
  if (history === undefined) return !comment.updated_at || comment.updated_at === comment.created_at;
  if (!history) return false;
  const edits = history.userContentEdits;
  const count = edits?.totalCount ?? 0;
  if (!history.lastEditedAt && count === 0) return true;
  // Edited: every revision must be present and made by Codex. A missing,
  // partial or deleted revision means the editors can't all be checked.
  if (!count || !Array.isArray(edits.nodes) || edits.nodes.length !== count) return false;
  if (!isCodexEditor(history.editor)) return false;
  return edits.nodes.every((edit) => edit && !edit.deletedAt && isCodexEditor(edit.editor));
}

const fromCodex = (comment) => isCodex(comment.user) && editedOnlyByCodex(comment);

/**
 * True only if the timeline shows the owner's account dismissed this review.
 * `dismissals` are the pull request's `review_dismissed` issue events (REST),
 * each { actor: { login }, dismissed_review: { review_id } }. No matching
 * event, an unknown actor, or any matching event by someone else: false.
 */
export function dismissedByOwner(review, dismissals) {
  if (!Array.isArray(dismissals)) return false;
  const events = dismissals.filter((e) => e?.event === 'review_dismissed' && e.dismissed_review?.review_id === review.id);
  return events.length > 0 && events.every((e) => e.actor?.login === OWNER_LOGIN);
}

/**
 * @param {object} input
 * @param {string} input.headSha full 40-character head commit
 * @param {Array} input.comments issue comments on the pull request, each
 *   with `edit_history` (see editedOnlyByCodex)
 * @param {Array} input.reviews pull request reviews
 * @param {Array} input.reactions reactions on the pull request (issue)
 * @param {Array} input.dismissals `review_dismissed` issue events (see dismissedByOwner)
 * @returns {{approved: boolean, reason: string}}
 */
export function evaluateCodexSignal({ headSha, comments: allComments = [], reviews = [], reactions = [], dismissals = [] }) {
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) return { approved: false, reason: 'No head commit to check.' };
  const short = headSha.slice(0, 7);
  // Every signal below reads only Codex comments that Codex alone has edited.
  const comments = allComments.filter(fromCodex);

  // Codex posts findings as a pull request review tied to a commit. A
  // dismissed review still counts unless the owner's account dismissed it.
  const findings = reviews
    .filter((r) => isCodex(r.user) && r.commit_id === headSha && r.state !== 'APPROVED')
    .filter((r) => r.state !== 'DISMISSED' || !dismissedByOwner(r, dismissals))
    .map((r) => time(r.submitted_at));
  const lastFinding = findings.length ? Math.max(...findings) : 0;

  // Signal 1: Codex's clean-result comment naming the head commit.
  const clean = comments
    .filter((c) => isCodex(c.user) && CLEAN_PHRASE.test(c.body ?? ''))
    .filter((c) => matchesHead((c.body.match(REVIEWED_COMMIT) || [])[1], headSha))
    .map((c) => time(c.created_at));
  const lastClean = clean.length ? Math.max(...clean) : 0;
  // Strictly later: a tie with a finding fails closed.
  if (lastClean && lastClean > lastFinding) {
    return { approved: true, reason: `Codex found no major issues on ${short}.` };
  }

  // Signal 2: Codex's own review state in its summary comment says the code
  // review of this exact head completed with no findings at all. (Not
  // "unresolved": anyone with write access can resolve a finding.) Timed by
  // the comment's last edit, and it must be later than any finding.
  const stateTimes = comments
    .filter((c) => isCodex(c.user) && (c.body ?? '').includes(SUMMARY_MARKER))
    .map((c) => {
      const m = (c.body ?? '').match(REVIEW_STATE);
      if (!m) return 0;
      let state;
      try { state = JSON.parse(m[1]); } catch { return 0; }
      const code = state?.code_review;
      const clean = code && code.commit_sha === headSha && code.status === 'completed' && code.has_any_findings === false;
      return clean ? time(c.updated_at ?? c.created_at) : 0;
    });
  const lastState = stateTimes.length ? Math.max(...stateTimes) : 0;
  if (lastState && lastState > lastFinding) {
    return { approved: true, reason: `Codex's review state shows no findings on ${short}.` };
  }

  // Signal 3: Codex's 👍 on the pull request, posted after its summary shows
  // the code review of the head commit completed, with no findings after it.
  // A 👍 left over from an earlier commit predates that completion, so it
  // never counts for a new head.
  const headCompletions = comments
    .filter((c) => isCodex(c.user) && (c.body ?? '').includes(SUMMARY_MARKER))
    .map((c) => c.body.match(SUMMARY_CODE_ROW))
    .filter((m) => m && matchesHead(m[2], headSha))
    .map((m) => time(m[1]));
  const completedAt = headCompletions.length ? Math.max(...headCompletions) : 0;
  const thumbs = reactions
    .filter((r) => isCodex(r.user) && r.content === '+1')
    .map((r) => time(r.created_at));
  const lastThumb = thumbs.length ? Math.max(...thumbs) : 0;
  if (completedAt && lastThumb > completedAt && lastThumb > lastFinding) {
    return { approved: true, reason: `Codex reacted thumbs-up after reviewing ${short}.` };
  }

  if (lastFinding) return { approved: false, reason: `Codex left findings on ${short}; waiting for a clean round.` };
  return { approved: false, reason: `Waiting for Codex's clean review of ${short}.` };
}
