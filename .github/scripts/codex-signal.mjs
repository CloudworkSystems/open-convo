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
//
// The owner can also accept the remaining findings on one exact head commit
// with an "owner-accepts-findings" note (see ownerAcceptance). That satisfies
// only this check; `tests` and code-owner approval still apply.

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
const isOwnerEditor = (actor) => Boolean(actor) && actor.__typename === 'User' && actor.login === OWNER_LOGIN;

/**
 * True only if nobody but Codex ever edited this comment.
 *
 * `edit_history` is the comment's GraphQL edit record, attached by
 * codex-approved.mjs: { lastEditedAt, editor, userContentEdits: { totalCount,
 * nodes: [{ editor, deletedAt }] } }. The REST API alone can't name an editor,
 * so without that record a comment counts only if it was never edited at all.
 */
export function editedOnlyByCodex(comment) {
  return editedOnlyBy(comment, isCodexEditor);
}

function editedOnlyBy(comment, isEditor) {
  const history = comment.edit_history;
  if (history === undefined) return !comment.updated_at || comment.updated_at === comment.created_at;
  if (!history) return false;
  const edits = history.userContentEdits;
  const count = edits?.totalCount ?? 0;
  if (!history.lastEditedAt && count === 0) return true;
  // Edited: every revision must be present and made by Codex. A missing,
  // partial or deleted revision means the editors can't all be checked.
  if (!count || !Array.isArray(edits.nodes) || edits.nodes.length !== count) return false;
  if (!isEditor(history.editor)) return false;
  return edits.nodes.every((edit) => edit && !edit.deletedAt && isEditor(edit.editor));
}

// The owner's note, in either of two exact forms, each alone on its line:
//   owner-accepts-findings <full 40-character head sha>
//   <!-- owner-accepts-findings sha=<full 40-character head sha> -->
// Lowercase hex only; anything else on the line makes it malformed. The line
// must start at the margin and be its own paragraph: a blank line (or the
// start or end of the comment) before and after it. That rejects quotes and
// their lazy continuation lines, list items, indented code and inline code.
// Lines inside fenced code blocks and multi-line HTML blocks (comments,
// <pre>, <script>, <style>, <textarea>, <?...?>, <!...>, CDATA) never count,
// so an example or commented-out note can't accept anything.
const ACCEPT_LINE = /^(?:owner-accepts-findings ([0-9a-f]{40})|<!-- owner-accepts-findings sha=([0-9a-f]{40}) -->)[ \t]*$/;
// GFM fences: a backtick opener's info string can't contain a backtick (then
// it isn't a fence at all); a closer is the same character, at least as long,
// followed only by spaces.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const fenceOpener = (line) => {
  const m = line.match(FENCE_OPEN);
  return m && (m[1][0] === '~' || !m[2].includes('`')) ? m[1] : null;
};
// Multi-line HTML blocks as GitHub Flavored Markdown defines them: how one
// starts, and the text that ends it.
const HTML_BLOCKS = [
  [/^ {0,3}<(?:pre|script|style|textarea)(?:\s|>|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];
const blank = (line) => line === undefined || /^[ \t]*$/.test(line);

/** The note's sha on each qualifying line (see above). */
function acceptedShas(body) {
  const lines = (body ?? '').split(/\r?\n/);
  const shas = [];
  let fence = null;
  let htmlEnd = null;
  lines.forEach((line, i) => {
    if (fence) {
      // A fence closes with the same character, at least as long.
      const f = line.match(FENCE_CLOSE);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return;
    }
    if (htmlEnd) {
      if (htmlEnd.test(line)) htmlEnd = null;
      return;
    }
    const m = line.match(ACCEPT_LINE);
    if (m) {
      if (blank(lines[i - 1]) && blank(lines[i + 1])) shas.push(m[1] ?? m[2]);
      return;
    }
    const f = fenceOpener(line);
    if (f) { fence = f; return; }
    for (const [open, close] of HTML_BLOCKS) {
      const o = line.match(open);
      // A block that also closes on its own first line hides nothing more.
      if (o) { if (!close.test(line.slice(o[0].length))) htmlEnd = close; break; }
    }
    // An HTML comment opened mid-line and not closed on it: fail closed and
    // treat everything up to its end as hidden.
    if (!htmlEnd) {
      const at = line.lastIndexOf('<!--');
      if (at >= 0 && !line.slice(at + 4).includes('-->')) htmlEnd = /-->/;
    }
  });
  return shas;
}

/**
 * True if the owner accepted the remaining Codex findings on this exact head.
 * Counts only an issue comment authored by the owner's account, whose edit
 * record was read and shows no editor but the owner, naming the full head
 * sha. Never for a pull request opened by the owner's account: Claude
 * sessions can open pull requests under it, and the owner shouldn't wave
 * those through.
 */
export function ownerAcceptance({ headSha, prAuthor, comments = [] }) {
  if (!prAuthor || prAuthor === OWNER_LOGIN) return false;
  return comments.some((c) => {
    if (c?.user?.login !== OWNER_LOGIN || c.user.type !== 'User') return false;
    // The edit record must have been read (fail closed if it wasn't).
    if (c.edit_history === undefined || !editedOnlyBy(c, isOwnerEditor)) return false;
    return acceptedShas(c.body).includes(headSha);
  });
}

const fromCodex = (comment) => isCodex(comment.user) && editedOnlyByCodex(comment);

// The commit a completed code review in Codex's review state names, if any.
function reviewStateSha(body) {
  const m = (body ?? '').match(REVIEW_STATE);
  if (!m) return null;
  try {
    const code = JSON.parse(m[1])?.code_review;
    return code?.status === 'completed' ? code.commit_sha : null;
  } catch { return null; }
}

/**
 * True only if the timeline shows the owner's account dismissed this review.
 * `dismissals` are the pull request's `review_dismissed` issue events (REST),
 * each { actor: { login }, dismissed_review: { review_id } }. No matching
 * event, an unknown actor, or any matching event by someone else: false.
 * GitHub documents `review_id` as a string while reviews carry a numeric
 * `id` (this repo's own events return a number), so both are compared as text.
 */
const sameId = (a, b) => a != null && b != null && String(a) === String(b);

export function dismissedByOwner(review, dismissals) {
  if (!Array.isArray(dismissals)) return false;
  const events = dismissals.filter((e) => e?.event === 'review_dismissed' && sameId(e.dismissed_review?.review_id, review.id));
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
 * @param {string} input.prAuthor login of the account that opened the pull request
 * @returns {{approved: boolean, reason: string}}
 */
export function evaluateCodexSignal({ headSha, comments: allComments = [], reviews = [], reactions = [], dismissals = [], prAuthor } = {}) {
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

  // The owner's explicit acceptance of whatever Codex left on this head. Only
  // once Codex has reviewed this exact head: a review of it, or its trusted
  // summary naming it. A note alone on an unreviewed head stays pending.
  const codexReviewedHead = reviews.some((r) => isCodex(r.user) && r.commit_id === headSha)
    || headCompletions.length > 0
    || comments.some((c) => (c.body ?? '').includes(SUMMARY_MARKER) && reviewStateSha(c.body) === headSha);
  if (codexReviewedHead && ownerAcceptance({ headSha, prAuthor, comments: allComments })) {
    return { approved: true, reason: `Owner accepted remaining findings on ${headSha}.` };
  }

  if (lastFinding) return { approved: false, reason: `Codex left findings on ${short}; waiting for a clean round.` };
  return { approved: false, reason: `Waiting for Codex's clean review of ${short}.` };
}
