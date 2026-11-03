// One in-process queue per ledger folder, plus an exclusive lock file so
// two processes (or two worker threads) cannot both fit a reservation into
// the same remaining budget. The lock names the process and the thread.
// A lock is removed when that process has exited, or when the thread that
// held it is gone. Worker threads share a process id, so the process id
// alone stays live after a worker is stopped. A lock that is still held
// is left alone.

import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, readlinkSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { threadId } from 'node:worker_threads';

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

// Linux publishes each thread under /proc/self/task. The id is recorded
// when the lock is taken. macOS has no such directory; there the open
// file itself is the signal, and 0 is stored in this field.
function currentTid() {
  if (process.platform !== 'linux') return 0;
  try {
    const tid = Number(readlinkSync('/proc/thread-self').split('/').pop());
    return Number.isSafeInteger(tid) && tid > 0 ? tid : 0;
  } catch {
    return 0;
  }
}

// null means this system has no thread list, so the caller checks the
// open file instead. A missing thread is not live. Anything we cannot
// read is treated as live, so a lock is not taken by mistake.
function threadAlive(tid) {
  if (process.platform !== 'linux') return null;
  if (!Number.isSafeInteger(tid) || tid <= 0) return true;
  try {
    return statSync(`/proc/self/task/${tid}`).isDirectory();
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    return true;
  }
}

function parseOwner(text) {
  const match = /^(\d+)\n(\d+)\n(\d+)\n(\d+)\n([0-9a-f]{32})\n$/.exec(text);
  if (!match) return null;
  const pid = Number(match[1]);
  const ownerThread = Number(match[2]);
  const tid = Number(match[3]);
  const heldFd = Number(match[4]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (!Number.isSafeInteger(ownerThread) || ownerThread < 0) return null;
  if (!Number.isSafeInteger(tid) || tid < 0) return null;
  if (!Number.isSafeInteger(heldFd) || heldFd < 0) return null;
  return { pid, ownerThread, tid, heldFd };
}

function descriptorMatches(fd, lockDev, lockIno) {
  try {
    const info = fstatSync(fd);
    return info.dev === lockDev && info.ino === lockIno;
  } catch (error) {
    // A closed descriptor is not a holder. Any other error is treated as
    // still held, so the lock is not removed on a transient failure.
    if (error.code === 'EBADF') return false;
    return true;
  }
}

// A lock from another process is live while that process is. A lock from
// another thread in this process is live while that thread is. On Linux
// the thread list is the signal, because a worker's descriptor number is
// not visible from the thread that is checking. On macOS the descriptor
// is shared, and it closes when the worker is stopped. This thread's own
// lock is live only while the file it recorded is still open.
function ownerLive(owner, lockDev, lockIno) {
  if (owner.pid !== process.pid) return processAlive(owner.pid);
  if (owner.ownerThread === threadId) return descriptorMatches(owner.heldFd, lockDev, lockIno);
  const task = threadAlive(owner.tid);
  if (task !== null) return task;
  return descriptorMatches(owner.heldFd, lockDev, lockIno);
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
  let opened;
  let text;
  try {
    opened = fstatSync(fd);
    text = readLock(fd);
  } finally {
    try { closeSync(fd); } catch { /* already closed */ }
  }
  const owner = parseOwner(text);
  if (owner) {
    if (ownerLive(owner, opened.dev, opened.ino)) return false;
  } else if (!unknown) {
    return false;
  }
  try {
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
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function writeFull(fd, text) {
  const data = Buffer.from(text);
  let offset = 0;
  while (offset < data.length) {
    const wrote = writeSync(fd, data, offset, data.length - offset);
    if (!Number.isInteger(wrote) || wrote <= 0 || wrote > data.length - offset) {
      const error = new Error('incomplete write');
      error.code = 'EIO';
      throw error;
    }
    offset += wrote;
  }
}

function createLock(lockPath, token) {
  let fd;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (error.code === 'EEXIST' || error.code === 'ELOOP') return null;
    throw error;
  }
  const payload = `${process.pid}\n${threadId}\n${currentTid()}\n${fd}\n${token}\n`;
  try {
    writeFull(fd, payload);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* already gone */ }
    throw error;
  }
  return { fd, payload };
}

function releaseLock(lockPath, fd, payload) {
  try { closeSync(fd); } catch { /* already closed */ }
  try {
    if (readFileSync(lockPath, 'utf8') === payload) unlinkSync(lockPath);
  } catch { /* a missing lock is already released */ }
}

function claim(lockPath, token) {
  const created = createLock(lockPath, token);
  if (created) return created;
  if (!reclaim(lockPath)) return null;
  return createLock(lockPath, token);
}

/** Synchronous exclusive lock for the protected-state file. */
export function withSyncLock(lockPath, fn, { attempts = 2000, waitMs = 5 } = {}) {
  const token = randomBytes(16).toString('hex');
  let taken = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    taken = claim(lockPath, token);
    if (taken) break;
    if (attempt + 1 < attempts) Atomics.wait(pause, 0, 0, waitMs);
  }
  if (!taken && reclaim(lockPath, { unknown: true })) taken = createLock(lockPath, token);
  if (!taken) return { ok: false };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseLock(lockPath, taken.fd, taken.payload);
  }
}

/**
 * @param {string} lockPath
 * @param {() => unknown} fn
 * @param {{ attempts?: number, waitMs?: number }} [options]
 */
export async function withFileLock(lockPath, fn, { attempts = 2000, waitMs = 5 } = {}) {
  const token = randomBytes(16).toString('hex');
  let taken = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    taken = claim(lockPath, token);
    if (taken) break;
    if (attempt + 1 < attempts) await delay(waitMs);
  }
  // A crash between creating the file and writing the owner leaves an
  // empty file. The waits above give a holder time to finish writing. An
  // empty file is then removed once. A file that is still held is not.
  if (!taken && reclaim(lockPath, { unknown: true })) taken = createLock(lockPath, token);
  if (!taken) return { ok: false };
  try {
    return { ok: true, value: await fn() };
  } finally {
    releaseLock(lockPath, taken.fd, taken.payload);
  }
}
