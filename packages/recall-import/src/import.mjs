#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { checkSource, sources as registeredSources, toNotes, validateSource } from './sources.mjs';

const digest = text => createHash('sha256').update(text).digest('hex');
const sourceDigest = text => digest(text.replace(/^imported: .*$/m, 'imported:'));
const safeJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: 1, entries: {}, pending: {} }; } };
const writeAtomic = (file, text, mode = 0o600) => { const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`; fs.writeFileSync(temp, text, { mode }); fs.renameSync(temp, file); };

function parseArgs(argv) {
  const out = { write: false, json: false, source: 'recall' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--write' || arg === '--json') out[arg.slice(2)] = true;
    else if (['--in', '--atlas', '--source', '--imported-at'].includes(arg)) out[arg.slice(2).replaceAll('-', '')] = argv[++i];
    else throw new Error(`Unknown option "${arg}".`);
  }
  if (!out.in || !out.atlas) throw new Error('Use --in <export folder> and --atlas <atlas folder>.');
  return out;
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

function readExport(root) {
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory()) {
    if (root.toLowerCase().endsWith('.zip')) throw new Error('Unzip the export first, then point --in at the folder.');
    throw new Error(`"${root}" is not a folder. Point --in at an unzipped readable folder.`);
  }
  const files = [];
  function walk(dir, prefix = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { files.push({ path: relative, text: '', symlink: true }); continue; }
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) files.push({ path: relative, text: fs.readFileSync(full, 'utf8') });
    }
  }
  walk(root);
  return files;
}

function publishLock(lock, data) {
  const temp = `${lock}.new-${process.pid}-${Math.random().toString(16).slice(2)}`;
  fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  try { fs.linkSync(temp, lock); } finally { fs.rmSync(temp, { force: true }); }
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
  if (argv[0] === 'unlock') {
    const reclaim = argv[1];
    if (argv.length !== 2 || !path.isAbsolute(reclaim || '') || !reclaim.endsWith('/.import.lock.reclaim')) throw new Error('Use unlock with the absolute reclaim-lock path printed by the command.');
    const info = lockInfo(reclaim);
    if (!info || info.host !== os.hostname() || !Number.isInteger(info.pid) || info.pid <= 0 || alive(info) || fs.lstatSync(reclaim).isSymbolicLink()) throw new Error(`Cannot unlock "${reclaim}": its process is running or cannot be confirmed gone.`);
    const before = fs.readFileSync(reclaim, 'utf8');
    if (before !== JSON.stringify(info)) throw new Error('Recovery lock changed. Try again.');
    fs.unlinkSync(reclaim);
    return { cards: 0, notes: 0, skipped: [], warnings: [], messages: [`Removed recovery lock "${reclaim}".`] };
  }
  const args = parseArgs(argv), sourceList = options.sources || registeredSources;
  const source = sourceList.find(item => item.id === args.source);
  if (!source) throw new Error(`Unknown source "${args.source}".`);
  validateSource(source);
  const input = path.resolve(args.in), atlas = path.resolve(args.atlas);
  let files;
  try { files = readExport(input); } catch (e) { if (e.code === 'EACCES') throw new Error(`Could not read "${input}". Check that it was unzipped and is readable.`); throw e; }
  const symlinks = files.filter(f => f.symlink).map(f => ({ sourcePath: f.path, reason: 'symbolic links are not read' }));
  files = files.filter(f => !f.symlink);
  const result = checkSource(source, files);
  result.skipped.push(...symlinks);
  if (!result.items.length) return { cards: 0, notes: 0, skipped: result.skipped, warnings: result.warnings, messages: ["This folder has no Recall cards. In Recall's web app, open Settings, choose Export, unzip the download, then run this again on that folder."] };
  const importedAt = args.importedat || new Date().toISOString();
  const sourceRoot = path.join(atlas, 'sources', source.id), manifestFile = path.join(sourceRoot, '.import-manifest.json');
  const messages = [];
  if (!args.write) {
    const converted = toNotes(result.items, { source, importedAt });
    return { cards: result.items.length, notes: converted.notes.length, skipped: result.skipped, warnings: [...result.warnings, ...converted.warnings], messages };
  }
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
  inspect(path.join(sourceRoot, '.import.lock'));
  inspect(path.join(sourceRoot, '.import.lock.reclaim'));
  mkdirSafe(sourceRoot, atlas);
  const lock = path.join(sourceRoot, '.import.lock');
  takeLock(lock, messages, options);
  try {
    const manifest = safeJson(manifestFile); manifest.entries ||= {}; manifest.pending ||= {};
    const converted = toNotes(result.items, { source, importedAt, manifest: { ...manifest.pending, ...manifest.entries }, hashKey: options.hashKey });
    for (const note of converted.notes) inspect(path.join(atlas, note.path));
    const currentKeys = new Set(result.items.map(i => i.key));
    for (const [key, old] of Object.entries(manifest.entries)) if (!currentKeys.has(key)) messages.push(`${old.path}: no longer in ${source.name}; kept.`);
    for (const note of converted.notes) {
      const destination = path.join(atlas, note.path), old = manifest.entries[note.key], pending = manifest.pending[note.key];
      mkdirSafe(path.dirname(destination), atlas);
      const exists = fs.existsSync(destination), diskHash = exists ? digest(fs.readFileSync(destination)) : null;
      const owned = !exists || diskHash === old?.fullHash || diskHash === pending?.fullHash;
      if (!owned) { messages.push(`${note.path}: kept, edited since the last import.`); continue; }
      if (old?.sourceHash === sourceDigest(note.text) && diskHash === old.fullHash) { messages.push(`${note.path}: unchanged.`); continue; }
      manifest.pending[note.key] = { path: note.path, fullHash: digest(note.text), sourceHash: sourceDigest(note.text) };
      writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
      const temp = `${destination}.tmp-${process.pid}`;
      fs.writeFileSync(temp, note.text, { mode: 0o600 });
      options.beforeRename?.({ note, destination, temp });
      const latest = fs.existsSync(destination) ? digest(fs.readFileSync(destination)) : null;
      if (latest !== diskHash) { fs.rmSync(temp, { force: true }); delete manifest.pending[note.key]; messages.push(`${note.path}: kept, edited since the last import.`); continue; }
      fs.renameSync(temp, destination);
      options.afterRename?.({ note, destination });
      manifest.entries[note.key] = manifest.pending[note.key]; delete manifest.pending[note.key];
    }
    writeAtomic(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
    return { cards: result.items.length, notes: converted.notes.length, skipped: result.skipped, warnings: [...result.warnings, ...converted.warnings], messages };
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
