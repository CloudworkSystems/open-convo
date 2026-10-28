import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateCodexSignal, editedOnlyByCodex, dismissedByOwner, ownerAcceptance, CODEX_LOGIN, CODEX_BOT_LOGIN, OWNER_LOGIN } from '../codex-signal.mjs';
import { parseCodeowners, protectedFiles, ownerOpenedBlock, withOwnerOpenedHold } from '../codeowners.mjs';
import { packagesToTest, listPackages, OWN_JOB } from '../package-changes.mjs';

const HEAD = '7af6dd5bd9'.padEnd(40, 'a');
const OLD = '572b68d313'.padEnd(40, 'b');
const codex = { login: CODEX_LOGIN, type: 'Bot' };
const impostor = { login: 'cloudwork-bot', type: 'User' };

const clean = (sha, at, user = codex) => ({
  user, created_at: at,
  body: `Codex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\`\n`,
});
const findings = (sha, at, user = codex) => ({ user, commit_id: sha, state: 'COMMENTED', submitted_at: at, body: '### 💡 Codex Review' });
const summary = (sha, done = '2026-10-15T01:30:00.123456Z') => ({
  user: codex, created_at: '2026-10-15T00:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="${done}">${done}</relative-time> | \`${sha.slice(0, 7)}\` | Manual request |`,
});
const thumb = (at, user = { login: CODEX_LOGIN, type: 'User' }) => ({ user, content: '+1', created_at: at });

test('clean comment on the head commit approves', () => {
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [clean(HEAD, '2026-10-15T02:00:00Z')] }).approved, true);
});

test('clean comment on an older commit does not approve (new commit resets)', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [clean(OLD, '2026-10-15T02:00:00Z')] });
  assert.equal(r.approved, false);
});

test('findings on the head block approval', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, reviews: [findings(HEAD, '2026-10-15T01:00:00Z')] });
  assert.equal(r.approved, false);
  assert.match(r.reason, /findings/);
});

test('a later clean round on the same head approves', () => {
  const r = evaluateCodexSignal({
    headSha: HEAD,
    reviews: [findings(HEAD, '2026-10-15T01:00:00Z')],
    comments: [clean(HEAD, '2026-10-15T02:00:00Z')],
  });
  assert.equal(r.approved, true);
});

test('findings after a clean comment on the same head block approval', () => {
  const r = evaluateCodexSignal({
    headSha: HEAD,
    comments: [clean(HEAD, '2026-10-15T01:00:00Z')],
    reviews: [findings(HEAD, '2026-10-15T02:00:00Z')],
  });
  assert.equal(r.approved, false);
});

test('signals from any other account are ignored', () => {
  const r = evaluateCodexSignal({
    headSha: HEAD,
    comments: [clean(HEAD, '2026-10-15T02:00:00Z', impostor), { ...summary(HEAD), user: impostor }],
    reactions: [thumb('2026-10-15T02:00:00Z', impostor)],
  });
  assert.equal(r.approved, false);
});

test('a look-alike login without the app suffix is ignored', () => {
  const fake = { login: 'chatgpt-codex-connector', type: 'User' };
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [clean(HEAD, '2026-10-15T02:00:00Z', fake)] }).approved, false);
});

test('thumbs-up with a completed summary on the head approves', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [summary(HEAD)], reactions: [thumb('2026-10-15T02:00:00Z')] });
  assert.equal(r.approved, true);
});

test('thumbs-up with the summary on an older commit does not approve', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [summary(OLD)], reactions: [thumb('2026-10-15T02:00:00Z')] });
  assert.equal(r.approved, false);
});

test('an old thumbs-up does not outweigh newer findings on the head', () => {
  const r = evaluateCodexSignal({
    headSha: HEAD,
    comments: [summary(HEAD)],
    reactions: [thumb('2026-10-15T01:00:00Z')],
    reviews: [findings(HEAD, '2026-10-15T02:00:00Z')],
  });
  assert.equal(r.approved, false);
});

test('resolved threads alone never approve', () => {
  // Only a review with findings exists; its threads being resolved changes nothing.
  const r = evaluateCodexSignal({ headSha: HEAD, reviews: [{ ...findings(HEAD, '2026-10-15T01:00:00Z'), resolved: true }] });
  assert.equal(r.approved, false);
});

test('no head commit never approves', () => {
  assert.equal(evaluateCodexSignal({ headSha: '' }).approved, false);
});

test('CODEOWNERS covers the rules, decisions and key files, and not ordinary code', () => {
  const rules = parseCodeowners(readFileSync(new URL('../../CODEOWNERS', import.meta.url), 'utf8'));
  const files = [
    'AGENTS.md', 'CLAUDE.md', '.github/CODEOWNERS', '.github/workflows/tests.yml',
    'PLAN.md', 'docs/decisions.md',
    'apps/mac/Sources/ArchiveProtection/ArchiveSeal.swift',
    'apps/mac/Sources/DeskHost/StoreCipher.swift',
    'apps/mac/Tests/ParticipantProcessTests/PaidUsageGateTests.swift',
    'apps/mac/Sources/DeskHost/ProofStore.swift', 'apps/mac/Sources/DeskWindowKit/DeskSession.swift',
    'apps/mac/Sources/ParticipantProcess/PaidUsageEndSignals.swift',
    'apps/mac/Sources/ParticipantDeskControls/PaidUsageDeskControls.swift',
    'apps/mac/Sources/ParticipantCoordinator/ParticipantCoordinator.swift',
    'apps/mac/Tests/DeskHostTests/StoreEncryptionTests.swift', 'apps/mac/Tests/DeskHostTests/WriteFaultRecoveryTests.swift',
    'apps/mac/Tests/DeskHostTests/ProofStoreTests.swift', 'apps/mac/Tests/ArchiveProtectionTests/SealedRecordingsTests.swift',
    'apps/mac/Sources/VoiceCursorMac/main.swift', 'apps/mac/Package.swift',
    'apps/mac/Tests/DeskWindowKitTests/DeskSessionParticipantTests.swift',
    'apps/mac/Sources/ParticipantProcess/ParticipantAvailability.swift',
    'apps/mac/Tests/ParticipantProcessTests/CoordinatorAppWiringTests.swift',
    'apps/mac/Sources/ParticipantSupervisor/Core/SupervisorDriver.swift',
    'apps/mac/Sources/DeskHost/ParticipantLane.swift', 'apps/mac/Tests/VoiceCursorCoreTests/DeskRouteWiringTests.swift',
    'apps/mac/Tests/ProtectionProofTests/Anything.swift',
    'apps/mac/Sources/VoiceCursorMac/OpenAIRealtimeTranscriber.swift',
    'apps/mac/Sources/VoiceCursorMac/OpenAIRealtimeSmoke.swift',
    'docs/plans/AGENTS.md', 'packages/CLAUDE.md', 'sub/AGENTS.md',
    // "/**/" matches zero folders too.
    'apps/mac/FooKeychain.swift', 'apps/mac/ParticipantX.swift',
  ];
  assert.deepEqual(protectedFiles(rules, files), files);
  const open = ['STATUS.md', 'README.md', 'apps/desk/src/app/App.tsx', 'packages/clarity/src/index.mjs',
    'docs/annotations/x.md', 'apps/mac/Sources/DeskHost/DeskHost.swift', 'docs/plans-old.md', 'docs/AGENTS-notes.md',
    // Plans merge on the owner's yes in a Claude thread (owner decision, October 27).
    'docs/plans/merge-gate.md', 'docs/plans/desk-annotation-layer.md',
    'apps/mac/Sources/VoiceCursorCore/ElectronFocusPolicy.swift', 'apps/mac/Sources/CorrectionMemory/LocalDataBoundary.swift'];
  assert.deepEqual(protectedFiles(rules, open), []);
});

test('a thumbs-up left from an earlier commit does not count for a newly completed head', () => {
  // 👍 at 01:00 for the old commit; the head's review completed at 01:30 with no new 👍.
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [summary(HEAD, '2026-10-15T01:30:00Z')], reactions: [thumb('2026-10-15T01:00:00Z')] });
  assert.equal(r.approved, false);
});

test('a thumbs-up at the same second as the completion does not count', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [summary(HEAD, '2026-10-15T01:30:00Z')], reactions: [thumb('2026-10-15T01:30:00Z')] });
  assert.equal(r.approved, false);
});

test('a clean comment and a finding in the same second fail closed', () => {
  const r = evaluateCodexSignal({
    headSha: HEAD,
    comments: [clean(HEAD, '2026-10-15T02:00:00Z')],
    reviews: [findings(HEAD, '2026-10-15T02:00:00Z')],
  });
  assert.equal(r.approved, false);
});

test('a summary without a completion time never approves through a thumbs-up', () => {
  const body = `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** | \`${HEAD.slice(0, 7)}\` | Manual request |`;
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [{ user: codex, created_at: '2026-10-15T00:00:00Z', body }], reactions: [thumb('2026-10-15T02:00:00Z')] });
  assert.equal(r.approved, false);
});

// Edit records as GitHub's GraphQL API reports them.
const codexEditor = { __typename: 'Bot', login: CODEX_BOT_LOGIN };
const botEditor = { __typename: 'User', login: 'cloudwork-bot' };
const neverEdited = { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } };
const editedBy = (...editors) => ({
  lastEditedAt: '2026-10-15T03:00:00Z',
  editor: editors[0],
  // Newest first, ending with the original version (its editor is the author).
  userContentEdits: { totalCount: editors.length + 1, nodes: [...editors, codexEditor].map((editor) => ({ editor, deletedAt: null })) },
});

const stateComment = (sha, { findings = false, status = 'completed', at = '2026-10-15T02:00:00Z', user = codex } = {}) => ({
  user, created_at: '2026-10-15T00:00:00Z', updated_at: at, edit_history: editedBy(codexEditor),
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: sha, has_any_findings: findings, has_unresolved_findings: findings, status } })} -->\n## Codex Review Summary`,
});

test('Codex review state: completed with no findings on the head approves', () => {
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [stateComment(HEAD)] }).approved, true);
});

test('Codex review state: an older commit, findings, or not completed do not approve', () => {
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [stateComment(OLD)] }).approved, false);
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [stateComment(HEAD, { findings: true })] }).approved, false);
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [stateComment(HEAD, { status: 'in_progress' })] }).approved, false);
});

test('Codex review state from any other account is ignored', () => {
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [stateComment(HEAD, { user: impostor })] }).approved, false);
});

test('Codex review state does not outweigh a later finding on the head', () => {
  const r = evaluateCodexSignal({
    headSha: HEAD,
    comments: [stateComment(HEAD, { at: '2026-10-15T01:00:00Z' })],
    reviews: [findings(HEAD, '2026-10-15T02:00:00Z')],
  });
  assert.equal(r.approved, false);
});

test('a malformed review state never approves', () => {
  const bad = { user: codex, updated_at: '2026-10-15T02:00:00Z', body: '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 {not json} -->' };
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [bad] }).approved, false);
});

test('no workflow job or job name is called codex-approved (only the status may carry that name)', async () => {
  const { readdirSync, readFileSync: read } = await import('node:fs');
  const dir = new URL('../../workflows/', import.meta.url);
  for (const file of readdirSync(dir)) {
    const text = read(new URL(file, dir), 'utf8');
    const jobs = text.split(/^jobs:\s*$/m)[1] ?? '';
    assert.doesNotMatch(jobs, /^  codex-approved:\s*$/m, `${file} has a job keyed codex-approved`);
    assert.doesNotMatch(jobs, /^\s+name:\s*['"]?codex-approved['"]?\s*$/m, `${file} has a job named codex-approved`);
  }
});

// Anyone with write access (the builder bot included) can edit Codex's
// comments, and GitHub keeps showing Codex as the author.

test('an unedited clean comment on the head approves (with its edit record)', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [{ ...clean(HEAD, '2026-10-15T02:00:00Z'), edit_history: neverEdited }] });
  assert.equal(r.approved, true);
});

test('a clean comment edited by the bot to name the head does not approve', () => {
  // Codex approved an older commit; the bot rewrote the commit in the comment.
  const forged = { ...clean(HEAD, '2026-10-15T02:00:00Z'), updated_at: '2026-10-15T03:00:00Z', edit_history: editedBy(botEditor) };
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [forged] }).approved, false);
});

test('a review state forged by the bot does not approve', () => {
  const forged = { ...stateComment(HEAD), edit_history: editedBy(botEditor) };
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [forged] }).approved, false);
});

test('a bot edit stays disqualifying even if Codex edits the comment again later', () => {
  const mixed = { ...stateComment(HEAD), edit_history: editedBy(codexEditor, botEditor) };
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [mixed] }).approved, false);
});

test('a summary completion time forged by the bot does not let a thumbs-up approve', () => {
  const forged = { ...summary(HEAD, '2026-10-15T01:30:00Z'), edit_history: editedBy(botEditor) };
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [forged], reactions: [thumb('2026-10-15T02:00:00Z')] });
  assert.equal(r.approved, false);
});

test('Codex editing its own summary comment still counts', () => {
  // Codex rewrites its summary comment many times per pull request.
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [stateComment(HEAD)] }).approved, true);
  const summaryEdited = { ...summary(HEAD, '2026-10-15T01:30:00Z'), edit_history: editedBy(codexEditor, codexEditor) };
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [summaryEdited], reactions: [thumb('2026-10-15T02:00:00Z')] }).approved, true);
});

test('edits whose editor cannot be checked fail closed', () => {
  const base = clean(HEAD, '2026-10-15T02:00:00Z');
  const cases = {
    'record missing': { ...base, edit_history: null },
    'editor deleted (null)': { ...base, edit_history: editedBy(null) },
    'partial history': { ...base, edit_history: { ...editedBy(codexEditor), userContentEdits: { totalCount: 150, nodes: editedBy(codexEditor).userContentEdits.nodes } } },
    'edited with no revisions listed': { ...base, edit_history: { lastEditedAt: '2026-10-15T03:00:00Z', editor: codexEditor, userContentEdits: { totalCount: 0, nodes: [] } } },
    'a revision deleted from history': { ...base, edit_history: { ...editedBy(codexEditor), userContentEdits: { totalCount: 2, nodes: [{ editor: codexEditor, deletedAt: '2026-10-15T04:00:00Z' }, { editor: codexEditor, deletedAt: null }] } } },
    'look-alike user editor': { ...base, edit_history: editedBy({ __typename: 'User', login: CODEX_BOT_LOGIN }) },
    'no record and changed since posting': { ...base, updated_at: '2026-10-15T03:00:00Z' },
  };
  for (const [name, comment] of Object.entries(cases)) {
    assert.equal(editedOnlyByCodex(comment), false, name);
    assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [comment] }).approved, false, name);
  }
});

// `tests` check: packages outside the dedicated jobs.
const PKGS = ['clarity', 'habit-grid', 'household-lists', 'site-engine'];

test('a change inside a package runs that package only', () => {
  assert.deepEqual(packagesToTest(['packages/site-engine/src/build.mjs'], PKGS), ['site-engine']);
  assert.deepEqual(packagesToTest(['packages/household-lists/README.md', 'packages/habit-grid/package.json'], PKGS), ['habit-grid', 'household-lists']);
});

test('changes outside packages run no package', () => {
  assert.deepEqual(packagesToTest(['STATUS.md', 'apps/desk/src/app/App.tsx', 'packages-old/x.mjs', 'packages/site-engine-copy/x'], PKGS), []);
  assert.deepEqual(packagesToTest([], PKGS), []);
});

test('a change to the checks, or a manual run, runs every package', () => {
  assert.deepEqual(packagesToTest(['.github/workflows/tests.yml'], PKGS), ['habit-grid', 'household-lists', 'site-engine']);
  assert.deepEqual(packagesToTest([], PKGS, { all: true }), ['habit-grid', 'household-lists', 'site-engine']);
});

test('packages with their own job are not run twice', () => {
  assert.deepEqual(packagesToTest(['packages/clarity/src/index.mjs'], PKGS), []);
  assert.ok(OWN_JOB.has('clarity'));
});

test('a package folder name unsafe for workflow paths is refused', () => {
  assert.throws(() => packagesToTest(['.github/x'], ['ok', 'bad name; rm -rf']));
});

test('every package in this repo with a package.json is found', () => {
  const found = listPackages(fileURLToPath(new URL('../../../packages/', import.meta.url)));
  for (const name of ['clarity', 'household-lists', 'site-engine']) assert.ok(found.includes(name), name);
});

test('the tests check waits for every other job in tests.yml', () => {
  const text = readFileSync(new URL('../../workflows/tests.yml', import.meta.url), 'utf8');
  const jobs = [...(text.split(/^jobs:\s*$/m)[1] ?? '').matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm)].map((m) => m[1]);
  const needs = (text.match(/^  tests:\s*\n    needs: \[([^\]]*)\]/m) ?? [])[1]?.split(',').map((s) => s.trim()) ?? [];
  assert.deepEqual(needs.sort(), jobs.filter((j) => j !== 'tests').sort());
});

// Any account with write access can dismiss a Codex review. Only the owner's
// dismissal clears the finding.
// As GitHub documents them: a review's id is a number, the event's review_id a string.
const dismissedReview = (id, sha, at) => ({ ...findings(sha, at), id, state: 'DISMISSED' });
const dismissal = (id, login) => ({ event: 'review_dismissed', actor: login ? { login } : null, dismissed_review: { review_id: String(id), state: 'dismissed' } });

test('a Codex review dismissed by the bot still blocks', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [clean(HEAD, '2026-10-15T01:00:00Z')], reviews: [dismissedReview(7, HEAD, '2026-10-15T02:00:00Z')], dismissals: [dismissal(7, 'cloudwork-bot')] });
  assert.equal(r.approved, false);
  assert.match(r.reason, /findings/);
});

test('a Codex review dismissed by the owner no longer blocks', () => {
  const r = evaluateCodexSignal({ headSha: HEAD, comments: [clean(HEAD, '2026-10-15T01:00:00Z')], reviews: [dismissedReview(7, HEAD, '2026-10-15T02:00:00Z')], dismissals: [dismissal(7, OWNER_LOGIN)] });
  assert.equal(r.approved, true);
});

test('a dismissed Codex review blocks when the dismisser is unknown', () => {
  const base = { headSha: HEAD, comments: [clean(HEAD, '2026-10-15T01:00:00Z')], reviews: [dismissedReview(7, HEAD, '2026-10-15T02:00:00Z')] };
  for (const [name, dismissals] of Object.entries({
    'no event': [],
    'event for another review': [dismissal(8, OWNER_LOGIN)],
    'actor missing (deleted account)': [dismissal(7, null)],
    'timeline not given': undefined,
    'owner and someone else': [dismissal(7, OWNER_LOGIN), dismissal(7, 'cloudwork-bot')],
  })) {
    assert.equal(evaluateCodexSignal({ ...base, dismissals }).approved, false, name);
  }
});

test('with no dismissals, results are unchanged', () => {
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [clean(HEAD, '2026-10-15T02:00:00Z')], reviews: [findings(HEAD, '2026-10-15T01:00:00Z')], dismissals: [] }).approved, true);
  assert.equal(evaluateCodexSignal({ headSha: HEAD, comments: [clean(HEAD, '2026-10-15T01:00:00Z')], reviews: [findings(HEAD, '2026-10-15T02:00:00Z')], dismissals: [] }).approved, false);
  assert.equal(dismissedByOwner({ id: 7 }, [dismissal(7, OWNER_LOGIN)]), true);
});

test('review ids match whether the event gives them as text or as a number', () => {
  const review = dismissedReview(5594675189, HEAD, '2026-10-15T02:00:00Z');
  assert.equal(typeof review.id, 'number');
  assert.equal(dismissedByOwner(review, [dismissal(5594675189, OWNER_LOGIN)]), true);
  // This repo's own review_dismissed events return a number.
  const numeric = { ...dismissal(5594675189, OWNER_LOGIN), dismissed_review: { review_id: 5594675189, state: 'dismissed' } };
  assert.equal(dismissedByOwner(review, [numeric]), true);
  assert.equal(dismissedByOwner({ id: undefined }, [{ ...numeric, dismissed_review: {} }]), false);
});

// The owner's "owner-accepts-findings" note.
const ownerUser = { login: OWNER_LOGIN, type: 'User' };
const ownerEditor = { __typename: 'User', login: OWNER_LOGIN };
const note = (body, { user = ownerUser, history = neverEdited } = {}) => ({ user, created_at: '2026-10-15T03:00:00Z', body, edit_history: history });
const withFindings = (extra) => ({ headSha: HEAD, prAuthor: 'cloudwork-bot', reviews: [findings(HEAD, '2026-10-15T01:00:00Z')], ...extra });

test('owner note on the exact head passes despite open findings', () => {
  // Exactly the one visible line at the left edge; blank lines around it and trailing whitespace are ignored.
  for (const body of [`owner-accepts-findings ${HEAD}`, `\n\r\nowner-accepts-findings ${HEAD}  \r\n`, `  \nowner-accepts-findings ${HEAD}\t\n`]) {
    const r = evaluateCodexSignal(withFindings({ comments: [note(body)] }));
    assert.equal(r.approved, true, body);
    assert.equal(r.reason, `Owner accepted remaining findings on ${HEAD}.`);
  }
  // Edited only by the owner still counts.
  const edited = { ...editedBy(ownerEditor), userContentEdits: { totalCount: 2, nodes: [{ editor: ownerEditor, deletedAt: null }, { editor: ownerEditor, deletedAt: null }] } };
  assert.equal(evaluateCodexSignal(withFindings({ comments: [note(`owner-accepts-findings ${HEAD}`, { history: edited })] })).approved, true);
});

test('owner note naming another commit stays pending', () => {
  assert.equal(evaluateCodexSignal(withFindings({ comments: [note(`owner-accepts-findings ${OLD}`)] })).approved, false);
});

test('a note from the bot or from Codex is ignored', () => {
  for (const user of [impostor, codex, { login: OWNER_LOGIN, type: 'Bot' }]) {
    assert.equal(evaluateCodexSignal(withFindings({ comments: [note(`owner-accepts-findings ${HEAD}`, { user })] })).approved, false, user.login);
  }
});

test('an owner note edited by the bot, or with an unreadable edit record, is ignored', () => {
  const byBot = { ...editedBy(botEditor), userContentEdits: { totalCount: 2, nodes: [{ editor: botEditor, deletedAt: null }, { editor: ownerEditor, deletedAt: null }] }, editor: botEditor };
  for (const history of [byBot, null]) {
    assert.equal(evaluateCodexSignal(withFindings({ comments: [note(`owner-accepts-findings ${HEAD}`, { history })] })).approved, false, String(history));
  }
  // No edit record attached at all.
  const { edit_history, ...unread } = note(`owner-accepts-findings ${HEAD}`);
  assert.equal(evaluateCodexSignal(withFindings({ comments: [unread] })).approved, false);
});

test('an owner note never counts on a pull request opened by the owner (or of unknown author)', () => {
  for (const prAuthor of [OWNER_LOGIN, undefined, '']) {
    assert.equal(evaluateCodexSignal(withFindings({ prAuthor, comments: [note(`owner-accepts-findings ${HEAD}`)] })).approved, false, String(prAuthor));
  }
});

test('malformed owner notes are ignored', () => {
  for (const body of [
    `owner-accepts-findings ${HEAD.slice(0, 7)}`,
    `owner-accepts-findings ${HEAD.toUpperCase()}`,
    `owner-accepts-findings ${HEAD} and more`,
    `please owner-accepts-findings ${HEAD}`,
    `owner-accepts-findings  ${HEAD}`,
    `<!-- owner-accepts-findings ${HEAD} -->`,
    `<!-- owner-accepts-findings sha=${HEAD} -->`,
    `    owner-accepts-findings ${HEAD}`,
    `\towner-accepts-findings ${HEAD}`,
    `\n  owner-accepts-findings ${HEAD}`,
    ` owner-accepts-findings ${HEAD}`,
    `<!-- owner-accepts-findings sha=${HEAD.slice(0, 39)} -->`,
    `\`owner-accepts-findings ${HEAD}\``,
  ]) {
    assert.equal(ownerAcceptance({ headSha: HEAD, prAuthor: 'cloudwork-bot', comments: [note(body)] }), false, body);
  }
});

test('an owner note only satisfies codex-approved, never tests', async () => {
  const dir = new URL('../../workflows/', import.meta.url);
  const tests = readFileSync(new URL('tests.yml', dir), 'utf8');
  assert.doesNotMatch(tests, /owner-accepts-findings|codex-signal|issue_comment/);
  const scripts = new URL('../', import.meta.url);
  const { readdirSync } = await import('node:fs');
  const readers = readdirSync(scripts).filter((f) => f.endsWith('.mjs') && readFileSync(new URL(f, scripts), 'utf8').includes('owner-accepts-findings'));
  assert.deepEqual(readers, ['codex-signal.mjs']);
});

test('the gate re-runs on comments by the owner, including deletions', () => {
  const wf = readFileSync(new URL('../../workflows/codex-approved.yml', import.meta.url), 'utf8');
  assert.match(wf, /types: \[created, edited, deleted\]/);
  assert.match(wf, /github\.event\.comment\.user\.login == 'CloudworkSystems'/);
});

test('an owner note on a head Codex has not reviewed stays pending', () => {
  const ok = note(`owner-accepts-findings ${HEAD}`);
  // No Codex review or summary of the head at all.
  assert.equal(evaluateCodexSignal({ headSha: HEAD, prAuthor: 'cloudwork-bot', comments: [ok] }).approved, false);
  // Codex reviewed only an older commit.
  assert.equal(evaluateCodexSignal({ headSha: HEAD, prAuthor: 'cloudwork-bot', comments: [ok], reviews: [findings(OLD, '2026-10-15T01:00:00Z')] }).approved, false);
  // Codex's summary of the head (state or completed row) counts as reviewed.
  const state = stateComment(HEAD, { findings: true });
  assert.equal(evaluateCodexSignal({ headSha: HEAD, prAuthor: 'cloudwork-bot', comments: [ok, state] }).approved, true);
  const row = { ...summary(HEAD), edit_history: neverEdited };
  assert.equal(evaluateCodexSignal({ headSha: HEAD, prAuthor: 'cloudwork-bot', comments: [ok, row] }).approved, true);
});

test('a comment with anything besides the note never counts', () => {
  const t = '```';
  for (const body of [
    // Extra text before, after or around it.
    `Read what's left; fine.\n\nowner-accepts-findings ${HEAD}`,
    `owner-accepts-findings ${HEAD}\n\nThanks.`,
    `Accepted.\n\n<!-- owner-accepts-findings sha=${HEAD} -->`,
    `owner-accepts-findings ${HEAD}\nowner-accepts-findings ${HEAD}`,
    `owner-accepts-findings ${HEAD}\n<!-- owner-accepts-findings sha=${HEAD} -->`,
    // Quotes and lists.
    `> owner-accepts-findings ${HEAD}`,
    `- owner-accepts-findings ${HEAD}`,
    // Code fences and inline code.
    `${t}\nowner-accepts-findings ${HEAD}\n${t}`,
    `~~~\n<!-- owner-accepts-findings sha=${HEAD} -->\n~~~`,
    `\`owner-accepts-findings ${HEAD}\``,
    // HTML around it, including Codex's latest case: paired container tags
    // separated by blank lines.
    `<blockquote>\n\nowner-accepts-findings ${HEAD}\n\n</blockquote>`,
    `<details>\n\nowner-accepts-findings ${HEAD}\n\n</details>`,
    `<div>owner-accepts-findings ${HEAD}</div>`,
    `<!--\nowner-accepts-findings ${HEAD}\n-->`,
    `<pre>\n\nowner-accepts-findings ${HEAD}\n\n</pre>`,
    `<!-- aside -->\n\nowner-accepts-findings ${HEAD}`,
  ]) {
    assert.equal(ownerAcceptance({ headSha: HEAD, prAuthor: 'cloudwork-bot', comments: [note(body)] }), false, body);
  }
  // Missing or non-text bodies never count.
  for (const body of [undefined, null, '', '   ']) {
    assert.equal(ownerAcceptance({ headSha: HEAD, prAuthor: 'cloudwork-bot', comments: [note(body)] }), false, String(body));
  }
});

test('a pull request the owner opened waits when it changes a protected file', () => {
  const rules = parseCodeowners(readFileSync(new URL('../../CODEOWNERS', import.meta.url), 'utf8'));
  const reason = ownerOpenedBlock({ prAuthor: OWNER_LOGIN, files: ['packages/x/a.mjs', 'AGENTS.md'], rules });
  assert.match(reason, /AGENTS\.md/);
  // A renamed file's old path counts: moving a protected file away changes it.
  assert.ok(ownerOpenedBlock({ prAuthor: OWNER_LOGIN, files: ['docs/old-decisions.md', 'docs/decisions.md'], rules }));
});

test('the owner-opened rule leaves ordinary changes and bot pull requests alone', () => {
  const rules = parseCodeowners(readFileSync(new URL('../../CODEOWNERS', import.meta.url), 'utf8'));
  assert.equal(ownerOpenedBlock({ prAuthor: OWNER_LOGIN, files: ['packages/visibility-report/src/a.mjs', 'STATUS.md'], rules }), null);
  assert.equal(ownerOpenedBlock({ prAuthor: 'cloudwork-bot', files: ['AGENTS.md', '.github/CODEOWNERS'], rules }), null);
  assert.equal(ownerOpenedBlock({ prAuthor: undefined, files: ['AGENTS.md'], rules }), null);
});

test('an owner-opened pull request whose file list was cut short waits', () => {
  const rules = parseCodeowners(readFileSync(new URL('../../CODEOWNERS', import.meta.url), 'utf8'));
  assert.ok(ownerOpenedBlock({ prAuthor: OWNER_LOGIN, files: ['packages/x/a.mjs'], rules, complete: false }));
  assert.equal(ownerOpenedBlock({ prAuthor: 'cloudwork-bot', files: ['packages/x/a.mjs'], rules, complete: false }), null);
});

test('the owner-opened hold applies after triage too', () => {
  const blocked = "Opened from the code owner's account and changes AGENTS.md; reopen it from cloudwork-bot";
  const judged = { approved: true, reason: 'Judge rated all 2 remaining Codex finding(s) on 1111111 as nits.' };
  assert.deepEqual(withOwnerOpenedHold(judged, blocked), { approved: false, reason: blocked });
  assert.deepEqual(withOwnerOpenedHold({ approved: true, reason: 'Codex is clean' }, blocked), { approved: false, reason: blocked });
  assert.deepEqual(withOwnerOpenedHold(judged, null), judged);
  assert.deepEqual(withOwnerOpenedHold({ approved: false, reason: 'waiting' }, null), { approved: false, reason: 'waiting' });
  // The script checks the hold before calling the judge, so no paid call is made for a held pull request.
  const script = readFileSync(new URL('../codex-approved.mjs', import.meta.url), 'utf8');
  assert.match(script, /if \(!result\.approved && !blocked\) result = await triage/);
});

// Codex triage: the judge for pull requests stuck on minor findings
// (docs/plans/codex-triage.md).
import { triageEligibility, triagePasses, verdictComment, judgeFindings, findingPriority, ACTIONS_LOGIN, MIN_ROUNDS } from '../codex-triage.mjs';

const C1 = '1111111111'.padEnd(40, 'c');
const C2 = '2222222222'.padEnd(40, 'd');
const unedited = { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } };
const review = (id, sha, at = '2026-10-24T10:00:00Z') => ({ id, user: codex, commit_id: sha, state: 'COMMENTED', submitted_at: at });
const finding = (id, reviewId, p = 2, extra = {}) => ({
  id, node_id: `n${id}`, pull_request_review_id: reviewId, user: codex, path: 'src/a.mjs', line: 3, diff_hunk: '@@ -1 +1 @@\n+x',
  body: `**<sub><sub>![P${p} Badge](https://img.shields.io/badge/P${p}-yellow?style=flat)</sub></sub>  Guard a rare case**\n\nDetails.\n\n<!-- codex-code-review-finding:v1 -->`,
  edit_history: unedited, ...extra,
});
const loop = () => ({ headSha: HEAD, prAuthor: 'cloudwork-bot', fromFork: false, reviews: [review(1, C1), review(2, C2), review(3, HEAD)], reviewComments: [finding(31, 3), finding(32, 3, 3)] });
const actions = { login: ACTIONS_LOGIN, type: 'Bot' };
const verdictFor = (elig, verdicts, at = '2026-10-24T11:00:00Z', extra = {}) => ({
  user: actions, created_at: at, edit_history: unedited,
  body: verdictComment({ headSha: HEAD, findings: elig.findings, verdicts }), ...extra,
});
const nits = (elig, confidence = 0.9) => elig.findings.map((f) => ({ id: f.id, verdict: 'nit', confidence, reason: 'edge case' }));

test('triage: only the project\'s own builders, on branches in this repo, reach the judge', () => {
  assert.equal(triageEligibility({ ...loop(), prAuthor: CODEX_LOGIN }).eligible, true);
  assert.equal(triageEligibility({ ...loop(), prAuthor: 'someone-else' }).eligible, false);
  assert.equal(triageEligibility({ ...loop(), fromFork: true }).eligible, false);
  const { fromFork, ...unsaid } = loop();
  assert.equal(triageEligibility(unsaid).eligible, false);
});

test('triage: priority badges are read, anything else is null', () => {
  assert.equal(findingPriority(finding(1, 1, 2).body), 2);
  assert.equal(findingPriority(finding(1, 1, 1).body), 1);
  assert.equal(findingPriority('no badge here'), null);
});

test('triage: P2/P3 findings after enough rounds are eligible', () => {
  const e = triageEligibility(loop());
  assert.equal(e.eligible, true, e.reason);
  assert.equal(e.findings.length, 2);
  assert.equal(MIN_ROUNDS, 3);
});

test('triage: too few rounds, a P1, an unreadable priority, or no findings are not eligible', () => {
  assert.equal(triageEligibility({ ...loop(), reviews: [review(2, C2), review(3, HEAD)] }).eligible, false);
  assert.equal(triageEligibility({ ...loop(), reviewComments: [finding(31, 3), finding(32, 3, 1)] }).eligible, false);
  assert.equal(triageEligibility({ ...loop(), reviewComments: [finding(31, 3), finding(32, 3, 2, { body: 'Codex finding <!-- codex-code-review-finding:v1 -->' })] }).eligible, false);
  assert.equal(triageEligibility({ ...loop(), reviewComments: [] }).eligible, false);
  assert.equal(triageEligibility({ ...loop(), reviews: [review(1, C1), review(2, C2)] }).eligible, false);
});

test('triage: owner-opened pull requests and edited or foreign findings are not eligible', () => {
  assert.equal(triageEligibility({ ...loop(), prAuthor: OWNER_LOGIN }).eligible, false);
  const botEdit = { lastEditedAt: '2026-10-24T10:30:00Z', editor: { __typename: 'User', login: 'cloudwork-bot' }, userContentEdits: { totalCount: 1, nodes: [{ editor: { __typename: 'User', login: 'cloudwork-bot' } }] } };
  assert.equal(triageEligibility({ ...loop(), reviewComments: [finding(31, 3), finding(32, 3, 2, { edit_history: botEdit })] }).eligible, false);
  assert.equal(triageEligibility({ ...loop(), reviewComments: [finding(31, 3), finding(32, 3, 2, { user: impostor })] }).eligible, false);
  assert.equal(triageEligibility({ ...loop(), reviewComments: [finding(31, 3), finding(32, 3, 2, { edit_history: null })] }).eligible, false);
});

test('triage: a later trusted verdict calling every finding a nit passes', () => {
  const e = triageEligibility(loop());
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [verdictFor(e, nits(e))] }), true);
});

test('triage: a real finding, low confidence, or a missing finding fails', () => {
  const e = triageEligibility(loop());
  const one = nits(e); one[1] = { ...one[1], verdict: 'real' };
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [verdictFor(e, one)] }), false);
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [verdictFor(e, nits(e, 0.79))] }), false);
  const partial = verdictFor({ findings: e.findings.slice(0, 1) }, nits(e).slice(0, 1));
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [partial] }), false);
});

test('triage: verdicts from another account, edited by someone else, older than the findings, or for another head fail', () => {
  const e = triageEligibility(loop());
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [verdictFor(e, nits(e), undefined, { user: impostor })] }), false);
  const botEdit = { lastEditedAt: '2026-10-24T11:30:00Z', editor: { __typename: 'User', login: 'cloudwork-bot' }, userContentEdits: { totalCount: 1, nodes: [{ editor: { __typename: 'User', login: 'cloudwork-bot' } }] } };
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [verdictFor(e, nits(e), undefined, { edit_history: botEdit })] }), false);
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [verdictFor(e, nits(e), undefined, { edit_history: undefined })] }), false);
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [verdictFor(e, nits(e), '2026-10-24T10:00:00Z')] }), false);
  const other = { ...verdictFor(e, nits(e)), body: verdictComment({ headSha: OLD, findings: e.findings, verdicts: nits(e) }) };
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [other] }), false);
});

test('triage: the judge result is checked strictly', async () => {
  const e = triageEligibility(loop());
  const reply = (body, stop = 'end_turn') => async () => ({ ok: true, json: async () => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(body) }] }) });
  const good = await judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: reply({ verdicts: nits(e) }) });
  assert.deepEqual(good.map((v) => v.id), e.findings.map((f) => f.id));
  await assert.rejects(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: reply({ verdicts: nits(e).slice(0, 1) }) }));
  await assert.rejects(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: reply({ verdicts: [...nits(e), nits(e)[0]] }) }));
  await assert.rejects(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: reply({ verdicts: nits(e, 1.5) }) }));
  await assert.rejects(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: reply({ verdicts: nits(e) }, 'refusal') }));
  await assert.rejects(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) }));
});

test('triage: the workflow can comment, gets the judge key, and still never checks out pull request code', () => {
  const wf = readFileSync(new URL('../../workflows/codex-approved.yml', import.meta.url), 'utf8');
  assert.match(wf, /issues: write/);
  assert.match(wf, /ANTHROPIC_API_KEY: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
  assert.match(wf, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.doesNotMatch(wf, /head\.sha|head\.ref|pull_request\.head/);
});

test('triage: replies to a finding are not findings', () => {
  const reply = { ...finding(33, 3), user: impostor, body: 'Fixed in abc.', in_reply_to_id: 31 };
  assert.equal(triageEligibility({ ...loop(), reviewComments: [finding(31, 3), finding(32, 3, 3), reply] }).eligible, true);
});

test('triage: only single pull request runs ask the judge, in that pull request\'s concurrency group', () => {
  const wf = readFileSync(new URL('../../workflows/codex-approved.yml', import.meta.url), 'utf8');
  assert.match(wf, /group: codex-approved-\$\{\{ github\.event\.pull_request\.number \|\| github\.event\.issue\.number \|\| inputs\.pull_request \|\| 'all' \}\}/);
  const script = readFileSync(new URL('../codex-approved.mjs', import.meta.url), 'utf8');
  assert.match(script, /if \(mayJudge && apiKey/);
  assert.match(script, /check\(number, fromEvent !== null\)/);
});

test('triage: a claim or an earlier verdict for this head and findings stops a second paid call', async () => {
  const { alreadyClaimed, claimComment, releasedComment } = await import('../codex-triage.mjs');
  const e = triageEligibility(loop());
  const claim = { user: actions, created_at: '2026-10-24T11:00:00Z', body: claimComment({ headSha: HEAD, findings: e.findings }) };
  assert.equal(alreadyClaimed({ headSha: HEAD, findings: e.findings, comments: [claim] }), true);
  assert.equal(alreadyClaimed({ headSha: OLD, findings: e.findings, comments: [claim] }), false);
  assert.equal(alreadyClaimed({ headSha: HEAD, findings: e.findings.slice(0, 1), comments: [claim] }), false);
  assert.equal(alreadyClaimed({ headSha: HEAD, findings: e.findings, comments: [{ ...claim, user: impostor }] }), false);
  const released = { ...claim, body: releasedComment({ headSha: HEAD, error: 'judge request failed: 500' }) };
  assert.equal(alreadyClaimed({ headSha: HEAD, findings: e.findings, comments: [released] }), false);
  const botEdit = { lastEditedAt: '2026-10-24T11:30:00Z', editor: { __typename: 'User', login: 'cloudwork-bot' }, userContentEdits: { totalCount: 1, nodes: [{ editor: { __typename: 'User', login: 'cloudwork-bot' } }] } };
  const tampered = verdictFor(e, nits(e), undefined, { edit_history: botEdit });
  assert.equal(alreadyClaimed({ headSha: HEAD, findings: e.findings, comments: [tampered] }), true);
  assert.equal(triagePasses({ headSha: HEAD, eligibility: e, comments: [tampered] }), false);
});

test('triage: the claim is posted before the judge is called and then edited into the verdict', () => {
  const script = readFileSync(new URL('../codex-approved.mjs', import.meta.url), 'utf8');
  const claimAt = script.indexOf('claimComment({ headSha, findings })');
  const judgeAt = script.indexOf('await judgeFindings(');
  assert.ok(claimAt > 0 && judgeAt > claimAt);
  assert.match(script, /gh\.patch\(`\$\{base\}\/issues\/comments\/\$\{claim\.id\}`, \{ body: verdictComment/);
});

test('triage: editing or deleting a verdict re-runs the gate', () => {
  const wf = readFileSync(new URL('../../workflows/codex-approved.yml', import.meta.url), 'utf8');
  assert.match(wf, /github\.event\.comment\.user\.login == 'github-actions\[bot\]'/);
});

test('triage: only an error reply from the API is unbilled (and releases the claim)', async () => {
  const e = triageEligibility(loop());
  const reply = (body, stop = 'end_turn') => async () => ({ ok: true, json: async () => ({ stop_reason: stop, content: [{ type: 'text', text: JSON.stringify(body) }] }) });
  const billedError = (p) => p.then(() => null, (error) => error.billed === true);
  assert.equal(await billedError(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: reply({ verdicts: nits(e) }, 'refusal') })), true);
  assert.equal(await billedError(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: reply({ verdicts: nits(e).slice(0, 1) }) })), true);
  assert.equal(await billedError(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }) }) })), true);
  assert.equal(await billedError(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 529 }) })), false);
  assert.equal(await billedError(judgeFindings({ findings: e.findings, apiKey: 'k', fetchImpl: async () => { throw new Error('network'); } })), true);
  const script = readFileSync(new URL('../codex-approved.mjs', import.meta.url), 'utf8');
  assert.match(script, /if \(!error\.billed\) await gh\.patch/);
});
