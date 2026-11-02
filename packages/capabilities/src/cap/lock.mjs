// One in-process queue per ledger folder, plus an exclusive lock file so
// two processes (or two worker threads) cannot both fit a reservation into
// the same remaining budget. A lock that is already held is left alone; this
// refuses the run instead of taking it.

import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const pause = new Int32Array(new SharedArrayBuffer(4));

const tails = new Map();

export function inProcess(key, fn) {
  const previous = tails.get(key) ?? Promise.resolve();
  const run = previous.then(() => fn());
  tails.set(key, run.then(() => {}, () => {}));
  return run;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Synchronous exclusive lock for the protected-state file. */
export function withSyncLock(lockPath, fn, { attempts = 2000, waitMs = 5 } = {}) {
  const token = randomBytes(16).toString('hex');
  let fd = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, token);
      break;
    } catch (error) {
      fd = null;
      if (error.code !== 'EEXIST' && error.code !== 'ELOOP') throw error;
      Atomics.wait(pause, 0, 0, waitMs);
    }
  }
  if (fd === null) return { ok: false };
  try {
    return { ok: true, value: fn() };
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
    } catch { /* a missing lock is already released */ }
  }
}

/**
 * @param {string} lockPath
 * @param {() => unknown} fn
 * @param {{ attempts?: number, waitMs?: number }} [options]
 */
export async function withFileLock(lockPath, fn, { attempts = 2000, waitMs = 5 } = {}) {
  const token = randomBytes(16).toString('hex');
  let fd = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      writeSync(fd, token);
      break;
    } catch (error) {
      fd = null;
      if (error.code !== 'EEXIST' && error.code !== 'ELOOP') throw error;
      await delay(waitMs);
    }
  }
  if (fd === null) return { ok: false };
  try {
    return { ok: true, value: await fn() };
  } finally {
    try { closeSync(fd); } catch { /* the process is exiting the lock either way */ }
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
    } catch { /* a missing lock is already released */ }
  }
}
