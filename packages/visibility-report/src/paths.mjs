import fs from 'node:fs';
import path from 'node:path';

/**
 * Path components after an absolute root. On Windows the root (`C:\`, a
 * UNC share, or a device path) is not a component, because the walk
 * already starts there.
 */
export function partsOf(value, pathApi = path) {
  let rest = value;
  if (pathApi.isAbsolute(value)) {
    const root = pathApi.parse(value).root;
    if (root && rest.startsWith(root)) rest = rest.slice(root.length);
  }
  const pieces = pathApi.sep === '\\' ? rest.split(/[\\/]/) : rest.split(pathApi.sep);
  return pieces.filter((part) => part !== '' && part !== '.');
}

/**
 * `C:out` is relative to that drive's current directory, not to one
 * component named `C:out`. Windows keeps a current directory per drive in
 * `=C:`; otherwise it uses the process directory, or that drive's root
 * when the process directory is on another drive. `..` stays in the text
 * so the walk can apply it after a symlink.
 */
export function expandDriveRelative(value, pathApi = path, cwd = () => process.cwd(), env = process.env) {
  if (pathApi.sep !== '\\' || typeof value !== 'string' || value.length < 2) return value;
  if (pathApi.isAbsolute(value)) return value;
  const device = value.slice(0, 2);
  if (!/^[A-Za-z]:$/.test(device)) return value;
  const third = value.charCodeAt(2);
  if (value.length > 2 && (third === 92 || third === 47)) return value;
  const perDrive = env[`=${device}`] || env[`=${device[0].toUpperCase()}:`] || env[`=${device[0].toLowerCase()}:`];
  let base = perDrive || cwd();
  const sameDrive = base.slice(0, 2).toLowerCase() === device.toLowerCase();
  if (!sameDrive && base.charCodeAt(2) === 92) base = `${device}\\`;
  const rest = value.slice(2);
  if (!rest) return base;
  if (base.endsWith('\\') || base.endsWith('/')) return base + rest;
  const sep = base.includes('\\') ? '\\' : (base.includes('/') ? '/' : '\\');
  return base + sep + rest;
}

/** Directory and components a path walks from, after drive-relative expansion. */
export function walkStart(input, pathApi = path, cwd = () => process.cwd(), env = process.env) {
  const expanded = expandDriveRelative(input, pathApi, cwd, env);
  if (pathApi.isAbsolute(expanded)) {
    return { dir: pathApi.parse(expanded).root, parts: partsOf(expanded, pathApi) };
  }
  return { dir: cwd(), parts: partsOf(expanded, pathApi) };
}

function rootOf(value) {
  return path.parse(value).root;
}

function isRoot(value) {
  return value === rootOf(value);
}

function joinPart(dir, part) {
  if (isRoot(dir)) return dir.endsWith(path.sep) ? dir + part : `${dir}${path.sep}${part}`;
  return `${dir}${path.sep}${part}`;
}

function lstatOrNull(value) {
  try {
    return fs.lstatSync(value);
  } catch {
    return null;
  }
}

/** Real path of an existing directory, plus any missing suffix left as written. */
function withMissingSuffix(dir, parts) {
  let base = dir;
  const stat = lstatOrNull(dir);
  if (stat && !stat.isSymbolicLink()) {
    try {
      base = fs.realpathSync(dir);
    } catch {
      base = dir;
    }
  }
  let result = base;
  for (const part of parts) result = joinPart(result, part);
  return result;
}

/**
 * Walk one component at a time. `..` is applied after any symlink in front
 * of it, which is how the file system writes through the path. A symlink
 * is remembered only while its target is being expanded, so the same link
 * may be followed again later in the path.
 */
function walk(dir, parts, chain) {
  let cursor = dir;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '..') {
      cursor = isRoot(cursor) ? cursor : path.dirname(cursor);
      continue;
    }
    const next = joinPart(cursor, part);
    const stat = lstatOrNull(next);
    if (!stat) return withMissingSuffix(cursor, parts.slice(index));
    if (!stat.isSymbolicLink()) {
      cursor = next;
      continue;
    }
    if (chain.has(next)) return withMissingSuffix(next, parts.slice(index + 1));
    chain.add(next);
    try {
      const target = expandDriveRelative(fs.readlinkSync(next));
      cursor = path.isAbsolute(target)
        ? walk(rootOf(target), partsOf(target), chain)
        : walk(path.dirname(next), partsOf(target), chain);
    } finally {
      chain.delete(next);
    }
  }
  const stat = lstatOrNull(cursor);
  if (stat && !stat.isSymbolicLink()) {
    try {
      return fs.realpathSync(cursor);
    } catch {
      return cursor;
    }
  }
  return cursor;
}

function fullyResolve(input) {
  const start = walkStart(input);
  return walk(start.dir, start.parts, new Set());
}

function sameInode(left, right) {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** True when two paths are one file, including links and letter case. */
export function sameFile(left, right) {
  const a = fullyResolve(left);
  const b = fullyResolve(right);
  if (a === b) return true;
  if (a.normalize('NFC').toLowerCase() === b.normalize('NFC').toLowerCase()) return true;
  return sameInode(left, right);
}
