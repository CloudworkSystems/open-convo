import fs from 'node:fs';
import path from 'node:path';

/** A path Node can stat, including a symlink whose target is not there yet. */
function existsOrLink(cursor) {
  try {
    fs.lstatSync(cursor);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve one existing path. A symlink is followed even when its target
 * does not exist yet, so two names for one output still compare equal.
 */
function resolveNode(cursor) {
  const seen = new Set();
  let current = cursor;
  while (true) {
    if (seen.has(current)) return current;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current;
    }
    if (!stat.isSymbolicLink()) {
      try {
        return fs.realpathSync(current);
      } catch {
        return current;
      }
    }
    seen.add(current);
    const target = fs.readlinkSync(current);
    current = path.resolve(path.dirname(current), target);
  }
}

function fullyResolve(input) {
  const absolute = path.resolve(input);
  let cursor = absolute;
  const suffix = [];
  while (!existsOrLink(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.push(path.basename(cursor));
    cursor = parent;
  }
  const base = resolveNode(cursor);
  return suffix.length === 0 ? base : path.join(base, ...suffix.reverse());
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
