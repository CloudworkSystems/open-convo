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

// Recognizes an AVIF so it can be refused by name. The bytes are not parsed
// or copied.
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


const EXTENSIONS = { jpeg: "jpg", png: "png", webp: "webp" };

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
  if (kind === "avif") fail(`AVIF images are not allowed: ${file}`);
  if (!kind) fail(`Image format is not allowed: ${file}`);
  try {
    if (kind === "jpeg") bytes = stripJpeg(bytes);
    else if (kind === "png") bytes = stripPng(bytes);
    else bytes = stripWebp(bytes);
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
