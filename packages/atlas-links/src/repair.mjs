/**
 * Repair Atlas links that broke because a note moved.
 * The library plans the repairs. This command reads one folder and,
 * only with --write, updates the notes it planned to change.
 *
 *   node packages/atlas-links/src/repair.mjs --dir <folder> [--write | --record] [--json]
 *   node packages/atlas-links/src/repair.mjs --dir <folder> --unlock
 */

import { randomBytes, createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  linkSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';
import {
  LinkRepairError,
  applyRepairs,
  formatReport,
  isGeneratedIndex,
  planRepairs,
  sha256Text,
} from './index.mjs';

const META = '.atlas-links';
const SNAPSHOT = 'paths.json';
const JOURNAL = 'journal.json';
const LOCK = 'run.lock';
const RECLAIM = 'run.lock.reclaim';
const KEPT = 'Kept the old snapshot so the skipped links can be repaired next run.';
const CLEARED = 'An earlier run stopped without finishing; cleared its lock.';
const RECOVERING = 'Another command is recovering; try again in a moment.';
const PAUSE = "Paused before writing. Change a note now if you're testing, then press Enter.";

const fail = message => {
  throw new LinkRepairError(message);
};

function emit(stream, text) {
  if (typeof stream === 'function') stream(text);
  else if (stream && typeof stream.write === 'function') stream.write(text);
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function parseArgs(argv) {
  const args = {
    dir: undefined,
    write: false,
    record: false,
    json: false,
    pause: false,
    unlock: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      if (args.write) fail('--write was given twice.');
      args.write = true;
      continue;
    }
    if (arg === '--record') {
      if (args.record) fail('--record was given twice.');
      args.record = true;
      continue;
    }
    if (arg === '--json') {
      if (args.json) fail('--json was given twice.');
      args.json = true;
      continue;
    }
    if (arg === '--pause-before-write') {
      if (args.pause) fail('--pause-before-write was given twice.');
      args.pause = true;
      continue;
    }
    if (arg === '--unlock') {
      if (args.unlock) fail('--unlock was given twice.');
      args.unlock = true;
      continue;
    }
    if (arg === '--dir' || arg.startsWith('--dir=')) {
      if (args.dir !== undefined) fail('--dir was given twice.');
      const value = arg === '--dir' ? argv[i + 1] : arg.slice('--dir='.length);
      if (arg === '--dir') i += 1;
      if (!value || value.startsWith('--')) fail('--dir needs a folder.');
      args.dir = value;
      continue;
    }
    fail(`Unknown argument "${arg}".`);
  }
  if (args.dir === undefined) fail('--dir needs a folder.');
  if (args.write && args.record) fail('Use either --write or --record.');
  if (args.unlock && (args.write || args.record || args.pause || args.json)) {
    fail('--unlock cannot be combined with another action.');
  }
  if (args.pause && !args.write) fail('--pause-before-write needs --write.');
  return args;
}

function repositoryRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      lstatSync(path.join(dir, '.git'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return '';
      dir = parent;
    }
  }
}

function refuseWorkspace(root) {
  try {
    lstatSync(path.join(root, '.git'));
    fail('Refusing this folder because it contains .git.');
  } catch (error) {
    if (error instanceof LinkRepairError) throw error;
  }
  const repo = repositoryRoot();
  if (repo && path.resolve(root) === path.resolve(repo)) {
    fail('Refusing this folder because it is the repository root.');
  }
}

function resolveFolder(cwd, dir) {
  const lexical = path.resolve(cwd, dir);
  let listed;
  try {
    listed = lstatSync(lexical);
  } catch {
    fail('Could not read this folder.');
  }
  if (!listed.isDirectory() && !listed.isSymbolicLink()) fail('Could not read this folder.');
  let root;
  try {
    root = realpathSync(lexical);
  } catch {
    fail('Could not read this folder.');
  }
  let stat;
  try {
    stat = statSync(root);
  } catch {
    fail('Could not read this folder.');
  }
  if (!stat.isDirectory()) fail('Could not read this folder.');
  return root;
}

function toNotePath(root, full) {
  const rel = path.relative(root, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('Refusing to read a file outside the folder.');
  return rel.split(path.sep).join('/');
}

function decodeNote(bytes, notePath) {
  let text;
  try {
    // ignoreBOM keeps a leading EF BB BF in the text, so writing it back matches the file.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail(`Refusing "${notePath}" because it is not valid UTF-8.`);
  }
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    fail(`Refusing "${notePath}" because it is not valid UTF-8.`);
  }
  return text;
}

function walk(root, dir, found) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    fail('Could not read this folder.');
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      walk(root, full, found);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    let listed;
    try {
      listed = lstatSync(full);
    } catch {
      fail(`Could not read "${toNotePath(root, full)}".`);
    }
    if (listed.isSymbolicLink() || !listed.isFile()) continue;
    const notePath = toNotePath(root, full);
    let bytes;
    try {
      bytes = readFileSync(full);
    } catch {
      fail(`Could not read "${notePath}".`);
    }
    found.push({ path: notePath, text: decodeNote(bytes, notePath), bytes });
  }
}

function scanDirectory(root) {
  refuseWorkspace(root);
  const found = [];
  walk(root, root, found);
  found.sort((a, b) => compareText(a.path, b.path));
  return {
    notes: found.map(item => ({ path: item.path, text: item.text })),
    bytes: new Map(found.map(item => [item.path, item.bytes])),
  };
}

function metaDir(root) {
  return path.join(root, META);
}

function metaPath(root, name) {
  return path.join(metaDir(root), name);
}

function refuseMetaLink(root) {
  const dir = metaDir(root);
  let listed;
  try {
    listed = lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false };
    fail('Could not read .atlas-links.');
  }
  if (listed.isSymbolicLink()) fail('Refusing this folder because .atlas-links is a symbolic link.');
  if (!listed.isDirectory()) fail('Refusing this folder because .atlas-links is not a folder.');
  for (const name of [SNAPSHOT, JOURNAL, LOCK, RECLAIM]) {
    try {
      const st = lstatSync(path.join(dir, name));
      if (st.isSymbolicLink()) fail(`Refusing this folder because .atlas-links/${name} is a symbolic link.`);
    } catch (error) {
      if (error instanceof LinkRepairError) throw error;
      if (error.code !== 'ENOENT') fail(`Could not read .atlas-links/${name}.`);
    }
  }
  return { exists: true };
}

function ensureMeta(root) {
  const state = refuseMetaLink(root);
  if (!state.exists) {
    try {
      mkdirSync(metaDir(root), { recursive: true, mode: 0o700 });
      chmodSync(metaDir(root), 0o700);
    } catch {
      fail('Could not prepare .atlas-links.');
    }
    try {
      const st = lstatSync(metaDir(root));
      if (st.isSymbolicLink() || !st.isDirectory()) fail('Refusing this folder because .atlas-links is not a folder.');
    } catch (error) {
      if (error instanceof LinkRepairError) throw error;
      fail('Could not prepare .atlas-links.');
    }
    return true;
  }
  return false;
}

function removeEmptyMeta(root, created) {
  if (!created) return;
  try {
    rmdirSync(metaDir(root));
  } catch {
    /* a file is still in the folder */
  }
}

function hostName() {
  const name = hostname();
  if (!name || name.includes('\n') || name.includes('\r')) fail('This computer has no usable host name.');
  return name;
}

function lockBody() {
  return `${process.pid}\n${hostName()}\n`;
}

function parseLock(text) {
  const match = /^([1-9]\d*)\n([^\n\r]+)\n$/.exec(text);
  if (!match) return null;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, host: match[2] };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function isStale(text) {
  const parsed = parseLock(text);
  if (!parsed) return true;
  if (parsed.host !== hostName()) return false;
  return !processAlive(parsed.pid);
}

function liveMessage(text) {
  const parsed = parseLock(text);
  if (parsed && parsed.host !== hostName()) return 'Another repair is running on another computer. Nothing was written.';
  return 'Another repair is already running. Nothing was written.';
}

function unlockAdvice(dir) {
  return `An earlier recovery stopped without finishing. Its lock is still here: .atlas-links/${RECLAIM}\nRemove it with: node packages/atlas-links/src/repair.mjs --dir ${dir} --unlock`;
}

function readTextFile(target, label) {
  let listed;
  try {
    listed = lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail(`Could not read ${label}.`);
  }
  if (listed.isSymbolicLink()) fail(`Refusing this folder because ${label} is a symbolic link.`);
  if (!listed.isFile()) fail(`Could not read ${label}.`);
  let bytes;
  try {
    bytes = readFileSync(target);
  } catch {
    fail(`Could not read ${label}.`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`Could not read ${label}.`);
  }
  return text;
}

function publish(target) {
  const body = lockBody();
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  let fd;
  try {
    fd = openSync(tmp, 'wx', 0o600);
  } catch {
    fail('Could not lock this folder.');
  }
  try {
    writeFileSync(fd, body);
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* closing a failed write */ }
    try { unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    fail('Could not lock this folder.');
  }
  try {
    closeSync(fd);
  } catch {
    try { unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    fail('Could not lock this folder.');
  }
  try {
    // link fails if the lock is already there, so a lock is never half-written.
    linkSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    if (error && error.code === 'EEXIST') {
      const exists = new Error('exists');
      exists.code = 'EEXIST';
      throw exists;
    }
    fail('Could not lock this folder.');
  }
  try { unlinkSync(tmp); } catch { /* already removed */ }
  return body;
}

function release(target, body) {
  if (!body) return;
  try {
    if (readFileSync(target, 'utf8') === body) unlinkSync(target);
  } catch {
    /* a missing lock is already released */
  }
}

function acquire(root, dirArg, io) {
  const messages = [];
  const lockPath = metaPath(root, LOCK);
  const reclaimPath = metaPath(root, RECLAIM);
  const reclaimText = readTextFile(reclaimPath, `.atlas-links/${RECLAIM}`);
  if (reclaimText !== null) {
    if (!isStale(reclaimText)) fail(RECOVERING);
    fail(unlockAdvice(dirArg));
  }
  const lockText = readTextFile(lockPath, `.atlas-links/${LOCK}`);
  if (lockText === null) return { messages, lock: publish(lockPath), reclaim: '' };
  if (!isStale(lockText)) fail(liveMessage(lockText));
  let reclaim = '';
  try {
    reclaim = publish(reclaimPath);
  } catch (error) {
    if (error && error.code === 'EEXIST') fail(RECOVERING);
    throw error;
  }
  try {
    if (io.onReclaim) io.onReclaim();
    const again = readTextFile(lockPath, `.atlas-links/${LOCK}`);
    if (again === null || again !== lockText || !isStale(again)) fail(RECOVERING);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error.code !== 'ENOENT') fail('Could not lock this folder.');
    }
    messages.push(CLEARED);
    let lock;
    try {
      lock = publish(lockPath);
    } catch (error) {
      if (error && error.code === 'EEXIST') fail(RECOVERING);
      throw error;
    }
    release(reclaimPath, reclaim);
    return { messages, lock, reclaim: '' };
  } catch (error) {
    release(reclaimPath, reclaim);
    throw error;
  }
}

function snapshotJson(snapshot) {
  const notes = snapshot.notes.slice().sort((a, b) => compareText(a.path, b.path));
  return `${JSON.stringify({ notes: notes.map(note => ({ path: note.path, sha256: note.sha256 })) }, null, 2)}\n`;
}

function journalJson(entries) {
  const notes = entries.slice().sort((a, b) => compareText(a.path, b.path));
  return `${JSON.stringify({
    notes: notes.map(note => ({ path: note.path, before: note.before, after: note.after })),
  }, null, 2)}\n`;
}

function writeBytes(target, bytes, mode) {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = openSync(tmp, 'wx', mode);
  try {
    writeFileSync(fd, bytes);
    fchmodSync(fd, mode);
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* closing a failed write */ }
    try { unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    throw error;
  }
  try {
    closeSync(fd);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    throw error;
  }
  return tmp;
}

function replaceFile(target, bytes, mode) {
  const tmp = writeBytes(target, bytes, mode);
  try {
    renameSync(tmp, target);
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw error;
  }
}

function locate(root, notePath) {
  if (typeof notePath !== 'string' || notePath.includes('\\') || notePath.startsWith('/') || notePath.split('/').some(part => part === '' || part === '.' || part === '..')) {
    fail(`Refusing to touch "${notePath}" because it is outside the folder.`);
  }
  const target = path.resolve(root, ...notePath.split('/'));
  const back = path.relative(root, target);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) {
    fail(`Refusing to touch "${notePath}" because it is outside the folder.`);
  }
  const parent = path.dirname(target);
  let parentReal;
  try {
    parentReal = realpathSync(parent);
  } catch {
    fail(`Could not update "${notePath}".`);
  }
  const parentBack = path.relative(path.resolve(root), parentReal);
  if (parentBack.startsWith('..') || path.isAbsolute(parentBack)) {
    fail(`Refusing to touch "${notePath}" because it is outside the folder.`);
  }
  return target;
}

function inspect(target) {
  let listed;
  try {
    listed = lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { missing: true };
    return { error: true };
  }
  if (listed.isSymbolicLink()) return { link: true };
  if (!listed.isFile()) return { blocked: true };
  try {
    return { bytes: readFileSync(target), mode: listed.mode & 0o777 };
  } catch {
    return { error: true };
  }
}

function fileTitle(notePath) {
  const slash = notePath.lastIndexOf('/');
  const name = slash < 0 ? notePath : notePath.slice(slash + 1);
  return name.endsWith('.md') ? name.slice(0, -3) : name;
}

function nameKey(name) {
  return name.normalize('NFC').toLowerCase();
}

function loadJson(root, name, label) {
  const text = readTextFile(metaPath(root, name), label);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    fail(`The ${label} is not usable.`);
  }
}

function snapshotNoteOk(note) {
  if (!note || typeof note !== 'object' || Array.isArray(note)) return false;
  if (typeof note.path !== 'string' || typeof note.sha256 !== 'string') return false;
  if (!/^[0-9a-f]{64}$/.test(note.sha256)) return false;
  if (
    note.path.length === 0
    || note.path.length > 4096
    || note.path.includes('\\')
    || note.path.startsWith('/')
    || !note.path.endsWith('.md')
    || note.path.split('/').some(part => part === '' || part === '.' || part === '..')
  ) return false;
  for (const key of Object.keys(note)) {
    if (key !== 'path' && key !== 'sha256') return false;
  }
  return true;
}

function readSnapshot(root) {
  const parsed = loadJson(root, SNAPSHOT, 'snapshot');
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.notes)) {
    fail('The snapshot is not usable.');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'notes') fail('The snapshot is not usable.');
  }
  const seen = new Set();
  for (const note of parsed.notes) {
    if (!snapshotNoteOk(note)) fail('The snapshot is not usable.');
    const key = note.path.normalize('NFC');
    if (seen.has(key)) fail('The snapshot is not usable.');
    seen.add(key);
  }
  return parsed;
}

function readJournal(root) {
  const parsed = loadJson(root, JOURNAL, 'journal');
  if (parsed === null) return null;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.notes)) {
    fail('The journal is not usable.');
  }
  for (const key of Object.keys(parsed)) {
    if (key !== 'notes') fail('The journal is not usable.');
  }
  for (const note of parsed.notes) {
    if (!note || typeof note !== 'object' || typeof note.path !== 'string') fail('The journal is not usable.');
    if (typeof note.before !== 'string' || typeof note.after !== 'string') fail('The journal is not usable.');
    if (!/^[0-9a-f]{64}$/.test(note.before) || !/^[0-9a-f]{64}$/.test(note.after)) {
      fail('The journal is not usable.');
    }
  }
  return parsed;
}

function hashByPath(scanned) {
  const hashes = new Map();
  for (const [notePath, bytes] of scanned.bytes) hashes.set(notePath, sha256Bytes(bytes));
  return hashes;
}

function pathPresent(paths, notePath) {
  const list = paths instanceof Map ? [...paths.keys()] : [...paths];
  if (list.includes(notePath)) return true;
  const want = notePath.normalize('NFC');
  return list.some(current => current.normalize('NFC') === want);
}

function aliasSnapshot(snapshot, journal, hashes) {
  if (!journal) return snapshot;
  if (!snapshot) fail('The snapshot is missing, so the unfinished repair cannot be finished.');
  const notes = [];
  for (const note of snapshot.notes) {
    if (!snapshotNoteOk(note)) fail('The snapshot is not usable.');
    notes.push({ path: note.path, sha256: note.sha256 });
  }
  for (const entry of journal.notes) {
    if (hashes.get(entry.path) !== entry.after) continue;
    const direct = notes.find(note => note.path.normalize('NFC') === entry.path.normalize('NFC'));
    if (direct) {
      if (direct.sha256 === entry.before) direct.sha256 = entry.after;
      continue;
    }
    const key = nameKey(fileTitle(entry.path));
    for (const note of notes) {
      if (note.sha256 !== entry.before) continue;
      if (pathPresent(hashes, note.path)) continue;
      if (nameKey(fileTitle(note.path)) !== key) continue;
      note.sha256 = entry.after;
    }
  }
  return { notes };
}

function hashOnDisk(root, notePath, previous) {
  let target;
  try {
    target = locate(root, notePath);
  } catch (error) {
    if (error instanceof LinkRepairError) return null;
    throw error;
  }
  const seen = inspect(target);
  if (!seen.bytes) return null;
  if (!previous || !previous.equals(seen.bytes)) decodeNote(seen.bytes, notePath);
  return sha256Bytes(seen.bytes);
}

function updateKept(root, snapshot, scanned, written) {
  const notes = snapshot.notes.map(note => ({ path: note.path, sha256: note.sha256 }));
  const writtenPaths = new Set();
  for (const item of written) {
    writtenPaths.add(item.path);
    const direct = notes.find(note => note.path.normalize('NFC') === item.path.normalize('NFC'));
    if (direct) {
      direct.sha256 = item.after;
      continue;
    }
    const key = nameKey(fileTitle(item.path));
    for (const note of notes) {
      if (note.sha256 !== item.before) continue;
      if (pathPresent(scanned.bytes, note.path)) continue;
      if (nameKey(fileTitle(note.path)) !== key) continue;
      note.sha256 = item.after;
    }
  }
  for (const note of notes) {
    if (writtenPaths.has(note.path) || !scanned.bytes.has(note.path)) continue;
    const hash = hashOnDisk(root, note.path, scanned.bytes.get(note.path));
    if (hash) note.sha256 = hash;
  }
  notes.sort((a, b) => compareText(a.path, b.path));
  return { notes };
}

function fullSnapshot(root, scanned, writtenText) {
  const notes = [];
  for (const note of scanned.notes) {
    if (writtenText.has(note.path)) {
      notes.push({ path: note.path, sha256: sha256Text(writtenText.get(note.path)) });
      continue;
    }
    const hash = hashOnDisk(root, note.path, scanned.bytes.get(note.path));
    if (!hash) continue;
    notes.push({ path: note.path, sha256: hash });
  }
  notes.sort((a, b) => compareText(a.path, b.path));
  return { notes };
}

function saveJson(root, name, text) {
  const target = metaPath(root, name);
  try {
    replaceFile(target, Buffer.from(text, 'utf8'), 0o600);
  } catch {
    fail(`Could not write .atlas-links/${name}.`);
  }
}

function destinationProblem(root, repair, writtenHashes) {
  let target;
  try {
    target = locate(root, repair.dest);
  } catch (error) {
    if (error instanceof LinkRepairError) return 'is outside the folder';
    return 'is not a note';
  }
  const seen = inspect(target);
  if (seen.missing) return 'is missing';
  if (seen.link) return 'is a symbolic link';
  if (seen.blocked || seen.error || !seen.bytes) return 'is not a note';
  const hash = sha256Bytes(seen.bytes);
  if (hash === repair.destHash || writtenHashes.get(repair.dest) === hash) return '';
  return 'changed after the scan';
}

function noteProblem(previous, seen) {
  if (seen.error || seen.blocked) return 'it is not a note';
  if (seen.link) return 'it is a symbolic link';
  if (seen.missing || !seen.bytes) return 'it disappeared after the scan';
  if (!previous || !previous.equals(seen.bytes)) return 'it changed after the scan';
  return '';
}

function readLine(input) {
  if (!input || typeof input.on !== 'function') {
    fail('Paused before writing, but there is no input to wait on.');
  }
  return new Promise(resolve => {
    let buf = '';
    const finish = () => {
      input.removeListener('data', onData);
      input.removeListener('end', onEnd);
      resolve();
    };
    const onData = chunk => {
      buf += chunk.toString();
      if (buf.includes('\n')) finish();
    };
    const onEnd = () => finish();
    input.on('data', onData);
    input.on('end', onEnd);
  });
}

function publicResult(result, extra) {
  return {
    repairs: result.repairs,
    needsYou: result.needsYou,
    writes: result.writes,
    counts: result.counts,
    ...extra,
  };
}

function notice(stdout, stderr, json, text) {
  emit(json ? stderr : stdout, `${text}\n`);
}

function recoveryBefore(journal, notePath, currentHash) {
  if (!journal || currentHash === undefined) return currentHash;
  const entries = journal.notes.filter(entry => entry.path.normalize('NFC') === notePath.normalize('NFC'));
  let hash = currentHash;
  let before = currentHash;
  const seen = new Set();
  while (hash && !seen.has(hash)) {
    seen.add(hash);
    const entry = entries.find(item => item.after === hash);
    if (!entry || entry.before === hash) break;
    before = entry.before;
    hash = entry.before;
  }
  return before;
}

async function runWrite(root, args, scanned, snapshot, journal, io, stdout) {
  const hashes = hashByPath(scanned);
  const aliased = aliasSnapshot(snapshot, journal, hashes);
  const result = planRepairs(scanned.notes, aliased);
  for (const item of result.writes) {
    const original = scanned.notes.find(note => note.path === item.path);
    if (!original || isGeneratedIndex(original.text)) {
      fail(`Refusing to write "${item.path}" because it is a generated index.`);
    }
  }
  if (args.pause) {
    emit(stdout, `${PAUSE}\n`);
    await readLine(io.stdin ?? process.stdin);
  }
  const planned = result.writes.map(item => ({
    path: item.path,
    before: recoveryBefore(journal, item.path, sha256Bytes(scanned.bytes.get(item.path))),
    after: sha256Text(item.text),
  }));
  // Keep entries whose file already matches, including a partial repair of a
  // note this run will write again. The new entry still starts at the original
  // before-hash, so a later interruption can reach the snapshot.
  const carried = [];
  if (journal) {
    for (const entry of journal.notes) {
      if (hashes.get(entry.path) !== entry.after) continue;
      if (planned.some(item => item.path === entry.path && item.before === entry.before && item.after === entry.after)) continue;
      carried.push({ path: entry.path, before: entry.before, after: entry.after });
    }
  }
  const journalEntries = () => [...planned, ...carried];
  if (journalEntries().length) saveJson(root, JOURNAL, journalJson(journalEntries()));
  const skipped = [];
  const written = [];
  const writtenText = new Map();
  const writtenHashes = new Map();
  const repairsByPath = new Map();
  for (const repair of result.repairs) {
    if (!repairsByPath.has(repair.path)) repairsByPath.set(repair.path, []);
    repairsByPath.get(repair.path).push(repair);
  }
  let wrote = 0;
  for (const item of result.writes) {
    const repairs = repairsByPath.get(item.path) ?? [];
    const target = locate(root, item.path);
    const previous = scanned.bytes.get(item.path);
    let problem = noteProblem(previous, inspect(target));
    if (problem) {
      skipped.push({ path: item.path, line: repairs[0]?.line ?? 0, from: repairs[0]?.from ?? '', to: repairs[0]?.to ?? '', reason: problem });
      continue;
    }
    const kept = [];
    for (const repair of repairs) {
      const destProblem = destinationProblem(root, repair, writtenHashes);
      if (destProblem) {
        skipped.push({
          path: item.path,
          line: repair.line,
          from: repair.from,
          to: repair.to,
          reason: `${repair.dest} ${destProblem}`,
        });
        continue;
      }
      kept.push(repair);
    }
    if (!kept.length) continue;
    problem = noteProblem(previous, inspect(target));
    if (problem) {
      skipped.push({ path: item.path, line: kept[0].line, from: kept[0].from, to: kept[0].to, reason: problem });
      continue;
    }
    const original = scanned.notes.find(note => note.path === item.path);
    const text = applyRepairs(original.text, kept);
    const seen = inspect(target);
    let tmp;
    try {
      tmp = writeBytes(target, Buffer.from(text, 'utf8'), seen.mode ?? 0o600);
    } catch {
      fail(`Could not write "${item.path}".`);
    }
    const beforeRename = noteProblem(previous, inspect(target));
    const destNow = kept.map(repair => destinationProblem(root, repair, writtenHashes)).find(Boolean) || '';
    if (beforeRename || destNow) {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      if (beforeRename) {
        skipped.push({ path: item.path, line: kept[0].line, from: kept[0].from, to: kept[0].to, reason: beforeRename });
      } else {
        for (const repair of kept) {
          const again = destinationProblem(root, repair, writtenHashes);
          if (again) {
            skipped.push({ path: item.path, line: repair.line, from: repair.from, to: repair.to, reason: `${repair.dest} ${again}` });
          }
        }
      }
      continue;
    }
    const actualAfter = sha256Text(text);
    const entry = planned.find(note => note.path === item.path);
    if (entry && entry.after !== actualAfter) {
      entry.after = actualAfter;
      try {
        saveJson(root, JOURNAL, journalJson(journalEntries()));
      } catch (error) {
        try { unlinkSync(tmp); } catch { /* already gone */ }
        throw error;
      }
    }
    try {
      renameSync(tmp, target);
    } catch {
      try { unlinkSync(tmp); } catch { /* already gone */ }
      fail(`Could not write "${item.path}".`);
    }
    const after = sha256Text(text);
    written.push({ path: item.path, before: sha256Bytes(previous), after });
    writtenText.set(item.path, text);
    writtenHashes.set(item.path, after);
    wrote += 1;
    if (io.crashAfterWrites && wrote >= io.crashAfterWrites) {
      const crash = new Error('Stopped before the snapshot was saved.');
      crash.crash = true;
      throw crash;
    }
  }
  const snapshotKept = skipped.length > 0;
  if (!aliased && snapshotKept) fail('The snapshot is missing, so the skipped links cannot be kept.');
  const next = snapshotKept
    ? updateKept(root, aliased, scanned, written)
    : fullSnapshot(root, scanned, writtenText);
  if (io.crashBeforeSnapshot) {
    const crash = new Error('Stopped before the snapshot was saved.');
    crash.crash = true;
    throw crash;
  }
  saveJson(root, SNAPSHOT, snapshotJson(next));
  const journalPath = metaPath(root, JOURNAL);
  try {
    if (lstatSync(journalPath).isFile()) unlinkSync(journalPath);
  } catch (error) {
    if (error.code !== 'ENOENT') fail('Could not finish the journal.');
  }
  return { result, skipped, snapshotKept };
}

function doUnlock(root, stdout) {
  refuseMetaLink(root);
  const reclaimPath = metaPath(root, RECLAIM);
  const text = readTextFile(reclaimPath, `.atlas-links/${RECLAIM}`);
  if (text === null) fail('There is no recovery lock to remove.');
  const parsed = parseLock(text);
  if (parsed && parsed.host !== hostName()) fail('That recovery lock belongs to another computer. Nothing was removed.');
  if (parsed && processAlive(parsed.pid)) fail('That recovery is still running. Nothing was removed.');
  try {
    unlinkSync(reclaimPath);
  } catch {
    fail('Could not remove the recovery lock.');
  }
  emit(stdout, `Removed .atlas-links/${RECLAIM}.\n`);
}

export async function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  let root = '';
  let createdMeta = false;
  let lock = '';
  try {
    const args = parseArgs(argv);
    root = resolveFolder(cwd, args.dir);
    refuseWorkspace(root);
    if (args.unlock) {
      doUnlock(root, stdout);
      return 0;
    }
    if (!args.write && !args.record) {
      const scanned = scanDirectory(root);
      const snapshot = readSnapshot(root);
      const journal = readJournal(root);
      const result = planRepairs(scanned.notes, aliasSnapshot(snapshot, journal, hashByPath(scanned)));
      emit(stdout, args.json ? `${JSON.stringify(publicResult(result), null, 2)}\n` : formatReport(result, { noSnapshot: snapshot === null }));
      return 0;
    }
    createdMeta = ensureMeta(root);
    const held = acquire(root, args.dir, io);
    lock = held.lock;
    for (const message of held.messages) notice(stdout, stderr, args.json, message);
    if (args.record) {
      const existing = readSnapshot(root);
      const journal = readJournal(root);
      if (journal) fail('An earlier repair stopped without finishing. Run --write to finish it before recording.');
      const scanned = scanDirectory(root);
      planRepairs(scanned.notes, existing);
      const snapshot = fullSnapshot(root, scanned, new Map());
      saveJson(root, SNAPSHOT, snapshotJson(snapshot));
      emit(stdout, args.json ? `${snapshotJson(snapshot)}` : `Recorded ${snapshot.notes.length} notes.\n`);
      return 0;
    }
    const snapshot = readSnapshot(root);
    const journal = readJournal(root);
    const scanned = scanDirectory(root);
    const outcome = await runWrite(root, args, scanned, snapshot, journal, io, stdout);
    const payload = publicResult(outcome.result, {
      skipped: outcome.skipped,
      snapshotKept: outcome.snapshotKept,
    });
    if (args.json) emit(stdout, `${JSON.stringify(payload, null, 2)}\n`);
    else {
      emit(stdout, formatReport(outcome.result, { noSnapshot: snapshot === null }));
      for (const item of outcome.skipped) emit(stdout, `Skipped ${item.path} because ${item.reason}.\n`);
      if (outcome.snapshotKept) emit(stdout, `${KEPT}\n`);
    }
    if (args.json && outcome.snapshotKept) emit(stderr, `${KEPT}\n`);
    return 0;
  } catch (error) {
    if (error instanceof LinkRepairError) {
      emit(stderr, `${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    if (root && lock) release(metaPath(root, LOCK), lock);
    if (root) removeEmptyMeta(root, createdMeta);
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }, () => {
    process.exitCode = 1;
  });
}
