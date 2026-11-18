// The gate's own git checkout (docs/plans/push-gate.md, "Its own copy, its
// own code"). A bare repository in the gate's folder, which agents can't
// write to. Every git command runs with hooks off and with no settings read
// from the user's or the system's git configuration, and the remote address
// is passed on each command, never read from a file.
//
// The token reaches git only through a sign-in helper that exists for the
// one push command: it is set on that command alone and reads the token
// from that command's environment, so the token is never a command
// argument, never in git's settings and never in the remote address.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { GIT_URL } from './constants.mjs';
import { LIMITS } from './constants.mjs';
import { CheckFailed, GitHubRefused, LocalFailure, NoConnection, RateLimited, SignInFailed, scrub } from './errors.mjs';

/** Runs a command and collects its output. Tests wrap this to watch the arguments. */
export function runCommand(command, args, { env, cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    // A command with no input gets no input pipe. One with input may exit
    // before reading it; that broken pipe is ignored, and the command's own
    // exit code is still what comes back.
    const child = spawn(command, args, { env, cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** The git settings that hand `$GH_TOKEN` to git for one address, and nothing else. */
export function signInHelperSettings(gitUrl) {
  const origin = new URL(gitUrl).origin;
  const helper = `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$GH_TOKEN"; }; f`;
  return [
    ['credential.helper', ''],
    [`credential.${origin}.helper`, ''],
    [`credential.${origin}.helper`, helper],
  ];
}

const NO_CONNECTION = /could not resolve host|failed to connect|couldn't connect|connection refused|connection timed out|network is unreachable|operation timed out|empty reply from server/i;
// A connection that dropped partway through a read or a push.
const DROPPED = /connection reset|connection was (?:reset|aborted)|recv failure|send failure|rpc failed|remote end hung up|unexpected disconnect|early eof|ssl_error|ssl_connect|ssl connect|tls connect|gnutls|http\/2 stream|transfer closed|broken pipe|timed out/i;
// GitHub's own answer when it has no words and no status to give.
const ANSWERED = /couldn't find remote ref|repository .*not found|does not appear to be a git repository/i;

export function createGit({ dir, gitUrl = GIT_URL, run = runCommand }) {
  const repo = join(dir, 'repo.git');
  const baseEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    GIT_DIR: repo,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
  const baseArgs = ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'fetch.fsckObjects=true', '-c', 'gc.auto=0'];

  const git = (args, options = {}) => run('git', [...baseArgs, ...(options.settings ?? []), ...args], { env: { ...baseEnv, ...(options.env ?? {}) }, cwd: dir });

  // What a failed fetch, ls-remote or push to GitHub means.
  function remoteFailure(stderr, secrets, what) {
    const text = scrub(stderr, secrets);
    // A rate limit: a 429, or a 403 whose text names one (GitHub's "secondary
    // rate limit"), the same way an API answer is read in app-token.mjs.
    // Git only passes on GitHub's words for some answers. A 403 that comes
    // with no words at all can't be told from a rate limit, so it is treated
    // as one: pausing for an hour is the safe reading. A 403 with GitHub's
    // reason (such as "Permission denied") stays a refusal of that request.
    const forbidden = /returned error: 403/i.test(text);
    if (/returned error: 429/i.test(text) || (forbidden && (/rate limit/i.test(text) || !/^remote: \S/m.test(stderr)))) {
      return new RateLimited('GitHub asked for a pause', LIMITS.rateLimitPauseMs);
    }
    if (/returned error: 401|authentication failed|could not read (username|password)|terminal prompts disabled/i.test(text)) return new SignInFailed("GitHub didn't accept the app's sign-in");
    if (/returned error: 5\d\d/i.test(text) || NO_CONNECTION.test(text)) return new NoConnection("GitHub can't be reached");
    // What GitHub itself said: its words ("remote: ..."), a rejected line, or a status.
    const answered = Number(/returned error: (\d{3})/i.exec(text)?.[1]) || Number(/\bHTTP (\d{3})\b/.exec(text)?.[1]) || 0;
    const rejected = /! \[(?:remote )?rejected\][^\n]*?\(([^)]*)\)/.exec(stderr)?.[1];
    const spoke = rejected !== undefined || /^remote: \S/m.test(stderr);
    // A connection that dropped during the read or the push (a reset, a
    // hang-up, a broken TLS session, a 408) is no connection, not a refusal:
    // the request waits and nothing is lost. A status of GitHub's own
    // (other than 408) or its words still make it a refusal.
    if (!spoke && (answered === 408 || (!answered && DROPPED.test(text)))) return new NoConnection("GitHub can't be reached");
    const reason = rejected ? scrub(rejected, secrets) : text.replace(/^.*?(?:fatal|error):\s*/i, '').slice(0, 200);
    // Nothing from GitHub at all: git failed here, on the gate's own Mac
    // (a full disk, a folder it can't write). That is not a refusal either.
    if (!spoke && !answered && !ANSWERED.test(text)) {
      return new LocalFailure(`git failed on the gate's own Mac during ${what}${reason ? ` ("${reason}")` : ''}`);
    }
    return new GitHubRefused(`GitHub turned ${what} down${reason ? ` ("${reason}")` : ''}`, answered || 422);
  }

  async function ensureRepo() {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (existsSync(join(repo, 'HEAD'))) return;
    const { GIT_DIR: _unused, ...initEnv } = baseEnv;
    const made = await run('git', [...baseArgs, 'init', '-q', '--bare', repo], { env: initEnv, cwd: dir });
    if (made.code !== 0) throw new Error("the push gate couldn't make its own git checkout");
  }

  /** Brings the gate's copy of `main` up to date. */
  async function fetchMain() {
    const out = await git(['fetch', '-q', '--no-tags', gitUrl, '+refs/heads/main:refs/gate/main']);
    if (out.code !== 0) throw remoteFailure(out.stderr, [], 'the read of main');
  }

  /** The commit a branch is at on GitHub, or null when it isn't there. */
  async function remoteBranch(branch) {
    const out = await git(['ls-remote', gitUrl, `refs/heads/${branch}`]);
    if (out.code !== 0) throw remoteFailure(out.stderr, [], 'the read of the branch');
    const line = out.stdout.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
    return line ? line.split('\t')[0] : null;
  }

  /** Fetches a branch's current tip from GitHub so it can be compared. */
  async function fetchRemoteBranch(branch, id) {
    const out = await git(['fetch', '-q', '--no-tags', gitUrl, `+refs/heads/${branch}:refs/gate/remote/${id}`]);
    if (out.code !== 0) throw remoteFailure(out.stderr, [], 'the read of the branch');
  }

  /** The commits a bundle file offers: `[{ sha, ref }]`. */
  async function bundleHeads(file) {
    const out = await git(['bundle', 'list-heads', file]);
    if (out.code !== 0) throw new CheckFailed("its bundle file isn't a git bundle, so make it again with git bundle create");
    return out.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        return { sha: line.slice(0, space), ref: line.slice(space + 1) };
      });
  }

  /** Reads the bundle's one commit into the gate's checkout. A bundle carries commits only. */
  async function fetchBundle(file, ref, id) {
    const verified = await git(['bundle', 'verify', '-q', file]);
    if (verified.code !== 0) {
      throw new CheckFailed("its bundle needs commits the gate doesn't have, so make the bundle from the current main to your commit");
    }
    const out = await git(['fetch', '-q', '--no-tags', file, `+${ref}:refs/gate/request/${id}`]);
    if (out.code !== 0) throw new CheckFailed("its bundle can't be read, so make it again with git bundle create");
  }

  async function revParse(name) {
    const out = await git(['rev-parse', '--verify', '-q', `${name}^{commit}`]);
    return out.code === 0 ? out.stdout.trim() : null;
  }

  async function isAncestor(older, newer) {
    const out = await git(['merge-base', '--is-ancestor', older, newer]);
    return out.code === 0;
  }

  /** Files that differ between two commits under one folder. */
  async function changedUnder(from, to, folder) {
    const out = await git(['diff', '--name-only', '--no-renames', from, to, '--', folder]);
    if (out.code !== 0) throw new Error("the push gate couldn't compare the commit with main");
    return out.stdout.split('\n').filter(Boolean);
  }

  /** Pushes one commit to one branch, forward only. Never with force. */
  async function push(commit, branch, token) {
    const settings = signInHelperSettings(gitUrl).flatMap(([key, value]) => ['-c', `${key}=${value}`]);
    const out = await git(['push', '-q', gitUrl, `${commit}:refs/heads/${branch}`], { settings, env: { GH_TOKEN: token } });
    if (out.code !== 0) throw remoteFailure(out.stderr, [token], 'the push');
  }

  /** Drops the names the gate made for one request. */
  async function forget(id) {
    await git(['update-ref', '-d', `refs/gate/request/${id}`]);
    await git(['update-ref', '-d', `refs/gate/remote/${id}`]);
  }

  return { ensureRepo, fetchMain, remoteBranch, fetchRemoteBranch, bundleHeads, fetchBundle, revParse, isAncestor, changedUnder, push, forget };
}
