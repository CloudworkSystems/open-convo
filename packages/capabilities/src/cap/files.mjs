// Small file helpers. Ledger names are fixed, so a record cannot point the
// write at another path. Symlinks are refused: a swapped link must not
// redirect the spending record.

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  fsyncSync,
  unlinkSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

const NOFOLLOW_READ = constants.O_RDONLY | constants.O_NOFOLLOW;

export function fileKind(path) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    return 'other';
  }
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

export function readNoFollow(path, maxBytes) {
  const fd = openSync(path, NOFOLLOW_READ);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) {
      const error = new Error('unreadable');
      error.code = 'EUNREADABLE';
      throw error;
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

/** Write a new file and rename it into place. Refuses to follow a symlink. */
export function atomicWrite(path, text) {
  if (fileKind(path) === 'symlink' || fileKind(path) === 'directory' || fileKind(path) === 'other') return false;
  const tmp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closing */ }
    try { unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw error;
  }
  closeSync(fd);
  renameSync(tmp, path);
  return true;
}
