// One invented world for a test: a throwaway app key, a fake GitHub with a
// temporary repository behind it, an agent's temporary repository, and the
// gate's own folders. Nothing here touches the network beyond 127.0.0.1.

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runOnce, status } from '../../src/gate.mjs';
import { runCommand } from '../../src/git.mjs';
import { startFakeGitHub } from './fake-github.mjs';

// A Monday at 10 AM in New York: outside quiet hours.
export const DAYTIME = Date.parse('2026-11-16T15:00:00Z');
export const MINUTE = 60 * 1000;

const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
export function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=Invented Agent', '-c', 'user.email=agent@example.com', '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    env: gitEnv,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export async function makeWorld(t, { startMs = DAYTIME } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'push-gate-test-'));
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const clock = { ms: startMs };
  const now = () => clock.ms;

  // "GitHub": a bare repository with one commit on main.
  const gitRoot = join(dir, 'github');
  const upstream = join(gitRoot, 'open-convo.git');
  mkdirSync(gitRoot, { recursive: true });
  git(gitRoot, 'init', '-q', '--bare', upstream);
  git(upstream, 'config', 'http.receivepack', 'true');
  const agent = join(dir, 'agent');
  git(dir, 'init', '-q', agent);
  writeFileSync(join(agent, 'README.md'), 'An invented project.\n');
  git(agent, 'add', '-A');
  git(agent, 'commit', '-q', '-m', 'Start');
  git(agent, 'push', '-q', upstream, 'main:main');

  const fake = await startFakeGitHub({ publicKey, gitRoot, now });
  const home = join(dir, 'gate');
  const shared = join(dir, 'shared');
  const requests = join(shared, 'requests');
  mkdirSync(requests, { recursive: true });
  const seam = { calls: 0, fail: false };
  seam.readAppKey = async () => {
    seam.calls += 1;
    if (seam.fail) throw new Error('invented 1Password failure');
    return privateKey;
  };
  const commands = [];
  const run = (command, args, options) => {
    commands.push({ command, args, env: options?.env });
    return runCommand(command, args, options);
  };
  let sequence = 0;

  const world = {
    dir,
    clock,
    now,
    fake,
    seam,
    home,
    shared,
    requests,
    agent,
    upstream,
    commands,
    privateKey,
    thread: 'test thread 7',
    /** Runs the gate once against the fake GitHub. */
    run: (extra = {}) => runOnce({ home, shared, seam, now, apiBase: fake.apiBase, gitUrl: fake.gitUrl, run, ...extra }),
    status: () => status({ home, shared }),
    /** Makes a commit on `branch` (started from `from`) in the agent's repository. */
    commit(branch, files = { 'notes.txt': `notes for ${branch}\n` }, { from = 'main' } = {}) {
      const exists = git(agent, 'branch', '--list', branch) !== '';
      git(agent, 'checkout', '-q', ...(exists ? [branch] : ['-b', branch, from]));
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(agent, name)), { recursive: true });
        writeFileSync(join(agent, name), text);
      }
      git(agent, 'add', '-A');
      git(agent, 'commit', '-q', '-m', `Work on ${branch}`);
      return git(agent, 'rev-parse', 'HEAD');
    },
    /** Moves main forward on "GitHub", as a merge would. */
    advanceMain() {
      const sha = world.commit('main', { 'merged.txt': `merged ${(sequence += 1)}\n` });
      git(agent, 'push', '-q', upstream, 'main:main');
      return sha;
    },
    /** Writes a git bundle holding `branch` (the commits after `base`) into the waiting folder. */
    bundle(name, branch, base = 'main') {
      git(agent, 'bundle', 'create', '-q', join(requests, name), `${base}..${branch}`);
      return name;
    },
    /** Drops a request file in the waiting folder. */
    request(id, body) {
      const path = join(requests, `${id}.json`);
      writeFileSync(path, JSON.stringify(body, null, 2));
      const at = (clock.ms - 10 * MINUTE) / 1000 + (sequence += 1);
      utimesSync(path, at, at);
      return id;
    },
    signOff: () => `Claude, ${world.thread}`,
    /** A push request that passes every check, with `changes` laid over it. */
    pushRequest(id, branch, commit, changes = {}) {
      const bundle = changes.bundle ?? world.bundle(`${id}.bundle`, branch);
      return world.request(id, {
        kind: 'push',
        agent: 'claude',
        thread: world.thread,
        branch,
        commit,
        bundle,
        review: { reviewer: 'codex', commit, result: 'clean' },
        pullRequest: { title: `Work on ${branch}`, body: `Adds invented notes.\n\n${world.signOff()}` },
        ...changes,
      });
    },
    commentRequest(id, target, changes = {}) {
      return world.request(id, { kind: 'comment', agent: 'claude', thread: world.thread, target, body: `An invented comment for ${id}.\n\n${world.signOff()}`, ...changes });
    },
    /** An open pull request that already exists on the fake GitHub. */
    openPull(branch = 'someone/elses-work') {
      const number = (fake.nextNumber += 1);
      fake.pulls.push({ number, state: 'open', title: 'Invented', body: `Invented work.\n\n${world.signOff()}`, head: { ref: branch }, base: { ref: 'main' }, labels: [], user: { login: 'cloudwork-agents[bot]' }, html_url: `https://github.com/CloudworkSystems/open-convo/pull/${number}` });
      return number;
    },
    result(id) {
      const path = join(shared, 'results', `${id}.json`);
      return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    },
    /** The commit a branch is at on "GitHub", or null. */
    onGitHub(branch) {
      try {
        return git(upstream, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`);
      } catch {
        return null;
      }
    },
    log() {
      const path = join(home, 'work', 'write-log.jsonl');
      return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    /** Every file under the gate's folders with its size and time, to show nothing was written. */
    snapshot() {
      const seen = [];
      const walk = (folder) => {
        if (!existsSync(folder)) return;
        for (const name of readdirSync(folder).sort()) {
          const path = join(folder, name);
          const info = statSync(path);
          if (info.isDirectory()) {
            seen.push(`${path}/`);
            walk(path);
          } else seen.push(`${path} ${info.size} ${info.mtimeMs}`);
        }
      };
      walk(home);
      walk(shared);
      return seen;
    },
    /** The text of every file the gate wrote, to search for things that must not be there. */
    everythingWritten() {
      const texts = [];
      const walk = (folder) => {
        if (!existsSync(folder)) return;
        for (const name of readdirSync(folder)) {
          const path = join(folder, name);
          if (statSync(path).isDirectory()) {
            if (name !== 'objects') walk(path);
          } else texts.push(readFileSync(path, 'latin1'));
        }
      };
      walk(home);
      walk(shared);
      return texts.join('\n');
    },
  };

  t.after(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return world;
}
