import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateCodexSignal, CODEX_LOGIN } from '../codex-signal.mjs';
import { parseCodeowners, protectedFiles } from '../codeowners.mjs';

const HEAD = '7af6dd5bd9'.padEnd(40, 'a');
const OLD = '572b68d313'.padEnd(40, 'b');
const codex = { login: CODEX_LOGIN, type: 'Bot' };
const impostor = { login: 'cloudwork-bot', type: 'User' };

const clean = (sha, at, user = codex) => ({
  user, created_at: at,
  body: `Codex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** \`${sha.slice(0, 10)}\`\n`,
});
const findings = (sha, at, user = codex) => ({ user, commit_id: sha, state: 'COMMENTED', submitted_at: at, body: '### 💡 Codex Review' });
const summary = (sha) => ({
  user: codex, created_at: '2026-10-15T00:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="x">x</relative-time> | \`${sha.slice(0, 7)}\` | Manual request |`,
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
    'PLAN.md', 'docs/plans/merge-gate.md', 'docs/decisions.md',
    'apps/mac/Sources/ArchiveProtection/ArchiveSeal.swift',
    'apps/mac/Sources/DeskHost/StoreCipher.swift',
    'apps/mac/Tests/ParticipantProcessTests/PaidUsageGateTests.swift',
  ];
  assert.deepEqual(protectedFiles(rules, files), files);
  const open = ['STATUS.md', 'README.md', 'apps/desk/src/app/App.tsx', 'packages/clarity/src/index.mjs',
    'docs/annotations/x.md', 'apps/mac/Sources/DeskHost/DeskHost.swift', 'docs/plans-old.md', 'sub/AGENTS.md'];
  assert.deepEqual(protectedFiles(rules, open), []);
});
