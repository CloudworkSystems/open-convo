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

// A capability may allow up to 10 GiB. Reading that into one Buffer can kill
// the process, so anything over this is refused before it is allocated.
export const MAX_READ_BYTES = 64 * 1024 * 1024;
const CREATE = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;

const MARKER_TEXT = ['trainedAlgorithmicMedia', 'compositeWithTrainedAlgorithmicMedia'];
const MARKERS = MARKER_TEXT.flatMap((text) => [Buffer.from(text), utf16le(text), utf16be(text)]);
const MARKER_OVERLAP = Math.max(...MARKERS.map((marker) => marker.length)) - 1;
const CHUNK = 64 * 1024;

const AVIF_BRANDS = new Set(['avif', 'avis']);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'heif', 'mif1', 'msf1']);
const MP4_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'mp71', 'avc1', 'dash', 'MSNV', 'M4V ',
]);

const EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
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
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') return isoType(bytes);
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    const docType = ebmlDocType(bytes);
    if (docType === 'webm') return 'video/webm';
    if (docType === 'matroska') return 'video/x-matroska';
    return null;
  }
  return null;
}

// An ftyp box is shared by MP4, QuickTime, HEIC and AVIF. The brand says which.
function isoType(bytes) {
  const brands = isoBrands(bytes);
  if (!brands) return null;
  if (brands.some((brand) => AVIF_BRANDS.has(brand))) return 'image/avif';
  if (brands.some((brand) => HEIF_BRANDS.has(brand))) return 'image/heic';
  if (brands[0] === 'qt  ') return 'video/quicktime';
  if (brands.some((brand) => MP4_BRANDS.has(brand))) return 'video/mp4';
  if (brands.includes('qt  ')) return 'video/quicktime';
  return null;
}

function isoBrands(bytes) {
  const boxSize = bytes.readUInt32BE(0);
  if (boxSize === 1) {
    if (bytes.length < 20) return null;
    return brandsFrom(bytes, 16, bytes.length);
  }
  const end = boxSize >= 16 ? Math.min(boxSize, bytes.length) : bytes.length;
  return brandsFrom(bytes, 8, end);
}

// Matroska and WebM share the EBML signature. The DocType says which one.
function ebmlDocType(bytes) {
  const headerSize = readVint(bytes, 4);
  if (!headerSize) return null;
  const headerEnd = Math.min(bytes.length, 4 + headerSize.width + headerSize.value);
  let at = 4 + headerSize.width;
  while (at + 2 <= headerEnd) {
    if (bytes[at] === 0x42 && bytes[at + 1] === 0x82) {
      const size = readVint(bytes, at + 2);
      if (!size || size.value > 32) return null;
      const start = at + 2 + size.width;
      const end = start + size.value;
      if (end > bytes.length) return null;
      return bytes.toString('ascii', start, end);
    }
    const id = readVint(bytes, at);
    if (!id) return null;
    const size = readVint(bytes, at + id.width);
    if (!size) return null;
    const next = at + id.width + size.width + size.value;
    if (next <= at || next > headerEnd) return null;
    at = next;
  }
  return null;
}

function readVint(bytes, offset) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let width = 1;
  let marker = 0x80;
  while (width <= 8 && (first & marker) === 0) {
    width += 1;
    marker >>= 1;
  }
  if (width > 8 || offset + width > bytes.length) return null;
  let value = first & (marker - 1);
  for (let i = 1; i < width; i += 1) value = value * 256 + bytes[offset + i];
  if (!Number.isSafeInteger(value)) return null;
  return { width, value };
}

function brandsFrom(bytes, majorAt, end) {
  if (majorAt + 4 > bytes.length) return null;
  const brands = [bytes.toString('latin1', majorAt, majorAt + 4)];
  for (let i = majorAt + 8; i + 4 <= end && i + 4 <= bytes.length; i += 4) {
    brands.push(bytes.toString('latin1', i, i + 4));
  }
  return brands;
}

export function extensionFor(type) {
  return EXTENSIONS[type] ?? null;
}

/** File types `sniffType` can name. A record may not promise any other. */
export function supportedFileTypes() {
  return Object.keys(EXTENSIONS);
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
 * Look at a regular file in small pieces, up to `maxBytes` and never more
 * than `MAX_READ_BYTES`. The whole file is not held in one Buffer. A larger
 * file is reported from its size and is not read. A symlink is not followed.
 */
export function scanFile(filePath, maxBytes) {
  const opened = openBounded(filePath, maxBytes);
  if (!opened.ok) return opened;
  const { fd, size } = opened;
  try {
    const chunk = Buffer.alloc(CHUNK);
    let header = Buffer.alloc(0);
    let overlap = Buffer.alloc(0);
    let provenance = false;
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, chunk, 0, Math.min(CHUNK, size - offset), offset);
      if (n <= 0) return { ok: false, code: 'unreadable' };
      const piece = chunk.subarray(0, n);
      if (header.length < 4096) {
        const take = Math.min(4096 - header.length, piece.length);
        header = Buffer.concat([header, piece.subarray(0, take)]);
      }
      if (!provenance) {
        const window = overlap.length === 0 ? piece : Buffer.concat([overlap, piece]);
        provenance = hasAiProvenance(window);
        const start = Math.max(0, window.length - MARKER_OVERLAP);
        overlap = Buffer.from(window.subarray(start));
      }
      offset += n;
    }
    return { ok: true, size, type: sniffType(header), provenance, filePath };
  } catch {
    return { ok: false, code: 'unreadable' };
  } finally {
    closeSync(fd);
  }
}

/** Copy `size` bytes from `src` into a new file. Reads one chunk at a time. */
export function streamCopy(src, dir, extension, size) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const name = `${randomBytes(16).toString('hex')}.${extension}`;
    const filePath = join(dir, name);
    let out;
    try {
      out = openSync(filePath, CREATE, 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') continue;
      return null;
    }
    const copied = streamFile(src, size, (piece) => writeAll(out, piece));
    try {
      if (!copied) {
        closeSync(out);
        unlinkSync(filePath);
        return null;
      }
      fsyncSync(out);
      closeSync(out);
      return { name, filePath };
    } catch {
      try { closeSync(out); } catch { /* already closing */ }
      try { unlinkSync(filePath); } catch { /* nothing to remove */ }
      return null;
    }
  }
  return null;
}

/**
 * Read `size` bytes from `src` and hand each chunk to `write` before the
 * next one is read. `write` must use the chunk before it returns.
 */
export function streamFile(src, size, write) {
  let fd;
  try {
    fd = openSync(src, NOFOLLOW_READ);
  } catch {
    return false;
  }
  try {
    const again = fstatSync(fd);
    if (!again.isFile() || again.size !== size || size > MAX_READ_BYTES) return false;
    const chunk = Buffer.alloc(CHUNK);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, chunk, 0, Math.min(CHUNK, size - offset), offset);
      if (n <= 0) return false;
      write(chunk.subarray(0, n));
      offset += n;
    }
    return true;
  } catch {
    return false;
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
      fd = openSync(filePath, CREATE, 0o600);
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
  const fd = openSync(receiptPath, CREATE, 0o600);
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

function openBounded(filePath, maxBytes) {
  const limit = Number.isInteger(maxBytes) && maxBytes >= 0 ? maxBytes : 0;
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch {
    return { ok: false, code: 'unreadable' };
  }
  if (stat.isSymbolicLink()) return { ok: false, code: 'link' };
  if (!stat.isFile()) return { ok: false, code: 'unreadable' };
  const over = overLimit(stat.size, limit);
  if (over) return over;
  let fd;
  try {
    fd = openSync(filePath, NOFOLLOW_READ);
  } catch (error) {
    if (error.code === 'ELOOP') return { ok: false, code: 'link' };
    return { ok: false, code: 'unreadable' };
  }
  try {
    const again = fstatSync(fd);
    if (!again.isFile()) {
      closeSync(fd);
      return { ok: false, code: 'unreadable' };
    }
    const grown = overLimit(again.size, limit);
    if (grown) {
      closeSync(fd);
      return grown;
    }
    return { ok: true, fd, size: again.size };
  } catch {
    try { closeSync(fd); } catch { /* already closing */ }
    return { ok: false, code: 'unreadable' };
  }
}

function overLimit(size, limit) {
  if (size > limit) return { ok: false, code: 'size' };
  if (size > MAX_READ_BYTES) return { ok: false, code: 'ceiling' };
  return null;
}

function utf16le(text) {
  return Buffer.from(text, 'utf16le');
}

function utf16be(text) {
  const le = utf16le(text);
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
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
