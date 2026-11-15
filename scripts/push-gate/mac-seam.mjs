// The Mac-only part of the push gate (docs/plans/push-gate.md, "Where It
// Lives"): reading the Cloudwork Agents app's private key through a
// 1Password service account.
//
// The package (packages/push-gate/) never touches Keychain or 1Password. It
// asks this seam for the key, and its tests replace the seam with a fake.
//
// Which sign-in, vault and item to use is in a settings file outside the
// repo (see SETUP.md), so nothing here names them. Nothing read here is
// printed, logged, written to a file or passed as a command argument: the
// service account's sign-in reaches the 1Password command line through its
// environment, and the key comes back on a pipe.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readSignInFile } from '../../packages/push-gate/src/sign-in-file.mjs';

// Runs a program and returns what it printed. A failure carries no output.
function capture(program, args, env, what) {
  return new Promise((resolve, reject) => {
    execFile(program, args, { env, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 30000 }, (error, stdout) => {
      if (error) reject(new Error(what));
      else resolve(stdout);
    });
  });
}

function readSettings(path) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`the push gate's settings file can't be read (${path}); see scripts/push-gate/SETUP.md`);
  }
  const text = (value) => typeof value === 'string' && value.trim() !== '';
  const signIn = settings.signIn ?? {};
  if (!text(settings.vault) || !text(settings.keyItem) || text(signIn.keychainService) === text(signIn.file)) {
    throw new Error(`the push gate's settings file needs "vault", "keyItem" and one of "signIn.keychainService" or "signIn.file" (${path})`);
  }
  return settings;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{readAppKey: () => Promise<string>}}
 */
export function createMacSeam(env = process.env) {
  const settingsPath = env.PUSH_GATE_SETTINGS || join(homedir(), '.config', 'push-gate', 'settings.json');
  const base = { PATH: env.PATH ?? '/usr/bin:/bin', HOME: env.HOME ?? homedir() };

  return {
    /** The app's private key, as PEM text. Throws a plain Error when it can't be opened. */
    async readAppKey() {
      const settings = readSettings(settingsPath);
      const signIn = settings.signIn.file
        ? readSignInFile(settings.signIn.file)
        : (await capture(settings.security ?? '/usr/bin/security', ['find-generic-password', '-s', settings.signIn.keychainService, '-w'], base, "Keychain didn't give the 1Password sign-in")).trim();
      if (!signIn) throw new Error('the 1Password sign-in is empty');
      const key = await capture(
        settings.op ?? 'op',
        ['document', 'get', settings.keyItem, '--vault', settings.vault],
        { ...base, OP_SERVICE_ACCOUNT_TOKEN: signIn },
        "1Password didn't give the app's key",
      );
      if (!key.includes('PRIVATE KEY')) throw new Error("1Password's item isn't a private key");
      return key;
    },
  };
}
