#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENTRY_LIMIT, LEDGER_BYTES, ProofError, SIDE_FILE_BYTES } from '../src/errors.mjs';
import { amendOriginal, recordOriginal, verifyLedger } from '../src/ledger.mjs';
import { realLinksPage } from '../src/page.mjs';
import { buildReport } from '../src/report.mjs';
import {
  ANOTHER_RECOVERY,
  ANOTHER_SAVE,
  CLEARED_LOCK,
  COMPLETE_LINE,
  DIDNT_FINISH,
  END_UNCHECKED,
  FILE_CHANGED,
  PLAIN_NOTE,
  RECORD_FIRST,
  WAS_SAVED,
  cutoffLine,
  recordCommand,
  unlockCommand,
} from '../src/words.mjs';

const CHUNK = 64 * 1024;
const USAGE = 'Usage: node packages/creator-proof/bin/creator-proof.mjs <record|amend|verify|report|links|unlock> --ledger <file>';

export class StopAfter extends Error {
  constructor(stage) {
    super(`stopped after ${stage}`);
    this.name = 'StopAfter';
    this.stage = stage;
  }
}

function readClock() {
  return new Date().toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fsMessage(action, file, error) {
  if (error instanceof ProofError) return error.message;
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return `Can't ${action} ${file}: permission denied.`;
  if (error?.code === 'ENOENT') return `Can't ${action} ${file}: file not found.`;
  if (error?.code === 'EISDIR') return `Can't ${action} ${file}: that is a folder, not a file.`;
  if (error?.code === 'ELOOP' || error?.code === 'EINVAL') return `${file} is a link, so nothing was changed.`;
  if (error?.code === 'ENOTDIR') return `Can't ${action} ${file}: a folder in that path is missing.`;
  return `Can't ${action} ${file}: ${error?.code || 'failed'}.`;
}

function refuseLink(file) {
  let st;
  try {
    st = lstatSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new ProofError(fsMessage('read', file, error));
  }
  if (st.isSymbolicLink()) throw new ProofError(`${file} is a link, so nothing was changed.`);
}

function readLimited(file, limit, action) {
  refuseLink(file);
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new ProofError(fsMessage(action, file, error));
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new ProofError(`Can't ${action} ${file}: that is a folder, not a file.`);
    if (info.size > limit) throw new ProofError(`Can't ${action} ${file}: the file is too large.`);
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < info.size) {
      const read = readSync(fd, buffer, offset, info.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError(fsMessage(action, file, error));
  } finally {
    closeSync(fd);
  }
}

function hashStableFile(file, hooks) {
  let before;
  try {
    refuseLink(file);
    before = statSync(file);
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError(fsMessage('read', file, error));
  }
  if (!before.isFile()) throw new ProofError(`Can't read ${file}: that is a folder, not a file.`);
  if (hooks.onBeforeStream) hooks.onBeforeStream(file);
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(file, { highWaterMark: CHUNK });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error instanceof ProofError ? error : new ProofError(fsMessage('read', file, error)));
    };
    stream.on('data', (chunk) => {
      if (hooks.onChunk) hooks.onChunk(chunk.length);
      hash.update(chunk);
    });
    stream.on('error', (error) => fail(error));
    stream.on('end', () => {
      if (settled) return;
      try {
        const after = statSync(file);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
          fail(new ProofError(FILE_CHANGED));
          return;
        }
        settled = true;
        resolve({ fileSha256: hash.digest('hex'), sizeBytes: after.size });
      } catch (error) {
        fail(error);
      }
    });
  });
}

function privateMode(file) {
  if (!existsSync(file)) return 0o600;
  const st = lstatSync(file);
  if (st.isSymbolicLink()) return null;
  const existing = st.mode & 0o777;
  if ((existing & ~0o600) !== 0) return 0o600;
  return existing;
}

// writeSync may stop early when the disk is full. A short write must not
// be renamed over the ledger, the head or a report.
export function writeAllBytes(buffer, writeAt) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeAt(buffer, offset, buffer.length - offset);
    if (!Number.isInteger(written) || written <= 0 || written > buffer.length - offset) {
      const error = new Error('short write');
      error.code = 'EIO';
      throw error;
    }
    offset += written;
  }
}

function writeAll(fd, data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  writeAllBytes(buffer, (bytes, offset, length) => writeSync(fd, bytes, offset, length));
}

function alreadyThere(file) {
  return `${file} already exists. Pass --force to replace it. Nothing was written.`;
}

function writeAtomic(file, data, { mode, label, hooks, exclusive = false }) {
  refuseLink(file);
  const dir = dirname(file);
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  const openMode = mode === 'public' ? 0o666 : 0o600;
  let fd;
  try {
    fd = openSync(tmp, 'w', openMode);
    writeAll(fd, data);
    fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw new ProofError(fsMessage('write', file, error));
  }
  closeSync(fd);
  if (mode !== 'public') {
    const next = privateMode(file);
    if (next === null) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      throw new ProofError(`${file} is a link, so nothing was written.`);
    }
    try {
      // open() is masked by umask. Set the final mode before the name moves.
      chmodSync(tmp, next);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      throw new ProofError(fsMessage('write', file, error));
    }
  }
  if (hooks?.onBeforeRename) hooks.onBeforeRename({ label, tmp, finalPath: file });
  // rename replaces a file that appeared after the exists check. A new pack
  // or page is linked into place instead, so the second creator loses.
  if (exclusive) {
    try {
      linkSync(tmp, file);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      if (error.code === 'EEXIST') throw new ProofError(alreadyThere(file));
      throw new ProofError(fsMessage('write', file, error));
    }
    try { unlinkSync(tmp); } catch { /* the output is already in place */ }
    return;
  }
  try {
    renameSync(tmp, file);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw new ProofError(fsMessage('write', file, error));
  }
}

function writePrivate(file, data, label, hooks, { exclusive = false } = {}) {
  writeAtomic(file, data, { mode: 'private', label, hooks, exclusive });
}

function writePublic(file, data, label, hooks, { exclusive = false } = {}) {
  writeAtomic(file, data, { mode: 'public', label, hooks, exclusive });
}

function publishLock(lockPath, payload, pid) {
  const tmp = join(dirname(lockPath), `.${basename(lockPath)}.${pid}.${randomBytes(6).toString('hex')}.tmp`);
  writePrivate(tmp, `${JSON.stringify(payload)}\n`, 'lock-temp', null);
  try {
    linkSync(tmp, lockPath);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    if (error.code === 'EEXIST') return false;
    throw new ProofError(fsMessage('write', lockPath, error));
  }
  try { unlinkSync(tmp); } catch { /* already gone */ }
  return true;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EINVAL') return false;
    return true;
  }
}

function inspectLock(lockPath, host) {
  let st;
  try {
    st = lstatSync(lockPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'absent' };
    throw new ProofError(fsMessage('read', lockPath, error));
  }
  if (st.isSymbolicLink()) return { state: 'link' };
  let raw;
  try {
    raw = readLimited(lockPath, SIDE_FILE_BYTES, 'read');
  } catch (error) {
    if (error instanceof ProofError && /permission denied/.test(error.message)) throw error;
    return { state: 'stale', reason: 'unreadable' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'stale', reason: 'unreadable' };
  }
  if (!isPlainObject(parsed) || !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.host !== 'string' || parsed.host === '') {
    return { state: 'stale', reason: 'unreadable' };
  }
  if (parsed.host !== host) return { state: 'other-host', pid: parsed.pid, host: parsed.host };
  if (!isAlive(parsed.pid)) return { state: 'stale', pid: parsed.pid, host: parsed.host, reason: 'dead' };
  return { state: 'live', pid: parsed.pid, host: parsed.host };
}

function sameStale(left, right) {
  if (!left || !right) return false;
  if (left.reason === 'unreadable' || right.reason === 'unreadable') {
    return left.reason === 'unreadable' && right.reason === 'unreadable';
  }
  return left.state === 'stale' && right.state === 'stale' && left.pid === right.pid && left.host === right.host;
}

function recoveryStuckMessage(status, ledgerPath) {
  const who = status.pid ? `process ${status.pid} on ${status.host === undefined ? 'this computer' : status.host}` : 'an unreadable recovery lock';
  return `A recovery lock is still here from ${who}, and that process is gone. Nothing was changed.\nRun: ${unlockCommand(ledgerPath)}`;
}

async function acquire(ledgerPath, { pid, host, hooks }) {
  const lockPath = `${ledgerPath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  refuseLink(lockPath);
  refuseLink(reclaimPath);
  if (publishLock(lockPath, { pid, host }, pid)) return { ok: true, lockPath };

  let status = inspectLock(lockPath, host);
  if (status.state === 'absent') {
    // The lock disappeared between the failed link and this read. Try once more.
    if (publishLock(lockPath, { pid, host }, pid)) return { ok: true, lockPath };
    status = inspectLock(lockPath, host);
  }
  if (status.state === 'link') throw new ProofError(`${lockPath} is a link, so nothing was changed.`);
  if (status.state === 'live' || status.state === 'other-host') return { ok: false, message: ANOTHER_SAVE };
  if (status.state === 'absent') return { ok: false, message: ANOTHER_SAVE };

  const reclaim = existsSync(reclaimPath) ? inspectLock(reclaimPath, host) : { state: 'absent' };
  if (reclaim.state === 'link') throw new ProofError(`${reclaimPath} is a link, so nothing was changed.`);
  if (reclaim.state === 'live' || reclaim.state === 'other-host') return { ok: false, message: ANOTHER_RECOVERY };
  if (reclaim.state === 'stale' || reclaim.reason === 'unreadable') {
    return { ok: false, message: recoveryStuckMessage(reclaim, ledgerPath) };
  }

  if (!publishLock(reclaimPath, { pid, host }, pid)) return { ok: false, message: ANOTHER_RECOVERY };
  if (hooks?.onReclaimHeld) await hooks.onReclaimHeld();
  const again = inspectLock(lockPath, host);
  if (!sameStale(status, again)) {
    try { unlinkSync(reclaimPath); } catch { /* already gone */ }
    return { ok: false, message: ANOTHER_SAVE };
  }
  try {
    unlinkSync(lockPath);
  } catch (error) {
    try { unlinkSync(reclaimPath); } catch { /* already gone */ }
    throw new ProofError(fsMessage('write', lockPath, error));
  }
  if (!publishLock(lockPath, { pid, host }, pid)) {
    try { unlinkSync(reclaimPath); } catch { /* already gone */ }
    return { ok: false, message: ANOTHER_SAVE };
  }
  try { unlinkSync(reclaimPath); } catch { /* already gone */ }
  return { ok: true, lockPath, cleared: CLEARED_LOCK };
}

function release(lockPath, pid, host) {
  const status = inspectLock(lockPath, host);
  if (status.pid === pid && status.host === host) {
    try { unlinkSync(lockPath); } catch (error) {
      if (error.code !== 'ENOENT') throw new ProofError(fsMessage('write', lockPath, error));
    }
  }
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0].startsWith('--')) {
    throw new ProofError(`Choose a command: record, amend, verify, report, links or unlock.\n${USAGE}`);
  }
  const command = argv[0];
  const positionals = [];
  const flags = {};
  const take = (name, value) => {
    if (Object.hasOwn(flags, name)) throw new ProofError(`--${name} was given twice.`);
    flags[name] = value;
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      take('force', true);
      continue;
    }
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new ProofError(`--${name} needs a value.`);
      take(name, value);
      i += 1;
      continue;
    }
    positionals.push(arg);
  }
  return { command, positionals, flags };
}

function requireLedger(flags) {
  if (!flags.ledger) throw new ProofError('--ledger is required. Pass the proof ledger file. Nothing was guessed.');
  if (typeof flags.ledger !== 'string' || flags.ledger.length === 0) {
    throw new ProofError('--ledger is required. Pass the proof ledger file. Nothing was guessed.');
  }
  return flags.ledger;
}

function knownFlags(flags, allowed) {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new ProofError(`--${name} is not used with this command.`);
  }
}

function loadLedger(ledgerPath) {
  if (!existsSync(ledgerPath)) return { exists: false, raw: null, entries: [] };
  const raw = readLimited(ledgerPath, LEDGER_BYTES, 'read');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProofError(`The ledger at ${ledgerPath} is not valid JSON, so nothing was added. Restore the ledger from your copy.`);
  }
  if (!Array.isArray(parsed)) {
    throw new ProofError(`The ledger at ${ledgerPath} is not a list of entries, so nothing was added. Restore the ledger from your copy.`);
  }
  return { exists: true, raw, entries: parsed };
}

function readHead(headPath) {
  if (!existsSync(headPath)) return { exists: false, valid: false, value: null };
  let raw;
  try {
    raw = readLimited(headPath, SIDE_FILE_BYTES, 'read');
  } catch (error) {
    if (error instanceof ProofError && (/is a link/.test(error.message) || /permission denied/.test(error.message))) {
      throw error;
    }
    return { exists: true, valid: false, value: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, valid: false, value: null };
  }
  if (!isPlainObject(parsed) || (parsed.state !== 'pending' && parsed.state !== 'committed')) {
    return { exists: true, valid: false, value: null };
  }
  if (!Number.isInteger(parsed.seq) || parsed.seq < 1 || typeof parsed.entryHash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.entryHash)) {
    return { exists: true, valid: false, value: null };
  }
  if (parsed.prev !== null) {
    if (!isPlainObject(parsed.prev) || !Number.isInteger(parsed.prev.seq) || parsed.prev.seq < 1 || typeof parsed.prev.entryHash !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.prev.entryHash)) {
      return { exists: true, valid: false, value: null };
    }
  }
  return {
    exists: true,
    valid: true,
    value: {
      state: parsed.state,
      seq: parsed.seq,
      entryHash: parsed.entryHash,
      prev: parsed.prev === null ? null : { seq: parsed.prev.seq, entryHash: parsed.prev.entryHash },
    },
  };
}

function ownerRefusal(message) {
  if (typeof message === 'string' && message.includes('was changed after it was recorded')) {
    return `${message.replace(/\.$/, '')}, so nothing was added. Restore the ledger from your copy.`;
  }
  return message;
}

function endsAt(entries, target) {
  if (target === null) return entries.length === 0;
  if (!target) return false;
  const last = entries[entries.length - 1];
  return Boolean(last) && last.seq === target.seq && last.entryHash === target.entryHash;
}

function writeHeadFile(headPath, value, hooks) {
  writePrivate(headPath, `${JSON.stringify(value, null, 2)}\n`, value.state === 'pending' ? 'head-pending' : 'head-committed', hooks);
}

function recover(ledgerPath, hooks) {
  const headPath = `${ledgerPath}.head`;
  const loaded = loadLedger(ledgerPath);
  const headInfo = readHead(headPath);
  const notices = [];
  if (!headInfo.exists && !loaded.exists) {
    return { fresh: true, actionable: true, entries: [], expectedHead: null, notices, loaded };
  }
  if (!headInfo.exists) {
    notices.push(`${END_UNCHECKED} Restore the head file from your copy.`);
    return { fresh: false, actionable: false, entries: loaded.entries, expectedHead: undefined, notices, loaded };
  }
  if (!headInfo.valid) {
    notices.push(`The head file can't be read, so the end of the ledger can't be checked. Restore the head file from your copy.`);
    return { fresh: false, actionable: false, entries: loaded.entries, expectedHead: undefined, notices, loaded };
  }
  const head = headInfo.value;
  const target = { seq: head.seq, entryHash: head.entryHash };
  if (head.state === 'pending' && endsAt(loaded.entries, target)) {
    const checked = verifyLedger(loaded.entries, { expectedHead: target });
    if (!checked.complete) {
      notices.push(ownerRefusal(checked.message));
      if (!ownerRefusal(checked.message).includes('Restore the ledger')) notices.push('Restore the ledger from your copy.');
      return { fresh: false, actionable: false, entries: loaded.entries, expectedHead: undefined, notices, loaded };
    }
    writeHeadFile(headPath, { ...head, state: 'committed' }, hooks);
    notices.push(WAS_SAVED);
    return { fresh: false, actionable: true, entries: loaded.entries, expectedHead: target, notices, loaded: loadLedger(ledgerPath) };
  }
  if (head.state === 'pending' && endsAt(loaded.entries, head.prev)) {
    if (head.prev === null) {
      try { unlinkSync(headPath); } catch (error) {
        if (error.code !== 'ENOENT') throw new ProofError(fsMessage('write', headPath, error));
      }
      notices.push(DIDNT_FINISH);
      const again = loadLedger(ledgerPath);
      return {
        fresh: !again.exists,
        actionable: !again.exists,
        entries: again.entries,
        expectedHead: again.exists ? undefined : null,
        notices,
        loaded: again,
      };
    }
    const restored = { state: 'committed', seq: head.prev.seq, entryHash: head.prev.entryHash, prev: null };
    writeHeadFile(headPath, restored, hooks);
    notices.push(DIDNT_FINISH);
    return {
      fresh: false,
      actionable: true,
      entries: loaded.entries,
      expectedHead: { seq: restored.seq, entryHash: restored.entryHash },
      notices,
      loaded,
    };
  }
  if (head.state === 'committed' && endsAt(loaded.entries, target)) {
    const checked = verifyLedger(loaded.entries, { expectedHead: target });
    if (!checked.complete) {
      notices.push(ownerRefusal(checked.message));
      if (!ownerRefusal(checked.message).includes('Restore the ledger')) notices.push('Restore the ledger from your copy.');
      return { fresh: false, actionable: false, entries: loaded.entries, expectedHead: undefined, notices, loaded };
    }
    return { fresh: false, actionable: true, entries: loaded.entries, expectedHead: target, notices, loaded };
  }
  const last = loaded.entries[loaded.entries.length - 1];
  const tailReady = loaded.entries.length === 0 || (isPlainObject(last) && Number.isInteger(last.seq));
  if (!tailReady) {
    const checked = verifyLedger(loaded.entries, { expectedHead: target });
    const refusal = ownerRefusal(checked.message);
    notices.push(refusal);
    if (!refusal.includes('Restore the ledger')) notices.push('Restore the ledger from your copy.');
    return { fresh: false, actionable: false, entries: loaded.entries, expectedHead: undefined, notices, loaded };
  }
  const actualSeq = loaded.entries.length === 0 ? 0 : last.seq;
  notices.push(cutoffLine(actualSeq, head.seq));
  notices.push('Restore the ledger from your copy.');
  return { fresh: false, actionable: false, entries: loaded.entries, expectedHead: undefined, notices, loaded, cutoff: true };
}

async function withLock(ledgerPath, io, fn) {
  const pid = io.pid ?? process.pid;
  const host = io.host ?? hostname();
  const hooks = io.hooks ?? {};
  refuseLink(ledgerPath);
  const parent = dirname(ledgerPath);
  if (!existsSync(parent)) throw new ProofError(`Can't write ${ledgerPath}: the folder is missing.`);
  const got = await acquire(ledgerPath, { pid, host, hooks });
  if (!got.ok) throw new ProofError(got.message);
  const notices = [];
  if (got.cleared) notices.push(got.cleared);
  try {
    if (hooks.pause) await hooks.pause('locked');
    const result = await fn({ notices, hooks, pid, host });
    release(got.lockPath, pid, host);
    return result;
  } catch (error) {
    if (!(error instanceof StopAfter)) release(got.lockPath, pid, host);
    throw error;
  }
}

function joinNotices(notices, message) {
  if (!notices.length) return message;
  return `${notices.join('\n')}\n${message}`;
}

function stageStop(stage, hooks) {
  if (hooks.stopAfter === stage) throw new StopAfter(stage);
}

async function pause(stage, hooks) {
  if (hooks.pause) await hooks.pause(stage);
  stageStop(stage, hooks);
}

// The bytes we are about to write are the bytes the next check will read.
// Refuse before the pending head exists, or a too-large save would stick.
export function prospectiveLedger(ledgerPath, next) {
  if (!Array.isArray(next)) {
    throw new ProofError(`The ledger at ${ledgerPath} could not be saved, so nothing was added.`);
  }
  if (next.length > ENTRY_LIMIT) {
    throw new ProofError(`This save would hold ${next.length} entries in ${ledgerPath}. The limit is ${ENTRY_LIMIT}, so nothing was added. The ledger was left as it was.`);
  }
  const raw = `${JSON.stringify(next, null, 2)}\n`;
  const bytes = Buffer.byteLength(raw);
  if (bytes > LEDGER_BYTES) {
    throw new ProofError(`This save would make ${ledgerPath} ${bytes} bytes. The limit is ${LEDGER_BYTES} bytes, so nothing was added. The ledger was left as it was.`);
  }
  return raw;
}

function appendFiles(ledgerPath, next, previousHead, hooks) {
  const last = next[next.length - 1];
  const pending = {
    state: 'pending',
    seq: last.seq,
    entryHash: last.entryHash,
    prev: previousHead,
  };
  writeHeadFile(`${ledgerPath}.head`, pending, hooks);
  return pending;
}

function successLines(lines) {
  return lines.join('\n');
}

async function saveNewEntry(ledgerPath, io, build) {
  return withLock(ledgerPath, io, async ({ notices, hooks }) => {
    const state = recover(ledgerPath, hooks);
    notices.push(...state.notices);
    if (!state.actionable) {
      const text = notices.join('\n');
      if (/nothing was added/i.test(text)) throw new ProofError(text);
      throw new ProofError(text ? `${text}\nNothing was added.` : 'Nothing was added.');
    }
    const before = state.loaded;
    if (hooks.afterReadLedger) hooks.afterReadLedger(ledgerPath);
    const built = await build(state, before);
    const after = loadLedger(ledgerPath);
    if (before.raw !== after.raw) {
      throw new ProofError(joinNotices(notices, 'The ledger changed after it was read, so nothing was added. Run verify, then try again.'));
    }
    const previousHead = state.expectedHead === null ? null : { ...state.expectedHead };
    const raw = prospectiveLedger(ledgerPath, built.next);
    const pending = appendFiles(ledgerPath, built.next, previousHead, hooks);
    await pause('pending-head', hooks);
    writePrivate(ledgerPath, raw, 'ledger', hooks);
    await pause('ledger', hooks);
    writeHeadFile(`${ledgerPath}.head`, { ...pending, state: 'committed' }, hooks);
    await pause('committed-head', hooks);
    return { text: successLines(built.lines(notices)), code: 0 };
  });
}

async function commandRecord(flags, positionals, io) {
  knownFlags(flags, ['ledger', 'title', 'platform', 'post-url', 'posted-at']);
  const ledgerPath = requireLedger(flags);
  if (positionals.length !== 1) throw new ProofError('record needs the media file.');
  if (!flags.title) throw new ProofError('--title needs text.');
  const media = positionals[0];
  const original = { title: flags.title };
  if (flags.platform) original.platform = flags.platform;
  if (flags['post-url']) original.postUrl = flags['post-url'];
  if (flags['posted-at']) original.postedAt = flags['posted-at'];
  const saved = await saveNewEntry(ledgerPath, io, async (state, before) => {
    const hashed = await hashStableFile(media, io.hooks ?? {});
    const recordedAt = (io.clock ?? readClock)();
    const next = recordOriginal(before.entries, {
      ...original,
      fileName: basename(media),
      fileSha256: hashed.fileSha256,
      sizeBytes: hashed.sizeBytes,
    }, { recordedAt, expectedHead: state.expectedHead });
    const entry = next[next.length - 1];
    return {
      next,
      lines: (noticeLines) => {
        const lines = [...noticeLines];
        if (state.fresh) lines.push(`Started a new proof ledger at ${ledgerPath}. Keep a copy somewhere safe.`);
        lines.push(`Recorded "${entry.title}" as ${entry.originalId} (entry ${entry.seq}).`);
        lines.push(`Proof code: ${entry.entryHash}`);
        lines.push(PLAIN_NOTE);
        return lines;
      },
    };
  });
  return saved;
}

async function commandAmend(flags, positionals, io) {
  knownFlags(flags, ['ledger', 'platform', 'post-url', 'posted-at', 'notes']);
  const ledgerPath = requireLedger(flags);
  if (positionals.length !== 1) throw new ProofError('amend needs the original id.');
  const changes = {};
  if (Object.hasOwn(flags, 'platform')) changes.platform = flags.platform;
  if (Object.hasOwn(flags, 'post-url')) changes.postUrl = flags['post-url'];
  if (Object.hasOwn(flags, 'posted-at')) changes.postedAt = flags['posted-at'];
  if (Object.hasOwn(flags, 'notes')) changes.notes = flags.notes;
  if (Object.keys(changes).length === 0) {
    throw new ProofError('Name at least one fact to change: platform, post link, posted date or notes.');
  }
  const id = positionals[0];
  return saveNewEntry(ledgerPath, io, async (state) => {
    const recordedAt = (io.clock ?? readClock)();
    const next = amendOriginal(state.entries, id, changes, { recordedAt, expectedHead: state.expectedHead });
    const entry = next[next.length - 1];
    return {
      next,
      lines: (notices) => [
        ...notices,
        `Updated ${id}. The earlier entry was kept.`,
        `Proof code: ${entry.entryHash}`,
        PLAIN_NOTE,
      ],
    };
  });
}

async function commandVerify(flags, io) {
  knownFlags(flags, ['ledger']);
  const ledgerPath = requireLedger(flags);
  return withLock(ledgerPath, io, async ({ notices, hooks }) => {
    const state = recover(ledgerPath, hooks);
    const lines = [...notices, ...state.notices];
    if (state.fresh) {
      lines.push(`No proof ledger at ${ledgerPath} yet.`);
      lines.push(RECORD_FIRST);
      lines.push(recordCommand(ledgerPath));
      return { code: 1, text: lines.join('\n') };
    }
    if (!state.actionable) return { code: 1, text: lines.join('\n') };
    const checked = verifyLedger(state.entries, { expectedHead: state.expectedHead });
    if (!checked.complete) {
      const refusal = ownerRefusal(checked.message);
      lines.push(refusal);
      if (!refusal.includes('Restore the ledger')) lines.push('Restore the ledger from your copy.');
      return { code: 1, text: lines.join('\n') };
    }
    lines.push(COMPLETE_LINE);
    lines.push(PLAIN_NOTE);
    if (checked.head) lines.push(`Proof code: ${checked.head.entryHash}`);
    lines.push(`Entries: ${state.entries.length}.`);
    return { code: 0, text: lines.join('\n') };
  });
}

function readJson(file, label) {
  let raw;
  try {
    raw = readLimited(file, SIDE_FILE_BYTES, 'read');
  } catch (error) {
    if (error instanceof ProofError) throw error;
    throw new ProofError(fsMessage('read', file, error));
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProofError(`The ${label} file is not valid JSON.`);
  }
}

function pathKey(file) {
  const resolved = resolve(file);
  try {
    return realpathSync(resolved);
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }
  const parent = dirname(resolved);
  let parentKey = parent;
  try {
    parentKey = realpathSync(parent);
  } catch {
    parentKey = resolve(parent);
  }
  return join(parentKey, basename(resolved));
}

function samePath(left, right) {
  const fold = (value) => (process.platform === 'darwin' ? value.normalize('NFD').toLowerCase() : value);
  return fold(pathKey(left)) === fold(pathKey(right));
}

function refuseLedgerTarget(file, ledgerPath) {
  const protectedPaths = [
    ledgerPath,
    `${ledgerPath}.head`,
    `${ledgerPath}.lock`,
    `${ledgerPath}.lock.reclaim`,
  ];
  for (const target of protectedPaths) {
    if (samePath(file, target)) {
      throw new ProofError(`${file} is the proof ledger or its head or lock. Choose another file. Nothing was written.`);
    }
  }
}

function refuseOverwrite(file, force, ledgerPath) {
  refuseLedgerTarget(file, ledgerPath);
  if (!force && existsSync(file)) throw new ProofError(alreadyThere(file));
  refuseLink(file);
}

async function commandReport(flags, io) {
  knownFlags(flags, ['ledger', 'case', 'out', 'force']);
  const ledgerPath = requireLedger(flags);
  if (!flags.case) throw new ProofError('--case needs a file.');
  if (!flags.out) throw new ProofError('--out needs a file.');
  return withLock(ledgerPath, io, async ({ notices, hooks }) => {
    const state = recover(ledgerPath, hooks);
    const lines = [...notices, ...state.notices];
    if (!state.fresh && !state.actionable) return { code: 1, text: lines.join('\n') };
    if (state.entries.length === 0 || state.fresh) {
      lines.push(RECORD_FIRST);
      lines.push(recordCommand(ledgerPath));
      return { code: 1, text: lines.join('\n') };
    }
    const theCase = readJson(flags.case, 'case');
    const report = buildReport(state.entries, theCase, { expectedHead: state.expectedHead });
    refuseOverwrite(flags.out, flags.force === true, ledgerPath);
    if (hooks.beforePublishOut) await hooks.beforePublishOut();
    writePrivate(flags.out, report.markdown, 'pack', hooks, { exclusive: flags.force !== true });
    lines.push('Checklist:');
    report.checklist.forEach((item, index) => {
      lines.push(`${index + 1}. ${item.place}`);
      for (const step of item.steps) lines.push(`   - ${step}`);
    });
    lines.push('Missing:');
    if (report.missing.length === 0) lines.push('- none.');
    for (const item of report.missing) lines.push(`- ${item.message}`);
    lines.push(`Wrote ${flags.out}`);
    return { code: 0, text: lines.join('\n') };
  });
}

async function commandLinks(flags, io) {
  knownFlags(flags, ['ledger', 'links', 'out', 'force']);
  const ledgerPath = requireLedger(flags);
  if (!flags.links) throw new ProofError('--links needs a file.');
  if (!flags.out) throw new ProofError('--out needs a file.');
  return withLock(ledgerPath, io, async ({ notices, hooks }) => {
    const state = recover(ledgerPath, hooks);
    const lines = [...notices, ...state.notices];
    if (!state.fresh && !state.actionable) return { code: 1, text: lines.join('\n') };
    if (state.entries.length === 0 || state.fresh) {
      lines.push(RECORD_FIRST);
      lines.push(recordCommand(ledgerPath));
      return { code: 1, text: lines.join('\n') };
    }
    const pageInput = readJson(flags.links, 'links');
    if (!isPlainObject(pageInput)) throw new ProofError('The links file must be a JSON object.');
    const html = realLinksPage({
      creatorName: pageInput.creatorName,
      intro: pageInput.intro,
      links: pageInput.links,
      updatedAt: pageInput.updatedAt,
      ledgerHash: state.expectedHead?.entryHash,
    });
    refuseOverwrite(flags.out, flags.force === true, ledgerPath);
    if (hooks.beforePublishOut) await hooks.beforePublishOut();
    writePublic(flags.out, html, 'page', hooks, { exclusive: flags.force !== true });
    lines.push(`Wrote ${flags.out}`);
    return { code: 0, text: lines.join('\n') };
  });
}

function commandUnlock(flags, io) {
  knownFlags(flags, ['ledger']);
  const ledgerPath = requireLedger(flags);
  const reclaimPath = `${ledgerPath}.lock.reclaim`;
  const host = io.host ?? hostname();
  if (!existsSync(reclaimPath)) throw new ProofError(`There is no stuck recovery lock at ${reclaimPath}.`);
  const status = inspectLock(reclaimPath, host);
  if (status.state === 'link') throw new ProofError(`${reclaimPath} is a link, so nothing was changed.`);
  if (status.state === 'other-host') {
    throw new ProofError(`That recovery lock is from ${status.host}, so it was left in place.`);
  }
  if (status.state === 'live') throw new ProofError(`That recovery is still running (process ${status.pid}). Nothing was removed.`);
  try {
    unlinkSync(reclaimPath);
  } catch (error) {
    throw new ProofError(fsMessage('write', reclaimPath, error));
  }
  return { code: 0, text: 'Removed the stuck recovery lock. Run verify to finish.' };
}

async function dispatch(argv, io) {
  const { command, positionals, flags } = parseArgs(argv);
  if (command === 'record') return commandRecord(flags, positionals, io);
  if (command === 'amend') return commandAmend(flags, positionals, io);
  if (command === 'verify') return commandVerify(flags, io);
  if (command === 'report') return commandReport(flags, io);
  if (command === 'links') return commandLinks(flags, io);
  if (command === 'unlock') return commandUnlock(flags, io);
  throw new ProofError(`Choose a command: record, amend, verify, report, links or unlock.\n${USAGE}`);
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const result = await dispatch(argv, io);
    if (result?.text) stdout.write(`${result.text}\n`);
    return result?.code ?? 0;
  } catch (error) {
    if (error instanceof StopAfter) throw error;
    if (error instanceof ProofError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
