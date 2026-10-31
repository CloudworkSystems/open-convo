// Tests for the Claude Code guard hook (.claude/hooks/guard.mjs), which blocks
// the repo's hard "never" rules before a tool runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBash, checkTool } from '../../../.claude/hooks/guard.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const guard = join(root, '.claude', 'hooks', 'guard.mjs');

// A scratch repo on a feature branch, so "no refspec" pushes aren't on main.
function repoOn(branch) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir });
  return dir;
}
const feature = repoOn('claude/some-work');
const onMain = repoOn('main');

test('blocks pushes to main and master', () => {
  for (const cmd of [
    'git push origin main',
    'git push -u origin main',
    'git push origin HEAD:main',
    'git push origin feature:refs/heads/main',
    'git push origin :main',
    'git push origin --delete main',
    'git push origin master',
    'cd /tmp && git push origin main',
    'FOO=1 git -C . push origin main',
  ]) {
    assert.ok(checkBash(cmd, feature), cmd);
  }
});

test('blocks a bare push while on main', () => {
  assert.ok(checkBash('git push', onMain));
  assert.ok(checkBash('git push origin', onMain));
  assert.equal(checkBash('git push', feature), null);
});

test('resolves HEAD and @ to the current branch', () => {
  assert.ok(checkBash('git push -u origin HEAD', onMain));
  assert.ok(checkBash('git push origin @', onMain));
  assert.ok(checkBash('git push origin main:HEAD', onMain));
  assert.equal(checkBash('git push -u origin HEAD', feature), null);
  assert.equal(checkBash('git push origin HEAD:claude/x', onMain), null);
});

test('blocks force-push in every spelling', () => {
  for (const cmd of [
    'git push --force origin claude/x',
    'git push -f origin claude/x',
    'git push -uf origin claude/x',
    'git push --force-with-lease origin claude/x',
    'git push --force-with-lease=claude/x origin claude/x',
    'git push origin +claude/x',
    'git push --mirror',
    'git push --all origin',
  ]) {
    assert.ok(checkBash(cmd, feature), cmd);
  }
});

test('allows normal branch pushes', () => {
  for (const cmd of [
    'git push -u origin claude/project-thread-aljntl',
    'git push origin HEAD:claude/fix-main-menu',
    'git push origin maintenance',
    'git fetch origin main && git rebase origin/main',
    'git log origin/main --oneline',
    'git checkout -B claude/x origin/main',
  ]) {
    assert.equal(checkBash(cmd, feature), null, cmd);
  }
});

test('blocks history rewriting, deleting main and admin merges', () => {
  assert.ok(checkBash('git filter-branch --tree-filter x HEAD', feature));
  assert.ok(checkBash('git filter-repo --path secret', feature));
  assert.ok(checkBash('git branch -D main', feature));
  assert.ok(checkBash('gh pr merge 12 --squash --admin', feature));
  assert.ok(checkBash('gh -R CloudworkSystems/open-convo pr merge 12 --admin', feature));
  assert.ok(checkBash('gh --repo CloudworkSystems/open-convo pr merge 12 --admin=true', feature));
  assert.ok(checkBash('GH_PROMPT_DISABLED=1 gh pr merge 12 --admin', feature));
  assert.ok(checkBash('command gh pr merge 12 --admin', feature));
  assert.ok(checkBash('env gh pr merge 12 --admin', feature));
  assert.equal(checkBash('gh pr merge 12 --squash', feature), null);
  assert.equal(checkBash('git branch -D claude/old', feature), null);
});

test('keeps the True Convo folder read-only', () => {
  const tc = '/Users/patrick/True-Convo-AI';
  for (const cmd of [
    `git -C ${tc} commit -m x`,
    `cd ${tc} && git push origin main`,
    `cd ${tc} && git checkout -b y`,
    `echo hi > ${tc}/notes.md`,
    `cp notes.md ${tc}/notes.md`,
    `rm -rf ${tc}/build`,
    `sed -i '' s/a/b/ ${tc}/file.txt`,
    `git -C ${tc} pull`,
    `git -C ${tc} restore src/Piece.swift`,
    `git -C ${tc} fetch origin`,
    `cd ${tc} && git stash`,
    `mv ${tc}/src/Piece.swift apps/mac/Sources/Piece.swift`,
    `cd ${tc} && rm -rf build`,
    `cd ${tc} && echo hi > notes.md`,
    `cd ${tc} && echo hi>notes.md`,
    `cd ${tc} && sed -i '' s/a/b/ file.txt`,
    `cd ${tc} && find . -name '*.o' -delete`,
    `cd ${tc} && touch x`,
    `cd ${tc} && cd src && rm Piece.swift`,
    `cd ${tc} && sort -o README.md README.md`,
    `cd -P ${tc} && rm notes.md`,
    `cd -L -- ${tc} && rm notes.md`,
    `pushd ${tc} && rm notes.md`,
    `cd ${tc} && (cd /tmp && pwd) && rm notes.md`,
    `cd ${tc} && cd /tmp && cd - && rm notes.md`,
    `cd ${tc} && cd /home/user/open-convo && rm -rf output`,
    `cd ${tc} && uniq in.txt out.txt`,
    `cd ${tc} && awk '{print}' a`,
    `cd ${tc}/src && cd .. && rm -rf build`,
    `cd /Users/patrick && cd True-Convo-AI && rm x`,
    `cd /Users/patrick && git -C True-Convo-AI pull`,
    `git -C ${tc} diff --output=README.md`,
    `git -C ${tc} log --output README.md`,
    `cd ${tc} && git show HEAD > out.txt`,
  ]) {
    assert.ok(checkBash(cmd, feature), cmd);
  }
  for (const cmd of [
    `cat ${tc}/README.md`,
    `git -C ${tc} log --oneline -5`,
    `git -C ${tc} show HEAD:src/Piece.swift`,
    `cd ${tc} && git status`,
    `cd ${tc} && ls -la && cat README.md | head -20`,
    `cd ${tc} && grep -rn Keychain src`,
    `cd ${tc} && find . -name '*.swift'`,
    `cp ${tc}/src/Piece.swift apps/mac/Sources/Piece.swift`,
    `grep -rn Keychain ${tc}/src`,
    `git commit -m "Move piece from ${tc}/src/Piece.swift"`,
  ]) {
    assert.equal(checkBash(cmd, feature), null, cmd);
  }
  assert.ok(checkBash('rm -rf build', `${tc}/src`));
  assert.equal(checkBash('cat README.md', tc), null);
  assert.ok(checkTool({ tool_name: 'Write', tool_input: { file_path: `${tc}/x.md` } }));
  assert.ok(checkTool({ tool_name: 'Edit', tool_input: { file_path: `${tc}/x.md` } }));
  assert.equal(checkTool({ tool_name: 'Write', tool_input: { file_path: `${root}/x.md` } }), null);
});

test('the script exits 2 with a reason when it blocks, 0 otherwise', () => {
  const run = (input) => spawnSync('node', [guard], { input: JSON.stringify(input), encoding: 'utf8' });
  const blocked = run({ tool_name: 'Bash', tool_input: { command: 'git push origin main' }, cwd: feature });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /main/);
  const allowed = run({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: feature });
  assert.equal(allowed.status, 0);
  const garbled = spawnSync('node', [guard], { input: 'not json', encoding: 'utf8' });
  assert.equal(garbled.status, 0);
});
