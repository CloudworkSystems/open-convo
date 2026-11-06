import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_LOGIN, OWNER_LOGIN } from '../codex-signal.mjs';
import { ACTIONS_LOGIN, triageEligibility } from '../codex-triage.mjs';
import {
  decideReviewLoop, roundsSince, isPlanPullRequest, readState, ownerResume, haltSummary,
  ensureLabel, applyReviewLoop, LABEL, PLAN_LIMIT, CODE_LIMIT,
} from '../review-loop.mjs';

const sha = (n) => n.toString(16).padStart(40, '0');
const HEAD = sha(100);
const codex = { login: CODEX_LOGIN, type: 'Bot' };
const ownerUser = { login: OWNER_LOGIN, type: 'User' };
const actions = { login: ACTIONS_LOGIN, type: 'Bot' };
const bot = { login: 'cloudwork-bot', type: 'User' };
const at = (minutes) => new Date(Date.UTC(2026, 10, 6, 0, 0) + minutes * 60_000).toISOString();
const NOW = Date.parse(at(1000));

const review = (commit, minutes, extra = {}) => ({ id: minutes, user: codex, commit_id: commit, state: 'COMMENTED', submitted_at: at(minutes), html_url: `https://example.test/r/${minutes}`, ...extra });
// Rounds 1..n on commits sha(1)..sha(n), the last one on the head.
const roundsOf = (n, { head = HEAD, start = 0 } = {}) => Array.from({ length: n }, (_, i) => review(i === n - 1 ? head : sha(start + i + 1), start + (i + 1) * 10));
const pr = (extra = {}) => ({ number: 7, state: 'open', draft: false, base: { ref: 'main', repo: { html_url: 'https://github.com/o/r' } }, head: { sha: HEAD }, user: bot, ...extra });
const CODE = ['apps/mac/x.swift'];
const PLAN = ['docs/plans/x.md'];
const actionsEdits = { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } };
const ownerEdits = { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } };
const stateComment = (state, extra = {}) => ({ id: 55, user: actions, created_at: at(1), body: `x\n<!-- review-loop:v1 ${JSON.stringify(state)} -->`, edit_history: actionsEdits, ...extra });
const ownerComment = (body, minutes, extra = {}) => ({ id: 900 + minutes, user: ownerUser, created_at: at(minutes), body, edit_history: ownerEdits, ...extra });
const decide = (extra) => decideReviewLoop({ pr: pr(), defaultBranch: 'main', files: CODE, now: NOW, ...extra });
const haltedState = (extra = {}) => ({ halted: true, haltedAt: at(500), haltedHead: HEAD, since: null, pushed: [], rounds: CODE_LIMIT, limit: CODE_LIMIT, ...extra });
const summary = (commit, done) => ({
  user: codex, created_at: at(0), updated_at: done, edit_history: { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } },
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {"code_review":{"commit_sha":"${commit}","has_any_findings":false,"status":"completed"}} -->`,
});
const thumbSummary = (commit, done) => ({
  user: codex, created_at: at(0), edit_history: { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } },
  body: `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${done}">${done}</relative-time> | \`${commit.slice(0, 7)}\` | New commits |`,
});

test('plan and code pull requests are told apart', () => {
  assert.equal(isPlanPullRequest(['docs/a.md', 'PLAN.md', 'STATUS.md']), true);
  assert.equal(isPlanPullRequest(['docs/a.md', 'AGENTS.md']), false);
  assert.equal(isPlanPullRequest(['docs/a.md'], false), false, 'an incomplete file list counts as code');
  assert.equal(isPlanPullRequest([]), false);
});

test('rounds count the way the triage judge counts them', () => {
  const reviews = [...roundsOf(4), review(sha(2), 25), review(sha(9), 99, { user: bot }), review(sha(8), 98, { state: 'APPROVED' })];
  const judge = triageEligibility({ headSha: HEAD, prAuthor: 'cloudwork-bot', fromFork: false, reviews });
  assert.equal(roundsSince({ reviews }), 4);
  assert.equal(judge.rounds, 4);
  assert.equal(roundsSince({ reviews, since: Date.parse(at(25)) }), 2);
});

test('a code pull request halts at its limit and not before', () => {
  assert.equal(decide({ reviews: roundsOf(CODE_LIMIT - 1) }).halted, false);
  const d = decide({ reviews: roundsOf(CODE_LIMIT) });
  assert.equal(d.halted, true);
  assert.equal(d.addLabel, true);
  assert.match(d.comment, /Stuck in review/);
  assert.match(d.comment, new RegExp(`owner-accepts-findings ${HEAD}`));
  assert.match(d.comment, /https:\/\/example\.test\/r\//, 'links the newest Codex review');
  assert.equal(readState([stateComment(JSON.parse(d.comment.match(/review-loop:v1 (\{.*\}) -->/)[1]))]).state.halted, true);
});

test('a plan pull request halts at the plan limit', () => {
  assert.equal(decide({ files: PLAN, reviews: roundsOf(PLAN_LIMIT - 1) }).halted, false);
  assert.equal(decide({ files: PLAN, reviews: roundsOf(PLAN_LIMIT) }).halted, true);
});

test('no halt: owner\'s own pull request, a draft, another base, or a clean head', () => {
  const reviews = roundsOf(CODE_LIMIT);
  assert.equal(decide({ pr: pr({ user: ownerUser }), reviews }).halted, false);
  assert.equal(decide({ pr: pr({ draft: true }), reviews }).halted, false);
  assert.equal(decide({ pr: pr({ base: { ref: 'other' } }), reviews }).halted, false);
  assert.equal(decide({ reviews, comments: [summary(HEAD, at(900))] }).halted, false);
  assert.equal(decide({ reviews, comments: [summary(HEAD, at(900))] }).comment, null, 'no comment on a pull request that never halted');
});

test('the head with no Codex review yet still halts when the newest review had findings', () => {
  const reviews = roundsOf(CODE_LIMIT, { head: sha(77) });
  assert.equal(decide({ reviews }).halted, true);
});

test('no halt when the newest Codex review has no live findings', () => {
  const approvedOnHead = [...roundsOf(CODE_LIMIT, { head: sha(42) }), review(HEAD, 900, { state: 'APPROVED' })];
  assert.equal(decide({ reviews: approvedOnHead }).halted, false);
  const dismissedOnHead = [...roundsOf(CODE_LIMIT, { head: sha(42) }), review(HEAD, 900, { id: 4242, state: 'DISMISSED' })];
  const byOwner = [{ event: 'review_dismissed', dismissed_review: { review_id: 4242 }, actor: { login: OWNER_LOGIN } }];
  assert.equal(decide({ reviews: dismissedOnHead, dismissals: byOwner }).halted, false);
  // Unreviewed head after an approval of an older commit: no halt either.
  const approvedOlder = [...roundsOf(CODE_LIMIT, { head: sha(42) }), review(sha(43), 900, { state: 'APPROVED' })];
  assert.equal(decide({ reviews: approvedOlder }).halted, false);
});

test('a halt needs the timeline, and an unreadable one changes nothing', () => {
  const comments = [stateComment(haltedState())];
  assert.equal(decide({ comments, labels: [LABEL] }).needsTimeline, true);
  const d = decide({ comments, labels: [], reviews: roundsOf(9), timeline: null });
  assert.match(d.error, /timeline unreadable/);
  assert.equal(d.addLabel, false);
  assert.equal(d.removeLabel, false);
  assert.equal(d.comment, null);
});

test('the owner removing the label lifts the halt and resets the count', () => {
  const comments = [stateComment(haltedState())];
  const timeline = [{ event: 'unlabeled', label: { name: LABEL }, actor: { login: OWNER_LOGIN }, created_at: at(600) }];
  const d = decide({ comments, labels: [], reviews: roundsOf(CODE_LIMIT), timeline });
  assert.equal(d.halted, false);
  assert.match(d.comment, /halt lifted:\*\* the owner removed the label/);
  assert.equal(d.existingCommentId, 55);
  const state = JSON.parse(d.comment.match(/review-loop:v1 (\{.*\}) -->/)[1]);
  assert.equal(state.since, at(600));
  // After the lift, only rounds after 600 count: seven more do not halt it, eight do.
  const old = roundsOf(CODE_LIMIT);
  const again = decide({ comments: [stateComment(state)], reviews: [...old, ...roundsOf(CODE_LIMIT - 1, { start: 600 })] });
  assert.equal(again.halted, false);
  assert.equal(again.rounds, CODE_LIMIT - 1);
  assert.equal(decide({ comments: [stateComment(state)], reviews: [...old, ...roundsOf(CODE_LIMIT, { start: 600 })] }).halted, true);
});

test('anyone else removing the label gets it put back', () => {
  const comments = [stateComment(haltedState())];
  const timeline = [{ event: 'unlabeled', label: { name: LABEL }, actor: { login: 'cloudwork-bot' }, created_at: at(600) }];
  const d = decide({ comments, labels: [], reviews: roundsOf(CODE_LIMIT), timeline });
  assert.equal(d.halted, true);
  assert.equal(d.addLabel, true);
  assert.match(d.comment, /removed by cloudwork-bot, not the owner, so it was put back/);
});

test('the owner adding the label halts the pull request', () => {
  const timeline = [{ event: 'labeled', label: { name: LABEL }, actor: { login: OWNER_LOGIN }, created_at: at(600) }];
  const d = decide({ labels: [LABEL], reviews: roundsOf(2), timeline });
  assert.equal(d.halted, true);
  assert.equal(d.addLabel, false);
  assert.match(d.comment, /The owner halted this pull request/);
});

test('a label anyone else added comes off; a leftover from a lift comes off too', () => {
  const byBot = decide({ labels: [LABEL], reviews: roundsOf(2), timeline: [{ event: 'labeled', label: { name: LABEL }, actor: { login: 'cloudwork-bot' }, created_at: at(600) }] });
  assert.equal(byBot.halted, false);
  assert.equal(byBot.removeLabel, true);
  const comments = [stateComment({ halted: false, since: at(700), liftedAt: at(700), pushed: [] })];
  const leftover = decide({ comments, labels: [LABEL], reviews: roundsOf(2), timeline: [{ event: 'labeled', label: { name: ACTIONS_LOGIN }, actor: { login: ACTIONS_LOGIN }, created_at: at(500) }, { event: 'labeled', label: { name: LABEL }, actor: { login: ACTIONS_LOGIN }, created_at: at(500) }] });
  assert.equal(leftover.halted, false);
  assert.equal(leftover.removeLabel, true);
});

test('the watchdog\'s own label from a run whose comment failed is finished', () => {
  const d = decide({ labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline: [{ event: 'labeled', label: { name: LABEL }, actor: { login: ACTIONS_LOGIN }, created_at: at(600) }] });
  assert.equal(d.halted, true);
  assert.ok(d.comment);
});

test('the owner\'s loop-resume lifts, but only his, unedited by others, after the halt', () => {
  const base = [stateComment(haltedState())];
  const timeline = [];
  const lifted = decide({ comments: [...base, ownerComment('loop-resume', 600)], labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline });
  assert.equal(lifted.halted, false);
  assert.equal(lifted.removeLabel, true);
  assert.match(lifted.comment, /commented loop-resume/);
  const editedByOther = ownerComment('loop-resume', 600, { edit_history: { lastEditedAt: at(601), editor: { __typename: 'User', login: 'cloudwork-bot' }, userContentEdits: { totalCount: 1, nodes: [{ editor: { __typename: 'User', login: 'cloudwork-bot' } }] } } });
  assert.equal(decide({ comments: [...base, editedByOther], labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline }).halted, true);
  const unreadable = ownerComment('loop-resume', 600, { edit_history: null });
  assert.equal(decide({ comments: [...base, unreadable], labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline }).halted, true);
  const noRecord = ownerComment('loop-resume', 600, { edit_history: undefined });
  assert.equal(ownerResume({ comments: [noRecord] }), 0, 'an edit record that was never read fails closed');
  assert.equal(decide({ comments: [...base, ownerComment('loop-resume', 400)], labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline }).halted, true, 'before the halt');
  assert.equal(decide({ comments: [...base, ownerComment('loop-resume please', 600)], labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline }).halted, true);
  assert.equal(decide({ comments: [...base, ownerComment('loop-resume', 600, { user: bot })], labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline }).halted, true);
});

test('the owner\'s accept line for the head lifts', () => {
  const comments = [stateComment(haltedState()), ownerComment(`owner-accepts-findings ${HEAD}`, 600)];
  const d = decide({ comments, labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline: [] });
  assert.equal(d.halted, false);
  assert.match(d.comment, /accepted the findings/);
});

test('Codex clean on the head lifts, in each form the gate counts', () => {
  const reviews = roundsOf(CODE_LIMIT, { head: sha(42) });
  const comments = [stateComment(haltedState({ haltedHead: sha(42) }))];
  const timeline = [];
  // The review state in Codex's summary comment.
  assert.equal(decide({ comments: [...comments, summary(HEAD, at(900))], labels: [LABEL], reviews, timeline }).halted, false);
  // Codex's clean-result comment.
  const cleanComment = { user: codex, created_at: at(900), edit_history: { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } }, body: `Didn't find any major issues.\n\n**Reviewed commit:** \`${HEAD.slice(0, 10)}\`` };
  assert.equal(decide({ comments: [...comments, cleanComment], labels: [LABEL], reviews, timeline }).halted, false);
  // The summary's completed row plus Codex's thumbs-up after it.
  const thumb = { user: { login: CODEX_LOGIN, type: 'User' }, content: '+1', created_at: at(905) };
  assert.equal(decide({ comments: [...comments, thumbSummary(HEAD, at(900))], reactions: [thumb], labels: [LABEL], reviews, timeline }).halted, false);
  // The completed row alone, without the thumbs-up, is not clean.
  assert.equal(decide({ comments: [...comments, thumbSummary(HEAD, at(900))], labels: [LABEL], reviews, timeline }).halted, true);
});

test('a push while halted is recorded once', () => {
  const comments = [stateComment(haltedState({ haltedHead: sha(1) }))];
  const d = decide({ comments, labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline: [] });
  assert.equal(d.halted, true);
  assert.match(d.comment, new RegExp(`Pushed while halted:\\*\\* \`${HEAD.slice(0, 7)}\``));
  const state = JSON.parse(d.comment.match(/review-loop:v1 (\{.*\}) -->/)[1]);
  assert.equal(decide({ comments: [stateComment(state)], labels: [LABEL], reviews: roundsOf(CODE_LIMIT), timeline: [] }).comment, null);
  assert.equal(haltSummary([stateComment(state)]).pushed, 1);
});

test('a state comment edited by anyone but GitHub Actions is ignored', () => {
  const tampered = stateComment(haltedState(), { edit_history: { lastEditedAt: at(2), editor: { __typename: 'User', login: 'cloudwork-bot' }, userContentEdits: { totalCount: 1, nodes: [{ editor: { __typename: 'User', login: 'cloudwork-bot' } }] } } });
  assert.equal(readState([tampered]), null);
  const lifted = stateComment({ halted: false, since: at(990), liftedAt: at(990), pushed: [] }, { edit_history: tampered.edit_history });
  assert.equal(decide({ comments: [lifted], reviews: roundsOf(CODE_LIMIT) }).halted, true, 'a forged reset does not hold off a halt');
});

test('haltSummary reads the round count for the owner list', () => {
  assert.deepEqual(haltSummary([stateComment(haltedState({ rounds: 9 }))]), { rounds: 9, limit: CODE_LIMIT, pushed: 0 });
  assert.equal(haltSummary([]), null);
});

function fakeGitHub({ labelExists }) {
  const calls = [];
  const gh = {
    get: async (path) => { calls.push(['GET', path]); if (!labelExists) throw new Error(`GET ${path} failed: 404 Not Found`); return {}; },
    post: async (path, body) => { calls.push(['POST', path, body]); return {}; },
    patch: async (path, body) => { calls.push(['PATCH', path, body]); return {}; },
    delete: async (path) => { calls.push(['DELETE', path]); return null; },
  };
  return { gh, calls };
}

test('a repository without the label gets it created, then added; the comment follows', async () => {
  const { gh, calls } = fakeGitHub({ labelExists: false });
  await applyReviewLoop({ gh, repoBase: '/repos/o/r', number: 7, decision: { addLabel: true, removeLabel: false, comment: 'c', existingCommentId: null } });
  assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), [
    `GET /repos/o/r/labels/${encodeURIComponent(LABEL)}`,
    'POST /repos/o/r/labels',
    'POST /repos/o/r/issues/7/labels',
    'POST /repos/o/r/issues/7/comments',
  ]);
  assert.equal(calls[1][2].name, LABEL);
});

test('lifting writes the comment before taking the label off', async () => {
  const { gh, calls } = fakeGitHub({ labelExists: true });
  await applyReviewLoop({ gh, repoBase: '/repos/o/r', number: 7, decision: { addLabel: false, removeLabel: true, comment: 'c', existingCommentId: 55 } });
  assert.deepEqual(calls.map(([m, p]) => `${m} ${p}`), ['PATCH /repos/o/r/issues/comments/55', `DELETE /repos/o/r/issues/7/labels/${encodeURIComponent(LABEL)}`]);
});

test('ensureLabel reads once per run and passes other errors on', async () => {
  const { gh, calls } = fakeGitHub({ labelExists: true });
  const cache = {};
  await ensureLabel({ gh, repoBase: '/r', cache });
  await ensureLabel({ gh, repoBase: '/r', cache });
  assert.equal(calls.length, 1);
  const failing = { get: async () => { throw new Error('GET x failed: 500 boom'); } };
  await assert.rejects(ensureLabel({ gh: failing, repoBase: '/r', cache: {} }), /500/);
});
