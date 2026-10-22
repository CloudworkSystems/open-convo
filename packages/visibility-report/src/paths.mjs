import fs from 'node:fs';
import path from 'node:path';

function fullyResolve(input) {
  const absolute = path.resolve(input);
  let cursor = absolute;
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.push(path.basename(cursor));
    cursor = parent;
  }
  let base = cursor;
  try {
    base = fs.realpathSync(cursor);
  } catch {
    base = cursor;
  }
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
