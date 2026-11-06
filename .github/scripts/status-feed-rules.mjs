// The status feed's state rules (docs/plans/status-feed.md, part 1). Pure
// functions: no network, so every rule is tested on invented pull requests in
// tests/status-feed.test.mjs. status-feed.mjs reads GitHub and calls these.
//
// Every open pull request gets exactly one state: Blocked, Returned, Needs
// You, Under Way, Checked or Unknown. When more than one fits, the first in
// that order wins, with one exception from the plan's November 4 revision: a
// pull request with the review-loop flag shows as Needs You ahead of Returned
// and Under Way, unless it is Blocked or everything Checked asks for is there.
//
// Evidence counts the way the PR keeper's "Who counts" rule counts it
// (docs/scheduled-tasks/pr-keeper.md): reviews, plan checks and the keeper's
// own comment only from cloudwork-bot, the owner's approvals only from
// CloudworkSystems, Codex only from its own app. Where these rules and the
// keeper's steps D to F disagree about whether a pull request is ready, the
// keeper's file wins and this file is the bug.

import { CODEX_LOGIN, OWNER_LOGIN, dismissedByOwner } from './codex-signal.mjs';
import { RISK_LABEL, RISK_ESCALATE_LABEL } from './risk-check.mjs';

export const BOT_LOGIN = 'cloudwork-bot';
export const DEPENDABOT_LOGIN = 'dependabot[bot]';
export const KEEPER_ISSUE = 52;
export const STATES = ['Blocked', 'Returned', 'Needs You', 'Under Way', 'Checked', 'Unknown'];
// The feed and its views say "not refreshed since" after this long.
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
// The judge has this long after Codex's review before the builder fixes the findings.
export const JUDGE_WINDOW_MS = 2 * 60 * 60 * 1000;
// A review loop: this many Codex rounds in a row, on different commits, each with a new P0 or P1.
export const LOOP_ROUNDS = 3;
// GitHub lists at most this many changed files per comparison (pr-keeper.md step D).
export const COMPARE_FILE_LIMIT = 300;

const time = (value) => Date.parse(value ?? '') || 0;
const short = (sha) => (sha ?? '').slice(0, 7);
const byBot = (item) => item?.user?.login === BOT_LOGIN;
const isCodex = (user) => Boolean(user) && user.login === CODEX_LOGIN;
const PRIORITY = /!\[P(\d) Badge\]/;

// ------------------------------------------------------------ reading review text

/** True when a text names this commit by its short or full sha. */
export function namesCommit(body, sha) {
  if (!/^[0-9a-f]{40}$/i.test(sha ?? '')) return false;
  return (body ?? '').toLowerCase().includes(sha.slice(0, 7).toLowerCase());
}

/**
 * True when a cloudwork-bot text has the form step D counts as an independent
 * review: it ends with "— GrokBot review", or begins (after any heading marks)
 * "Independent review" or "Delta review". A fresh Claude review begins
 * "Independent review" too.
 */
export function isReviewForm(body) {
  const text = (body ?? '').trim();
  if (/—\s*GrokBot review$/.test(text)) return true;
  return /^(?:Independent review|Delta review)\b/.test(text.replace(/^[#\s]+/, ''));
}

// The privacy and security checklist block (docs/agent-process.md): a heading
// that names it and its ten numbered answers.
const CHECKLIST_HEADING = /privacy and security checklist/i;

/** The text before the checklist block, where a review's findings are. */
function findingsPart(body) {
  const text = body ?? '';
  const at = text.search(CHECKLIST_HEADING);
  return at === -1 ? text : text.slice(0, at);
}

/** True when the text carries the privacy and security checklist block. */
export function hasChecklist(body) {
  const text = body ?? '';
  const at = text.search(CHECKLIST_HEADING);
  if (at === -1) return false;
  const block = text.slice(at);
  for (let n = 1; n <= 10; n += 1) {
    if (!new RegExp(`^\\s*(?:[-*]\\s+)?(?:\\*\\*)?${n}[.)]`, 'm').test(block)) return false;
  }
  return true;
}

/** True when a review asks the owner to see a risk (a `risk-escalate:` line). */
export function hasEscalation(body) {
  return /^\s*[-*]?\s*`?risk-escalate:/m.test(body ?? '');
}

/**
 * The severities of the findings a review lists, most severe first: each
 * line before the checklist block whose first word, after any list mark,
 * number or bold, is P0, P1, P2 or P3. "No P1 or P2 findings" and
 * "clean, no P0 or P1" list none.
 */
export function findingSeverities(body) {
  const out = [];
  for (const line of findingsPart(body).split('\n')) {
    const m = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#+\s+)*(?:\*\*|__)?\[?P([0-3])\b/);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

/** A plan check's verdict: 'passed', 'missing', or null when the text isn't one. */
export function planCheckVerdict(body) {
  const first = (body ?? '').trim().split('\n')[0].replace(/^[#\s]+/, '');
  if (!/^Plan check\b/.test(first)) return null;
  return /:\s*(?:\*\*)?passed\b/i.test(first) ? 'passed' : 'missing';
}

// ------------------------------------------------------------ the keeper's comment

// The waiting lines the keeper writes, and which state each one means.
const WAITING = [
  { pattern: /plan changed after the owner's yes/, state: 'Under Way', next: 'The thread that asked you checks the change', whose: 'Claude thread' },
  { pattern: /rules change changed after the owner's yes/, state: 'Under Way', next: 'The thread that asked you checks the change', whose: 'Claude thread' },
  { pattern: /plan waiting on the owner's yes/, state: 'Needs You', next: 'Your yes in the Claude thread', whose: 'you' },
  { pattern: /rules change waiting on the owner's yes/, state: 'Needs You', next: 'Your yes in the Claude thread', whose: 'you' },
  { pattern: /site change waiting on the owner's yes/, state: 'Needs You', next: 'Your yes for the website change', whose: 'you' },
  { pattern: /risk escalation waiting on the owner/, state: 'Needs You', next: 'Approve the latest commit after reading the escalation', whose: 'you' },
  { pattern: /Dependabot waiting on the owner/, state: 'Needs You', next: 'Your approval on GitHub', whose: 'you' },
  { pattern: /waiting on the coordinator/, state: 'Under Way', next: 'The coordinator switches on auto-merge', whose: 'coordinator' },
  { pattern: /needs a fresh Claude review from another agent/, state: 'Under Way', next: 'The coordinator asks for a fresh Claude review', whose: 'coordinator' },
  { pattern: /independent review has no privacy and security checklist block/, state: 'Under Way', next: 'The reviewer adds the checklist block', whose: 'independent reviewer' },
  { pattern: /^(?:auto-merge|merge) refused:/, state: 'Under Way', next: 'The coordinator looks at why GitHub refused', whose: 'coordinator' },
];

/**
 * The keeper's latest "Not working" comment on #52: cloudwork-bot's comment
 * that starts "## Not working" and carries "— PR keeper (scheduled)". The
 * keeper updates its oldest one in place, so that one is read.
 */
export function keeperComment(comments = []) {
  return comments
    .filter((c) => byBot(c) && /^\s*## Not working/.test(c.body ?? '') && (c.body ?? '').includes('— PR keeper (scheduled)'))
    .sort((a, b) => time(a.created_at) - time(b.created_at))[0] ?? null;
}

/**
 * The lines of the keeper's comment that name pull requests.
 * `silent`: "<agent> silent on [#N](…/pull/N)" lines (issue links and the
 * "not set up" lines never count). `waiting`: the waiting lines above.
 */
export function parseKeeper(comment) {
  const silent = [];
  const waiting = [];
  if (!comment) return { checkedAt: null, silent, waiting };
  for (const raw of (comment.body ?? '').split('\n')) {
    const line = raw.replace(/^\s*[-*]\s+/, '').trim();
    const s = line.match(/^(.+?) silent on \[#(\d+)\]\([^)\s]*\/pull\/(\d+)\)/);
    if (s && s[2] === s[3]) {
      silent.push({ number: Number(s[2]), agent: s[1].trim(), text: line });
      continue;
    }
    const w = line.match(/^\[#(\d+)\]\([^)\s]*\/pull\/(\d+)\)\s+(.*)$/);
    if (!w || w[1] !== w[2]) continue;
    const kind = WAITING.find((k) => k.pattern.test(w[3]));
    if (kind) waiting.push({ number: Number(w[1]), text: w[3], state: kind.state, next: kind.next, whose: kind.whose });
  }
  return { checkedAt: comment.updated_at ?? comment.created_at ?? null, silent, waiting };
}

/**
 * Whether a "silent on" line still stands (plan requirement 7): it is
 * ignored once the head has moved on since the keeper checked, or once the
 * step it names is covered (Codex has reviewed the head, or a counted
 * independent review of the head is there).
 */
export function silenceStands(line, { headCommittedAt, keeperCheckedAt, codexReviewedHead, review }) {
  if (time(headCommittedAt) > time(keeperCheckedAt)) return false;
  // A builder's silence ("Claude builder", "Codex builder") stands until it pushes.
  if (/\bbuilder$/i.test(line.agent)) return true;
  if (/^Codex\b/.test(line.agent)) return !codexReviewedHead;
  if (/^(GrokBot|independent review|Gemini)\b/i.test(line.agent)) return !review;
  return true;
}

/**
 * Whether a waiting line still speaks for the head: the keeper wrote it about
 * the commit it saw, so a push after its check makes the line stale.
 */
export function waitingStands(line, { headCommittedAt, keeperCheckedAt }) {
  return time(headCommittedAt) <= time(keeperCheckedAt);
}

// ------------------------------------------------------------ Codex

/** Codex reviews that leave findings, minus those the owner's account dismissed. */
export function codexFindingReviews(reviews = [], dismissals = []) {
  return reviews
    .filter((r) => isCodex(r.user) && r.state !== 'APPROVED')
    .filter((r) => r.state !== 'DISMISSED' || !dismissedByOwner(r, dismissals));
}

/**
 * How many Codex rounds in a row, on different commits and counting back
 * from its newest review, each raised a P0 or P1. A review counts as raising
 * one when one of its own finding comments carries a P0 or P1 badge.
 * Rounds are 0 when Codex is clean on a head it left no findings on: the
 * loop is over.
 */
export function loopRounds({ headSha, reviews = [], reviewComments = [], dismissals = [], codexCleanOnHead = false }) {
  const finding = codexFindingReviews(reviews, dismissals);
  const severe = (review) => reviewComments.some((c) => c.pull_request_review_id === review.id && !c.in_reply_to_id && isCodex(c.user)
    && (() => { const m = (c.body ?? '').match(PRIORITY); return m && Number(m[1]) <= 1; })());
  // Each commit's latest review time, newest first.
  const commits = new Map();
  for (const r of finding) commits.set(r.commit_id, Math.max(commits.get(r.commit_id) ?? 0, time(r.submitted_at)));
  const order = [...commits.entries()].sort((a, b) => b[1] - a[1]).map(([sha]) => sha);
  if (!order.length) return 0;
  if (order[0] !== headSha && codexCleanOnHead) return 0;
  let rounds = 0;
  for (const sha of order) {
    if (!finding.some((r) => r.commit_id === sha && severe(r))) break;
    rounds += 1;
  }
  return rounds;
}

// ------------------------------------------------------------ independent review and plan check

/** Every cloudwork-bot comment and review body, with its time. */
function botTexts({ comments = [], reviews = [] }) {
  return [
    ...comments.filter(byBot).map((c) => ({ body: c.body ?? '', at: time(c.created_at) })),
    ...reviews.filter(byBot).map((r) => ({ body: r.body ?? '', at: time(r.submitted_at) })),
  ].sort((a, b) => a.at - b.at);
}

/**
 * The commit named by the newest independent review on the pull request
 * (step D's R), or null. Only a sha among the pull request's own commits counts.
 */
export function reviewedCommit({ comments, reviews, commits = [] }) {
  const reviewsFound = botTexts({ comments, reviews }).filter((t) => isReviewForm(t.body));
  for (const t of reviewsFound.reverse()) {
    for (const token of t.body.match(/\b[0-9a-f]{7,40}\b/gi) ?? []) {
      const hit = commits.find((c) => c.sha.toLowerCase().startsWith(token.toLowerCase()));
      if (hit) return hit.sha;
    }
  }
  return null;
}

/**
 * Whether two comparisons against main show the same changes (step D's SAME):
 * neither is cut at GitHub's file limit, the first isn't empty, and they match.
 * Each is a compare response's `files`.
 */
export function sameChanges(filesA, filesB) {
  if (!Array.isArray(filesA) || !Array.isArray(filesB)) return false;
  if (filesA.length === 0 || filesA.length >= COMPARE_FILE_LIMIT || filesB.length >= COMPARE_FILE_LIMIT) return false;
  const shape = (files) => JSON.stringify(files.map((f) => [f.filename, f.status, f.sha, f.patch ?? null]));
  return shape(filesA) === shape(filesB);
}

/**
 * The independent review that counts for the head: the newest cloudwork-bot
 * review naming the head, or else, when `sameAs` is a commit whose changes
 * are the head's (step D's SAME), the newest one naming that commit.
 * Returns { at, severities, checklist, escalation } or null.
 */
export function countedReview({ comments, reviews, headSha, sameAs = null }) {
  const texts = botTexts({ comments, reviews }).filter((t) => isReviewForm(t.body));
  const pick = (sha) => texts.filter((t) => namesCommit(t.body, sha)).at(-1);
  const found = pick(headSha) ?? (sameAs ? pick(sameAs) : undefined);
  if (!found) return null;
  return { at: found.at, severities: findingSeverities(found.body), checklist: hasChecklist(found.body), escalation: hasEscalation(found.body) };
}

/** The time of the newest cloudwork-bot review of the head with a `risk-escalate` line, or 0. */
export function escalationAt({ comments, reviews, headSha }) {
  const hits = botTexts({ comments, reviews }).filter((t) => isReviewForm(t.body) && namesCommit(t.body, headSha) && hasEscalation(t.body));
  return hits.length ? hits.at(-1).at : 0;
}

/** The newest plan check naming the head: { verdict, checklist } or null. */
export function planCheck({ comments, reviews, headSha }) {
  const found = botTexts({ comments, reviews }).filter((t) => planCheckVerdict(t.body) && namesCommit(t.body, headSha)).at(-1);
  return found ? { verdict: planCheckVerdict(found.body), checklist: hasChecklist(found.body) } : null;
}

// ------------------------------------------------------------ the owner

/** The owner's newest deciding review: APPROVED, CHANGES_REQUESTED or DISMISSED. */
function ownerLatest(reviews = [], after = 0) {
  return reviews
    .filter((r) => r.user?.login === OWNER_LOGIN && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state) && time(r.submitted_at) > after)
    .sort((a, b) => time(a.submitted_at) - time(b.submitted_at))
    .at(-1) ?? null;
}

/**
 * True while the owner's approval of the protected paths stands (plan
 * requirement 8): his newest deciding review is an approval. An update from
 * main doesn't void it; GitHub's dismissal does.
 */
export function ownerApprovalStands(reviews) {
  return ownerLatest(reviews)?.state === 'APPROVED';
}

/** True when the owner approved the head after the escalating review (step F). */
export function ownerApprovedAfter(reviews, at, headSha) {
  const latest = ownerLatest(reviews, at);
  return latest?.state === 'APPROVED' && latest.commit_id === headSha;
}

// ------------------------------------------------------------ the state

const builderName = (builder) => ({ 'agent: claude': 'Claude builder', 'agent: codex': 'Codex builder', 'agent: grokbot': 'GrokBot builder', Dependabot: 'Dependabot' }[builder] ?? 'the builder');

/**
 * The one state of a pull request, from facts status-feed.mjs gathers.
 *
 * @param {object} f
 * @param {boolean} f.draft
 * @param {boolean} f.conflict mergeable_state is "dirty"
 * @param {boolean} f.mergeUnknown GitHub hasn't worked out yet whether it conflicts
 * @param {string} f.builder 'agent: claude' | 'agent: codex' | 'agent: grokbot' | 'Dependabot' | 'none'
 * @param {'success'|'failure'|'pending'|null} f.tests the `tests` check on the head
 * @param {'success'|'pending'|'failure'|null} f.codexApproved the `codex-approved` status on the head
 * @param {boolean} f.codexReviewedHead Codex left a review of the head, or is clean on it
 * @param {boolean} f.codexCleanOnHead Codex's own signal is clean on the head
 * @param {boolean} f.codexFindingsOnHead Codex left findings on the head
 * @param {boolean} f.judgeDue the triage judge has the head's findings (codex-triage.mjs)
 * @param {boolean} f.judgeSaidReal the judge rated a finding on the head as real
 * @param {number} f.loopRounds see loopRounds()
 * @param {boolean} f.reviewNeeded an independent review is required (agent: claude, agent: codex, no label)
 * @param {object|null} f.review see countedReview()
 * @param {boolean} f.planCheckNeeded an outside module (agent: grokbot or agent: codex changing packages/)
 * @param {object|null} f.planCheck see planCheck()
 * @param {boolean} f.protectedNeeded it changes owner-protected paths
 * @param {boolean} f.ownerApproval the owner's approval stands
 * @param {boolean} f.openedByOwner opened from the owner's account
 * @param {string[]} f.labels
 * @param {boolean} f.escalated a risk-escalate label, or a risk-escalate line in a review of the head
 * @param {boolean} f.escalationApproved the owner approved the head after that review
 * @param {boolean} f.autoMerge auto-merge is on
 * @param {Array} f.silent the keeper's "silent on" lines that still stand
 * @param {Array} f.waiting the keeper's waiting lines for this pull request
 * @returns {{state: string, rule: string, next: string, whose: string, approvalNeeded: boolean, loop: number}}
 */
export function stateOf(f) {
  const labels = f.labels ?? [];
  const approvalNeeded = Boolean(f.protectedNeeded && !f.ownerApproval);
  const loop = (f.loopRounds ?? 0) >= LOOP_ROUNDS ? f.loopRounds : 0;
  const builder = builderName(f.builder);
  const out = (state, rule, next, whose) => ({ state, rule, next, whose, approvalNeeded, loop });

  // 1. Blocked: a "silent on" line in the keeper's latest comment that still stands.
  if (f.silent?.length) {
    return out('Blocked', `The PR keeper's report says: ${f.silent[0].text}`, 'The PR keeper restarts or covers it; the coordinator steps in if it stays quiet', 'PR keeper');
  }

  const reviewOpen = f.review ? f.review.severities.filter((s) => s <= 2) : [];
  const riskHeld = labels.includes(RISK_LABEL);
  const escalationPending = Boolean(f.escalated && !f.escalationApproved);
  const escalationLabelLeft = Boolean(f.escalationApproved && labels.includes(RISK_ESCALATE_LABEL));
  const waitingYou = (f.waiting ?? []).find((w) => w.state === 'Needs You');
  const waitingOthers = (f.waiting ?? []).find((w) => w.state === 'Under Way');
  // The keeper judges whether each finding was fixed or answered on the pull
  // request (step F). It switches auto-merge on, or lists the pull request as
  // waiting on the coordinator, only once they all are, so either one means
  // the review's findings are answered.
  const answered = Boolean(f.autoMerge || (f.waiting ?? []).some((w) => ['coordinator', 'independent reviewer'].includes(w.whose)));

  const checked = !f.draft && !f.conflict && !f.mergeUnknown && f.tests === 'success' && f.codexApproved === 'success'
    && !approvalNeeded && !riskHeld && !escalationPending && !escalationLabelLeft && !waitingYou && !waitingOthers
    && (!f.reviewNeeded || (f.review && f.review.checklist && (reviewOpen.length === 0 || answered)))
    && (!f.planCheckNeeded || (f.planCheck && f.planCheck.verdict === 'passed' && f.planCheck.checklist));
  const checkedRule = f.autoMerge
    ? 'Tests, Codex and every review it needs are clean on the latest commit. Auto-merge is on.'
    : 'Tests, Codex and every review it needs are clean on the latest commit. Auto-merge is off.';
  const checkedOut = () => out('Checked', checkedRule, f.autoMerge ? 'GitHub merges it' : 'The coordinator switches on auto-merge', f.autoMerge ? 'GitHub' : 'coordinator');

  // The review-loop flag (revision, November 4): Needs You ahead of Returned
  // and Under Way, unless everything Checked asks for is there.
  if (loop) {
    if (checked) return checkedOut();
    return out('Needs You', `Codex raised a new P0 or P1 on each of the last ${loop} commits.`, 'Your call: accept the findings or narrow the plan', 'you');
  }

  // 2. Returned: the builder owes the next move.
  if (f.draft) return out('Returned', 'It is still a draft.', `${builder} finishes it and marks it ready`, builder);
  if (f.tests === 'failure') return out('Returned', 'Tests are red on the latest commit.', `${builder} fixes the failing test`, builder);
  if (f.conflict) return out('Returned', 'It has merge conflicts with main.', `${builder} updates it from main`, builder);
  if (f.codexApproved !== 'success' && !f.codexCleanOnHead && f.codexFindingsOnHead && !f.judgeDue) {
    const rule = f.judgeSaidReal ? 'The triage judge rated a Codex finding on the latest commit as real.' : 'Codex left findings on the latest commit.';
    return out('Returned', rule, `${builder} fixes or answers the findings`, builder);
  }
  if (reviewOpen.length && !answered) {
    return out('Returned', `The independent review of the latest commit has an open P${reviewOpen[0]}.`, `${builder} fixes or answers it`, builder);
  }
  if (f.planCheckNeeded && f.planCheck?.verdict === 'missing') {
    return out('Returned', 'The plan check of the latest commit lists something missing.', `${builder} adds what the plan check lists`, builder);
  }

  // 3. Needs You: only the owner can move it.
  if (approvalNeeded) {
    const rule = f.openedByOwner
      ? 'It changes protected files and was opened from your account, so GitHub won\'t let you approve it.'
      : 'It changes protected files and needs your approval.';
    return out('Needs You', rule, f.openedByOwner ? 'Reopen it from cloudwork-bot, then approve it' : 'Your approval on GitHub', 'you');
  }
  if (riskHeld) return out('Needs You', 'Risk hold: it adds an outside host, a dependency, a Mac permission or a key name.', 'Read the risk comment, then approve the latest commit', 'you');
  if (escalationPending) return out('Needs You', 'A reviewer escalated a risk for you to see.', 'Read the escalation, then approve the latest commit', 'you');
  if (waitingYou) return out('Needs You', `The PR keeper lists it: ${waitingYou.text}`, waitingYou.next, 'you');

  // 4. Under Way: someone other than the builder or the owner has it.
  if (escalationLabelLeft) return out('Under Way', 'You approved it after the escalation; the label is still on.', 'The coordinator removes the label', 'coordinator');
  if (waitingOthers) return out('Under Way', `The PR keeper lists it: ${waitingOthers.text}`, waitingOthers.next, waitingOthers.whose);
  if (f.tests !== 'success') return out('Under Way', 'Tests are still running on the latest commit.', 'Tests finish', 'tests');
  if (f.mergeUnknown) return out('Under Way', 'GitHub is still checking whether it conflicts with main.', 'GitHub finishes the check', 'GitHub');
  if (f.codexApproved !== 'success') {
    if (f.judgeDue) return out('Under Way', 'Only minor Codex findings are left; the triage judge rates them.', 'The triage judge rates the findings', 'triage judge');
    if (!f.codexReviewedHead) return out('Under Way', 'Codex hasn\'t reviewed the latest commit yet.', 'Codex reviews it', 'Codex');
    if (f.codexCleanOnHead) return out('Under Way', 'Codex is clean; the codex-approved check hasn\'t caught up yet.', 'The codex-approved check runs again', 'codex-approved');
  }
  if (f.reviewNeeded && !f.review) return out('Under Way', 'The independent review of the latest commit hasn\'t arrived.', 'GrokBot or a fresh Claude review', 'independent reviewer');
  if (f.reviewNeeded && !f.review.checklist) return out('Under Way', 'The independent review has no privacy and security checklist block.', 'The reviewer adds the checklist block', 'independent reviewer');
  if (f.planCheckNeeded && !f.planCheck) return out('Under Way', 'The plan check of the latest commit hasn\'t been posted.', 'The coordinator checks it against its plan', 'coordinator');
  if (f.planCheckNeeded && !f.planCheck.checklist) return out('Under Way', 'The plan check has no privacy and security checklist block.', 'The coordinator adds the checklist block', 'coordinator');

  // 5. Checked, then 6. Unknown.
  if (checked) return checkedOut();
  return out('Unknown', 'No rule fits this pull request, so it shows here instead of hiding.', 'Someone adds the rule this needs', 'nobody yet');
}

// ------------------------------------------------------------ the feed

/** Day key (YYYY-MM-DD) in the owner's time zone. */
export function easternDay(ms) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * The whole feed: the rows (each with how long it has been in its state,
 * carried over from the previous feed, and "also red on" for a failing job
 * shared with other pull requests) and the totals on top, each with the
 * count it rests on.
 *
 * @param {object} input
 * @param {Array} input.rows each { number, state, failingJobs, ... }
 * @param {object|null} input.previous the last feed
 * @param {Array} input.merged merged_at times of recently merged pull requests
 * @param {string|null} input.keeperCheckedAt
 * @param {number} input.now
 */
export function buildFeed({ rows = [], previous = null, merged = [], keeperCheckedAt = null, now = Date.now() }) {
  const before = new Map((previous?.rows ?? []).map((r) => [r.number, r]));
  const out = rows
    .map((row) => {
      const old = before.get(row.number);
      const since = old && old.state === row.state && old.since ? old.since : new Date(now).toISOString();
      const alsoRedOn = (row.failingJobs ?? []).length
        ? rows.filter((o) => o.number !== row.number && (o.failingJobs ?? []).some((j) => row.failingJobs.includes(j))).map((o) => o.number).sort((a, b) => a - b)
        : [];
      return { ...row, since, alsoRedOn };
    })
    .sort((a, b) => STATES.indexOf(a.state) - STATES.indexOf(b.state) || a.number - b.number);
  const byState = Object.fromEntries(STATES.map((s) => [s, out.filter((r) => r.state === s).length]));
  const today = easternDay(now);
  const mergedTimes = merged.map(time).filter(Boolean);
  const mergedToday = mergedTimes.filter((t) => easternDay(t) === today).length;
  const mergedWeek = mergedTimes.filter((t) => now - t <= 7 * 24 * 60 * 60 * 1000).length;
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    keeperCheckedAt,
    totals: {
      open: out.length,
      byState,
      waitingOnYou: { value: byState['Needs You'], of: out.length },
      inFlight: { value: byState.Returned + byState['Under Way'], of: out.length },
      mergedToday: { value: mergedToday, of: mergedToday },
      mergedLast7Days: { value: mergedWeek, of: mergedWeek },
    },
    rows: out,
  };
}

/** True when a feed is older than the views allow ("not refreshed since"). */
export function feedIsStale(feed, now = Date.now()) {
  return !feed?.generatedAt || now - time(feed.generatedAt) > STALE_AFTER_MS;
}

/**
 * True when a new feed says nothing the previous one didn't, apart from its
 * time, and the previous one is under 50 minutes old: then the run writes
 * nothing, so the data branch doesn't grow a commit per event.
 */
export function unchangedSince(previous, next, now = Date.now()) {
  if (!previous?.generatedAt || now - time(previous.generatedAt) >= 50 * 60 * 1000) return false;
  const strip = (feed) => JSON.stringify({ ...feed, generatedAt: null });
  return strip(previous) === strip(next);
}
