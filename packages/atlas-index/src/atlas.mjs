/**
 * Read a folder of markdown notes, rebuild the Atlas indexes, and print the
 * health list. Nothing is written unless --write is set. The library itself
 * never touches the disk; this command does.
 *
 *   node packages/atlas-index/src/atlas.mjs --dir <folder> [--write] [--json]
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AtlasError,
  DEFAULT_INDEX_NAME,
  DEFAULT_ROOT_MAP_NAME,
  MAP_MARKER,
  buildAtlas,
  caseFoldClash,
  isGeneratedIndex,
} from './index.mjs';

const fail = message => {
  throw new AtlasError(message);
};

function emit(stream, text) {
  if (stream && typeof stream.write === 'function') stream.write(text);
  else stream(text);
}

function parseArgs(argv) {
  let dir;
  let write = false;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write') {
      if (write) fail('--write was given twice.');
      write = true;
      continue;
    }
    if (arg === '--json') {
      if (json) fail('--json was given twice.');
      json = true;
      continue;
    }
    if (arg === '--dir' || arg.startsWith('--dir=')) {
      if (dir !== undefined) fail('--dir was given twice.');
      const value = arg === '--dir' ? argv[i + 1] : arg.slice('--dir='.length);
      if (arg === '--dir') i += 1;
      if (!value || value.startsWith('--')) fail('--dir needs a folder.');
      dir = value;
      continue;
    }
    fail(`Unknown argument "${arg}".`);
  }
  if (dir === undefined) fail('--dir needs a folder.');
  return { dir, write, json };
}

function repositoryRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      fs.lstatSync(path.join(dir, '.git'));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return '';
      dir = parent;
    }
  }
}

function refuseWorkspace(root, fileSystem) {
  try {
    fileSystem.lstatSync(path.join(root, '.git'));
    fail('Refusing this folder because it contains .git.');
  } catch (error) {
    if (error instanceof AtlasError) throw error;
  }
  const repo = repositoryRoot();
  if (repo && path.resolve(root) === path.resolve(repo)) {
    fail('Refusing this folder because it is the repository root.');
  }
}

function resolveFolder(cwd, dir, fileSystem) {
  const lexical = path.resolve(cwd, dir);
  let listed;
  try {
    listed = fileSystem.lstatSync(lexical);
  } catch {
    fail('Could not read this folder.');
  }
  if (!listed.isDirectory() && !listed.isSymbolicLink()) fail('Could not read this folder.');
  let root;
  try {
    root = fileSystem.realpathSync(lexical);
  } catch {
    fail('Could not read this folder.');
  }
  let stat;
  try {
    stat = fileSystem.statSync(root);
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

function walk(root, dir, fileSystem, found) {
  let entries;
  try {
    entries = fileSystem.readdirSync(dir, { withFileTypes: true });
  } catch {
    fail('Could not read this folder.');
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.')) continue;
      walk(root, full, fileSystem, found);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const notePath = toNotePath(root, full);
    let bytes;
    try {
      bytes = fileSystem.readFileSync(full);
    } catch {
      fail(`Could not read "${notePath}".`);
    }
    found.push({ path: notePath, text: bytes.toString('utf8'), bytes });
  }
}

/** Read every markdown file under a folder. Hidden folders and links are skipped. */
export function scanDirectory(root, fileSystem = fs) {
  refuseWorkspace(root, fileSystem);
  const found = [];
  walk(root, root, fileSystem, found);
  found.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (process.platform === 'darwin') {
    const clashes = caseFoldClash(found.map(item => item.path));
    if (clashes.length) {
      fail(`Refusing this folder because these paths differ only by case: ${clashes.join('; ')}.`);
    }
  }
  return {
    root,
    notes: found.map(item => ({ path: item.path, text: item.text })),
    bytes: new Map(found.map(item => [item.path, item.bytes])),
  };
}

function isIndexPath(notePath) {
  return notePath === DEFAULT_INDEX_NAME || notePath.endsWith(`/${DEFAULT_INDEX_NAME}`);
}

function safeRelative(notePath) {
  if (typeof notePath !== 'string' || notePath.length === 0) return false;
  if (notePath.includes('\\') || notePath.startsWith('/')) return false;
  return notePath.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

function assertPlanPaths(result) {
  if (!result || !Array.isArray(result.writes) || !Array.isArray(result.removes)) {
    fail('The rebuild result is not usable.');
  }
  for (const item of result.writes) {
    if (!item || typeof item.path !== 'string' || typeof item.text !== 'string') fail('The rebuild result is not usable.');
    if (!safeRelative(item.path)) fail(`Refusing to touch "${item.path}" because it is outside the folder.`);
    if (!isIndexPath(item.path) && item.path !== DEFAULT_ROOT_MAP_NAME) {
      fail(`Refusing to write "${item.path}" because it is not an index or the map.`);
    }
  }
  for (const notePath of result.removes) {
    if (typeof notePath !== 'string' || !safeRelative(notePath) || !isIndexPath(notePath)) {
      fail(`Refusing to remove "${notePath}" because it is not an index.`);
    }
  }
}

function locate(root, notePath, fileSystem) {
  if (notePath.includes('\\') || notePath.startsWith('/') || notePath.split('/').some(part => part === '' || part === '.' || part === '..')) {
    fail(`Refusing to touch "${notePath}" because it is outside the folder.`);
  }
  const target = path.resolve(root, ...notePath.split('/'));
  const back = path.relative(root, target);
  if (!back && notePath !== DEFAULT_ROOT_MAP_NAME && notePath !== DEFAULT_INDEX_NAME) {
    fail(`Refusing to touch "${notePath}" because it is outside the folder.`);
  }
  if (back.startsWith('..') || path.isAbsolute(back)) {
    fail(`Refusing to touch "${notePath}" because it is outside the folder.`);
  }
  const parent = path.dirname(target);
  let parentReal;
  try {
    parentReal = fileSystem.realpathSync(parent);
  } catch {
    fail(`Could not update "${notePath}".`);
  }
  const parentBack = path.relative(path.resolve(root), parentReal);
  if (parentBack.startsWith('..') || path.isAbsolute(parentBack)) {
    fail(`Refusing to touch "${notePath}" because it is outside the folder.`);
  }
  return target;
}

function inspect(fileSystem, target) {
  let stat;
  try {
    stat = fileSystem.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { missing: true };
    return { error: true };
  }
  if (!stat.isFile()) return { blocked: true };
  try {
    return { bytes: fileSystem.readFileSync(target), mode: stat.mode & 0o777 };
  } catch {
    return { error: true };
  }
}

function unchangedSinceScan(previous, seen) {
  if (seen.error || seen.blocked) return false;
  if (previous === undefined) return seen.missing === true;
  if (seen.missing || !seen.bytes) return false;
  return previous.equals(seen.bytes);
}

const NEW_FILE_MODE = 0o600;

function writeAtomic(fileSystem, target, text, mode) {
  const tmp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const fd = fileSystem.openSync(tmp, 'wx', mode);
  try {
    fileSystem.writeFileSync(fd, text);
    // open() still applies the process umask, so set the mode again.
    fileSystem.fchmodSync(fd, mode);
    fileSystem.fsyncSync(fd);
  } catch (error) {
    try { fileSystem.closeSync(fd); } catch { /* closing a failed write */ }
    try { fileSystem.unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    throw error;
  }
  try {
    fileSystem.closeSync(fd);
  } catch (error) {
    try { fileSystem.unlinkSync(tmp); } catch { /* the temp file may not exist */ }
    throw error;
  }
  return tmp;
}

const LEFT_ALONE = 'This file changed after the scan, so it was left as it is.';
const NOT_REMOVED = 'This file changed after the scan, so it was not removed.';
const HEADER_GONE = 'This file no longer starts with the generated header, so it was not removed.';

function utf8RoundTrip(bytes) {
  return Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes);
}

// The library reads text. A map whose prefix is not valid UTF-8 would otherwise
// be written back with U+FFFD in place of those bytes. Keep the original prefix.
function mapBytes(item, previous) {
  if (item.path !== DEFAULT_ROOT_MAP_NAME || !previous || utf8RoundTrip(previous)) return item.text;
  const markerAt = item.text.indexOf(MAP_MARKER);
  if (markerAt < 0) return null;
  const generated = Buffer.from(item.text.slice(markerAt), 'utf8');
  const marker = Buffer.from(MAP_MARKER, 'utf8');
  const at = previous.indexOf(marker);
  if (at >= 0) return Buffer.concat([previous.subarray(0, at), generated]);
  if (previous.length === 0 || previous[previous.length - 1] === 0x0a) return Buffer.concat([previous, generated]);
  return Buffer.concat([previous, Buffer.from('\n'), generated]);
}

function writeOne(root, scanned, item, fileSystem) {
  const target = locate(root, item.path, fileSystem);
  const previous = scanned.bytes.get(item.path);
  const seen = inspect(fileSystem, target);
  if (!unchangedSinceScan(previous, seen)) {
    return { conflict: { path: item.path, detail: LEFT_ALONE } };
  }
  const body = mapBytes(item, previous);
  if (body === null) return { conflict: { path: item.path, detail: LEFT_ALONE } };
  let tmp;
  try {
    tmp = writeAtomic(fileSystem, target, body, seen.mode ?? NEW_FILE_MODE);
  } catch {
    fail(`Could not write "${item.path}".`);
  }
  if (!unchangedSinceScan(previous, inspect(fileSystem, target))) {
    try { fileSystem.unlinkSync(tmp); } catch { /* already gone */ }
    return { conflict: { path: item.path, detail: LEFT_ALONE } };
  }
  try {
    fileSystem.renameSync(tmp, target);
  } catch {
    try { fileSystem.unlinkSync(tmp); } catch { /* already gone */ }
    fail(`Could not write "${item.path}".`);
  }
  return {};
}

function removeOne(root, scanned, notePath, fileSystem) {
  const target = locate(root, notePath, fileSystem);
  const previous = scanned.bytes.get(notePath);
  const seen = inspect(fileSystem, target);
  if (!previous || !unchangedSinceScan(previous, seen)) {
    return { conflict: { path: notePath, detail: NOT_REMOVED } };
  }
  if (!isGeneratedIndex(seen.bytes.toString('utf8'))) {
    return { conflict: { path: notePath, detail: HEADER_GONE } };
  }
  try {
    fileSystem.unlinkSync(target);
  } catch {
    fail(`Could not remove "${notePath}".`);
  }
  return {};
}

function compareDetail(a, b) {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0;
}

function compareHealth(a, b) {
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : compareDetail(a, b);
}

function finish(result, extra, droppedWrites, droppedRemoves) {
  const skipWrite = new Set(droppedWrites);
  const skipRemove = new Set(droppedRemoves);
  const writes = result.writes.filter(item => !skipWrite.has(item.path));
  const removes = result.removes.filter(notePath => !skipRemove.has(notePath));
  const conflicts = [...result.conflicts, ...extra].sort(compareDetail);
  const health = result.health.filter(item => item.kind !== 'conflict');
  for (const conflict of conflicts) health.push({ kind: 'conflict', path: conflict.path, detail: conflict.detail });
  health.sort(compareHealth);
  const conflictCount = health.filter(item => item.kind === 'conflict').length;
  const counts = {
    ...result.counts,
    indexesWritten: writes.filter(item => isIndexPath(item.path)).length,
    indexesRemoved: removes.length,
    mapWritten: writes.some(item => item.path === DEFAULT_ROOT_MAP_NAME) ? 1 : 0,
    conflict: conflictCount,
  };
  return { writes, removes, unchanged: result.unchanged, conflicts, health, counts };
}

function plannedCaseConflicts(existingPaths, plannedPaths) {
  const conflicts = [];
  for (const planned of plannedPaths) {
    const key = planned.toLowerCase();
    const others = existingPaths.filter(path => path !== planned && path.toLowerCase() === key).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (!others.length) continue;
    conflicts.push({
      path: planned,
      detail: `This name differs only by case from ${others.join(' and ')}, so nothing was written.`,
    });
  }
  return conflicts;
}

/** Apply writes and removes. A file that changed since the scan is left in place. */
export function applyPlan(root, scanned, result, fileSystem = fs, options = {}) {
  refuseWorkspace(root, fileSystem);
  assertPlanPaths(result);
  const caseFold = options.caseFold ?? process.platform === 'darwin';
  if (caseFold) {
    const conflicts = plannedCaseConflicts(
      [...scanned.bytes.keys()],
      [...result.writes.map(item => item.path), ...result.removes],
    );
    if (conflicts.length) {
      return finish(result, conflicts, result.writes.map(item => item.path), result.removes);
    }
  }
  const extra = [];
  const droppedWrites = [];
  const droppedRemoves = [];
  for (const item of result.writes) {
    const outcome = writeOne(root, scanned, item, fileSystem);
    if (outcome.conflict) {
      extra.push(outcome.conflict);
      droppedWrites.push(item.path);
    }
  }
  for (const notePath of result.removes) {
    const outcome = removeOne(root, scanned, notePath, fileSystem);
    if (outcome.conflict) {
      extra.push(outcome.conflict);
      droppedRemoves.push(notePath);
    }
  }
  return finish(result, extra, droppedWrites, droppedRemoves);
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The short summary the command prints when --json is not set. */
export function formatSummary(result) {
  const counts = result.counts;
  const lines = [
    `${plural(counts.notes, 'note', 'notes')}, ${plural(counts.folders, 'folder', 'folders')}.`,
    `Writes ${result.writes.length}, removes ${result.removes.length}, unchanged ${result.unchanged.length}, conflicts ${result.conflicts.length}.`,
    `Health: ${plural(counts['broken-link'], 'broken link', 'broken links')}, ${plural(counts.orphan, 'orphan', 'orphans')}, ${plural(counts.duplicate, 'duplicate', 'duplicates')}, ${counts['too-long']} too long, ${plural(counts.conflict, 'conflict', 'conflicts')}.`,
  ];
  if (result.writes.length) lines.push(`Write: ${result.writes.map(item => item.path).join(', ')}`);
  if (result.removes.length) lines.push(`Remove: ${result.removes.join(', ')}`);
  if (result.conflicts.length) lines.push(`Conflict: ${result.conflicts.map(item => item.path).join(', ')}`);
  return `${lines.join('\n')}\n`;
}

export function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const fileSystem = io.fs ?? fs;
  const cwd = io.cwd ?? process.cwd();
  try {
    const args = parseArgs(argv);
    const root = resolveFolder(cwd, args.dir, fileSystem);
    const scanned = scanDirectory(root, fileSystem);
    const result = buildAtlas(scanned.notes);
    const finalResult = args.write ? applyPlan(root, scanned, result, fileSystem) : result;
    emit(stdout, args.json ? `${JSON.stringify(finalResult, null, 2)}\n` : formatSummary(finalResult));
    return 0;
  } catch (error) {
    if (error instanceof AtlasError) {
      emit(stderr, `${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = run(process.argv.slice(2));
