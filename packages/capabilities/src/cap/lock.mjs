// One in-process queue per ledger folder, plus an exclusive lock file so
// two processes (or two worker threads) cannot both fit a reservation into
// the same remaining budget. The lock names the process that holds it. A
// lock whose process is gone is removed, so a crash does not leave paid
// runs stopped. A lock whose process is still running is left alone.

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs';
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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists and we may not signal it. Anything
    // other than "no such process" is treated as still running.
    return error.code !== 'ESRCH';
  }
}

function classify(text) {
  const match = /^(\d+)\n([0-9a-f]{32})\n$/.exec(text);
  if (!match) return 'unknown';
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  return processAlive(pid) ? 'live' : 'dead';
}

function readLock(fd) {
  const info = fstatSync(fd);
  if (info.size > 128) return '';
  const buf = Buffer.alloc(info.size);
  readSync(fd, buf, 0, info.size, 0);
  return buf.toString('utf8');
}

// Remove a lock whose owner has exited. A live owner's file is left as it
// is. The inode is checked so a lock created in the meantime is not the
// file that gets removed.
function reclaim(lockPath, { unknown = false } = {}) {
  let fd;
  try {
    fd = openSync(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    if (error.code === 'ELOOP') return false;
    throw error;
  }
  try {
    const opened = fstatSync(fd);
    const kind = classify(readLock(fd));
    if (kind === 'live') return false;
    if (kind === 'unknown' && !unknown) return false;
    let current;
    try {
      current = statSync(lockPath);
    } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
    if (current.ino !== opened.ino || current.dev !== opened.dev) return false;
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return true;
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
}

function createLock(lockPath, payload) {
  let fd;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ELOOP') return null;
    throw error;
  }
  try {
    writeSync(fd, payload);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    throw error;
  }
  return fd;
}

function releaseLock(lockPath, fd, payload) {
  try { closeSync(fd); } catch { /* already closed */ }
  try {
    if (readFileSync(lockPath, 'utf8') === payload) unlinkSync(lockPath);
  } catch { /* a missing lock is already released */ }
}

function claim(lockPath, payload) {
  const fd = createLock(lockPath, payload);
  if (fd !== null) return fd;
  if (!reclaim(lockPath)) return null;
  return createLock(lockPath, payload);
}

/** Synchronous exclusive lock for the protected-state file. */
export function withSyncLock(lockPath, fn, { attempts = 2000, waitMs = 5 } = {}) {
  const token = randomBytes(16).toString('hex');
  const payload = `${process.pid}\n${token}\n`;
  let fd = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    fd = claim(lockPath, payload);
    if (fd !== null) break;
    if (attempt + 1 < attempts) Atomics.wait(pause, 0, 0, waitMs);
  }
  if (fd === null && reclaim(lockPath, { unknown: true })) fd = createLock(lockPath, payload);
  if (fd === null) return { ok: false };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseLock(lockPath, fd, payload);
  }
}

/**
 * @param {string} lockPath
 * @param {() => unknown} fn
 * @param {{ attempts?: number, waitMs?: number }} [options]
 */
export async function withFileLock(lockPath, fn, { attempts = 2000, waitMs = 5 } = {}) {
  const token = randomBytes(16).toString('hex');
  const payload = `${process.pid}\n${token}\n`;
  let fd = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    fd = claim(lockPath, payload);
    if (fd !== null) break;
    if (attempt + 1 < attempts) await delay(waitMs);
  }
  // A crash between creating the file and writing the process id leaves an
  // empty file. The waits above give a holder time to finish writing. An
  // empty file is then removed once. A file that names a running process
  // is not removed.
  if (fd === null && reclaim(lockPath, { unknown: true })) fd = createLock(lockPath, payload);
  if (fd === null) return { ok: false };
  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseLock(lockPath, fd, payload);
  }
}
