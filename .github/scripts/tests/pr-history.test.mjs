import test from 'node:test';
import assert from 'node:assert/strict';
import { area, agentOf, codexSummary, outsideSummary, buildRow, toCsv, COLUMNS, CODEX } from '../pr-history.mjs';

const codex = { login: CODEX };
const pull = (over = {}) => ({
  number: 900, title: 'Invented change', state: 'closed', draft: false, user: { login: 'cloudwork-bot' },
  head: { ref: 'OC-261099-invented', sha: 'a'.repeat(40) }, labels: [],
  created_at: '2026-10-20T00:00:00Z', merged_at: '2026-10-21T12:00:00Z', closed_at: '2026-10-21T12:00:00Z',
  updated_at: '2026-10-21T12:00:00Z', html_url: 'https://github.com/example/repo/pull/900', ...over,
});
const commit = (message, name = 'cloudwork-bot') => ({ commit: { message, author: { name } } });
const clean = (sha, at) => ({ user: codex, created_at: at, body: `Codex Review: Didn't find any major issues. Nice.\n\n**Reviewed commit:** \`${sha}\`` });
const findings = (sha, at) => ({ user: codex, commit_id: sha, submitted_at: at, state: 'COMMENTED', body: '### 💡 Codex Review' });

test('areas group apps, packages and docs by their second folder', () => {
  assert.equal(area('apps/desk/src/main.ts'), 'apps/desk');
  assert.equal(area('packages/habit-grid/index.mjs'), 'packages/habit-grid');
  assert.equal(area('docs/plans/x.md'), 'docs/plans');
  assert.equal(area('docs/decisions.md'), 'docs');
  assert.equal(area('STATUS.md'), 'STATUS.md');
});

test('the agent label wins, then commit marks', () => {
  assert.equal(agentOf(pull({ labels: [{ name: 'agent: grokbot' }] }), [commit('x\n\nClaude-Session: y')]), 'grokbot');
  assert.equal(agentOf(pull(), [commit('Add engine', 'Cursor Agent')]), 'grokbot');
  assert.equal(agentOf(pull(), [commit('Fix\n\nClaude-Session: https://example.invalid')]), 'claude');
  assert.equal(agentOf(pull({ head: { ref: 'codex/x', sha: 'b' } }), []), 'codex');
  assert.equal(agentOf(pull({ user: { login: 'dependabot[bot]' } }), []), 'dependabot');
  assert.equal(agentOf(pull(), [commit('Plain')]), 'unknown');
});

test('Codex rounds count distinct reviewed commits; the summary comment sets the latest result', () => {
  const reviews = [findings('1111111111aaaa', '2026-10-20T01:00:00Z')];
  const comments = [clean('2222222222', '2026-10-20T02:00:00Z')];
  const reviewComments = [{ user: codex, body: '![P1 Badge](x) one' }, { user: codex, body: '![P2 Badge](x) two' }, { user: { login: 'someone' }, body: '![P1 Badge]' }];
  const r = codexSummary({ reviews, comments, reviewComments });
  assert.deepEqual([r.codexRounds, r.codexLatest, r.codexP1, r.codexP2], [2, 'clean', 1, 1]);
  const open = { user: codex, created_at: '2026-10-20T03:00:00Z', body: '<!-- codex-review-state:v1 {"code_review":{"has_any_findings":true,"has_unresolved_findings":true,"status":"completed"}} -->' };
  assert.equal(codexSummary({ reviews, comments: [...comments, open], reviewComments: [] }).codexLatest, 'open findings');
  assert.equal(codexSummary({ reviews: [], comments: [], reviewComments: [] }).codexLatest, 'none');
  const running = { user: codex, created_at: '2026-10-20T03:30:00Z', body: '<!-- codex-review-state:v1 {"code_review":{"has_any_findings":false,"has_unresolved_findings":false,"status":"in_progress"}} -->' };
  assert.equal(codexSummary({ reviews, comments: [...comments, running], reviewComments: [] }).codexLatest, 'review running');
  const done = { user: codex, created_at: '2026-10-20T03:40:00Z', body: '<!-- codex-review-state:v1 {"code_review":{"commit_sha":"' + 'c'.repeat(40) + '","has_any_findings":false,"has_unresolved_findings":false,"status":"completed"}} -->' };
  assert.equal(codexSummary({ reviews, comments: [...comments, done], reviewComments: [] }, 'c'.repeat(40)).codexLatest, 'clean');
  assert.equal(codexSummary({ reviews, comments: [...comments, done], reviewComments: [] }, 'd'.repeat(40)).codexLatest, 'earlier commit');
  const broken = { user: codex, created_at: '2026-10-20T04:00:00Z', body: '<!-- codex-review-state:v1 {"code_review":{oops} -->' };
  assert.equal(codexSummary({ reviews, comments: [...comments, broken], reviewComments: [] }).codexLatest, 'clean');
});

test('outside reviews: GrokBot and fresh Claude, latest decides clean', () => {
  const comments = [
    { user: { login: 'cloudwork-bot' }, created_at: '2026-10-20T01:00:00Z', body: '@cursor Please do an independent review' },
    { user: { login: 'cursor[bot]' }, created_at: '2026-10-20T02:00:00Z', body: 'Independent review of `abc`. Two P1 findings.\n\n— GrokBot review' },
    { user: { login: 'cursor[bot]' }, created_at: '2026-10-20T02:30:00Z', body: 'Pushed a fix for the build.' },
    { user: { login: 'cloudwork-bot' }, created_at: '2026-10-20T03:00:00Z', body: '**Independent review (fresh Claude) of def4567: clean, no P0 or P1.**' },
  ];
  assert.deepEqual(outsideSummary({ reviews: [], comments }, 'def4567'.padEnd(40, '0')), { outsideReviewer: 'Claude + GrokBot', outsideRounds: 2, outsideLatest: 'clean', outsideCommit: 'def4567', outsideOnHead: 'yes' });
});

test('a clean outside review holds only for the commit it reviewed', () => {
  const head = '1234567890'.padEnd(40, 'f');
  const on = (body, extra = {}) => outsideSummary({ reviews: [{ user: { login: 'cloudwork-bot' }, submitted_at: '2026-10-20T01:00:00Z', body, ...extra }], comments: [] }, head);
  assert.equal(on('**Independent review of 1234567: clean.**').outsideOnHead, 'yes');
  assert.equal(on('**Independent review of abcdef0: clean.**').outsideOnHead, 'no');
  assert.equal(on('Independent review: clean, nothing new.', { commit_id: head }).outsideOnHead, 'yes');
  assert.equal(outsideSummary({ reviews: [], comments: [] }, head).outsideOnHead, '');
});

test('an outside review with an open P2 is not clean, but one with fixed findings is', () => {
  const review = (body) => outsideSummary({ reviews: [], comments: [{ user: { login: 'cloudwork-bot' }, created_at: '2026-10-20T01:00:00Z', body }] }).outsideLatest;
  assert.equal(review('**Independent review of abc: no P0 or P1.** One P2: the retry never stops.'), 'findings');
  assert.equal(review('Independent review of abc: clean, no P0 or P1, but two P2s remain.'), 'findings');
  assert.equal(review('Independent review of abc: no P0 or P1.'), 'findings');
  assert.equal(review('Independent re-review of abc: clean. Both P1s are fixed. No new findings.'), 'clean');
  assert.equal(review('Independent review of abc: clean, no open P1 or P2.'), 'clean');
  assert.equal(review('Independent re-review: no new findings. [P2] Previous retry issue remains open'), 'findings');
  assert.equal(review('Independent review of abc: not clean yet.'), 'findings');
  assert.equal(review('**Independent review of abc: clean, no P0, P1 or P2.**'), 'clean');
  assert.equal(review('Independent review of abc: clean. Codex P1s, fixed. Earlier P3s, fixed.'), 'clean');
  assert.equal(review('Independent review of abc. Docs only, so only P0 and P1 block. Clean. It resolves the Codex P1.'), 'clean');
  assert.equal(review('## Independent review of abc\n\nNo new findings.\n\n### P1. The token is readable'), 'findings');
  assert.equal(review('Independent re-review of abc: clean. Fixed one P1 and two P2 findings; no new findings.'), 'clean');
  assert.equal(review('Independent re-review of abc. No new findings. One P1 was fixed, but one P2 remains open.'), 'findings');
  assert.equal(review('Independent re-review of abc: clean. One P1 fixed; one P2 still open.'), 'findings');
});

test('a row has every column, and the CSV quotes commas and defuses formulas', () => {
  const row = buildRow(pull({ title: 'One, two' }), {
    files: [{ filename: 'STATUS.md', additions: 2, deletions: 1 }], reviews: [{ user: { login: 'CloudworkSystems' }, state: 'APPROVED' }],
    comments: [], reviewComments: [], commits: [commit('x')],
  });
  assert.deepEqual(Object.keys(row), COLUMNS);
  assert.equal(row.state, 'merged');
  assert.equal(row.daysOpen, 1.5);
  assert.equal(row.ownerApproved, 'yes');
  const csv = toCsv([row, { ...row, title: '=HYPERLINK("x")' }]).split('\n');
  assert.match(csv[1], /^900,"One, two",/);
  assert.match(csv[2], /^900,"'=HYPERLINK\(""x""\)",/);
});
