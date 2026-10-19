import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const CLI = fileURLToPath(new URL("../src/build.mjs", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const FIXED_URLS = [
  "http://www.sitemaps.org/schemas/sitemap/0.9",
  "https://schema.org",
];
const EXIF_MARKER = "OC-MARKER-EXIF-9f3a2c";
const PNG_MARKER = "OC-MARKER-PNG-9f3a2c";
const PNG_ITXT = "OC-MARKER-PNG-ITXT";
const WEBP_MARKER = "OC-MARKER-WEBP-9f3a2c";
const GPS = "GPSLatitude=13.3701";
const GPS_LONG = "GPSLongitude=-84.4281";
const XMP = "http://ns.adobe.com/xap/1.0/";

function run(facts, out) {
  return spawnSync(process.execPath, [CLI, "--facts", facts, "--out", out], { encoding: "utf8" });
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "site-engine-"));
}

async function writeJson(dir, facts, name = "facts.json") {
  const file = path.join(dir, name);
  await writeFile(file, `${JSON.stringify(facts, null, 2)}\n`);
  return file;
}

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}

async function filesIn(dir) {
  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) found.push(...(await walk(full)));
      else found.push(path.relative(dir, full));
    }
    return found;
  }
  if (!existsSync(dir)) return [];
  return (await walk(dir)).sort();
}

async function snapshot(dir) {
  const records = {};
  for (const rel of await filesIn(dir)) {
    const full = path.join(dir, rel);
    const [buf, info] = await Promise.all([readFile(full), stat(full)]);
    records[rel] = {
      sha256: createHash("sha256").update(buf).digest("hex"),
      mtimeMs: info.mtimeMs,
    };
  }
  return records;
}

function textOf(buf) {
  return buf.toString("latin1");
}

function allowedUrls(facts) {
  const urls = new Set(FIXED_URLS);
  urls.add(facts.siteUrl);
  if (facts.contact?.bookingUrl) urls.add(facts.contact.bookingUrl);
  for (const item of facts.social ?? []) urls.add(item.url);
  return urls;
}

function unexpectedUrls(text, allowed) {
  const found = text.match(/https?:\/\/[^\s"'<>]*/g) ?? [];
  return found.map((url) => url.replaceAll("&amp;", "&")).filter((url) => !allowed.has(url));
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

function adler32(data) {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStore(data) {
  const out = Buffer.alloc(2 + 5 + data.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  out[2] = 0x01;
  out.writeUInt16LE(data.length, 3);
  out.writeUInt16LE((data.length ^ 0xffff) & 0xffff, 5);
  data.copy(out, 7);
  out.writeUInt32BE(adler32(data), 7 + data.length);
  return out;
}

function cleanPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStore(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunkTypes(buf) {
  const types = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    types.push(buf.toString("ascii", offset + 4, offset + 8));
    offset += 12 + length;
  }
  return types;
}

function jpegSegment(marker, payload) {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function dirtyJpeg() {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(
    jpegSegment(
      0xe0,
      Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
    ),
  );
  const secret = `${EXIF_MARKER} ${GPS} ${GPS_LONG}`;
  parts.push(jpegSegment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from(secret)])));
  parts.push(
    jpegSegment(
      0xe1,
      Buffer.concat([Buffer.from(`${XMP}\0`, "latin1"), Buffer.from(secret)]),
    ),
  );
  parts.push(jpegSegment(0xed, Buffer.from(`Photoshop 3.0\0${secret}`, "latin1")));
  parts.push(jpegSegment(0xfe, Buffer.from(secret)));
  parts.push(jpegSegment(0xc0, Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])));
  parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(Buffer.from([0x00, 0xff, 0xd9]));
  parts.push(Buffer.from("SECRET-TRAILING-JPEG"));
  return Buffer.concat(parts);
}

function dirtyPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const text = Buffer.concat([
    Buffer.from("Comment\0", "latin1"),
    Buffer.from(`${PNG_MARKER} ${GPS} ${GPS_LONG}`),
  ]);
  const itxt = Buffer.concat([
    Buffer.from("Comment\0", "latin1"),
    Buffer.from([0, 0]),
    Buffer.from("\0\0", "latin1"),
    Buffer.from(`${PNG_ITXT} ${XMP}`),
  ]);
  const time = Buffer.from([0x07, 0xe9, 1, 2, 3, 4, 5]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("iTXt", itxt),
    pngChunk("eXIf", Buffer.from(`Exif\0${PNG_MARKER} ${GPS}`, "latin1")),
    pngChunk("tIME", time),
    pngChunk("IDAT", zlibStore(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
    Buffer.from("SECRET-TRAILING-HTML"),
  ]);
}

function riffChunk(tag, data) {
  const head = Buffer.alloc(8);
  head.write(tag, 0, "ascii");
  head.writeUInt32LE(data.length, 4);
  const pad = data.length % 2 === 1 ? Buffer.from([0]) : Buffer.alloc(0);
  return Buffer.concat([head, data, pad]);
}

function dirtyWebp() {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08;
  const chunks = Buffer.concat([
    riffChunk("VP8X", vp8x),
    riffChunk("EXIF", Buffer.from(`${WEBP_MARKER} ${GPS} ${XMP}`)),
    riffChunk("VP8 ", Buffer.from("fakevp8payload")),
  ]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + chunks.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, chunks]);
}


function jfifPayload() {
  return Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
}

function iccJpeg() {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, jfifPayload()));
  parts.push(
    jpegSegment(
      0xe2,
      Buffer.concat([
        Buffer.from("ICC_PROFILE\0", "latin1"),
        Buffer.from([1, 1]),
        Buffer.from("ICC-AUTHOR-9f3a desc Copyright Device"),
      ]),
    ),
  );
  parts.push(jpegSegment(0xc0, Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])));
  parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(Buffer.from([0x00, 0xff, 0xd9]));
  return Buffer.concat(parts);
}

function iccPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("iCCP", Buffer.from("sRGB\0\0ICC-AUTHOR-9f3a")),
    pngChunk("IDAT", zlibStore(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function iccWebp() {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02 | 0x10 | 0x20;
  const chunks = Buffer.concat([
    riffChunk("VP8X", vp8x),
    riffChunk("ICCP", Buffer.from("ICC-AUTHOR-9f3a profile-desc")),
    riffChunk("VP8 ", Buffer.from("fakevp8payload")),
  ]);
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + chunks.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, chunks]);
}

function progressiveJpeg() {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, jfifPayload()));
  parts.push(jpegSegment(0xc2, Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])));
  parts.push(jpegSegment(0xc4, Buffer.from([0x00, 0x00])));
  parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(Buffer.from([0x00, 0x11]));
  parts.push(jpegSegment(0xfe, Buffer.from("PROGRESSIVE-MARKER-SECRET")));
  parts.push(jpegSegment(0xc4, Buffer.from([0x01, 0x02])));
  parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(Buffer.from("SCAN2-KEEP"));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}


function progressiveJpegWithTables() {
  const parts = [Buffer.from([0xff, 0xd8])];
  parts.push(jpegSegment(0xe0, jfifPayload()));
  parts.push(jpegSegment(0xc2, Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])));
  parts.push(jpegSegment(0xdd, Buffer.from([0x00, 0x04])));
  parts.push(jpegSegment(0xc4, Buffer.from("SCAN1-TABLE")));
  parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(Buffer.from([0x00, 0x11]));
  parts.push(jpegSegment(0xfe, Buffer.from("PROGRESSIVE-MARKER-SECRET")));
  parts.push(jpegSegment(0xc4, Buffer.from("SCAN2-TABLE")));
  parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
  parts.push(Buffer.from("SCAN2-KEEP"));
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

function jsonLd(html) {
  const matches = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g) ?? [];
  assert.equal(matches.length, 1);
  const body = matches[0].replace(/^<script type="application\/ld\+json">/, "").replace(/<\/script>$/, "");
  assert.doesNotMatch(body, /<\/script/i);
  return JSON.parse(body);
}

function assertWellFormedXml(xml) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  let index = xml.indexOf("?>") + 2;
  if (xml[index] === "\n") index += 1;
  const stack = [];
  while (index < xml.length) {
    if (xml[index] !== "<") {
      const next = xml.indexOf("<", index);
      const text = xml.slice(index, next === -1 ? xml.length : next);
      assert.equal(/&(?!(?:amp|lt|gt|quot|apos);)/.test(text), false, text);
      if (next === -1) break;
      index = next;
      continue;
    }
    if (xml.startsWith("</", index)) {
      const end = xml.indexOf(">", index);
      const name = xml.slice(index + 2, end);
      assert.equal(stack.pop(), name);
      index = end + 1;
      continue;
    }
    const end = xml.indexOf(">", index);
    assert.ok(end > index);
    let raw = xml.slice(index + 1, end);
    const selfClosing = raw.endsWith("/");
    if (selfClosing) raw = raw.slice(0, -1).trimEnd();
    const name = raw.split(/\s+/)[0];
    assert.match(name, /^[A-Za-z_][\w.-]*$/);
    if (!selfClosing) stack.push(name);
    index = end + 1;
  }
  assert.deepEqual(stack, []);
}

function headings(html) {
  return [...html.matchAll(/<h([1-6])\b/g)].map((match) => Number(match[1]));
}

test("1. a complete facts file builds and every required file exists", async () => {
  const root = await tempDir();
  try {
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.images = [{ file: "loaf.png", alt: "A fictional rye loaf on a wooden board" }];
    await writeFile(path.join(root, "loaf.png"), cleanPng());
    const factsPath = await writeJson(root, facts);
    const out = path.join(root, "site");
    const result = run(factsPath, out);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await filesIn(out), [
      "images/1.png",
      "index.html",
      "robots.txt",
      "site-engine.txt",
      "site.css",
      "sitemap.xml",
    ]);
    const html = await readFile(path.join(out, "index.html"), "utf8");
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<meta name="description" content="[^"]+"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/marrow-lane\.example\/">/);
    assert.deepEqual(headings(html), [1, 2, 2, 2, 2, 2, 2, 2]);
    assert.equal(html.match(/<h1\b/g).length, 1);
    const images = [...html.matchAll(/<img\b[^>]*>/g)];
    assert.equal(images.length, 1);
    assert.match(images[0][0], /alt="A fictional rye loaf on a wooden board"/);
    assert.equal(html.match(/<script\b/gi).length, 1);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.match(html, /href="site\.css"/);
    const tutorOut = path.join(root, "tutor");
    const tutor = run(path.join(FIXTURES, "northglass-tutoring.facts.json"), tutorOut);
    assert.equal(tutor.status, 0, tutor.stderr);
    assert.deepEqual(await filesIn(tutorOut), [
      "index.html",
      "robots.txt",
      "site-engine.txt",
      "site.css",
      "sitemap.xml",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("2. the same input gives byte-identical output", async () => {
  const root = await tempDir();
  try {
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.images = [{ file: "loaf.png", alt: "A fictional rye loaf" }];
    await writeFile(path.join(root, "loaf.png"), cleanPng());
    const factsPath = await writeJson(root, facts);
    const first = path.join(root, "one");
    const second = path.join(root, "two");
    assert.equal(run(factsPath, first).status, 0);
    assert.equal(run(factsPath, second).status, 0);
    const left = await snapshot(first);
    const right = await snapshot(second);
    for (const record of Object.values(left)) delete record.mtimeMs;
    for (const record of Object.values(right)) delete record.mtimeMs;
    assert.deepEqual(left, right);
    assert.equal(run(factsPath, first).status, 0);
    const again = await snapshot(first);
    for (const record of Object.values(again)) delete record.mtimeMs;
    assert.deepEqual(again, left);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("3. an extra field fails and its value is not in the output", async () => {
  const root = await tempDir();
  try {
    const marker = "MARKER-privateNotes-should-not-leak";
    const facts = await loadFixture("northglass-tutoring.facts.json");
    facts.privateNotes = marker;
    const factsPath = await writeJson(root, facts);
    const out = path.join(root, "site");
    await writeFile(path.join(root, "previous.html"), "<p>previous good page</p>");
    const seeded = path.join(root, "seeded");
    const good = await loadFixture("northglass-tutoring.facts.json");
    const goodPath = await writeJson(root, good, "good.json");
    assert.equal(run(goodPath, seeded).status, 0);
    const before = await snapshot(seeded);
    const failed = run(factsPath, out);
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Unknown field: privateNotes/);
    assert.equal(existsSync(out), false);
    assert.deepEqual(await snapshot(seeded), before);
    const seededText = (await readFile(path.join(seeded, "index.html"), "utf8"));
    assert.equal(seededText.includes(marker), false);
    assert.equal(failed.stderr.includes(marker), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("4. a missing required field fails with a message naming it", async () => {
  const root = await tempDir();
  try {
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    delete facts.tagline;
    const factsPath = await writeJson(root, facts);
    const out = path.join(root, "site");
    const result = run(factsPath, out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing required field: tagline/);
    assert.equal(existsSync(out), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("5. brand colors that fail contrast fail the build with a plain message", async () => {
  const root = await tempDir();
  try {
    const facts = await loadFixture("northglass-tutoring.facts.json");
    facts.brand = { background: "#ffffff", text: "#ffffff", accent: "#ffffff" };
    const factsPath = await writeJson(root, facts);
    const out = path.join(root, "site");
    const result = run(factsPath, out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Brand colors fail WCAG AA contrast/);
    assert.match(result.stderr, /4\.5:1/);
    assert.equal(existsSync(out), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("6. JSON-LD matches the facts, with LocalBusiness or Organization", async () => {
  const root = await tempDir();
  try {
    const bakery = await loadFixture("marrow-lane-bakery.facts.json");
    const bakeryOut = path.join(root, "bakery");
    assert.equal(run(await writeJson(root, bakery, "bakery.json"), bakeryOut).status, 0);
    const bakeryHtml = await readFile(path.join(bakeryOut, "index.html"), "utf8");
    const bakeryLd = jsonLd(bakeryHtml);
    assert.equal(bakeryLd["@context"], "https://schema.org");
    assert.equal(bakeryLd["@type"], "LocalBusiness");
    assert.equal(bakeryLd.name, bakery.name);
    assert.equal(bakeryLd.address["@type"], "PostalAddress");
    assert.equal(bakeryLd.address.streetAddress, bakery.location.street);
    assert.equal(bakeryLd.address.addressLocality, bakery.location.city);
    assert.equal(bakeryLd.address.addressRegion, bakery.location.region);
    assert.equal(bakeryLd.address.postalCode, bakery.location.postalCode);
    assert.equal(bakeryLd.address.addressCountry, bakery.location.country);
    assert.deepEqual(
      bakeryLd.openingHoursSpecification.map((slot) => [slot.dayOfWeek, slot.opens, slot.closes]),
      bakery.hours.map((slot) => [slot.days, slot.open, slot.close]),
    );
    assert.match(bakeryHtml, /18 Marrow Lane/);
    assert.match(bakeryHtml, /Tue–Fri/);

    const tutor = await loadFixture("northglass-tutoring.facts.json");
    const tutorOut = path.join(root, "tutor");
    assert.equal(run(await writeJson(root, tutor, "tutor.json"), tutorOut).status, 0);
    const tutorHtml = await readFile(path.join(tutorOut, "index.html"), "utf8");
    const tutorLd = jsonLd(tutorHtml);
    assert.equal(tutorLd["@type"], "Organization");
    assert.equal(tutorLd.name, tutor.name);
    assert.equal(tutorLd.address, undefined);
    assert.equal(JSON.stringify(tutorLd).includes("PostalAddress"), false);
    assert.equal(JSON.stringify(tutorLd).includes("streetAddress"), false);
    assert.equal(tutorLd.openingHours, "By appointment");
    assert.match(tutorHtml, /Online only/);
    const css = await readFile(path.join(tutorOut, "site.css"), "utf8");
    assert.match(css, /#15110f/);
    assert.match(css, /#f7f2ee/);
    assert.match(css, /#f37a4a/);

    const addressed = await loadFixture("northglass-tutoring.facts.json");
    addressed.contact.email = "notes?draft#1@northglass-tutoring.example";
    const addressedOut = path.join(root, "addressed");
    const addressedRun = run(await writeJson(root, addressed, "addressed.json"), addressedOut);
    assert.equal(addressedRun.status, 0, addressedRun.stderr);
    const addressedHtml = await readFile(path.join(addressedOut, "index.html"), "utf8");
    assert.match(addressedHtml, /href="mailto:notes%3Fdraft%231@northglass-tutoring\.example"/);
    assert.match(addressedHtml, />notes\?draft#1@northglass-tutoring\.example</);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("7. output has no web address except the facts links and two standard identifiers", async () => {
  const root = await tempDir();
  try {
    for (const [index, name] of ["marrow-lane-bakery.facts.json", "northglass-tutoring.facts.json"].entries()) {
      const facts = await loadFixture(name);
      const out = path.join(root, `site-${index}`);
      const result = run(await writeJson(root, facts, name), out);
      assert.equal(result.status, 0, result.stderr);
      const allowed = allowedUrls(facts);
      for (const rel of await filesIn(out)) {
        const text = textOf(await readFile(path.join(out, rel)));
        assert.deepEqual(unexpectedUrls(text, allowed), [], rel);
      }
      const html = await readFile(path.join(out, "index.html"), "utf8");
      assert.doesNotMatch(html, /fonts\.google|cdn|analytics|gtag|facebook\.net|unpkg|jsdelivr/i);
      assert.equal([...html.matchAll(/<link\b/g)].length, 2);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("8. an image without alt text fails the build", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, "loaf.png"), cleanPng());
    const missing = await loadFixture("marrow-lane-bakery.facts.json");
    missing.images = [{ file: "loaf.png" }];
    const missingOut = path.join(root, "missing");
    const missingResult = run(await writeJson(root, missing, "missing.json"), missingOut);
    assert.notEqual(missingResult.status, 0);
    assert.match(missingResult.stderr, /alt/);
    assert.equal(existsSync(missingOut), false);

    const blank = await loadFixture("marrow-lane-bakery.facts.json");
    blank.images = [{ file: "loaf.png", alt: "   " }];
    const blankOut = path.join(root, "blank");
    const blankResult = run(await writeJson(root, blank, "blank.json"), blankOut);
    assert.notEqual(blankResult.status, 0);
    assert.match(blankResult.stderr, /Image is missing alt text/);
    assert.equal(existsSync(blankOut), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("9. hostile text stays plain text, with one script and valid sitemap XML", async () => {
  const root = await tempDir();
  try {
    const hostile = 'Rye & "Daily" <b>loaves</b></script><script>alert(1)';
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.name = hostile;
    facts.siteUrl = "https://hostile.example/menu?item=rye&size=large";
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.equal(result.status, 0, result.stderr);
    const html = await readFile(path.join(out, "index.html"), "utf8");
    assert.equal(html.match(/<script\b/gi).length, 1);
    assert.equal(html.includes("<b>"), false);
    assert.equal(html.includes("</script><script>"), false);
    assert.match(html, /Rye &amp; &quot;Daily&quot; &lt;b&gt;loaves&lt;\/b&gt;&lt;\/script&gt;&lt;script&gt;alert\(1\)/);
    const data = jsonLd(html);
    assert.equal(data.name, hostile);
    assert.equal(data["@type"], "LocalBusiness");
    assert.equal(data.url, facts.siteUrl);
    const sitemap = await readFile(path.join(out, "sitemap.xml"), "utf8");
    assertWellFormedXml(sitemap);
    assert.match(sitemap, /item=rye&amp;size=large/);
    assert.equal(sitemap.includes("&size=large"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("10. unsafe links fail before output is written", async () => {
  const cases = [
    ["siteUrl", "javascript:alert(1)"],
    ["bookingUrl", "data:text/html,hi"],
    ["social", "//example.test"],
    ["siteUrl", "http://example.test/menu"],
    ["social", "ftp://example.test/file"],
  ];
  const root = await tempDir();
  try {
    for (const [index, [field, value]] of cases.entries()) {
      const facts = await loadFixture("marrow-lane-bakery.facts.json");
      if (field === "siteUrl") facts.siteUrl = value;
      if (field === "bookingUrl") facts.contact.bookingUrl = value;
      if (field === "social") facts.social = [{ label: "Away", url: value }];
      const out = path.join(root, `out-${index}`);
      const seeded = path.join(root, "kept.txt");
      await writeFile(seeded, "keep");
      const before = await readFile(seeded);
      const result = run(await writeJson(root, facts, `${field}.json`), out);
      assert.notEqual(result.status, 0, value);
      assert.match(result.stderr, /https:\/\//);
      assert.equal(existsSync(out), false, value);
      assert.deepEqual(await readFile(seeded), before);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("11. unsafe images fail", async () => {
  const root = await tempDir();
  try {
    const outside = path.join(root, "outside.jpg");
    await writeFile(outside, Buffer.concat([Buffer.from("OUTSIDE-SECRET-9f3a"), cleanPng()]));
    const cases = [
      ["absolute", { file: outside, alt: "An outside file" }, null],
      ["parent", { file: "../outside.jpg", alt: "A parent path" }, null],
      ["symlink", { file: "linked.png", alt: "A linked file" }, async (dir) => {
        await symlink(outside, path.join(dir, "linked.png"));
      }],
      ["svg", { file: "mark.svg", alt: "A drawing" }, async (dir) => {
        await writeFile(path.join(dir, "mark.svg"), "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
      }],
      ["html", { file: "photo.png", alt: "Not a photo" }, async (dir) => {
        await writeFile(path.join(dir, "photo.png"), "<!DOCTYPE html><html><body>SECRET-HTML</body></html>");
      }],
    ];
    for (const [label, image, arrange] of cases) {
      const dir = path.join(root, label);
      await mkdir(dir);
      if (arrange) await arrange(dir);
      const facts = await loadFixture("marrow-lane-bakery.facts.json");
      facts.images = [image];
      const out = path.join(dir, "site");
      const result = run(await writeJson(dir, facts), out);
      assert.notEqual(result.status, 0, `${label}: ${result.stderr}`);
      assert.equal(existsSync(out), false, label);
      assert.equal(result.stderr.includes("OUTSIDE-SECRET-9f3a"), false, label);
      assert.equal(result.stderr.includes("SECRET-HTML"), false, label);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("12. a rebuild drops removed images, and a failed rebuild leaves the last good output", async () => {
  const root = await tempDir();
  try {
    const png = cleanPng();
    await writeFile(path.join(root, "loaf.png"), png);
    const withImage = await loadFixture("marrow-lane-bakery.facts.json");
    withImage.images = [{ file: "loaf.png", alt: "TRACE-RYE-PHOTO-9f3a" }];
    const factsPath = await writeJson(root, withImage);
    const out = path.join(root, "site");
    assert.equal(run(factsPath, out).status, 0);
    assert.equal(existsSync(path.join(out, "images/1.png")), true);
    await writeFile(path.join(out, "leftover.txt"), "LEFTOVER-FROM-OLD-BUILD");

    const without = await loadFixture("marrow-lane-bakery.facts.json");
    const withoutPath = await writeJson(root, without, "without.json");
    assert.equal(run(withoutPath, out).status, 0);
    const names = await filesIn(out);
    assert.deepEqual(names, ["index.html", "robots.txt", "site-engine.txt", "site.css", "sitemap.xml"]);
    const html = await readFile(path.join(out, "index.html"), "utf8");
    assert.equal(html.includes("TRACE-RYE-PHOTO-9f3a"), false);
    assert.equal(html.includes("images/1.png"), false);
    assert.equal(html.includes("<img"), false);
    assert.equal(html.includes("LEFTOVER-FROM-OLD-BUILD"), false);
    assert.equal(existsSync(path.join(out, "leftover.txt")), false);

    const good = await snapshot(out);
    const broken = await loadFixture("marrow-lane-bakery.facts.json");
    broken.privateNotes = "SHOULD-NOT-APPEAR-9f3a";
    const brokenPath = await writeJson(root, broken, "broken.json");
    const failed = run(brokenPath, out);
    assert.notEqual(failed.status, 0);
    assert.deepEqual(await snapshot(out), good);
    const after = await readFile(path.join(out, "index.html"), "utf8");
    assert.equal(after.includes("SHOULD-NOT-APPEAR-9f3a"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("13. JPEG and PNG metadata, including GPS, is removed from the built images", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, "counter.jpg"), dirtyJpeg());
    await writeFile(path.join(root, "note.png"), dirtyPng());
    await writeFile(path.join(root, "still.webp"), dirtyWebp());
    await writeFile(path.join(root, "icc.jpg"), iccJpeg());
    await writeFile(path.join(root, "icc.png"), iccPng());
    await writeFile(path.join(root, "icc.webp"), iccWebp());
    await writeFile(path.join(root, "progressive.jpg"), progressiveJpeg());
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.images = [
      { file: "counter.jpg", alt: "A fictional counter" },
      { file: "note.png", alt: "A fictional note card" },
      { file: "still.webp", alt: "A fictional still life" },
      { file: "icc.jpg", alt: "A fictional color target" },
      { file: "icc.png", alt: "A fictional color card" },
      { file: "icc.webp", alt: "A fictional color still" },
      { file: "progressive.jpg", alt: "A fictional progressive photo" },
    ];
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.equal(result.status, 0, result.stderr);
    const forbidden = [
      EXIF_MARKER,
      PNG_MARKER,
      PNG_ITXT,
      WEBP_MARKER,
      GPS,
      GPS_LONG,
      XMP,
      "Exif\0",
      "SECRET-TRAILING-JPEG",
      "SECRET-TRAILING-HTML",
      "ICC-AUTHOR-9f3a",
      "PROGRESSIVE-MARKER-SECRET",
    ];
    for (const rel of await filesIn(out)) {
      const bytes = await readFile(path.join(out, rel));
      const text = textOf(bytes);
      for (const marker of forbidden) {
        assert.equal(text.includes(marker), false, `${marker} in ${rel}`);
      }
    }
    const jpeg = await readFile(path.join(out, "images/1.jpg"));
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
    assert.equal(textOf(jpeg).includes("JFIF"), true);
    const png = await readFile(path.join(out, "images/2.png"));
    assert.deepEqual(pngChunkTypes(png), ["IHDR", "IDAT", "IEND"]);
    const webp = await readFile(path.join(out, "images/3.webp"));
    assert.equal(textOf(webp).includes("EXIF"), false);
    assert.equal(textOf(webp).includes("VP8 "), true);
    const iccJpegOut = await readFile(path.join(out, "images/4.jpg"));
    assert.equal(textOf(iccJpegOut).includes("JFIF"), true);
    assert.equal(textOf(iccJpegOut).includes("ICC_PROFILE"), false);
    const iccPngOut = await readFile(path.join(out, "images/5.png"));
    assert.deepEqual(pngChunkTypes(iccPngOut), ["IHDR", "IDAT", "IEND"]);
    const iccWebpOut = await readFile(path.join(out, "images/6.webp"));
    assert.equal(textOf(iccWebpOut).includes("ICCP"), false);
    assert.equal(iccWebpOut[20] & 0x20, 0);
    assert.equal(iccWebpOut[20] & 0x12, 0x12);
    const progressive = await readFile(path.join(out, "images/7.jpg"));
    assert.equal(textOf(progressive).includes("SCAN2-KEEP"), true);
    assert.equal(progressive.filter((byte, index) => byte === 0xff && progressive[index + 1] === 0xda).length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function inventedAvif() {
  const brands = Buffer.concat([
    Buffer.from("avif"),
    Buffer.alloc(4),
    Buffer.from("avif"),
    Buffer.from("mif1"),
  ]);
  const ftypSize = Buffer.alloc(4);
  ftypSize.writeUInt32BE(8 + brands.length);
  const secret = Buffer.from("HIDDEN-AUTHOR-9f3a");
  const freeSize = Buffer.alloc(4);
  freeSize.writeUInt32BE(8 + secret.length);
  return Buffer.concat([ftypSize, Buffer.from("ftyp"), brands, freeSize, Buffer.from("free"), secret]);
}

test("an AVIF image is refused", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, "portrait.avif"), inventedAvif());
    const facts = await loadFixture("northglass-tutoring.facts.json");
    facts.images = [{ file: "portrait.avif", alt: "A fictional portrait" }];
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AVIF images are not allowed: portrait\.avif/);
    assert.equal(existsSync(out), false);
    assert.equal(result.stderr.includes("HIDDEN-AUTHOR-9f3a"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ICC profiles in PNG, JPEG, and WebP are removed", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, "icc.png"), iccPng());
    await writeFile(path.join(root, "icc.jpg"), iccJpeg());
    await writeFile(path.join(root, "icc.webp"), iccWebp());
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.images = [
      { file: "icc.png", alt: "A fictional color card" },
      { file: "icc.jpg", alt: "A fictional color target" },
      { file: "icc.webp", alt: "A fictional color still" },
    ];
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.equal(result.status, 0, result.stderr);
    const png = await readFile(path.join(out, "images/1.png"));
    const jpeg = await readFile(path.join(out, "images/2.jpg"));
    const webp = await readFile(path.join(out, "images/3.webp"));
    assert.deepEqual(pngChunkTypes(png), ["IHDR", "IDAT", "IEND"]);
    assert.equal(textOf(jpeg).includes("ICC_PROFILE"), false);
    assert.equal(textOf(jpeg).includes("JFIF"), true);
    assert.equal(textOf(webp).includes("ICCP"), false);
    let flags = null;
    let offset = 12;
    while (offset + 8 <= webp.length) {
      const tag = webp.toString("ascii", offset, offset + 4);
      const size = webp.readUInt32LE(offset + 4);
      if (tag === "VP8X") flags = webp[offset + 8];
      offset += 8 + size + (size % 2);
    }
    assert.equal(flags & 0x20, 0);
    assert.equal(flags & 0x10, 0x10);
    assert.equal(flags & 0x02, 0x02);
    for (const bytes of [png, jpeg, webp]) {
      const text = textOf(bytes);
      assert.equal(text.includes("ICC-AUTHOR-9f3a"), false);
      assert.equal(text.includes("Copyright"), false);
      assert.equal(text.includes("Device"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("a progressive JPEG keeps later scans", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, "progressive.jpg"), progressiveJpegWithTables());
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.images = [{ file: "progressive.jpg", alt: "A fictional progressive photo" }];
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.equal(result.status, 0, result.stderr);
    const jpeg = await readFile(path.join(out, "images/1.jpg"));
    const text = textOf(jpeg);
    assert.equal(text.includes("SCAN2-KEEP"), true);
    assert.equal(text.includes("SCAN2-TABLE"), true);
    assert.equal(text.includes("PROGRESSIVE-MARKER-SECRET"), false);
    assert.equal(jpeg.filter((byte, index) => byte === 0xff && jpeg[index + 1] === 0xda).length, 2);
    assert.equal(jpeg.filter((byte, index) => byte === 0xff && jpeg[index + 1] === 0xc2).length, 1);
    assert.equal(jpeg.filter((byte, index) => byte === 0xff && jpeg[index + 1] === 0xdd).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mailto links percent-encode reserved characters", async () => {
  const root = await tempDir();
  try {
    const facts = await loadFixture("northglass-tutoring.facts.json");
    const email = "notes?draft&1#box@northglass-tutoring.example";
    facts.contact.email = email;
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.equal(result.status, 0, result.stderr);
    const html = await readFile(path.join(out, "index.html"), "utf8");
    assert.match(html, /href="mailto:notes%3Fdraft%261%23box@northglass-tutoring\.example"/);
    assert.match(html, />notes\?draft&amp;1#box@northglass-tutoring\.example</);
    assert.equal(jsonLd(html).email, email);
    assert.equal(html.includes("mailto:notes?draft"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function parseWebpChunks(buf) {
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const tag = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    chunks.push({ tag, data: Buffer.from(buf.subarray(offset + 8, offset + 8 + size)) });
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

function assembleWebp(chunks) {
  const body = Buffer.concat(chunks.map((chunk) => riffChunk(chunk.tag, chunk.data)));
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(4 + body.length, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

function withWebpMetadata(buf) {
  const chunks = parseWebpChunks(buf);
  const header = chunks.find((chunk) => chunk.tag === "VP8X");
  assert.ok(header);
  header.data[0] |= 0x04 | 0x08 | 0x20;
  const next = [];
  for (const chunk of chunks) {
    next.push(chunk);
    if (chunk.tag === "VP8X") next.push({ tag: "ICCP", data: Buffer.from("OC-MARKER-WEBP-ICC-9f3a") });
  }
  next.push({ tag: "EXIF", data: Buffer.from("OC-MARKER-WEBP-EXIF-9f3a") });
  next.push({ tag: "XMP ", data: Buffer.from("OC-MARKER-WEBP-XMP-9f3a") });
  return assembleWebp(next);
}

function vp8xFlags(buf) {
  return parseWebpChunks(buf).find((chunk) => chunk.tag === "VP8X").data[0];
}

async function transparentWebp() {
  const width = 8;
  const height = 8;
  const raw = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      raw[pixel] = 200;
      raw[pixel + 1] = 30;
      raw[pixel + 2] = 40;
      raw[pixel + 3] = x < 4 ? 0 : 255;
    }
  }
  const encoded = await sharp(raw, { raw: { width, height, channels: 4 } })
    .webp({ quality: 100, alphaQuality: 100 })
    .toBuffer();
  return withWebpMetadata(encoded);
}

async function animatedWebp() {
  const width = 8;
  const height = 8;
  const red = Buffer.alloc(width * height * 4);
  const blue = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    red[pixel * 4] = 220;
    red[pixel * 4 + 1] = 15;
    red[pixel * 4 + 2] = 15;
    red[pixel * 4 + 3] = 255;
    blue[pixel * 4] = 15;
    blue[pixel * 4 + 1] = 15;
    blue[pixel * 4 + 2] = 220;
    blue[pixel * 4 + 3] = pixel === 0 ? 0 : 255;
  }
  const encoded = await sharp(Buffer.concat([red, blue]), {
    raw: { width, height: height * 2, channels: 4, pageHeight: height },
  })
    .webp({ lossless: true, loop: 0, delay: [50, 80] })
    .toBuffer();
  return withWebpMetadata(encoded);
}

test("a transparent WebP and an animated WebP still decode after metadata is removed", async () => {
  const root = await tempDir();
  try {
    await writeFile(path.join(root, "logo.webp"), await transparentWebp());
    await writeFile(path.join(root, "sign.webp"), await animatedWebp());
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.images = [
      { file: "logo.webp", alt: "A fictional transparent mark" },
      { file: "sign.webp", alt: "A fictional animated sign" },
    ];
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.equal(result.status, 0, result.stderr);

    const still = await readFile(path.join(out, "images/1.webp"));
    const animation = await readFile(path.join(out, "images/2.webp"));
    for (const bytes of [still, animation]) {
      const text = textOf(bytes);
      assert.equal(text.includes("OC-MARKER-WEBP-EXIF-9f3a"), false);
      assert.equal(text.includes("OC-MARKER-WEBP-XMP-9f3a"), false);
      assert.equal(text.includes("OC-MARKER-WEBP-ICC-9f3a"), false);
      const flags = vp8xFlags(bytes);
      assert.equal(flags & 0x04, 0);
      assert.equal(flags & 0x08, 0);
      assert.equal(flags & 0x20, 0);
    }
    assert.equal(vp8xFlags(still) & 0x10, 0x10);
    const decoded = await sharp(still).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, 8);
    assert.equal(decoded.info.height, 8);
    assert.equal(decoded.data[3], 0);
    assert.equal(decoded.data[19], 255);

    assert.equal(vp8xFlags(animation) & 0x02, 0x02);
    assert.equal(vp8xFlags(animation) & 0x10, 0x10);
    const meta = await sharp(animation, { animated: true }).metadata();
    assert.equal(meta.pages, 2);
    assert.deepEqual(meta.delay, [50, 80]);
    const frames = await sharp(animation, { animated: true, pages: -1 })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(frames.info.pages, 2);
    const frameSize = frames.info.width * frames.info.pageHeight * 4;
    assert.deepEqual([...frames.data.subarray(0, 4)], [220, 15, 15, 255]);
    assert.equal(frames.data[frameSize + 3], 0);
    assert.deepEqual([...frames.data.subarray(frameSize + 4, frameSize + 8)], [15, 15, 220, 255]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an existing folder is replaced only when it is an earlier Site Engine build", async () => {
  const root = await tempDir();
  try {
    const facts = await loadFixture("northglass-tutoring.facts.json");
    const factsPath = await writeJson(root, facts);
    const marker = "Built by Open Convo Site Engine.\n";

    const precious = path.join(root, "precious");
    await mkdir(precious);
    await writeFile(path.join(precious, "notes.txt"), "UNRELATED-NOTES-9f3a\n");
    const refused = run(factsPath, precious);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /Output folder is not an earlier Site Engine build: precious/);
    assert.equal(await readFile(path.join(precious, "notes.txt"), "utf8"), "UNRELATED-NOTES-9f3a\n");
    assert.equal(existsSync(path.join(precious, "index.html")), false);
    assert.equal(existsSync(path.join(precious, "site-engine.txt")), false);

    const empty = path.join(root, "empty");
    await mkdir(empty);
    assert.equal(run(factsPath, empty).status, 0);
    assert.equal(await readFile(path.join(empty, "site-engine.txt"), "utf8"), marker);

    facts.tagline = "A second fictional term";
    const againPath = await writeJson(root, facts, "again.json");
    assert.equal(run(againPath, empty).status, 0);
    const rebuilt = await readFile(path.join(empty, "index.html"), "utf8");
    assert.match(rebuilt, /A second fictional term/);
    assert.equal(await readFile(path.join(empty, "site-engine.txt"), "utf8"), marker);

    const fake = path.join(root, "fake");
    await mkdir(fake);
    await writeFile(path.join(fake, "site-engine.txt"), "not a build\n");
    await writeFile(path.join(fake, "keep.txt"), "KEEP-THIS-9f3a\n");
    const wrong = run(factsPath, fake);
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /Output folder is not an earlier Site Engine build: fake/);
    assert.equal(await readFile(path.join(fake, "keep.txt"), "utf8"), "KEEP-THIS-9f3a\n");
    assert.equal(existsSync(path.join(fake, "index.html")), false);

    const linked = path.join(root, "linked");
    await mkdir(linked);
    await writeFile(path.join(root, "elsewhere.txt"), marker);
    await symlink(path.join(root, "elsewhere.txt"), path.join(linked, "site-engine.txt"));
    await writeFile(path.join(linked, "keep.txt"), "KEEP-LINK-9f3a\n");
    const linkRun = run(factsPath, linked);
    assert.notEqual(linkRun.status, 0);
    assert.match(linkRun.stderr, /Output folder is not an earlier Site Engine build: linked/);
    assert.equal(await readFile(path.join(linked, "keep.txt"), "utf8"), "KEEP-LINK-9f3a\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a named pipe is refused instead of waiting for a writer", async () => {
  const root = await tempDir();
  try {
    const made = spawnSync("mkfifo", [path.join(root, "photo.webp")]);
    assert.equal(made.status, 0, made.stderr);
    const facts = await loadFixture("northglass-tutoring.facts.json");
    facts.images = [{ file: "photo.webp", alt: "A fictional picture" }];
    const out = path.join(root, "site");
    const result = spawnSync(process.execPath, [CLI, "--facts", await writeJson(root, facts), "--out", out], {
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Image is not a file: photo\.webp/);
    assert.equal(existsSync(out), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a JFXX header is removed and a plain JFIF header is kept", async () => {
  const root = await tempDir();
  try {
    const parts = [Buffer.from([0xff, 0xd8])];
    parts.push(jpegSegment(0xe0, jfifPayload()));
    parts.push(
      jpegSegment(
        0xe0,
        Buffer.concat([Buffer.from("JFXX\0"), Buffer.from([0x10]), Buffer.from("HIDDEN-JFXX-9f3a")]),
      ),
    );
    parts.push(jpegSegment(0xc0, Buffer.from([0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00])));
    parts.push(jpegSegment(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])));
    parts.push(Buffer.from([0x00, 0xff, 0xd9]));
    await writeFile(path.join(root, "card.jpg"), Buffer.concat(parts));
    const facts = await loadFixture("marrow-lane-bakery.facts.json");
    facts.images = [{ file: "card.jpg", alt: "A fictional card" }];
    const out = path.join(root, "site");
    const result = run(await writeJson(root, facts), out);
    assert.equal(result.status, 0, result.stderr);
    const jpeg = await readFile(path.join(out, "images/1.jpg"));
    const text = textOf(jpeg);
    assert.equal(text.includes("JFIF"), true);
    assert.equal(text.includes("JFXX"), false);
    assert.equal(text.includes("HIDDEN-JFXX-9f3a"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
