// Tests for the status feed's state rules (docs/plans/status-feed.md, part 1).
// Every pull request, comment and review here is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, LOOP_ROUNDS,
  namesCommit, isReviewForm, hasChecklist, hasEscalation, findingSeverities, planCheckVerdict,
  keeperComment, parseKeeper, silenceStands, loopRounds, reviewedCommit, sameChanges,
  countedReview, escalationAt, planCheck, ownerApprovalStands, ownerApprovedAfter,
  stateOf, buildFeed, feedIsStale, unchangedSince, easternDay,
} from '../status-feed-rules.mjs';
import { RISK_LABEL, RISK_ESCALATE_LABEL, RISK_LABELS } from '../risk-check.mjs';

const HEAD = 'a1b2c3d'.padEnd(40, '0');
const OLD = 'e4f5a6b'.padEnd(40, '1');
const BOT = { login: 'cloudwork-bot' };
const OWNER = { login: 'CloudworkSystems' };
const CODEX = { login: 'chatgpt-codex-connector[bot]' };
const OUTSIDER = { login: 'someone-else' };

const CHECKLIST = ['### Privacy and security checklist', ...Array.from({ length: 10 }, (_, i) => `${i + 1}. No.`)].join('\n');
const reviewBody = (sha, findings = 'clean, no P0 or P1', checklist = true) => `Independent review of ${sha}: ${findings}\n\n${checklist ? CHECKLIST : ''}\n— GrokBot review`;
const comment = (user, body, at = '2026-11-06T10:00:00Z') => ({ user, body, created_at: at });

// A pull request that meets everything Checked asks for. Each test changes one fact.
const ready = (over = {}) => ({
  draft: false,
  conflict: false,
  builder: 'agent: claude',
  tests: 'success',
  codexApproved: 'success',
  codexReviewedHead: true,
  codexCleanOnHead: true,
  codexFindingsOnHead: false,
  judgeDue: false,
  judgeSaidReal: false,
  loopRounds: 0,
  reviewNeeded: true,
  review: { at: 1, severities: [], checklist: true, escalation: false },
  planCheckNeeded: false,
  planCheck: null,
  protectedNeeded: false,
  ownerApproval: false,
  openedByOwner: false,
  labels: [],
  escalated: false,
  escalationApproved: false,
  autoMerge: false,
  silent: [],
  waiting: [],
  ...over,
});
const state = (over) => stateOf(ready(over)).state;

// ------------------------------------------------------------ every state

test('a pull request that meets every condition is Checked', () => {
  const r = stateOf(ready());
  assert.equal(r.state, 'Checked');
  assert.match(r.next, /coordinator switches on auto-merge/);
  assert.equal(stateOf(ready({ autoMerge: true })).next, 'GitHub merges it');
});

test('every state can be reached', () => {
  const seen = new Set([
    state({}),
    state({ silent: [{ number: 1, agent: 'Codex', text: 'Codex silent on #1' }] }),
    state({ tests: 'failure' }),
    state({ protectedNeeded: true }),
    state({ review: null }),
    state({ codexApproved: 'failure', codexCleanOnHead: false, codexFindingsOnHead: false, codexReviewedHead: true }),
  ]);
  assert.deepEqual([...seen].sort(), [...STATES].sort());
});

test('Blocked: a keeper silence line that still stands', () => {
  const r = stateOf(ready({ silent: [{ number: 7, agent: 'GrokBot', text: 'GrokBot silent on [#7](x) (no review, 2 hours)' }] }));
  assert.equal(r.state, 'Blocked');
  assert.match(r.rule, /GrokBot silent/);
});

test('Returned: draft, red tests, conflicts, Codex findings, open review finding, missing plan check item', () => {
  assert.equal(state({ draft: true }), 'Returned');
  assert.equal(state({ tests: 'failure' }), 'Returned');
  assert.equal(state({ conflict: true }), 'Returned');
  assert.equal(state({ codexApproved: 'pending', codexCleanOnHead: false, codexFindingsOnHead: true }), 'Returned');
  assert.equal(state({ review: { at: 1, severities: [2], checklist: true } }), 'Returned');
  assert.equal(state({ builder: 'agent: codex', planCheckNeeded: true, planCheck: { verdict: 'missing', checklist: true } }), 'Returned');
  assert.match(stateOf(ready({ builder: 'agent: grokbot', tests: 'failure' })).next, /GrokBot builder/);
});

test('Returned: the judge rating a finding real is said so', () => {
  const r = stateOf(ready({ codexApproved: 'pending', codexCleanOnHead: false, codexFindingsOnHead: true, judgeSaidReal: true }));
  assert.equal(r.state, 'Returned');
  assert.match(r.rule, /triage judge rated/);
});

test('a P3 in the review does not send it back', () => {
  assert.equal(state({ review: { at: 1, severities: [3], checklist: true } }), 'Checked');
});

test('Needs You: protected paths, risk hold, escalation, the keeper\'s yes lines', () => {
  assert.equal(state({ protectedNeeded: true }), 'Needs You');
  assert.equal(state({ labels: [RISK_LABEL] }), 'Needs You');
  assert.equal(state({ labels: [RISK_ESCALATE_LABEL], escalated: true }), 'Needs You');
  for (const text of ["plan waiting on the owner's yes", "rules change waiting on the owner's yes", "site change waiting on the owner's yes", 'risk escalation waiting on the owner', 'Dependabot waiting on the owner']) {
    const waiting = parseKeeper({ body: `## Not working\n\n### Waiting on someone\n\n- [#9](https://github.com/o/r/pull/9) ${text}\n\n— PR keeper (scheduled)` }).waiting;
    assert.equal(waiting.length, 1, text);
    assert.equal(state({ waiting }), 'Needs You', text);
  }
});

test('Needs You: a pull request opened from the owner\'s account says how to get out', () => {
  const r = stateOf(ready({ protectedNeeded: true, openedByOwner: true }));
  assert.equal(r.state, 'Needs You');
  assert.match(r.next, /cloudwork-bot/);
});

test('protected paths with the owner\'s standing approval are not held', () => {
  assert.equal(state({ protectedNeeded: true, ownerApproval: true }), 'Checked');
});

test('the approval-needed flag rides along on another state', () => {
  const r = stateOf(ready({ protectedNeeded: true, tests: 'failure' }));
  assert.equal(r.state, 'Returned');
  assert.equal(r.approvalNeeded, true);
});

test('Under Way: tests running, Codex not there yet, review not posted, plan check not posted, keeper waiting lines', () => {
  assert.equal(state({ tests: 'pending' }), 'Under Way');
  assert.equal(state({ tests: null }), 'Under Way');
  assert.equal(state({ codexApproved: 'pending', codexReviewedHead: false, codexCleanOnHead: false }), 'Under Way');
  assert.equal(state({ codexApproved: 'pending', codexCleanOnHead: true }), 'Under Way');
  assert.equal(state({ review: null }), 'Under Way');
  assert.equal(state({ review: { at: 1, severities: [], checklist: false } }), 'Under Way');
  assert.equal(state({ builder: 'agent: codex', planCheckNeeded: true, planCheck: null }), 'Under Way');
  assert.equal(state({ builder: 'agent: codex', planCheckNeeded: true, planCheck: { verdict: 'passed', checklist: false } }), 'Under Way');
  for (const text of ["rules change waiting on the coordinator", "plan changed after the owner's yes: waiting on the thread that asked him", 'needs a fresh Claude review from another agent (keeper fixed it)']) {
    const waiting = parseKeeper({ body: `## Not working\n- [#9](https://github.com/o/r/pull/9) ${text}\n— PR keeper (scheduled)` }).waiting;
    assert.equal(state({ waiting }), 'Under Way', text);
  }
});

test('Unknown: a pull request no rule fits shows instead of hiding', () => {
  const r = stateOf(ready({ codexApproved: 'failure', codexCleanOnHead: false, codexFindingsOnHead: false, codexReviewedHead: true }));
  assert.equal(r.state, 'Unknown');
  assert.match(r.rule, /No rule fits/);
});

// ------------------------------------------------------------ the order

test('the first matching state wins: Blocked, Returned, Needs You, Under Way, Checked', () => {
  const silent = [{ number: 1, agent: 'Codex', text: 'Codex silent' }];
  assert.equal(state({ silent, tests: 'failure', protectedNeeded: true }), 'Blocked');
  assert.equal(state({ tests: 'failure', protectedNeeded: true }), 'Returned');
  assert.equal(state({ protectedNeeded: true, review: null }), 'Needs You');
  assert.equal(state({ review: null, tests: 'pending' }), 'Under Way');
});

// ------------------------------------------------------------ the loop flag (revision, November 4)

test('a review loop goes to Needs You ahead of Returned and Under Way', () => {
  const r = stateOf(ready({ loopRounds: 4, codexApproved: 'pending', codexCleanOnHead: false, codexFindingsOnHead: true }));
  assert.equal(r.state, 'Needs You');
  assert.equal(r.loop, 4);
  assert.equal(state({ loopRounds: LOOP_ROUNDS, review: null }), 'Needs You');
});

test('a review loop never hides a Blocked row', () => {
  assert.equal(state({ loopRounds: 5, silent: [{ number: 1, agent: 'Codex', text: 'Codex silent' }] }), 'Blocked');
});

test('a review loop with everything Checked asks for is Checked', () => {
  const r = stateOf(ready({ loopRounds: 5 }));
  assert.equal(r.state, 'Checked');
  assert.equal(r.loop, 5);
});

test('fewer rounds than the flag needs leave the row to the other rules', () => {
  const r = stateOf(ready({ loopRounds: LOOP_ROUNDS - 1, tests: 'failure' }));
  assert.equal(r.state, 'Returned');
  assert.equal(r.loop, 0);
});

const codexReview = (id, commit_id, at) => ({ id, user: CODEX, state: 'COMMENTED', commit_id, submitted_at: at });
const codexFinding = (reviewId, p) => ({ pull_request_review_id: reviewId, user: CODEX, body: `**![P${p} Badge](x)** something` });

test('loop rounds count consecutive Codex rounds with a P0 or P1, newest first', () => {
  const shas = ['1', '2', '3', '4'].map((c) => c.repeat(40));
  const reviews = shas.map((sha, i) => codexReview(i + 1, sha, `2026-11-0${i + 1}T10:00:00Z`));
  const severe = [codexFinding(2, 1), codexFinding(3, 0), codexFinding(4, 1), codexFinding(1, 2)];
  assert.equal(loopRounds({ headSha: shas[3], reviews, reviewComments: severe }), 3);
  // A P2-only round in the middle breaks the run.
  const broken = [codexFinding(2, 1), codexFinding(3, 2), codexFinding(4, 1)];
  assert.equal(loopRounds({ headSha: shas[3], reviews, reviewComments: broken }), 1);
  // Codex clean on a newer head ends the loop.
  assert.equal(loopRounds({ headSha: '5'.repeat(40), reviews, reviewComments: severe, codexCleanOnHead: true }), 0);
  // Replies and other accounts' comments don't count.
  assert.equal(loopRounds({ headSha: shas[3], reviews, reviewComments: [{ ...codexFinding(4, 0), in_reply_to_id: 9 }, { ...codexFinding(3, 0), user: OUTSIDER }] }), 0);
});

// ------------------------------------------------------------ requirement 1: who counts

test('only cloudwork-bot reviews in the keeper\'s form, naming the head, count', () => {
  const comments = [comment(OUTSIDER, reviewBody(HEAD))];
  assert.equal(countedReview({ comments, reviews: [], headSha: HEAD }), null);
  // An outsider's clean review on the head leaves the row Under Way, never Checked.
  assert.equal(state({ review: countedReview({ comments, reviews: [], headSha: HEAD }) }), 'Under Way');
  assert.ok(countedReview({ comments: [comment(BOT, reviewBody(HEAD))], reviews: [], headSha: HEAD }));
  assert.ok(countedReview({ comments: [], reviews: [{ user: BOT, body: reviewBody(HEAD), submitted_at: '2026-11-06T10:00:00Z' }], headSha: HEAD }));
  assert.equal(countedReview({ comments: [comment(BOT, reviewBody(OLD))], reviews: [], headSha: HEAD }), null);
  assert.equal(countedReview({ comments: [comment(BOT, `Looks good for ${HEAD}`)], reviews: [], headSha: HEAD }), null);
});

test('review forms: GrokBot ending, Independent or Delta review opening after heading marks', () => {
  assert.ok(isReviewForm('Findings...\n— GrokBot review'));
  assert.ok(isReviewForm('## Independent review (fresh Claude, PR keeper) of x'));
  assert.ok(isReviewForm('Delta review of x'));
  assert.ok(!isReviewForm('Plan check (PR keeper) of x: passed'));
  assert.ok(!isReviewForm('I did an Independent review'));
});

test('a sha names the commit by its short or full form', () => {
  assert.ok(namesCommit(`of ${HEAD.slice(0, 7)}`, HEAD));
  assert.ok(namesCommit(`of ${HEAD}`, HEAD));
  assert.ok(!namesCommit(`of ${OLD}`, HEAD));
  assert.ok(!namesCommit('x', 'short'));
});

// ------------------------------------------------------------ requirement 2: risk-escalate

const ownerReview = (state, commit_id, at) => ({ user: OWNER, state, commit_id, submitted_at: at });

test('an escalation holds for the owner until he approves the head after it, then waits on the coordinator', () => {
  const escalating = comment(BOT, `${reviewBody(HEAD)}\nrisk-escalate: sends notes to an outside host`, '2026-11-06T10:00:00Z');
  const at = escalationAt({ comments: [escalating], reviews: [], headSha: HEAD });
  assert.ok(at > 0);
  const before = [ownerReview('APPROVED', HEAD, '2026-11-06T09:00:00Z')];
  assert.equal(ownerApprovedAfter(before, at, HEAD), false);
  assert.equal(state({ escalated: true, escalationApproved: false, labels: [RISK_ESCALATE_LABEL] }), 'Needs You');
  const after = [...before, ownerReview('APPROVED', HEAD, '2026-11-06T11:00:00Z')];
  assert.equal(ownerApprovedAfter(after, at, HEAD), true);
  const r = stateOf(ready({ escalated: true, escalationApproved: true, labels: [RISK_ESCALATE_LABEL] }));
  assert.equal(r.state, 'Under Way');
  assert.match(r.next, /coordinator removes the label/);
  // Approval of an older commit, or a later change request, doesn't count.
  assert.equal(ownerApprovedAfter([ownerReview('APPROVED', OLD, '2026-11-06T11:00:00Z')], at, HEAD), false);
  assert.equal(ownerApprovedAfter([...after, ownerReview('CHANGES_REQUESTED', HEAD, '2026-11-06T12:00:00Z')], at, HEAD), false);
});

test('an escalation line holds even before the label is added', () => {
  assert.ok(hasEscalation('- `risk-escalate: reads the address book`'));
  assert.ok(!hasEscalation('no escalation here'));
  assert.equal(state({ escalated: true, escalationApproved: false }), 'Needs You');
});

test('an approved escalation with the label already removed can be Checked', () => {
  assert.equal(state({ escalated: true, escalationApproved: true, labels: [] }), 'Checked');
});

// ------------------------------------------------------------ requirement 3: the checklist block

test('the checklist block needs its heading and all ten answers', () => {
  assert.ok(hasChecklist(CHECKLIST));
  assert.ok(hasChecklist(CHECKLIST.replace(/^(\d+)\./gm, '- **$1.**')));
  assert.ok(!hasChecklist(CHECKLIST.replace('10. No.', '')));
  assert.ok(!hasChecklist('1. a\n2. b'));
  const review = countedReview({ comments: [comment(BOT, reviewBody(HEAD, 'clean, no P0 or P1', false))], reviews: [], headSha: HEAD });
  assert.equal(review.checklist, false);
  assert.equal(state({ review }), 'Under Way');
});

test('an outside module needs a passed plan check with the checklist block', () => {
  const passed = planCheck({ comments: [comment(BOT, `Plan check (PR keeper) of ${HEAD.slice(0, 7)}: passed\n\n${CHECKLIST}\n— PR keeper (scheduled)`)], reviews: [], headSha: HEAD });
  assert.deepEqual(passed, { verdict: 'passed', checklist: true });
  assert.equal(state({ builder: 'agent: codex', planCheckNeeded: true, planCheck: passed }), 'Checked');
  const missing = planCheck({ comments: [comment(BOT, `Plan check (PR keeper) of ${HEAD.slice(0, 7)}: the finish line's test is missing`)], reviews: [], headSha: HEAD });
  assert.equal(missing.verdict, 'missing');
  assert.equal(planCheck({ comments: [comment(OUTSIDER, `Plan check of ${HEAD.slice(0, 7)}: passed\n${CHECKLIST}`)], reviews: [], headSha: HEAD }), null);
  assert.equal(planCheckVerdict('Not a plan check'), null);
});

test('a GrokBot pull request needs no independent review: Codex is its review', () => {
  assert.equal(state({ builder: 'agent: grokbot', reviewNeeded: false, review: null }), 'Checked');
});

// ------------------------------------------------------------ requirement 4: codex-approved covers Codex

test('a passing codex-approved satisfies every Codex condition, the owner\'s hung-review override included', () => {
  assert.equal(state({ codexApproved: 'success', codexReviewedHead: false, codexCleanOnHead: false, codexFindingsOnHead: true }), 'Checked');
});

// ------------------------------------------------------------ requirement 5: SAME

test('a review of an earlier commit counts when the changes against main are the same', () => {
  const files = [{ filename: 'a.js', status: 'modified', sha: 'x', patch: '@@ +1 @@' }];
  assert.ok(sameChanges(files, structuredClone(files)));
  assert.ok(!sameChanges(files, [{ ...files[0], patch: '@@ +2 @@' }]));
  assert.ok(!sameChanges([], []));
  const many = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}`, status: 'added', sha: String(i) }));
  assert.ok(!sameChanges(many, many));
  const comments = [comment(BOT, reviewBody(OLD))];
  const commits = [{ sha: OLD }, { sha: HEAD }];
  assert.equal(reviewedCommit({ comments, reviews: [], commits }), OLD);
  assert.ok(countedReview({ comments, reviews: [], headSha: HEAD, sameAs: OLD }));
  // A sha that isn't one of the pull request's commits is never R.
  assert.equal(reviewedCommit({ comments: [comment(BOT, reviewBody('f'.repeat(40)))], reviews: [], commits }), null);
});

// ------------------------------------------------------------ requirement 6: one case per condition of step F

test('step F: each condition, missing alone, keeps the row from Checked', () => {
  const cases = {
    'codex-approved success': { codexApproved: 'pending', codexCleanOnHead: false, codexReviewedHead: false },
    'an independent review of the head': { review: null },
    'no open P0, P1 or P2': { review: { at: 1, severities: [1], checklist: true } },
    'the checklist block': { review: { at: 1, severities: [], checklist: false } },
    'no risk-escalate label': { labels: [RISK_ESCALATE_LABEL], escalated: true },
    'no risk-escalate line unless approved': { escalated: true },
    'any plan check passed': { builder: 'agent: grokbot', reviewNeeded: false, planCheckNeeded: true, planCheck: { verdict: 'missing', checklist: true } },
    "a plan's quoted yes": { waiting: [{ number: 1, state: 'Needs You', text: "plan waiting on the owner's yes", next: 'x', whose: 'you' }] },
    "a site change's quoted yes": { waiting: [{ number: 1, state: 'Needs You', text: "site change waiting on the owner's yes", next: 'x', whose: 'you' }] },
    'rules files are the coordinator\'s': { waiting: [{ number: 1, state: 'Under Way', text: 'rules change waiting on the coordinator', next: 'x', whose: 'coordinator' }] },
  };
  for (const [name, over] of Object.entries(cases)) assert.notEqual(state(over), 'Checked', name);
});

test('findings the keeper has judged answered (auto-merge on, or waiting on the coordinator) don\'t send it back', () => {
  const review = { at: 1, severities: [2], checklist: true };
  assert.equal(state({ review, autoMerge: true }), 'Checked');
  const waiting = [{ number: 1, state: 'Under Way', text: 'rules change waiting on the coordinator', next: 'x', whose: 'coordinator' }];
  assert.equal(state({ review, waiting }), 'Under Way');
});

test('Checked also needs a ready pull request with no conflicts', () => {
  assert.notEqual(state({ draft: true }), 'Checked');
  assert.notEqual(state({ conflict: true }), 'Checked');
});

// ------------------------------------------------------------ requirement 7: silence lines

const KEEPER = `## Not working

- Codex silent on [#11](https://github.com/o/r/pull/11) after a restart
- GrokBot silent on [#12](https://github.com/o/r/pull/12) (no review, 70 minutes)
- independent review silent on [#13](https://github.com/o/r/pull/13) (3 hours after Codex was clean)
- Claude builder silent on [#14](https://github.com/o/r/pull/14) (P1 open for 5 hours)
- Codex team A silent on issue [#40](https://github.com/o/r/issues/40) (no branch, 5 hours after it was assigned)
- Gemini review not set up (GrokBot, then a fresh Claude review)

### Waiting on someone

- [#15](https://github.com/o/r/pull/15) plan waiting on the owner's yes
- [#16](https://github.com/o/r/pull/16) has merge conflicts with main (waiting on its builder)

Checked Nov 6, 2026, 9:00 AM EST

— PR keeper (scheduled)
<!-- keeper-not-working -->`;

test('the keeper\'s comment: only cloudwork-bot\'s, oldest one, with its pull request lines', () => {
  const mine = { user: BOT, body: KEEPER, created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-06T14:00:00Z' };
  const quote = { user: OUTSIDER, body: KEEPER, created_at: '2026-10-30T00:00:00Z' };
  const replaced = { user: BOT, body: 'Replaced by the keeper\'s comment above. — PR keeper (scheduled)', created_at: '2026-11-02T00:00:00Z' };
  const found = keeperComment([quote, replaced, mine]);
  assert.equal(found, mine);
  const parsed = parseKeeper(found);
  assert.equal(parsed.checkedAt, '2026-11-06T14:00:00Z');
  assert.deepEqual(parsed.silent.map((s) => [s.number, s.agent]), [[11, 'Codex'], [12, 'GrokBot'], [13, 'independent review'], [14, 'Claude builder']]);
  assert.deepEqual(parsed.waiting.map((w) => [w.number, w.state]), [[15, 'Needs You']]);
  assert.deepEqual(parseKeeper(null), { checkedAt: null, silent: [], waiting: [] });
});

test('a silence line stands only while the silence is unresolved', () => {
  const checked = { headCommittedAt: '2026-11-06T10:00:00Z', keeperCheckedAt: '2026-11-06T14:00:00Z', codexReviewedHead: false, review: null };
  const codex = { number: 11, agent: 'Codex' };
  const grok = { number: 12, agent: 'GrokBot' };
  const independent = { number: 13, agent: 'independent review' };
  const builder = { number: 14, agent: 'Claude builder' };
  assert.equal(silenceStands(codex, checked), true);
  assert.equal(silenceStands(codex, { ...checked, codexReviewedHead: true }), false);
  // A fresh Claude review standing in for a silent GrokBot covers it.
  assert.equal(silenceStands(grok, checked), true);
  assert.equal(silenceStands(grok, { ...checked, review: { checklist: true } }), false);
  assert.equal(silenceStands(independent, { ...checked, review: { checklist: true } }), false);
  // A builder's silence is not covered by Codex or a review.
  assert.equal(silenceStands(builder, { ...checked, codexReviewedHead: true, review: {} }), true);
  // A push after the keeper's check makes every line stale.
  for (const line of [codex, grok, independent, builder]) assert.equal(silenceStands(line, { ...checked, headCommittedAt: '2026-11-06T15:00:00Z' }), false);
});

// ------------------------------------------------------------ requirement 8: the owner's approval

test('the owner\'s approval stands after an update from main unless dismissed', () => {
  assert.equal(ownerApprovalStands([ownerReview('APPROVED', OLD, '2026-11-05T10:00:00Z')]), true);
  assert.equal(ownerApprovalStands([ownerReview('APPROVED', OLD, '2026-11-05T10:00:00Z'), ownerReview('DISMISSED', OLD, '2026-11-05T11:00:00Z')]), false);
  assert.equal(ownerApprovalStands([ownerReview('APPROVED', OLD, '2026-11-05T10:00:00Z'), ownerReview('CHANGES_REQUESTED', HEAD, '2026-11-05T11:00:00Z')]), false);
  assert.equal(ownerApprovalStands([ownerReview('APPROVED', OLD, '2026-11-05T10:00:00Z'), ownerReview('COMMENTED', HEAD, '2026-11-05T11:00:00Z')]), true);
  assert.equal(ownerApprovalStands([{ ...ownerReview('APPROVED', HEAD, '2026-11-05T10:00:00Z'), user: OUTSIDER }]), false);
});

// ------------------------------------------------------------ requirement 9: both risk labels

test('both risk labels come from the constant owner-queue uses', () => {
  assert.deepEqual(RISK_LABELS, ['needs-owner: risk', 'needs-owner: risk-escalate']);
  for (const label of RISK_LABELS) assert.equal(state({ labels: [label], escalated: label === RISK_ESCALATE_LABEL }), 'Needs You', label);
});

// ------------------------------------------------------------ the triage window

test('the triage window: Under Way while the judge has it, Returned after', () => {
  const pending = { codexApproved: 'pending', codexCleanOnHead: false, codexFindingsOnHead: true };
  const r = stateOf(ready({ ...pending, judgeDue: true }));
  assert.equal(r.state, 'Under Way');
  assert.equal(r.whose, 'triage judge');
  assert.equal(state({ ...pending, judgeDue: false }), 'Returned');
});

// ------------------------------------------------------------ reading review text

test('findings are the lines before the checklist that start with a priority', () => {
  const body = `Independent review of ${HEAD}:\n\n- **P2** a missing guard\n1. P1: wrong total\n### P3 wording\nNo P1 or P2 findings beyond these.\n\n${CHECKLIST.replace('1. No.', '1. P0? No.')}`;
  assert.deepEqual(findingSeverities(body), [1, 2, 3]);
  assert.deepEqual(findingSeverities(reviewBody(HEAD)), []);
});

// ------------------------------------------------------------ the feed

test('the feed sorts rows by state, keeps how long each has been in it, and links shared red jobs', () => {
  const now = Date.parse('2026-11-06T15:00:00Z');
  const previous = { rows: [{ number: 3, state: 'Returned', since: '2026-11-06T12:00:00Z' }, { number: 4, state: 'Under Way', since: '2026-11-06T12:00:00Z' }] };
  const rows = [
    { number: 3, state: 'Returned', failingJobs: ['tests'] },
    { number: 4, state: 'Checked', failingJobs: [] },
    { number: 5, state: 'Needs You', failingJobs: [] },
    { number: 6, state: 'Returned', failingJobs: ['tests', 'lint'] },
  ];
  const merged = ['2026-11-06T13:00:00Z', '2026-11-06T04:00:00Z', '2026-11-02T10:00:00Z', '2026-10-20T10:00:00Z'];
  const feed = buildFeed({ rows, previous, merged, keeperCheckedAt: '2026-11-06T14:00:00Z', now });
  assert.deepEqual(feed.rows.map((r) => r.number), [3, 6, 5, 4]);
  assert.equal(feed.rows.find((r) => r.number === 3).since, '2026-11-06T12:00:00Z');
  assert.equal(feed.rows.find((r) => r.number === 4).since, '2026-11-06T15:00:00.000Z');
  assert.deepEqual(feed.rows.find((r) => r.number === 3).alsoRedOn, [6]);
  assert.deepEqual(feed.rows.find((r) => r.number === 4).alsoRedOn, []);
  assert.deepEqual(feed.totals.waitingOnYou, { value: 1, of: 4 });
  assert.deepEqual(feed.totals.inFlight, { value: 2, of: 4 });
  // 13:00 UTC is today in New York; 04:00 UTC is still yesterday there.
  assert.equal(feed.totals.mergedToday.value, 1);
  assert.equal(feed.totals.mergedLast7Days.value, 3);
  assert.equal(easternDay(Date.parse('2026-11-06T04:00:00Z')), '2026-11-05');
});

test('no open pull requests is an empty feed, not a missing one', () => {
  const feed = buildFeed({ rows: [], now: Date.parse('2026-11-06T15:00:00Z') });
  assert.equal(feed.totals.open, 0);
  assert.deepEqual(feed.rows, []);
});

test('a feed older than 3 hours is stale', () => {
  const now = Date.parse('2026-11-06T15:00:00Z');
  assert.equal(feedIsStale({ generatedAt: '2026-11-06T13:00:00Z' }, now), false);
  assert.equal(feedIsStale({ generatedAt: '2026-11-06T11:00:00Z' }, now), true);
  assert.equal(feedIsStale(null, now), true);
});

test('a run with nothing new writes nothing until the feed is 50 minutes old', () => {
  const now = Date.parse('2026-11-06T15:00:00Z');
  const rows = [{ number: 3, state: 'Returned', failingJobs: [] }];
  const previous = buildFeed({ rows, now: now - 10 * 60 * 1000 });
  const next = buildFeed({ rows, previous, now });
  assert.equal(unchangedSince(previous, next, now), true);
  assert.equal(unchangedSince(previous, buildFeed({ rows: [{ ...rows[0], state: 'Checked' }], previous, now }), now), false);
  const old = buildFeed({ rows, now: now - 55 * 60 * 1000 });
  assert.equal(unchangedSince(old, buildFeed({ rows, previous: old, now }), now), false);
  assert.equal(unchangedSince(null, next, now), false);
});
