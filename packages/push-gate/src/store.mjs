// The gate's files (docs/plans/push-gate.md, "Requests", "Results" and "When
// It Goes Wrong" 2). Two places:
//
//   shared/requests/   agents drop request files and bundles here (waiting)
//   shared/results/    one result file per request; only the gate writes
//   home/work/         the gate's own: working copies, state, the write log
//   home/checkout/     the gate's own git checkout
//
// Every change is written to a new file and renamed into place, so a crash
// leaves either the old file or the new one, never half of one.

import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DAY, HOUR, LIMITS } from './constants.mjs';
import { REQUEST_ID } from './checks.mjs';

const EMPTY_STATE = { stopped: null, pausedUntil: 0, pausedAt: 0, noteOwed: false, lastPush: {}, refusals: [], unrevoked: [] };

function writeAtomic(path, text, mode = 0o644) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, path);
}

// Reads a file an agent wrote: a plain file (never a link), up to `maxBytes`.
function readPlainFile(path, maxBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error('not a plain file');
    if (info.size > maxBytes) throw new Error('too large');
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function createStore({ home, shared }) {
  const requestsDir = join(shared, 'requests');
  const resultsDir = join(shared, 'results');
  const workDir = join(home, 'work');
  const workingDir = join(workDir, 'working');
  const allowedDir = join(workDir, 'allowed');
  const statePath = join(workDir, 'state.json');
  const logPath = join(workDir, 'write-log.jsonl');
  const lockPath = join(workDir, 'lock');
  const checkoutDir = join(home, 'checkout');

  const list = (dir) => (existsSync(dir) ? readdirSync(dir) : []);

  /** Request files in the waiting folder, oldest first. */
  function listWaiting() {
    const found = [];
    for (const name of list(requestsDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (!REQUEST_ID.test(id)) continue;
      let info;
      try {
        info = lstatSync(join(requestsDir, name));
      } catch {
        continue;
      }
      found.push({ id, path: join(requestsDir, name), mtimeMs: info.mtimeMs });
    }
    return found.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.id < b.id ? -1 : 1));
  }

  /** Reads a waiting request. `{ raw }`, or `{ unreadable: true }`. */
  function readWaiting(entry) {
    try {
      return { raw: JSON.parse(readPlainFile(entry.path, LIMITS.requestBytes).toString('utf8')) };
    } catch {
      return { unreadable: true };
    }
  }

  /** Requests the gate has taken on and not finished, oldest first. */
  function listWorking() {
    const found = [];
    for (const name of list(workingDir)) {
      if (!name.endsWith('.json')) continue;
      try {
        found.push(JSON.parse(readFileSync(join(workingDir, name), 'utf8')));
      } catch {
        // A half-written file can't exist (writes are renames); skip anything else.
      }
    }
    return found.sort((a, b) => a.takenAt - b.takenAt || (a.id < b.id ? -1 : 1));
  }

  const workingBundle = (id) => join(workingDir, `${id}.bundle`);

  /**
   * Moves a request from waiting to working: copies it (and its bundle) into
   * the gate's own folder, then removes it from the waiting folder. Returns
   * the working item, or throws a plain Error naming what is wrong with the bundle.
   */
  function take(entry, request, nowMs) {
    mkdirSync(workingDir, { recursive: true, mode: 0o700 });
    if (request.kind === 'push') {
      let bytes;
      try {
        bytes = readPlainFile(join(requestsDir, request.bundle), LIMITS.bundleBytes - 1);
      } catch (error) {
        throw new Error(error.message === 'too large' ? 'bundle too large' : 'bundle missing');
      }
      writeAtomic(workingBundle(entry.id), bytes, 0o600);
    }
    const item = { id: entry.id, request, step: 'taken', takenAt: nowMs };
    saveWorking(item);
    rmSync(entry.path, { force: true });
    if (request.kind === 'push') rmSync(join(requestsDir, request.bundle), { force: true });
    return item;
  }

  function saveWorking(item) {
    mkdirSync(workingDir, { recursive: true, mode: 0o700 });
    writeAtomic(join(workingDir, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, 0o600);
  }

  /** Drops a request from the waiting folder (refused before it was taken). */
  function dropWaiting(entry, bundleName) {
    rmSync(entry.path, { force: true });
    if (bundleName && /^[A-Za-z0-9._-]+\.bundle$/.test(bundleName)) rmSync(join(requestsDir, bundleName), { force: true });
  }

  function finishWorking(id) {
    rmSync(join(workingDir, `${id}.json`), { force: true });
    rmSync(workingBundle(id), { force: true });
    rmSync(join(allowedDir, id), { force: true });
  }

  /** Writes a request's result file, unless it already says the same. */
  function writeResult(id, result, nowMs) {
    mkdirSync(resultsDir, { recursive: true, mode: 0o755 });
    const path = join(resultsDir, `${id}.json`);
    const before = readResult(id);
    if (before) {
      const { updated: _ignored, ...rest } = before;
      if (JSON.stringify(rest) === JSON.stringify({ id, ...result })) return;
    }
    writeAtomic(path, `${JSON.stringify({ id, ...result, updated: new Date(nowMs).toISOString() }, null, 2)}\n`);
  }

  function readResult(id) {
    try {
      return JSON.parse(readFileSync(join(resultsDir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
  }

  function listResults() {
    return list(resultsDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readResult(name.slice(0, -'.json'.length)))
      .filter(Boolean)
      .sort((a, b) => (a.updated < b.updated ? -1 : a.updated > b.updated ? 1 : a.id < b.id ? -1 : 1));
  }

  /** Removes result files older than 30 days. */
  function pruneResults(nowMs) {
    for (const name of list(resultsDir)) {
      const path = join(resultsDir, name);
      try {
        if (statSync(path).mtimeMs < nowMs - LIMITS.logDays * DAY) rmSync(path, { force: true });
      } catch {
        // Gone already.
      }
    }
  }

  function loadState() {
    try {
      return { ...EMPTY_STATE, ...JSON.parse(readFileSync(statePath, 'utf8')) };
    } catch {
      return structuredClone(EMPTY_STATE);
    }
  }

  function saveState(state) {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  function readLog() {
    let text;
    try {
      text = readFileSync(logPath, 'utf8');
    } catch {
      return [];
    }
    const lines = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Skip a line that can't be read.
      }
    }
    return lines;
  }

  /**
   * Adds one line to the write log: time, kind, branch or pull request,
   * result. Never a token, never the text of a comment. Lines older than 30
   * days are dropped.
   */
  function logWrite({ kind, target, result }, nowMs) {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const kept = readLog().filter((line) => Date.parse(line.time) >= nowMs - LIMITS.logDays * DAY);
    kept.push({ time: new Date(nowMs).toISOString(), kind, target, result });
    writeAtomic(logPath, kept.map((line) => JSON.stringify(line)).join('\n') + '\n', 0o600);
  }

  /** Times of the writes made in the last hour. */
  function recentWriteTimes(nowMs) {
    return readLog()
      .map((line) => Date.parse(line.time))
      .filter((t) => t > nowMs - HOUR);
  }

  function allow(id) {
    mkdirSync(allowedDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(allowedDir, id), '', { mode: 0o600 });
  }

  const isAllowed = (id) => existsSync(join(allowedDir, id));

  /** Takes the run lock. False when another run holds it. */
  function lock(nowMs) {
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: nowMs }), { flag: 'wx', mode: 0o600 });
        return true;
      } catch {
        let held;
        try {
          held = JSON.parse(readFileSync(lockPath, 'utf8'));
        } catch {
          held = null;
        }
        let alive = false;
        if (held && Number.isInteger(held.pid)) {
          try {
            process.kill(held.pid, 0);
            alive = true;
          } catch {
            alive = false;
          }
        }
        if (alive && held.pid !== process.pid) return false;
        rmSync(lockPath, { force: true });
      }
    }
    return false;
  }

  const unlock = () => rmSync(lockPath, { force: true });

  return {
    requestsDir,
    resultsDir,
    workDir,
    checkoutDir,
    listWaiting,
    readWaiting,
    listWorking,
    workingBundle,
    take,
    saveWorking,
    dropWaiting,
    finishWorking,
    writeResult,
    readResult,
    listResults,
    pruneResults,
    loadState,
    saveState,
    readLog,
    logWrite,
    recentWriteTimes,
    allow,
    isAllowed,
    lock,
    unlock,
  };
}
