// Reading and writing media files. Symlinks are refused so a swapped link
// cannot point the copy at another file, or the save at another folder.

import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const NOFOLLOW_READ = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

const MARKERS = [
  Buffer.from('trainedAlgorithmicMedia', 'utf8'),
  Buffer.from('compositeWithTrainedAlgorithmicMedia', 'utf8'),
  Buffer.from('trainedAlgorithmicMedia', 'utf16le'),
  Buffer.from('compositeWithTrainedAlgorithmicMedia', 'utf16le'),
];

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

export function sniffType(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return null;
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6) {
    const head = bytes.toString('ascii', 0, 6);
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'video/webm';
  }
  return null;
}

export function extensionFor(type) {
  return EXTENSIONS[type] ?? null;
}

/** IPTC trained-algorithmic markers, as C2PA and XMP store them. */
export function hasAiProvenance(bytes) {
  return MARKERS.some((marker) => bytes.includes(marker));
}

export function mediaDirKind(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return 'absent';
    return 'other';
  }
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

/**
 * Read a regular file up to `maxBytes`. A larger file is reported from its
 * size and is not read. A symlink is not followed.
 */
export function readRegularFile(filePath, maxBytes) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    return { ok: false, code: 'unreadable' };
  }
  if (stat.isSymbolicLink()) return { ok: false, code: 'link' };
  if (!stat.isFile()) return { ok: false, code: 'unreadable' };
  if (stat.size > maxBytes) return { ok: false, code: 'size' };
  let fd;
  try {
    fd = openSync(filePath, NOFOLLOW_READ);
  } catch (error) {
    if (error.code === 'ELOOP') return { ok: false, code: 'link' };
    return { ok: false, code: 'unreadable' };
  }
  try {
    const again = fstatSync(fd);
    if (!again.isFile()) return { ok: false, code: 'unreadable' };
    if (again.size > maxBytes) return { ok: false, code: 'size' };
    const bytes = Buffer.alloc(again.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read <= 0) return { ok: false, code: 'unreadable' };
      offset += read;
    }
    return { ok: true, bytes };
  } catch {
    return { ok: false, code: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

/** A new name in `dir`. The caller's filename is never used. */
export function writeNewFile(dir, extension, bytes) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = `${randomBytes(16).toString('hex')}.${extension}`;
    const filePath = join(dir, name);
    let fd;
    try {
      fd = openSync(filePath, CREATE, 0o644);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      return null;
    }
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
      return { name, filePath };
    } catch {
      try { closeSync(fd); } catch { /* already closing */ }
      try { unlinkSync(filePath); } catch { /* nothing to remove */ }
      return null;
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
  return null;
}

export function writeReceipt(filePath, receipt) {
  const receiptPath = `${filePath}.receipt.json`;
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  const fd = openSync(receiptPath, CREATE, 0o644);
  try {
    writeAll(fd, Buffer.from(text));
    fsyncSync(fd);
  } catch (error) {
    try { closeSync(fd); } catch { /* already closing */ }
    try { unlinkSync(receiptPath); } catch { /* nothing to remove */ }
    throw error;
  }
  closeSync(fd);
  return receiptPath;
}

export function removeFile(filePath) {
  try {
    unlinkSync(filePath);
  } catch {
    /* the save already failed; leaving the file is reported by the caller */
  }
}

function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isInteger(wrote) || wrote <= 0) {
      const error = new Error('incomplete write');
      error.code = 'EIO';
      throw error;
    }
    offset += wrote;
  }
}
