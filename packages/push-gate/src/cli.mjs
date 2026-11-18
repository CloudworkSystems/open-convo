// The push gate's command line (docs/plans/push-gate.md):
//
//   push-gate token -- <command>   run one command with a one-hour app token
//   push-gate run-once [--quiet]   handle every waiting request once
//   push-gate status               list each request's result
//   push-gate allow <request>      let one request through quiet hours
//
// `run-once --restart` is the owner's restart after a stop. `--quiet` is for
// the background job: a run with nothing waiting prints nothing.

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createSession } from './app-token.mjs';
import { API_BASE, GIT_URL } from './constants.mjs';
import { KeyUnavailable, NoConnection, RateLimited, SignInFailed, WrongReach, scrub } from './errors.mjs';
import { NOTHING_WAITING, allow, runOnce, status } from './gate.mjs';
import { signInHelperSettings } from './git.mjs';

const USAGE = `Usage:
  push-gate token [--permissions name:level,...] -- <command> [arguments]
  push-gate run-once [--restart] [--quiet]
  push-gate status
  push-gate allow <request>

Folders: PUSH_GATE_HOME (default ~/.push-gate) holds the gate's own files;
PUSH_GATE_SHARED (default <home>/shared) holds requests/ and results/.`;

const DEFAULT_PERMISSIONS = { contents: 'write', pull_requests: 'write', issues: 'write' };
// The permissions the plan lists for the gate's writes (docs/plans/push-gate.md, "The Token Helper").
const PERMISSION_NAMES = ['contents', 'pull_requests', 'issues'];

function folders(env) {
  const home = env.PUSH_GATE_HOME || join(homedir(), '.push-gate');
  return { home, shared: env.PUSH_GATE_SHARED || join(home, 'shared') };
}

function parsePermissions(text) {
  const permissions = {};
  for (const part of text.split(',')) {
    const [name, level] = part.split(':');
    if (!PERMISSION_NAMES.includes(name) || !['read', 'write'].includes(level)) return null;
    permissions[name] = level;
  }
  return permissions;
}

// Why a token couldn't be made, in one plain sentence.
function tokenFailure(error) {
  if (error instanceof KeyUnavailable) return "The push gate can't open its key. The owner needs to check 1Password.";
  if (error instanceof NoConnection) return "GitHub can't be reached, so no token was made. Try again when the connection is back.";
  if (error instanceof RateLimited) return 'GitHub asked for a pause (a rate limit), so no token was made. Wait an hour before trying again.';
  if (error instanceof SignInFailed) return "GitHub didn't accept the app's sign-in, so no token was made. The owner needs to check the app's key.";
  if (error instanceof WrongReach) return `No token was handed over: ${error.message}. The owner needs to check the app's installation.`;
  return `No token was made: ${scrub(error?.message ?? 'an unexpected error')}.`;
}

/** Runs `command` with the token in its environment only, then returns its exit code. */
function runWithToken(command, args, token, { env, gitUrl, spawnImpl }) {
  // The token reaches gh through GH_TOKEN and git through a sign-in helper
  // that lives only in this command's environment. It is never an argument.
  const settings = signInHelperSettings(gitUrl);
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  const childEnv = { ...env, GH_TOKEN: token, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(count + settings.length) };
  settings.forEach(([key, value], i) => {
    childEnv[`GIT_CONFIG_KEY_${count + i}`] = key;
    childEnv[`GIT_CONFIG_VALUE_${count + i}`] = value;
  });
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, { env: childEnv, stdio: 'inherit' });
    const pass = (signal) => child.kill(signal);
    process.on('SIGINT', pass);
    process.on('SIGTERM', pass);
    const finish = (code) => {
      process.off('SIGINT', pass);
      process.off('SIGTERM', pass);
      resolve(code);
    };
    child.on('error', () => finish(127));
    child.on('close', (code, signal) => finish(code ?? (signal ? 1 : 0)));
  });
}

/**
 * @param {string[]} argv arguments after `push-gate`
 * @param {object} options
 * @param {() => Promise<{readAppKey: () => Promise<string>}>} options.loadSeam
 *   how the app's key is read; loaded only by the commands that need it
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, { loadSeam, env = process.env, out = (line) => console.log(line), err = (line) => console.error(line), now = Date.now, apiBase = API_BASE, gitUrl = GIT_URL, fetchImpl = fetch, spawnImpl = spawn, run } = {}) {
  const [command, ...rest] = argv;

  if (command === 'status') {
    for (const line of status(folders(env)).lines) out(line);
    return 0;
  }

  if (command === 'allow') {
    const answer = allow(folders(env), rest[0]);
    (answer.ok ? out : err)(answer.line);
    return answer.ok ? 0 : 1;
  }

  if (command === 'run-once') {
    const unknown = rest.filter((arg) => arg !== '--restart' && arg !== '--quiet');
    if (unknown.length) {
      err(USAGE);
      return 2;
    }
    // The background job runs every minute. With --quiet an idle run prints
    // nothing, so its log file isn't written to either.
    const say = rest.includes('--quiet') ? (line) => line !== NOTHING_WAITING && out(line) : out;
    const seam = await loadSeam();
    try {
      await runOnce({ ...folders(env), seam, restart: rest.includes('--restart'), say, now, apiBase, gitUrl, fetchImpl, ...(run ? { run } : {}) });
    } catch (error) {
      // An unexpected error: one sentence, never a stack trace. The request it
      // happened on has a "failed" result (push-gate status shows it).
      err(`The push gate run stopped on an unexpected error (${scrub(error?.message ?? 'no reason given').slice(0, 200)}). Run push-gate status to see which request it was.`);
      return 1;
    }
    return 0;
  }

  if (command === 'token') {
    const split = rest.indexOf('--');
    const before = split === -1 ? rest : rest.slice(0, split);
    const toRun = split === -1 ? [] : rest.slice(split + 1);
    let permissions = DEFAULT_PERMISSIONS;
    if (before.length === 2 && before[0] === '--permissions') permissions = parsePermissions(before[1]);
    else if (before.length) permissions = null;
    if (!permissions || !toRun.length) {
      err(USAGE);
      return 2;
    }
    const seam = await loadSeam();
    // The hand-over line goes to the screen, not into the command's output.
    let unrevoked = null;
    let pauseMs = 0;
    const session = createSession({
      seam,
      apiBase,
      fetchImpl,
      now,
      say: err,
      onUnrevoked: (expiresAt) => (unrevoked = expiresAt),
      onRevokeRateLimited: (waitMs) => (pauseMs = waitMs),
    });
    // A token still alive after the command: say so in one sentence, and fail.
    const sayUnrevoked = () =>
      err(
        pauseMs
          ? `The token could not be revoked and works until ${unrevoked}, because GitHub asked for a pause (a rate limit), so run nothing more against GitHub for ${Math.ceil(pauseMs / 60000)} minutes.`
          : `The token could not be revoked and works until ${unrevoked}. The owner can end it now by suspending the app's installation.`,
      );
    try {
      const code = await session.withToken(permissions, (token) => runWithToken(toRun[0], toRun.slice(1), token, { env, gitUrl, spawnImpl }));
      if (unrevoked) {
        sayUnrevoked();
        return code === 0 ? 1 : code;
      }
      return code;
    } catch (error) {
      if (error instanceof RateLimited) pauseMs ||= error.waitMs;
      if (unrevoked) sayUnrevoked();
      else err(tokenFailure(error));
      return 1;
    }
  }

  (command === 'help' || command === '--help' || command === '-h' ? out : err)(USAGE);
  return command === 'help' || command === '--help' || command === '-h' ? 0 : 2;
}
