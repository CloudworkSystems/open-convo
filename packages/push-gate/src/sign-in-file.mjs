// Reading the gate's 1Password sign-in from a file (docs/plans/push-gate.md,
// "Running": one of the two places the owner may choose at Build Order step
// 4). The gate refuses a sign-in file anyone else can read.

import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';

/**
 * Returns the file's contents, trimmed. Throws a plain Error, with no part
 * of the file in it, when the file is missing, is not a plain file, belongs
 * to another user, or can be read or written by anyone but its owner.
 */
export function readSignInFile(path, { uid = process.getuid?.() } = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("the sign-in file can't be opened");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error("the sign-in file isn't a plain file");
    if (uid !== undefined && info.uid !== uid) throw new Error('the sign-in file belongs to another user');
    if (info.mode & 0o077) throw new Error('the sign-in file can be read by others; only its owner may read it (chmod 600)');
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}
