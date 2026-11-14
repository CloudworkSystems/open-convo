import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pinProblems, pullRequestTargetProblems, usesPullRequestTarget, readWorkflows } from '../workflow-guards.mjs';
import { lockfileFolders, foldersToAudit, parseAcceptedRisks, advisoriesIn, judge, ACCEPTED_RISKS } from '../npm-audit.mjs';

const WORKFLOWS = fileURLToPath(new URL('../../workflows', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SHA = 'a'.repeat(40);
const DEFAULT = '${{ github.event.repository.default_branch }}';

// ------------------------------------------------------------ the real files

test('every workflow pins its actions to a commit hash with a version comment', () => {
  const workflows = readWorkflows(WORKFLOWS);
  assert.ok(workflows.length > 0);
  for (const { name, text } of workflows) assert.deepEqual(pinProblems(text), [], name);
});

test('every pull_request_target workflow checks out only the default branch', () => {
  const targets = readWorkflows(WORKFLOWS).filter((w) => usesPullRequestTarget(w.text));
  // codex-approved.yml, owner-queue.yml and status-feed.yml today; the guard must see them.
  assert.ok(targets.map((w) => w.name).includes('codex-approved.yml'));
  assert.ok(targets.map((w) => w.name).includes('owner-queue.yml'));
  assert.ok(targets.map((w) => w.name).includes('status-feed.yml'));
  for (const { name, text } of targets) assert.deepEqual(pullRequestTargetProblems(text), [], name);
});

test('the accepted-risks list is well formed', () => {
  parseAcceptedRisks(readFileSync(`${ROOT}/${ACCEPTED_RISKS}`, 'utf8'));
});

// ------------------------------------------------------------ pins

test('pins: tags, branches and short hashes fail; full hashes with a version pass', () => {
  const wf = (uses) => `jobs:\n  a:\n    steps:\n      - uses: ${uses}\n`;
  assert.deepEqual(pinProblems(wf(`actions/checkout@${SHA} # v4.4.0`)), []);
  assert.deepEqual(pinProblems(wf(`'actions/checkout@${SHA}' # v4`)), []);
  assert.deepEqual(pinProblems(wf(`invented/tool/sub-action@${SHA} # v1.2.3`)), []);
  assert.deepEqual(pinProblems(wf('./.github/actions/local')), []);
  assert.match(pinProblems(wf('actions/checkout@v4'))[0], /not pinned/);
  assert.match(pinProblems(wf('actions/checkout@main'))[0], /not pinned/);
  assert.match(pinProblems(wf('actions/checkout@abc1234 # v4'))[0], /not pinned/);
  assert.match(pinProblems(wf(`actions/checkout@${SHA}`))[0], /version it stands for/);
  assert.match(pinProblems(wf(`actions/checkout@${SHA} # latest`))[0], /version it stands for/);
  assert.match(pinProblems(wf('docker://invented/image:1'))[0], /sha256/);
  assert.deepEqual(pinProblems(wf(`docker://invented/image@sha256:${'b'.repeat(64)}`)), []);
});

test('pins: a step whose uses comes after its name is checked too', () => {
  const text = 'jobs:\n  a:\n    steps:\n      - name: Check out\n        uses: actions/checkout@v4\n';
  assert.equal(pinProblems(text).length, 1);
});

// ------------------------------------------------------------ pull_request_target

const target = (checkout, extra = '') => `on:
  pull_request_target:
    types: [opened]
jobs:
  a:
    runs-on: ubuntu-latest
    steps:
${checkout}      - run: node .github/scripts/x.mjs
${extra}`;

const goodCheckout = `      - uses: actions/checkout@${SHA} # v4.4.0
        with:
          ref: ${DEFAULT}
          persist-credentials: false
`;

test('pull_request_target: the trigger is found in each way `on:` can be written', () => {
  assert.equal(usesPullRequestTarget('on: pull_request_target\n'), true);
  assert.equal(usesPullRequestTarget('on: [push, pull_request_target]\n'), true);
  assert.equal(usesPullRequestTarget("'on':\n  pull_request_target:\n"), true);
  assert.equal(usesPullRequestTarget('on:\n  pull_request:\n# pull_request_target is left out\njobs: {}\n'), false);
  assert.equal(usesPullRequestTarget('on:\n  pull_request:\njobs:\n  a:\n    name: pull_request_target\n'), false);
});

test('pull_request_target: a checkout of the default branch passes', () => {
  assert.deepEqual(pullRequestTargetProblems(target(goodCheckout)), []);
  assert.deepEqual(pullRequestTargetProblems(target(goodCheckout.replace(DEFAULT, `'${DEFAULT}'`))), []);
});

test('pull_request_target: a checkout without a ref, or of the pull request, fails', () => {
  const noRef = `      - uses: actions/checkout@${SHA} # v4.4.0\n`;
  assert.match(pullRequestTargetProblems(target(noRef))[0], /must set `ref:/);
  const head = goodCheckout.replace(DEFAULT, '${{ github.event.pull_request.head.sha }}');
  const problems = pullRequestTargetProblems(target(head));
  assert.ok(problems.some((p) => /must set `ref:/.test(p)));
  assert.ok(problems.some((p) => /reach for pull request code/.test(p)));
  const named = `      - name: Check out\n        uses: actions/checkout@${SHA} # v4.4.0\n        with:\n          ref: refs/pull/1/merge\n`;
  assert.ok(pullRequestTargetProblems(target(named)).some((p) => /must set `ref:/.test(p)));
});

test('pull_request_target: another repository or fetching pull request code fails', () => {
  const other = goodCheckout.replace('          persist-credentials', '          repository: invented/fork\n          persist-credentials');
  assert.match(pullRequestTargetProblems(target(other))[0], /another repository/);
  for (const run of ['git fetch origin pull/1/head', 'gh pr checkout 1', 'echo ${{ github.head_ref }}']) {
    const problems = pullRequestTargetProblems(target(goodCheckout, `      - run: ${run}\n`));
    assert.match(problems[0], /reach for pull request code/, run);
  }
});

test('pull_request_target: comments are not mistaken for code, and other triggers are left alone', () => {
  assert.deepEqual(pullRequestTargetProblems(target(goodCheckout, '      # never git fetch the head here\n')), []);
  const plain = target(`      - uses: actions/checkout@${SHA} # v4.4.0\n`).replace('pull_request_target', 'pull_request');
  assert.deepEqual(pullRequestTargetProblems(plain), []);
});

// ------------------------------------------------------------ npm audit

test('audit: lockfile folders and which ones a change touches', () => {
  const folders = lockfileFolders(['apps/desk/package-lock.json', 'apps/desk/src/a.ts', 'packages/one/package-lock.json', 'README.md']);
  assert.deepEqual(folders, ['apps/desk', 'packages/one']);
  assert.deepEqual(foldersToAudit(['apps/desk/src/a.ts'], folders), ['apps/desk']);
  assert.deepEqual(foldersToAudit(['apps/desktop/a.ts', 'README.md'], folders), []);
  assert.deepEqual(foldersToAudit(['.github/workflows/tests.yml'], folders), folders);
});

const GHSA_A = 'GHSA-2222-3333-4444';
const GHSA_B = 'GHSA-cccc-ffff-gggg';
const GHSA_C = 'GHSA-hhhh-jjjj-mmmm';
const advisory = (id, name, severity) => ({ source: 1, name, severity, title: `Invented issue in ${name}`, url: `advisories/${id}` });
const report = (vulns) => ({ auditReportVersion: 2, vulnerabilities: vulns });

// Invented packages: a runtime one with a high and a moderate advisory, and a
// development tool with a critical one.
const runtime = report({
  'invented-runtime': { name: 'invented-runtime', severity: 'high', via: [advisory(GHSA_A, 'invented-runtime', 'high'), advisory(GHSA_B, 'invented-runtime', 'moderate')] },
  'invented-wrapper': { name: 'invented-wrapper', severity: 'high', via: ['invented-runtime'] },
});
const full = report({
  ...runtime.vulnerabilities,
  'invented-dev-tool': { name: 'invented-dev-tool', severity: 'critical', via: [advisory(GHSA_C, 'invented-dev-tool', 'critical')] },
});

test('audit: each advisory is read once, through paths are skipped', () => {
  assert.deepEqual(advisoriesIn(runtime).map((a) => `${a.id}:${a.package}:${a.severity}`), [
    `${GHSA_A}:invented-runtime:high`,
    `${GHSA_B}:invented-runtime:moderate`,
  ]);
  assert.throws(() => advisoriesIn({ error: { code: 'ENOTFOUND', summary: 'registry unreachable' } }), /registry unreachable/);
  assert.throws(() => advisoriesIn({}), /without a vulnerabilities section/);
});

test('audit: high runtime advisories fail; development-only and lower ones are reported', () => {
  const result = judge({ folder: 'apps/desk', runtime, full, accepted: [] });
  assert.deepEqual(result.failures.map((f) => f.id), [GHSA_A]);
  assert.deepEqual(result.warnings.map((w) => `${w.id}:${w.scope}`), [`${GHSA_B}:runtime`, `${GHSA_C}:development only`]);
});

test('audit: an accepted advisory passes only for its own folder and package', () => {
  const entry = { advisory: GHSA_A, folder: 'apps/desk', package: 'invented-runtime', reason: 'Invented: the code path is never called.', ownerYes: '2026-11-02, invented thread', date: '2026-11-02' };
  const accepted = parseAcceptedRisks(JSON.stringify({ accepted: [entry] }));
  assert.deepEqual(judge({ folder: 'apps/desk', runtime, full, accepted }).failures, []);
  assert.deepEqual(judge({ folder: 'apps/desk', runtime, full, accepted }).accepted.map((a) => a.id), [GHSA_A]);
  assert.equal(judge({ folder: 'packages/one', runtime, full, accepted }).failures.length, 1);
});

test('audit: a malformed accepted-risks entry is refused', () => {
  const entry = { advisory: GHSA_A, folder: 'apps/desk', package: 'invented-runtime', reason: 'r', ownerYes: 'y', date: '2026-11-02' };
  assert.throws(() => parseAcceptedRisks('{}'), /"accepted" list/);
  assert.throws(() => parseAcceptedRisks(JSON.stringify({ accepted: [{ ...entry, ownerYes: '' }] })), /ownerYes/);
  assert.throws(() => parseAcceptedRisks(JSON.stringify({ accepted: [{ ...entry, advisory: 'CVE-2026-0001' }] })), /GHSA id/);
  assert.throws(() => parseAcceptedRisks(JSON.stringify({ accepted: [{ ...entry, date: 'November 2' }] })), /YYYY-MM-DD/);
});
