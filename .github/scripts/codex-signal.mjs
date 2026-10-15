// Decides whether Codex has given an affirmative, clean result for a pull
// request's current head commit. Pure function: no network, easy to test.
//
// Only signals authored by Codex's own GitHub App count. Resolved review
// threads never count, because any account with write access can resolve them.

export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';

const CLEAN_PHRASE = /didn['’]t find any major issues/i;
const REVIEWED_COMMIT = /\*\*Reviewed commit:\*\*\s*`([0-9a-f]{7,40})`/i;
const SUMMARY_MARKER = '<!-- codex-pull-request-review-summary -->';
const SUMMARY_CODE_ROW = /Code Review\*\*\s*\|\s*✅\s*\*\*Completed\*\*[^|]*\|\s*`([0-9a-f]{7,40})`/i;

// GitHub usernames can't contain "[", so only the app itself can carry this
// login. (The reactions API reports the app's type as "User", so type isn't used.)
const isCodex = (user) => Boolean(user) && user.login === CODEX_LOGIN;
const matchesHead = (short, head) => Boolean(short) && short.length >= 7 && head.toLowerCase().startsWith(short.toLowerCase());
const time = (value) => Date.parse(value ?? '') || 0;

/**
 * @param {object} input
 * @param {string} input.headSha full 40-character head commit
 * @param {Array} input.comments issue comments on the pull request
 * @param {Array} input.reviews pull request reviews
 * @param {Array} input.reactions reactions on the pull request (issue)
 * @returns {{approved: boolean, reason: string}}
 */
export function evaluateCodexSignal({ headSha, comments = [], reviews = [], reactions = [] }) {
  if (!/^[0-9a-f]{40}$/i.test(headSha ?? '')) return { approved: false, reason: 'No head commit to check.' };
  const short = headSha.slice(0, 7);

  // Codex posts findings as a pull request review tied to a commit.
  const findings = reviews
    .filter((r) => isCodex(r.user) && r.commit_id === headSha && r.state !== 'APPROVED' && r.state !== 'DISMISSED')
    .map((r) => time(r.submitted_at));
  const lastFinding = findings.length ? Math.max(...findings) : 0;

  // Signal 1: Codex's clean-result comment naming the head commit.
  const clean = comments
    .filter((c) => isCodex(c.user) && CLEAN_PHRASE.test(c.body ?? ''))
    .filter((c) => matchesHead((c.body.match(REVIEWED_COMMIT) || [])[1], headSha))
    .map((c) => time(c.created_at));
  const lastClean = clean.length ? Math.max(...clean) : 0;
  if (lastClean && lastClean >= lastFinding) {
    return { approved: true, reason: `Codex found no major issues on ${short}.` };
  }

  // Signal 2: Codex's 👍 on the pull request, with its summary showing the code
  // review completed on the head commit and no findings posted after the 👍.
  const summaryOnHead = comments.some((c) => {
    if (!isCodex(c.user) || !(c.body ?? '').includes(SUMMARY_MARKER)) return false;
    return matchesHead((c.body.match(SUMMARY_CODE_ROW) || [])[1], headSha);
  });
  const thumbs = reactions
    .filter((r) => isCodex(r.user) && r.content === '+1')
    .map((r) => time(r.created_at));
  const lastThumb = thumbs.length ? Math.max(...thumbs) : 0;
  if (summaryOnHead && lastThumb && lastThumb >= lastFinding) {
    return { approved: true, reason: `Codex reacted 👍 after reviewing ${short}.` };
  }

  if (lastFinding) return { approved: false, reason: `Codex left findings on ${short}; waiting for a clean round.` };
  return { approved: false, reason: `Waiting for Codex's clean review of ${short}.` };
}
