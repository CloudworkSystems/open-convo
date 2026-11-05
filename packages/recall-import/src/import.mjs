#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkSource, limits, sources as registeredSources, toNotes, validateSource } from './sources.mjs';
import { normalizeTime, optionObject, checkHashKey } from './validation.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const sourceDigest = text => digest(text.replace(/^imported: .*$/m, 'imported:'));
const dataMap = value => Object.assign(Object.create(null), value);
const ownValue = (record, key) => Object.hasOwn(record, key) ? record[key] : undefined;
const safeJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: 1, entries: {}, pending: {} }; } };
function shortTemp(file, kind) {
  const directory = fs.mkdtempSync(path.join(path.dirname(file), `.import-${kind}-tmp-`));
  return { directory, file: path.join(directory, 'data') };
}
function writeAtomic(file, text, mode = 0o600) {
  const temp = shortTemp(file, 'manifest');
  try { fs.writeFileSync(temp.file, text, { mode, flag: 'wx' }); fs.renameSync(temp.file, file); }
  finally { fs.rmSync(temp.file, { force: true }); fs.rmdirSync(temp.directory); }
}

function loadImportState(manifestFile, journalFile) {
  const manifest = safeJson(manifestFile);
  manifest.entries = dataMap(ownValue(manifest, 'entries'));
  manifest.pending = dataMap(ownValue(manifest, 'pending'));
  const recovering = fs.existsSync(journalFile);
  if (recovering) {
    const journal = fs.readFileSync(journalFile, 'utf8');
    // A partial final append cannot have been followed by a note rename.
    const complete = journal.slice(0, journal.lastIndexOf('\n') + 1);
    for (const line of complete.split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { throw new Error(`Could not read recovery journal "${journalFile}". Keep it and check the interrupted import.`); }
      if (typeof entry.key !== 'string' || !Object.hasOwn(entry, 'entry')) throw new Error(`Invalid recovery record in "${journalFile}".`);
      if (entry.entry === null) delete manifest.pending[entry.key];
      else manifest.pending[entry.key] = entry.entry;
    }
  }
  return { manifest, recovering };
}

function reconcilePending(manifest, atlas, sourceRoot, inspect, messages) {
  for (const [key, pending] of Object.entries(manifest.pending)) {
    const relative = typeof pending.path === 'string' ? path.relative(sourceRoot, path.resolve(atlas, pending.path)) : '..';
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Refusing pending path for "${key}" outside this source's folder.`);
    const destination = path.join(sourceRoot, relative);
    inspect(destination);
    const diskHash = fs.existsSync(destination) ? digest(fs.readFileSync(destination)) : null;
    const old = ownValue(manifest.entries, key);
    if (diskHash === pending.fullHash || !old) manifest.entries[key] = pending;
    if (diskHash !== null && diskHash !== pending.fullHash && diskHash !== old?.fullHash) messages.push(`${pending.path}: kept, edited since the last import.`);
    delete manifest.pending[key];
  }
}

function parseArgs(argv) {
  const out = { write: false, json: false, source: 'recall' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!['--write', '--dry-run', '--json', '--in', '--atlas', '--source', '--imported-at'].includes(arg)) throw new Error(`${arg}: unknown flag; use --in, --atlas, --source, --imported-at, --write, --dry-run or --json.`);
    if (seen.has(arg)) throw new Error(`${arg}: repeated flag; supply it only once.`);
    seen.add(arg);
    if (['--write', '--dry-run', '--json'].includes(arg)) {
      if (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) throw new Error(`${arg}: expected a switch without a value.`);
      if (arg !== '--dry-run') out[arg.slice(2)] = true;
    } else {
      const value = argv[++i];
      if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Error(`${arg}: expected one nonempty value after the flag.`);
      out[arg.slice(2).replaceAll('-', '')] = value;
    }
  }
  if (seen.has('--write') && seen.has('--dry-run')) throw new Error('--dry-run: use either --dry-run or --write, not both.');
  if (!out.in) throw new Error('--in: expected an unzipped export-folder path.');
  if (!out.atlas) throw new Error('--atlas: expected an Atlas folder path.');
  checkPath(out.in, '--in'); checkPath(out.atlas, '--atlas');
  if (!/^[a-z][a-z0-9-]{0,63}$(?![\s\S])/.test(out.source)) throw new Error('--source: expected 1 to 64 lowercase letters, digits or hyphens, starting with a letter.');
  if (out.importedat !== undefined) out.importedat = normalizeTime(out.importedat, '--imported-at');
  return out;
}

function checkPath(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value) || value.split('/').includes('..') || value.split('/').some(part => Buffer.byteLength(part) > 255)) throw new Error(`${label}: expected a nonempty folder path, without controls, '..' segments or components over 255 UTF-8 bytes.`);
}

function checkCommandOptions(options) {
  optionObject(options, 'runImport', ['sources', 'hashKey', 'beforeRename', 'afterRename', 'afterReclaimLock']);
  for (const name of ['beforeRename', 'afterRename', 'afterReclaimLock']) if (options[name] !== undefined && typeof options[name] !== 'function') throw new Error(`${name}: expected a callback function.`);
  checkHashKey(options.hashKey);
  const list = options.sources === undefined ? registeredSources : options.sources;
  if (!Array.isArray(list) || !list.length) throw new Error('sources: expected a nonempty array of valid source objects.');
  const ids = new Set();
  for (const source of list) {
    try { validateSource(source); } catch (error) { throw new Error(`sources/--source: ${error.message}`); }
    if (ids.has(source.id)) throw new Error('sources: expected unique source ids.');
    ids.add(source.id);
  }
  return list;
}

function mkdirSafe(dir, root) {
  const absoluteRoot = path.resolve(root);
  const parts = path.resolve(dir).slice(absoluteRoot.length).split(path.sep).filter(Boolean);
  let current = absoluteRoot;
  if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
  if (fs.lstatSync(current).isSymbolicLink() || !fs.lstatSync(current).isDirectory()) throw new Error(`Refusing write through non-folder "${current}".`);
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing write through non-folder "${current}".`);
  }
  if (!fs.realpathSync(current).startsWith(fs.realpathSync(absoluteRoot) + path.sep) && current !== absoluteRoot) throw new Error(`Refusing destination outside "${absoluteRoot}".`);
}

function readExport(root, readNonMarkdown = false) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) {
    if (root.toLowerCase().endsWith('.zip')) throw new Error('Unzip the export first, then point --in at the folder.');
    throw new Error(`"${root}" is not a folder. Point --in at an unzipped readable folder.`);
  }
  const entries = [], skipped = [];
  let total = 0, count = 0;
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { skipped.push({ sourcePath: relative, reason: 'symbolic links are not read' }); continue; }
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) {
        const info = fs.lstatSync(full);
        if (info.isSymbolicLink()) { skipped.push({ sourcePath: relative, reason: 'symbolic links are not read' }); continue; }
        if (!info.isFile()) throw new Error(`File "${relative}" changed during the import. Try again.`);
        total += info.size;
        if (total > limits.totalBytes) throw new Error(`Refusing export larger than ${limits.totalBytes} bytes.`);
        const markdown = /\.md$/i.test(relative);
        if (markdown && ++count > limits.cards) throw new Error(`Refusing ${count} files. The card limit is ${limits.cards}.`);
        if (info.size > limits.cardBytes && (markdown || readNonMarkdown)) skipped.push({ sourcePath: relative, reason: `card is ${info.size} bytes; limit is ${limits.cardBytes}` });
        else entries.push({ path: relative, full, size: info.size, markdown });
      }
    }
  }
  walk(root);
  // No content is read until the complete count and byte total have passed.
  const files = entries.map(entry => {
    if (!entry.markdown && !readNonMarkdown) return { path: entry.path, text: '' };
    const fd = fs.openSync(entry.full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const current = fs.fstatSync(fd);
      if (!current.isFile() || current.size !== entry.size) throw new Error(`File "${entry.path}" changed during the import. Try again.`);
      const content = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < content.length) {
        const read = fs.readSync(fd, content, offset, content.length - offset, offset);
        if (!read) throw new Error(`File "${entry.path}" changed during the import. Try again.`);
        offset += read;
      }
      if (fs.fstatSync(fd).size !== entry.size) throw new Error(`File "${entry.path}" changed during the import. Try again.`);
      return { path: entry.path, text: content.toString('utf8') };
    } finally { fs.closeSync(fd); }
  });
  return { files, skipped };
}

function publishLock(lock, data) {
  const temp = shortTemp(lock, 'lock');
  try {
    fs.writeFileSync(temp.file, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    fs.linkSync(temp.file, lock);
  } finally { fs.rmSync(temp.file, { force: true }); fs.rmdirSync(temp.directory); }
}
function alive(info) { if (!info) return false; if (info.host !== os.hostname()) return true; if (!Number.isInteger(info.pid)) return false; try { process.kill(info.pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
function lockInfo(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function takeLock(lock, messages, options) {
  const reclaim = `${lock}.reclaim`;
  if (fs.existsSync(reclaim)) throw new Error(`Another command is recovering; try again in a moment. Reclaim lock: ${reclaim}. To remove it after checking its process is gone: node "${fileURLToPath(import.meta.url)}" unlock "${reclaim}"`);
  try { publishLock(lock, { pid: process.pid, host: os.hostname() }); return; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const stale = lockInfo(lock);
  if (alive(stale)) throw new Error('Another import is running for this source. Try again when it finishes.');
  try { publishLock(reclaim, { pid: process.pid, host: os.hostname() }); } catch (e) { if (e.code === 'EEXIST') throw new Error('Another command is recovering; try again in a moment.'); throw e; }
  try {
    options.afterReclaimLock?.();
    const again = lockInfo(lock);
    if (JSON.stringify(again) !== JSON.stringify(stale)) throw new Error('Another import is running for this source. Try again when it finishes.');
    fs.rmSync(lock);
    publishLock(lock, { pid: process.pid, host: os.hostname() });
    messages.push('An earlier import stopped without finishing; cleared its lock.');
  } finally { fs.rmSync(reclaim, { force: true }); }
}

export function runImport(argv, options = {}) {
  if (!Array.isArray(argv)) throw new Error('argv: expected an array of command-line flags and string values.');
  const sourceList = checkCommandOptions(options);
  if (argv[0] === 'unlock') {
    const reclaim = argv[1];
    checkPath(reclaim, 'unlock');
    if (argv.length !== 2 || !path.isAbsolute(reclaim) || !/\/sources\/[a-z][a-z0-9-]{0,63}\/\.import\.lock\.reclaim$/.test(reclaim)) throw new Error('unlock: expected the absolute sources/<id>/.import.lock.reclaim path printed by the command.');
    const info = lockInfo(reclaim);
    if (!info || info.host !== os.hostname() || !Number.isInteger(info.pid) || info.pid <= 0 || alive(info) || fs.lstatSync(reclaim).isSymbolicLink()) throw new Error(`Cannot unlock "${reclaim}": its process is running or cannot be confirmed gone.`);
    const before = fs.readFileSync(reclaim, 'utf8');
    if (before !== JSON.stringify(info)) throw new Error('Recovery lock changed. Try again.');
    fs.unlinkSync(reclaim);
    return { cards: 0, notes: 0, skipped: [], warnings: [], messages: [`Removed recovery lock "${reclaim}".`] };
  }
  const args = parseArgs(argv);
  const source = sourceList.find(item => item.id === args.source);
  if (!source) throw new Error(`--source: unknown source "${args.source}"; select a registered id: ${sourceList.map(item => item.id).join(', ')}.`);
  validateSource(source);
  const input = path.resolve(args.in), atlas = path.resolve(args.atlas);
  const overlaps = (parent, child) => { const relative = path.relative(parent, child); return !relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); };
  if (overlaps(input, atlas) || overlaps(atlas, input)) throw new Error('--atlas: expected a folder separate from --in, with neither folder inside the other.');
  for (const folder of [atlas, path.join(atlas, 'sources'), path.join(atlas, 'sources', source.id)]) {
    let stat;
    try { stat = fs.lstatSync(folder); } catch (error) { if (error.code === 'ENOENT') continue; throw new Error(`--atlas: expected accessible real folders; ${error.message}`); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`--atlas: refusing non-folder or symbolic link "${folder}"; expected real folders for the selected source.`);
  }
  let files, skipped;
  try { ({ files, skipped } = readExport(input, source.id !== 'recall')); } catch (e) { throw new Error(`--in: ${e.message}. Expected an unzipped readable export folder.`); }
  const result = checkSource(source, files);
  result.skipped.push(...skipped);
  const sourceRoot = path.join(atlas, 'sources', source.id), manifestFile = path.join(sourceRoot, '.import-manifest.json');
  const journalFile = path.join(sourceRoot, '.import-journal.jsonl');
  const messages = [];
  if (!result.items.length) {
    messages.push(source.emptyGuidance ?? 'This folder has no items for the selected source. Check that --in points to a readable folder in the format this source supports, then try again.');
    // A genuinely first empty run writes nothing. An existing import still
    // needs its lock, pending recovery, and removed-card reconciliation.
    if (!fs.existsSync(manifestFile) && !fs.existsSync(journalFile)) return { cards: 0, notes: 0, skipped: result.skipped, warnings: result.warnings, messages, paths: [], changes: [] };
  }
  const importedAt = args.importedat || new Date().toISOString();
  // Inspect the complete destination tree before creating any import files.
  const preview = toNotes(result.items, { source, importedAt });
  const inspect = target => {
    let current = atlas;
    for (const segment of ['', ...path.relative(atlas, target).split(path.sep).filter(Boolean)]) {
      if (segment) current = path.join(current, segment);
      let stat;
      try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (stat.isSymbolicLink()) throw new Error(`Refusing write through non-folder "${current}".`);
    }
  };
  for (const note of preview.notes) inspect(path.join(atlas, note.path));
  inspect(manifestFile);
  inspect(journalFile);
  inspect(path.join(sourceRoot, '.import.lock'));
  inspect(path.join(sourceRoot, '.import.lock.reclaim'));
  const changes = [];
  const report = converted => ({ cards: result.items.length, notes: converted.notes.length, skipped: result.skipped, warnings: [...result.warnings, ...converted.warnings], messages, paths: converted.notes.map(({ key, path: notePath }) => ({ key, path: notePath })), changes });
  const addChange = (key, notePath, action) => {
    changes.push({ key, path: notePath, action });
    const detail = action === 'removed' ? `no longer in ${source.name}; kept.` : action === 'kept' ? 'kept, edited since the last import.' : `${action}.`;
    messages.push(`${notePath}: ${detail}`);
  };
  const convert = manifest => {
    const converted = toNotes(result.items, { source, importedAt, manifest: Object.assign(dataMap(manifest.pending), manifest.entries), hashKey: options.hashKey });
    for (const note of converted.notes) inspect(path.join(atlas, note.path));
    const currentKeys = new Set(result.items.map(item => item.key));
    for (const [key, old] of Object.entries(manifest.entries)) if (!currentKeys.has(key)) addChange(key, old.path, 'removed');
    return converted;
  };
  const classify = (note, manifest) => {
    const destination = path.join(atlas, note.path), old = ownValue(manifest.entries, note.key), pending = ownValue(manifest.pending, note.key);
    const exists = fs.existsSync(destination), diskHash = exists ? digest(fs.readFileSync(destination)) : null;
    const owned = !exists || diskHash === old?.fullHash || diskHash === pending?.fullHash;
    const action = !owned ? 'kept' : old?.sourceHash === sourceDigest(note.text) && diskHash === old.fullHash ? 'unchanged' : exists ? 'updated' : 'created';
    return { destination, diskHash, action };
  };
  if (!args.write) {
    const { manifest } = loadImportState(manifestFile, journalFile);
    reconcilePending(manifest, atlas, sourceRoot, inspect, messages);
    const converted = convert(manifest);
    for (const note of converted.notes) addChange(note.key, note.path, classify(note, manifest).action);
    return report(converted);
  }
  mkdirSafe(sourceRoot, atlas);
  const lock = path.join(sourceRoot, '.import.lock');
  takeLock(lock, messages, options);
  let manifest, canCompact = false;
  const compact = () => {
    writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.rmSync(journalFile, { force: true });
  };
  const record = (key, entry) => fs.appendFileSync(journalFile, `${JSON.stringify({ key, entry })}\n`, { mode: 0o600 });
  try {
    const state = loadImportState(manifestFile, journalFile);
    manifest = state.manifest;
    const recovering = state.recovering;
    canCompact = true;
    reconcilePending(manifest, atlas, sourceRoot, inspect, messages);
    // Checkpoint a recovered journal once, then start a fresh append sequence.
    if (recovering || !fs.existsSync(manifestFile)) compact();
    const converted = convert(manifest);
    for (const note of converted.notes) {
      const { destination, diskHash, action } = classify(note, manifest);
      mkdirSafe(path.dirname(destination), atlas);
      if (action === 'kept' || action === 'unchanged') { addChange(note.key, note.path, action); continue; }
      manifest.pending[note.key] = { path: note.path, fullHash: digest(note.text), sourceHash: sourceDigest(note.text) };
      record(note.key, ownValue(manifest.pending, note.key));
      const temporary = shortTemp(destination, 'note'), temp = temporary.file;
      fs.writeFileSync(temp, note.text, { mode: 0o600, flag: 'wx' });
      options.beforeRename?.({ note, destination, temp });
      const latest = fs.existsSync(destination) ? digest(fs.readFileSync(destination)) : null;
      if (latest !== diskHash) { fs.rmSync(temp, { force: true }); fs.rmdirSync(temporary.directory); delete manifest.pending[note.key]; record(note.key, null); addChange(note.key, note.path, 'kept'); continue; }
      fs.renameSync(temp, destination);
      fs.rmdirSync(temporary.directory);
      options.afterRename?.({ note, destination });
      manifest.entries[note.key] = ownValue(manifest.pending, note.key); delete manifest.pending[note.key];
      addChange(note.key, note.path, action);
    }
    compact();
    return report(converted);
  } catch (error) {
    // Caught interruptions keep the legacy pending-manifest representation.
    // Abrupt exits leave the journal for the next lock owner to recover.
    if (canCompact) compact();
    throw error;
  } finally { fs.rmSync(lock, { force: true }); }
}

function print(report, json) {
  if (json) console.log(JSON.stringify(report));
  else {
    console.log(`Cards: ${report.cards}; notes: ${report.notes}; skipped: ${report.skipped.length}; warnings: ${report.warnings.length}`);
    for (const item of report.skipped) console.log(`Skipped ${item.sourcePath}: ${item.reason}`);
    for (const warning of report.warnings) console.log(`Warning: ${warning}`);
    for (const message of report.messages) console.log(message);
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { const args = process.argv.slice(2); print(runImport(args), args.includes('--json')); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
