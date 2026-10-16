import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

import { SiteEngineError } from "./errors.mjs";
import { checkImageLexicalPath } from "./schema.mjs";

const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Structural PNG chunks only. Text, time, EXIF, XMP and private chunks are
// dropped so a photo cannot carry GPS, a camera serial or an author name.
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "sRGB",
  "cICP",
  "sBIT",
  "bKGD",
  "pHYs",
  "sPLT",
  "hIST",
  "acTL",
  "fcTL",
  "fdAT",
]);

const WEBP_KEEP = new Set(["VP8X", "VP8 ", "VP8L", "ALPH", "ANIM", "ANMF"]);

const AVIF_MARKERS = [
  "Exif",
  "http://ns.adobe.com/xap",
  "GPSLatitude",
  "GPSLongitude",
  "<x:xmpmeta",
];

function fail(message) {
  throw new SiteEngineError(message);
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function isInside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export async function readImageFile(factsDir, file) {
  const lexical = checkImageLexicalPath(file);
  if (lexical) fail(lexical);

  let root;
  try {
    root = await realpath(factsDir);
  } catch {
    fail("Facts folder was not found.");
  }

  let current = root;
  for (const segment of file.split("/")) {
    current = path.join(current, segment);
    if (!isInside(root, current)) fail(`Image is outside the facts folder: ${file}`);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") fail(`Image file was not found: ${file}`);
      fail(`Image file was not found: ${file}`);
    }
    if (info.isSymbolicLink()) fail(`Image is a symbolic link: ${file}`);
  }

  const realFile = await realpath(current).catch(() => null);
  if (!realFile || !isInside(root, realFile)) {
    fail(`Image is outside the facts folder: ${file}`);
  }

  let handle;
  try {
    handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP" || error.code === "EPERM") {
      fail(`Image is a symbolic link: ${file}`);
    }
    fail(`Image file was not found: ${file}`);
  }

  try {
    const info = await handle.stat();
    if (!info.isFile()) fail(`Image is not a file: ${file}`);
    if (info.size === 0 || info.size > MAX_IMAGE_BYTES) {
      fail(info.size === 0 ? `Image format is not allowed: ${file}` : `Image file is too large: ${file}`);
    }
    const buf = Buffer.alloc(info.size);
    const { bytesRead } = await handle.read(buf, 0, info.size, 0);
    if (bytesRead !== info.size) fail(`Could not remove hidden details from image: ${file}`);
    return buf;
  } finally {
    await handle.close();
  }
}

function detect(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }
  if (isAvif(buf)) return "avif";
  return null;
}

function isAvif(buf) {
  if (buf.length < 16) return false;
  if (buf.toString("ascii", 4, 8) !== "ftyp") return false;
  const size = buf.readUInt32BE(0);
  if (size < 16 || size > buf.length) return false;
  const brand = buf.toString("ascii", 8, 12);
  if (brand === "avif" || brand === "avis") return true;
  for (let offset = 16; offset + 4 <= size; offset += 4) {
    const compatible = buf.toString("ascii", offset, offset + 4);
    if (compatible === "avif" || compatible === "avis") return true;
  }
  return false;
}

function stripJpeg(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) {
    throw new Error("not a jpeg");
  }
  const parts = [Buffer.from([0xff, 0xd8])];
  let offset = 2;
  let sawScan = false;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new Error("jpeg marker");
    while (offset < buf.length && buf[offset] === 0xff) offset += 1;
    if (offset >= buf.length) throw new Error("jpeg truncated");
    const marker = buf[offset];
    offset += 1;
    if (marker === 0xd9) {
      if (!sawScan) throw new Error("jpeg scan");
      parts.push(Buffer.from([0xff, 0xd9]));
      return Buffer.concat(parts);
    }
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Error("jpeg marker");
    }
    if (offset + 2 > buf.length) throw new Error("jpeg truncated");
    const length = buf.readUInt16BE(offset);
    if (length < 2 || offset + length > buf.length) throw new Error("jpeg truncated");
    const drop = shouldDropJpegSegment(marker);
    if (!drop) {
      parts.push(Buffer.from([0xff, marker]));
      parts.push(buf.subarray(offset, offset + length));
    }
    offset += length;
    if (marker === 0xda) {
      sawScan = true;
      const start = offset;
      offset = scanEntropyEnd(buf, offset);
      parts.push(buf.subarray(start, offset));
    }
  }
  throw new Error("jpeg truncated");
}

// APP0 (JFIF) and APP14 (Adobe color transform) stay. Every other APP
// segment is dropped, including ICC profiles: a profile can carry a
// description, a copyright line, a device name, or private fields.
function shouldDropJpegSegment(marker) {
  if (marker === 0xfe) return true;
  return marker >= 0xe1 && marker <= 0xef && marker !== 0xee;
}

// Entropy runs until the next real marker. That marker may be another scan,
// a table, or the end of the image; the caller decides which to keep.
function scanEntropyEnd(buf, offset) {
  let index = offset;
  while (index < buf.length) {
    if (buf[index] !== 0xff) {
      index += 1;
      continue;
    }
    let markerAt = index;
    while (markerAt < buf.length && buf[markerAt] === 0xff) markerAt += 1;
    if (markerAt >= buf.length) break;
    const marker = buf[markerAt];
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      index = markerAt + 1;
      continue;
    }
    return index;
  }
  throw new Error("jpeg truncated");
}

function stripPng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("not a png");
  const kept = [];
  let offset = 8;
  let sawIhdr = false;
  let sawIdat = false;
  let sawIend = false;
  while (offset < buf.length) {
    if (sawIend) break;
    if (offset + 8 > buf.length) throw new Error("png truncated");
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (!/^[A-Za-z]{4}$/.test(type) || length > MAX_IMAGE_BYTES || dataEnd + 4 > buf.length) {
      throw new Error("png chunk");
    }
    const stored = buf.readUInt32BE(dataEnd);
    const actual = crc32(Buffer.concat([Buffer.from(type), buf.subarray(dataStart, dataEnd)]));
    if (stored !== actual) throw new Error("png crc");
    if (!sawIhdr && type !== "IHDR") throw new Error("png ihdr");
    if (type === "IHDR") sawIhdr = true;
    if (type === "IDAT") sawIdat = true;
    if (PNG_KEEP.has(type)) kept.push(buf.subarray(offset, dataEnd + 4));
    if (type === "IEND") sawIend = true;
    offset = dataEnd + 4;
  }
  if (!sawIhdr || !sawIdat || !sawIend) throw new Error("png structure");
  return Buffer.concat([buf.subarray(0, 8), ...kept]);
}

function stripWebp(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error("not a webp");
  }
  const chunks = [];
  let offset = 12;
  let droppedMeta = false;
  let sawImage = false;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new Error("webp truncated");
    const tag = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (size > MAX_IMAGE_BYTES || dataEnd > buf.length) throw new Error("webp chunk");
    const data = Buffer.from(buf.subarray(dataStart, dataEnd));
    const pad = size % 2 === 1 ? 1 : 0;
    if (tag === "VP8 " || tag === "VP8L" || tag === "ANMF") sawImage = true;
    if (tag === "EXIF" || tag === "XMP " || tag === "ICCP") {
      droppedMeta = true;
    } else if (!WEBP_KEEP.has(tag)) {
      throw new Error("webp chunk");
    } else if (tag === "VP8X") {
      if (data.length < 10) throw new Error("webp vp8x");
      data[0] &= ~0x02;
      data[0] &= ~0x08;
      data[0] &= ~0x10;
      chunks.push(riffChunk(tag, data));
    } else {
      chunks.push(riffChunk(tag, data));
    }
    offset = dataEnd + pad;
  }
  if (!sawImage) throw new Error("webp image");
  if (offset !== buf.length) throw new Error("webp trailing");
  if (!droppedMeta) return Buffer.from(buf);
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

function riffChunk(tag, data) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

// Boxes whose bytes are image structure, not a place to store a name or a
// location. Anything else, including `free` and `skip`, is refused. A box on
// this list still has to match that box's layout, so a familiar name cannot
// carry an author string or a color profile.
const AVIF_SAFE = new Set([
  "ftyp",
  "meta",
  "mdat",
  "idat",
  "hdlr",
  "pitm",
  "iloc",
  "iinf",
  "infe",
  "iref",
  "iprp",
  "ipco",
  "ipma",
  "dinf",
  "dref",
  "url ",
  "urn ",
  "ispe",
  "pixi",
  "av1C",
  "clap",
  "irot",
  "imir",
  "pasp",
  "lsel",
  "a1op",
  "a1lx",
  "auxC",
  "colr",
]);

const AVIF_BRANDS = new Set(["avif", "avis", "mif1", "miaf", "MA1A", "MA1B"]);
const AVIF_REFERENCE = new Set(["dimg", "thmb", "auxl", "cdsc"]);
const AVIF_ALPHA_AUX = Buffer.from("urn:mpeg:mpegB:cicp:systems:auxiliary:alpha\0", "ascii");

function stripAvif(buf, file) {
  const boxes = [];
  walkAvif(buf, 0, buf.length, (type, payload, fileOffset) => {
    boxes.push({ type, payload, fileOffset });
  });
  for (const box of boxes) {
    const known = AVIF_SAFE.has(box.type) || AVIF_REFERENCE.has(box.type);
    if (!known || !avifBoxIsSafe(box)) {
      fail(`Could not remove hidden details from image: ${file}`);
    }
  }
  if (!avifMediaIsVerified(buf, boxes)) {
    fail(`Could not remove hidden details from image: ${file}`);
  }
  const text = buf.toString("latin1");
  for (const marker of AVIF_MARKERS) {
    if (text.includes(marker)) fail(`Could not remove hidden details from image: ${file}`);
  }
  return Buffer.from(buf);
}

// Every byte of mdat/idat must belong to an item extent, and those bytes
// must be AV1 open bitstream units. Unreferenced bytes, plain text, metadata
// OBUs and padding are refused: this builder does not re-encode AV1.
function avifMediaIsVerified(buf, boxes) {
  const media = boxes
    .filter((box) => box.type === "mdat" || box.type === "idat")
    .map((box) => ({ type: box.type, start: box.fileOffset, end: box.fileOffset + box.payload.length }));
  if (media.length === 0) return false;
  const extents = [];
  for (const box of boxes) {
    if (box.type !== "iloc") continue;
    const parsed = avifIlocExtents(box.payload);
    if (!parsed) return false;
    extents.push(...parsed);
  }
  if (extents.length === 0) return false;
  const covered = [];
  for (const extent of extents) {
    if (extent.dataReferenceIndex !== 0 || extent.length <= 0) return false;
    let start = null;
    if (extent.construction === 0) start = extent.offset;
    else if (extent.construction === 1) {
      const idat = media.filter((span) => span.type === "idat");
      if (idat.length !== 1) return false;
      start = idat[0].start + extent.offset;
    }
    if (start === null || !Number.isSafeInteger(start) || start < 0) return false;
    const end = start + extent.length;
    if (!media.some((span) => start >= span.start && end <= span.end)) return false;
    covered.push({ start, end });
  }
  for (const span of media) {
    let cursor = span.start;
    const pieces = covered
      .filter((item) => item.end > span.start && item.start < span.end)
      .map((item) => ({
        start: Math.max(item.start, span.start),
        end: Math.min(item.end, span.end),
      }))
      .sort((left, right) => left.start - right.start);
    for (const piece of pieces) {
      if (piece.start > cursor) return false;
      cursor = Math.max(cursor, piece.end);
    }
    if (cursor !== span.end) return false;
  }
  let sawSequence = false;
  for (const extent of covered) {
    const bytes = buf.subarray(extent.start, extent.end);
    const coded = avifExtentIsCoded(bytes);
    if (!coded) return false;
    if (coded.sequence) sawSequence = true;
  }
  return sawSequence;
}

function avifBoxIsSafe(box) {
  const { type, payload } = box;
  if (type === "ftyp") return avifFtypIsClean(payload);
  if (type === "mdat" || type === "idat") return true;
  if (type === "meta") return avifFullBoxHeader(payload, 0) && payload.length >= 4;
  if (type === "iref") {
    return (avifFullBoxHeader(payload, 0) || avifFullBoxHeader(payload, 1)) && payload.length >= 4;
  }
  if (type === "hdlr") return avifHdlrIsClean(payload);
  if (type === "pitm") return avifPitmIsClean(payload);
  if (type === "iloc") return avifIlocIsClean(payload);
  if (type === "iinf") return avifIinfIsClean(payload);
  if (type === "infe") return avifItemIsImage(payload);
  if (type === "iprp" || type === "ipco" || type === "dinf") return true;
  if (type === "ipma") return avifIpmaIsClean(payload);
  if (type === "dref") return avifFullBoxHeader(payload, 0) && payload.length >= 8;
  if (type === "url " || type === "urn ") return payload.equals(Buffer.from([0, 0, 0, 1]));
  if (type === "ispe") return avifFixedProperty(payload, 12);
  if (type === "pixi") return avifPixiIsClean(payload);
  if (type === "av1C") return avifAv1cIsClean(payload);
  if (type === "colr") return avifColrIsClean(payload);
  if (type === "clap") return avifClapIsClean(payload);
  if (type === "irot") return avifAngleIsClean(payload, 0xfc);
  if (type === "imir") return avifAngleIsClean(payload, 0xfe);
  if (type === "pasp") return avifPaspIsClean(payload);
  if (type === "lsel") return avifFixedProperty(payload, 6);
  if (type === "a1op") return avifFixedProperty(payload, 5);
  if (type === "a1lx") return avifA1lxIsClean(payload);
  if (type === "auxC") return avifAuxcIsClean(payload);
  if (AVIF_REFERENCE.has(type)) return avifReferenceIsClean(payload);
  return false;
}

function avifFullBoxHeader(payload, version) {
  return payload.length >= 4 && payload[0] === version && payload[1] === 0 && payload[2] === 0 && payload[3] === 0;
}

function avifFtypIsClean(payload) {
  if (payload.length < 8 || payload.length % 4 !== 0) return false;
  for (let offset = 0; offset < payload.length; offset += 4) {
    if (offset === 4) continue;
    if (!AVIF_BRANDS.has(payload.toString("ascii", offset, offset + 4))) return false;
  }
  return true;
}

function avifHdlrIsClean(payload) {
  if (!avifFullBoxHeader(payload, 0) || payload.length < 24) return false;
  if (payload.readUInt32BE(4) !== 0) return false;
  if (payload.toString("ascii", 8, 12) !== "pict") return false;
  return payload.subarray(12).every((byte) => byte === 0);
}

function avifPitmIsClean(payload) {
  if (avifFullBoxHeader(payload, 0) && payload.length === 6) return true;
  return avifFullBoxHeader(payload, 1) && payload.length === 8;
}

function avifIinfIsClean(payload) {
  if (avifFullBoxHeader(payload, 0)) return payload.length >= 6;
  if (avifFullBoxHeader(payload, 1)) return payload.length >= 8;
  return false;
}

function avifFixedProperty(payload, length) {
  return avifFullBoxHeader(payload, 0) && payload.length === length;
}

function avifPixiIsClean(payload) {
  if (!avifFullBoxHeader(payload, 0) || payload.length < 5) return false;
  const channels = payload[4];
  if (channels < 1 || channels > 8 || payload.length !== 5 + channels) return false;
  for (let index = 0; index < channels; index += 1) {
    const bits = payload[5 + index];
    if (bits < 1 || bits > 32) return false;
  }
  return true;
}

function avifColrIsClean(payload) {
  if (payload.toString("ascii", 0, 4) !== "nclx" || payload.length !== 11) return false;
  return (payload[10] & 0x7f) === 0;
}

function avifClapIsClean(payload) {
  if (payload.length !== 32) return false;
  for (const offset of [4, 12, 20, 28]) {
    if (payload.readUInt32BE(offset) === 0) return false;
  }
  return true;
}

function avifAngleIsClean(payload, reservedMask) {
  return avifFixedProperty(payload, 5) && (payload[4] & reservedMask) === 0;
}

function avifPaspIsClean(payload) {
  return payload.length === 8 && payload.readUInt32BE(0) !== 0 && payload.readUInt32BE(4) !== 0;
}

function avifA1lxIsClean(payload) {
  if (!avifFullBoxHeader(payload, 0) || payload.length < 5) return false;
  if ((payload[4] & 0xfe) !== 0) return false;
  const large = (payload[4] & 0x01) === 1;
  return payload.length === (large ? 17 : 11);
}

function avifAuxcIsClean(payload) {
  if (!avifFullBoxHeader(payload, 0) || payload.length !== 4 + AVIF_ALPHA_AUX.length) return false;
  return payload.subarray(4).equals(AVIF_ALPHA_AUX);
}

function avifReferenceIsClean(payload) {
  if (payload.length >= 4 && payload.length % 2 === 0) {
    const count = payload.readUInt16BE(2);
    if (count <= 64 && payload.length === 4 + 2 * count) return true;
  }
  if (payload.length >= 8 && payload.length % 4 === 0) {
    const count = payload.readUInt32BE(4);
    if (count <= 64 && payload.length === 8 + 4 * count) return true;
  }
  return false;
}

function avifIpmaIsClean(payload) {
  if (payload.length < 8 || payload[1] !== 0 || payload[2] !== 0) return false;
  const version = payload[0];
  const flags = payload[3];
  if (version > 1 || flags > 1) return false;
  const entryCount = payload.readUInt32BE(4);
  if (entryCount > 1024) return false;
  let cursor = 8;
  const idBytes = version === 0 ? 2 : 4;
  const assocBytes = flags === 1 ? 2 : 1;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + idBytes + 1 > payload.length) return false;
    cursor += idBytes;
    const associationCount = payload[cursor];
    cursor += 1;
    if (associationCount > 64) return false;
    const bytes = associationCount * assocBytes;
    if (cursor + bytes > payload.length) return false;
    cursor += bytes;
  }
  return cursor === payload.length;
}

function avifIlocIsClean(payload) {
  return Array.isArray(avifIlocExtents(payload));
}

function avifIlocExtents(payload) {
  if (!avifFullBoxHeader(payload, payload[0]) || payload[0] > 2 || payload.length < 8) return null;
  const version = payload[0];
  let cursor = 4;
  const offsetSize = payload[cursor] >> 4;
  const lengthSize = payload[cursor] & 0x0f;
  cursor += 1;
  const baseOffsetSize = payload[cursor] >> 4;
  const indexOrReserved = payload[cursor] & 0x0f;
  cursor += 1;
  if (![0, 4, 8].includes(offsetSize) || ![0, 4, 8].includes(lengthSize) || ![0, 4, 8].includes(baseOffsetSize)) {
    return null;
  }
  let indexSize = 0;
  if (version === 0) {
    if (indexOrReserved !== 0) return null;
  } else if (![0, 4, 8].includes(indexOrReserved)) {
    return null;
  } else {
    indexSize = indexOrReserved;
  }
  const countBytes = version < 2 ? 2 : 4;
  const idBytes = version < 2 ? 2 : 4;
  if (cursor + countBytes > payload.length) return null;
  const itemCount = readBe(payload, cursor, countBytes);
  cursor += countBytes;
  if (itemCount > 1024) return null;
  const extents = [];
  for (let index = 0; index < itemCount; index += 1) {
    if (cursor + idBytes > payload.length) return null;
    cursor += idBytes;
    let construction = 0;
    if (version === 1 || version === 2) {
      if (cursor + 2 > payload.length) return null;
      const word = payload.readUInt16BE(cursor);
      if ((word & 0xfff0) !== 0) return null;
      construction = word & 0x0f;
      cursor += 2;
    }
    if (cursor + 2 > payload.length) return null;
    const dataReferenceIndex = payload.readUInt16BE(cursor);
    cursor += 2;
    const base = readSized(payload, cursor, baseOffsetSize);
    if (!base) return null;
    cursor = base.cursor;
    if (cursor + 2 > payload.length) return null;
    const extentCount = payload.readUInt16BE(cursor);
    cursor += 2;
    if (extentCount > 1024) return null;
    for (let extentIndex = 0; extentIndex < extentCount; extentIndex += 1) {
      if (version >= 1 && indexSize > 0) {
        const extentIndexValue = readSized(payload, cursor, indexSize);
        if (!extentIndexValue) return null;
        cursor = extentIndexValue.cursor;
      }
      const extentOffset = readSized(payload, cursor, offsetSize);
      if (!extentOffset) return null;
      cursor = extentOffset.cursor;
      const extentLength = readSized(payload, cursor, lengthSize);
      if (!extentLength) return null;
      cursor = extentLength.cursor;
      const offset = base.value + extentOffset.value;
      if (!Number.isSafeInteger(offset)) return null;
      extents.push({
        construction,
        dataReferenceIndex,
        offset,
        length: extentLength.value,
      });
    }
  }
  if (cursor !== payload.length) return null;
  return extents;
}

function readSized(payload, cursor, size) {
  if (size === 0) return { value: 0, cursor };
  if (size !== 4 && size !== 8) return null;
  if (cursor + size > payload.length) return null;
  if (size === 4) return { value: payload.readUInt32BE(cursor), cursor: cursor + 4 };
  const big = payload.readBigUInt64BE(cursor);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return { value: Number(big), cursor: cursor + 8 };
}

function readBe(payload, offset, size) {
  if (size === 2) return payload.readUInt16BE(offset);
  return payload.readUInt32BE(offset);
}

function avifAv1cIsClean(payload) {
  if (payload.length < 4 || payload[0] !== 0x81) return false;
  if ((payload[3] & 0xe0) !== 0) return false;
  if ((payload[3] & 0x10) === 0 && (payload[3] & 0x0f) !== 0) return false;
  return walkAv1Obus(payload.subarray(4));
}

// Sequence-header and temporal-delimiter OBUs only. Metadata and padding
// OBUs can hold a name, and a payload that is not an OBU at all can too.
function walkAv1Obus(data) {
  let offset = 0;
  while (offset < data.length) {
    const header = data[offset];
    const type = (header >> 3) & 0x0f;
    const extension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    if ((header & 0x81) !== 0 || (type !== 1 && type !== 2) || !hasSize) return false;
    offset += 1;
    if (extension) {
      if (offset >= data.length) return false;
      offset += 1;
    }
    const decoded = readLeb128(data, offset);
    if (!decoded || decoded.value > data.length - decoded.offset) return false;
    offset = decoded.offset + decoded.value;
  }
  return true;
}

function readLeb128(buf, offset) {
  let value = 0;
  for (let shift = 0; shift <= 21; shift += 7) {
    if (offset >= buf.length) return null;
    const byte = buf[offset];
    offset += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, offset };
  }
  return null;
}

function avifExtentIsCoded(bytes) {
  let offset = 0;
  let sequence = false;
  if (bytes.length === 0) return null;
  while (offset < bytes.length) {
    const header = bytes[offset];
    const type = (header >> 3) & 0x0f;
    const extension = (header & 0x04) !== 0;
    const hasSize = (header & 0x02) !== 0;
    if ((header & 0x81) !== 0 || !hasSize || ![1, 2, 3, 4, 6, 7].includes(type)) return null;
    offset += 1;
    if (extension) {
      if (offset >= bytes.length) return null;
      offset += 1;
    }
    const decoded = readLeb128(bytes, offset);
    if (!decoded || decoded.value > bytes.length - decoded.offset) return null;
    const payload = bytes.subarray(decoded.offset, decoded.offset + decoded.value);
    if (hasIdentityRun(payload)) return null;
    if (type === 2 && payload.length !== 0) return null;
    if (type === 1) {
      if (!avifSequenceHeaderIsClean(payload)) return null;
      sequence = true;
    }
    offset = decoded.offset + decoded.value;
  }
  return { sequence };
}

function hasIdentityRun(buf) {
  let run = 0;
  for (const byte of buf) {
    const word = (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a);
    run = word ? run + 1 : 0;
    if (run >= 6) return true;
  }
  return false;
}

function avifSequenceHeaderIsClean(payload) {
  try {
    const bits = new BitCursor(payload);
    const profile = bits.u(3);
    if (profile > 2) return false;
    const still = bits.u(1);
    const reduced = bits.u(1);
    if (reduced && !still) return false;
    let decoderModel = false;
    let initialDelay = false;
    if (reduced) {
      bits.u(5);
    } else {
      const timing = bits.u(1);
      if (timing) {
        readTimingInfo(bits);
        decoderModel = bits.u(1) === 1;
        if (decoderModel) readDecoderModelInfo(bits);
      }
      initialDelay = bits.u(1) === 1;
      const points = bits.u(5);
      for (let index = 0; index <= points; index += 1) {
        bits.u(12);
        const level = bits.u(5);
        if (level > 7) bits.u(1);
        if (decoderModel) {
          const present = bits.u(1);
          if (present) readOperatingParameters(bits);
        }
        if (initialDelay && bits.u(1)) bits.u(4);
      }
    }
    const widthBits = bits.u(4) + 1;
    bits.u(widthBits);
    const heightBits = bits.u(4) + 1;
    bits.u(heightBits);
    let orderHint = false;
    if (!reduced && bits.u(1)) {
      bits.u(4);
      bits.u(3);
    }
    bits.u(1);
    bits.u(1);
    bits.u(1);
    if (!reduced) {
      bits.u(1);
      bits.u(1);
      bits.u(1);
      bits.u(1);
      orderHint = bits.u(1) === 1;
      if (orderHint) {
        bits.u(1);
        bits.u(1);
      }
      const chooseScreen = bits.u(1);
      const forceScreen = chooseScreen ? 2 : bits.u(1);
      if (forceScreen > 0) {
        const chooseInteger = bits.u(1);
        if (!chooseInteger) bits.u(1);
      }
      if (orderHint) bits.u(3);
    }
    bits.u(1);
    bits.u(1);
    bits.u(1);
    readColorConfig(bits, profile);
    if (bits.u(1)) return false;
    return bits.done();
  } catch {
    return false;
  }
}

function readTimingInfo(bits) {
  bits.u(32);
  if (bits.u(32) === 0) throw new Error("time scale");
  if (bits.u(1)) bits.uvlc();
}

function readDecoderModelInfo(bits) {
  bits.bufferDelayBits = bits.u(5) + 1;
  bits.u(32);
  bits.u(5);
  bits.u(5);
}

function readOperatingParameters(bits) {
  const width = bits.bufferDelayBits ?? 1;
  bits.u(width);
  bits.u(width);
  bits.u(1);
}

function readColorConfig(bits, profile) {
  const high = bits.u(1);
  let bitDepth = high ? 10 : 8;
  if (profile === 2 && high) bitDepth = bits.u(1) ? 12 : 10;
  const mono = profile === 1 ? 0 : bits.u(1);
  let primaries = 2;
  let transfer = 2;
  let matrix = 2;
  if (bits.u(1)) {
    primaries = bits.u(8);
    transfer = bits.u(8);
    matrix = bits.u(8);
  }
  if (mono) {
    bits.u(1);
    return;
  }
  const identity = primaries === 1 && transfer === 13 && matrix === 0;
  let subsampleX = 1;
  let subsampleY = 1;
  if (identity) {
    subsampleX = 0;
    subsampleY = 0;
  } else {
    bits.u(1);
    if (profile === 0) {
      subsampleX = 1;
      subsampleY = 1;
    } else if (profile === 1) {
      subsampleX = 0;
      subsampleY = 0;
    } else if (bitDepth === 12) {
      subsampleX = bits.u(1);
      subsampleY = subsampleX ? bits.u(1) : 0;
    } else {
      subsampleX = 1;
      subsampleY = 0;
    }
    if (subsampleX && subsampleY) bits.u(2);
  }
  bits.u(1);
}

class BitCursor {
  constructor(buf) {
    this.buf = buf;
    this.bit = 0;
    this.bufferDelayBits = 1;
  }

  u(n) {
    let value = 0;
    for (let index = 0; index < n; index += 1) {
      const byteIndex = this.bit >> 3;
      if (byteIndex >= this.buf.length) throw new Error("bits");
      const shift = 7 - (this.bit & 7);
      value = (value << 1) | ((this.buf[byteIndex] >> shift) & 1);
      this.bit += 1;
    }
    return value >>> 0;
  }

  uvlc() {
    let leading = 0;
    while (this.u(1) === 0) {
      leading += 1;
      if (leading > 31) throw new Error("uvlc");
    }
    if (leading === 0) return 0;
    return this.u(leading) + (1 << leading) - 1;
  }

  done() {
    const leftover = this.buf.length * 8 - this.bit;
    if (leftover < 0 || leftover >= 8) return false;
    if (leftover === 0) return true;
    const mask = (1 << leftover) - 1;
    return (this.buf[this.bit >> 3] & mask) === 0;
  }
}

function avifItemIsImage(payload) {
  if (payload.length < 4) return false;
  const version = payload[0];
  if (version < 2 || payload[1] !== 0 || payload[2] !== 0 || payload[3] !== 0) return false;
  let cursor = 4;
  const idSize = version === 2 ? 2 : 4;
  if (payload.length < cursor + idSize + 6) return false;
  cursor += idSize + 2;
  const itemType = payload.toString("ascii", cursor, cursor + 4);
  cursor += 4;
  if (!["av01", "grid", "iden"].includes(itemType)) return false;
  if (payload[cursor] !== 0) return false;
  return cursor + 1 === payload.length;
}

function walkAvif(buf, start, end, visit) {
  let offset = start;
  while (offset + 8 <= end) {
    let size = buf.readUInt32BE(offset);
    let header = 8;
    const type = buf.toString("ascii", offset + 4, offset + 8);
    if (size === 1) {
      if (offset + 16 > end) throw new Error("avif size");
      const large = buf.readBigUInt64BE(offset + 8);
      if (large > BigInt(end - offset) || large < 16n) throw new Error("avif size");
      size = Number(large);
      header = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (!Number.isFinite(size) || size < header || offset + size > end) throw new Error("avif size");
    const payload = buf.subarray(offset + header, offset + size);
    visit(type, payload, offset + header);
    const childSkip = avifChildSkip(type, payload);
    if (childSkip !== null) walkAvif(buf, offset + header + childSkip, offset + size, visit);
    offset += size;
  }
  if (offset !== end) throw new Error("avif trailing");
}

function avifChildSkip(type, payload) {
  if (type === "meta" || type === "iref") return payload.length >= 4 ? 4 : null;
  if (type === "iprp" || type === "ipco" || type === "dinf") return 0;
  if (type === "iinf") {
    if (payload.length < 6) return null;
    return payload[0] === 0 ? 6 : 8;
  }
  if (type === "dref") return payload.length >= 8 ? 8 : null;
  return null;
}

const EXTENSIONS = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif" };

export async function prepareImage(factsDir, image, index) {
  const file = image.file;
  let bytes;
  try {
    bytes = await readImageFile(factsDir, file);
  } catch (error) {
    if (error instanceof SiteEngineError) throw error;
    fail(`Image file was not found: ${file}`);
  }
  const kind = detect(bytes);
  if (!kind) fail(`Image format is not allowed: ${file}`);
  try {
    if (kind === "jpeg") bytes = stripJpeg(bytes);
    else if (kind === "png") bytes = stripPng(bytes);
    else if (kind === "webp") bytes = stripWebp(bytes);
    else bytes = stripAvif(bytes, file);
  } catch (error) {
    if (error instanceof SiteEngineError) throw error;
    fail(`Could not remove hidden details from image: ${file}`);
  }
  return {
    src: `images/${index}.${EXTENSIONS[kind]}`,
    bytes,
    alt: image.alt,
  };
}

export async function prepareImages(factsDir, images = []) {
  const prepared = [];
  for (let index = 0; index < images.length; index += 1) {
    prepared.push(await prepareImage(factsDir, images[index], index + 1));
  }
  return prepared;
}
