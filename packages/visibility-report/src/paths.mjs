import fs from 'node:fs';
import path from 'node:path';

function partsOf(value) {
  return value.split(path.sep).filter((part) => part !== '' && part !== '.');
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
      const target = fs.readlinkSync(next);
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
  const chain = new Set();
  if (path.isAbsolute(input)) return walk(rootOf(input), partsOf(input), chain);
  return walk(process.cwd(), partsOf(input), chain);
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
