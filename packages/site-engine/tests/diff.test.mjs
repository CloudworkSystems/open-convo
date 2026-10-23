import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { diffFacts } from "../src/diff.mjs";
import { SiteEngineError } from "../src/errors.mjs";

const CLI = fileURLToPath(new URL("../src/diff.mjs", import.meta.url));
const DIFF_LIB = CLI;
const FIXTURES = fileURLToPath(new URL("../fixtures/", import.meta.url));
const BAKERY = "marrow-lane-bakery.facts.json";
const TUTOR = "northglass-tutoring.facts.json";
const ADDRESS = "18 Marrow Lane, Hearthwick, Northglass 00000, Freedonia";
const HOURS = "Tue\u2013Fri 07:00\u201314:00; Sat 08:00\u201313:00";
const MARKER = "MARKER-private-notes-9f3a";

function runDiff(args, cwd) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd });
}

async function loadFixture(name) {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "site-engine-diff-"));
}

async function writeJson(dir, facts, name) {
  const file = path.join(dir, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(facts, null, 2)}\n`);
  return file;
}

function assertChangeShape(result) {
  assert.equal(result.schemaVersion, 1);
  assert.ok(Array.isArray(result.changes));
  for (const item of result.changes) {
    assert.deepEqual(Object.keys(item), ["area", "kind", "path", "before", "after", "sentence"]);
  }
}

function assertCli(oldPath, newPath, result, cwd) {
  const text = runDiff(["--old", oldPath, "--new", newPath], cwd);
  const json = runDiff(["--json", "--old", oldPath, "--new", newPath], cwd);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(text.stderr, "");
  assert.equal(json.stderr, "");
  const expectedText =
    result.changes.length === 0
      ? "Nothing on the site changes.\n"
      : `${result.changes.map((item) => item.sentence).join("\n")}\n`;
  assert.equal(text.stdout, expectedText);
  assert.equal(json.stdout, `${JSON.stringify(result)}\n`);
  assert.deepEqual(JSON.parse(json.stdout), result);
}

async function withPair(oldFacts, newFacts, files, fn) {
  const root = await tempDir();
  try {
    const oldDir = path.join(root, "old");
    const newDir = path.join(root, "new");
    await mkdir(oldDir);
    await mkdir(newDir);
    for (const file of files) {
      const dir = file.side === "old" ? oldDir : newDir;
      await writeFile(path.join(dir, file.name), file.bytes);
    }
    const oldPath = await writeJson(oldDir, oldFacts, "facts.json");
    const newPath = await writeJson(newDir, newFacts, "facts.json");
    const result = await diffFacts(oldPath, newPath);
    assertChangeShape(result);
    assertCli(oldPath, newPath, result, root);
    await fn({ root, oldPath, newPath, result, sentences: result.changes.map((item) => item.sentence) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function expectSentences(expected, mutate, base = BAKERY, files = []) {
  const oldFacts = await loadFixture(base);
  const newFacts = structuredClone(oldFacts);
  mutate(oldFacts, newFacts);
  await withPair(oldFacts, newFacts, files, ({ sentences }) => {
    assert.deepEqual(sentences, expected);
  });
}

function sides(name, bytes) {
  return [
    { side: "old", name, bytes },
    { side: "new", name, bytes },
  ];
}

function crc32(buf) {
  let crc = 0xffffffff;
  for (let index = 0; index < buf.length; index += 1) {
    crc ^= buf[index];
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

function pngWithPixel(pixel) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibStore(Buffer.from(pixel))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function cleanPng() {
  return pngWithPixel([0, 0]);
}

function otherPng() {
  return pngWithPixel([0, 255]);
}

function dirtyPng() {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const text = Buffer.concat([
    Buffer.from("Comment\0", "latin1"),
    Buffer.from("GPSLatitude=13.3701 GPSLongitude=-84.4281"),
  ]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("tEXt", text),
    pngChunk("tIME", Buffer.from([0x07, 0xe9, 1, 2, 3, 4, 5])),
    pngChunk("IDAT", zlibStore(Buffer.from([0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
    Buffer.from("TRAILING-GPS"),
  ]);
}

function rye(price, description = "A slow-fermented rye, sold whole.") {
  return { name: "Rye loaf", description, price };
}

function runQuiet(oldPath, newPath) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "site-engine-quiet-"));
  const resultPath = path.join(dir, "result.json");
  const code = `
    import { writeFileSync } from "node:fs";
    import { diffFacts } from ${JSON.stringify(DIFF_LIB)};
    try {
      const result = await diffFacts(${JSON.stringify(oldPath)}, ${JSON.stringify(newPath)});
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ ok: true, result }));
    } catch (error) {
      writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({
        ok: false,
        name: error.name,
        message: error.message,
      }));
    }
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
  const recorded = JSON.parse(readFileSync(resultPath, "utf8"));
  rmSync(dir, { recursive: true, force: true });
  return { stdout: run.stdout, stderr: run.stderr, status: run.status, ...recorded };
}

async function snapshot(dir) {
  const found = {};
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(full);
      else found[path.relative(dir, full)] = (await readFile(full)).toString("base64");
    }
  }
  await visit(dir);
  return found;
}

test("1. the same file against itself changes nothing", async () => {
  const factsPath = path.join(FIXTURES, BAKERY);
  const result = await diffFacts(factsPath, factsPath);
  assert.deepEqual(result, { schemaVersion: 1, changes: [] });
  const quiet = runQuiet(factsPath, factsPath);
  assert.equal(quiet.status, 0);
  assert.equal(quiet.stdout, "");
  assert.equal(quiet.stderr, "");
  assert.equal(quiet.ok, true);
  assert.deepEqual(quiet.result, result);
  const run = runDiff(["--old", factsPath, "--new", factsPath]);
  assert.equal(run.status, 0);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, "Nothing on the site changes.\n");
  const again = runDiff(["--old", factsPath, "--new", factsPath]);
  const json = runDiff(["--json", "--old", factsPath, "--new", factsPath]);
  const jsonAgain = runDiff(["--json", "--old", factsPath, "--new", factsPath]);
  assert.equal(again.stdout, run.stdout);
  assert.equal(json.stdout, jsonAgain.stdout);
  assert.equal(json.stdout, `${JSON.stringify(result)}\n`);
});

test("name and description each change alone, with their exact sentences", async () => {
  await expectSentences(["Name: Marrow Lane Bakery becomes Hearthwick Oven"], (_oldFacts, next) => {
    next.name = "Hearthwick Oven";
  });
  await expectSentences(
    [
      "Description: A fictional neighborhood bakery. We bake rye, buns, and a Friday pie. Nothing here is a real shop. becomes A fictional neighborhood bakery. We bake rye, buns, and a Friday tart.",
    ],
    (_oldFacts, next) => {
      next.description = "A fictional neighborhood bakery. We bake rye, buns, and a Friday tart.";
    },
  );
});

test("2. each area changed alone gives its sentence", async () => {
  await expectSentences(
    ["Tagline: Rye bread and morning buns becomes Rye bread and afternoon buns"],
    (_oldFacts, next) => {
      next.tagline = "Rye bread and afternoon buns";
    },
  );
  await expectSentences(["New service: Gift cards"], (_oldFacts, next) => {
    next.services.push({ name: "Gift cards", description: "A card for a later loaf.", price: "$25" });
  });
  await expectSentences(["Service removed: Morning bun"], (_oldFacts, next) => {
    next.services = next.services.filter((service) => service.name !== "Morning bun");
  });
  await expectSentences(["Price of Rye loaf: $9 becomes $10"], (_oldFacts, next) => {
    next.services[0].price = "$10";
  });
  await expectSentences(["Price of Rye loaf removed"], (_oldFacts, next) => {
    delete next.services[0].price;
  });
  await expectSentences(
    ["Description of Rye loaf: A slow-fermented rye, sold whole. becomes A slow rye, sold by the slice."],
    (_oldFacts, next) => {
      next.services[0].description = "A slow rye, sold by the slice.";
    },
  );
  await expectSentences(
    ["Hours on Sat: 08:00\u201313:00 becomes 10:00\u201314:00"],
    (_oldFacts, next) => {
      next.hours[1] = { days: "Sat", open: "10:00", close: "14:00" };
    },
  );
  await expectSentences(["New hours: Sun 09:00\u201312:00"], (_oldFacts, next) => {
    next.hours.push({ days: "Sun", open: "09:00", close: "12:00" });
  });
  await expectSentences(["No longer open: Sat"], (_oldFacts, next) => {
    next.hours = next.hours.filter((slot) => slot.days !== "Sat");
  });
  await expectSentences(["Phone: +1 206 555 0142 becomes +1 206 555 0199"], (_oldFacts, next) => {
    next.contact.phone = "+1 206 555 0199";
  });
  await expectSentences(
    ["Email: hello@marrow-lane.example becomes oven@marrow-lane.example"],
    (_oldFacts, next) => {
      next.contact.email = "oven@marrow-lane.example";
    },
  );
  await expectSentences(
    [
      "Booking link: https://booking.marrow-lane.example/visit becomes https://booking.marrow-lane.example/saturday",
    ],
    (_oldFacts, next) => {
      next.contact.bookingUrl = "https://booking.marrow-lane.example/saturday";
    },
  );
  await expectSentences(["New phone: +1 206 555 0148"], (_oldFacts, next) => {
    next.contact.phone = "+1 206 555 0148";
  }, TUTOR);
  await expectSentences(
    ["Email removed: hello@marrow-lane.example"],
    (_oldFacts, next) => {
      delete next.contact.email;
    },
  );
  await expectSentences(
    [
      "Label of https://journal.marrow-lane.example/: The bakery journal becomes The oven notes",
    ],
    (_oldFacts, next) => {
      next.social[0].label = "The oven notes";
    },
  );
  await expectSentences(
    ["Site address: https://marrow-lane.example/ becomes https://oven.marrow-lane.example/. The page's canonical link and sitemap change too."],
    (_oldFacts, next) => {
      next.siteUrl = "https://oven.marrow-lane.example/";
    },
  );
});

test("2. every location row gives exactly its sentences", async () => {
  await expectSentences(["Street: 18 Marrow Lane becomes 20 Marrow Lane"], (_oldFacts, next) => {
    next.location.street = "20 Marrow Lane";
  });
  await expectSentences(
    [
      "Street: 18 Marrow Lane becomes 20 Marrow Lane",
      "City: Hearthwick becomes Milltown",
      "Region: Northglass becomes Southglass",
      "Postal code: 00000 becomes 00001",
      "Country: Freedonia becomes Exemplia",
    ],
    (_oldFacts, next) => {
      next.location = {
        street: "20 Marrow Lane",
        city: "Milltown",
        region: "Southglass",
        postalCode: "00001",
        country: "Exemplia",
      };
    },
  );
  await expectSentences(
    [
      `Location: ${ADDRESS} becomes Online only`,
      "Search engines will see an online business, with no address",
    ],
    (_oldFacts, next) => {
      next.location = "Online only";
    },
  );
  await expectSentences(
    [
      `Location: Online only becomes ${ADDRESS}`,
      "Search engines will see a local business at this address",
    ],
    (previous, _next) => {
      previous.location = "Online only";
    },
  );
  await expectSentences(
    ["Location section removed (it said: Online only)"],
    (previous, next) => {
      previous.location = "Online only";
      delete next.location;
    },
  );
  await expectSentences(["New Location section: Online only"], (previous, next) => {
    delete previous.location;
    next.location = "Online only";
  });
  await expectSentences(
    [
      `New Location section: ${ADDRESS}`,
      "Search engines will see a local business at this address",
    ],
    (previous) => {
      delete previous.location;
    },
  );
  await expectSentences(
    [
      `Location section removed (it said: ${ADDRESS})`,
      "Search engines will see an online business, with no address",
    ],
    (_oldFacts, next) => {
      delete next.location;
    },
  );
});

test("2. services, photos, social links, and contact appear and disappear as one section", async () => {
  await expectSentences(
    ["New Services section: Rye loaf; Morning bun"],
    (previous) => {
      delete previous.services;
    },
  );
  await expectSentences(["Services section removed (it said: Rye loaf; Morning bun)"], (_oldFacts, next) => {
    delete next.services;
  });
  await expectSentences(
    ["New Social section: The bakery journal (https://journal.marrow-lane.example/)"],
    (previous) => {
      delete previous.social;
    },
  );
  await expectSentences(
    ["Social section removed (it said: The bakery journal (https://journal.marrow-lane.example/))"],
    (_oldFacts, next) => {
      delete next.social;
    },
  );
  const contact = "+1 206 555 0142; hello@marrow-lane.example; https://booking.marrow-lane.example/visit";
  await expectSentences([`New Contact section: ${contact}`], (previous) => {
    delete previous.contact;
  });
  await expectSentences([`Contact section removed (it said: ${contact})`], (_oldFacts, next) => {
    delete next.contact;
  });

  const loaf = cleanPng();
  const bun = otherPng();
  const oldFacts = await loadFixture(BAKERY);
  const newFacts = structuredClone(oldFacts);
  newFacts.images = [
    { file: "loaf.png", alt: "A rye loaf" },
    { file: "bun.png", alt: "A morning bun" },
  ];
  await withPair(
    oldFacts,
    newFacts,
    [
      { side: "new", name: "loaf.png", bytes: loaf },
      { side: "new", name: "bun.png", bytes: bun },
    ],
    ({ sentences }) => {
      assert.deepEqual(sentences, ["New Photos section: A rye loaf; A morning bun"]);
    },
  );
  await withPair(
    newFacts,
    oldFacts,
    [
      { side: "old", name: "loaf.png", bytes: loaf },
      { side: "old", name: "bun.png", bytes: bun },
    ],
    ({ sentences }) => {
      assert.deepEqual(sentences, ["Photos section removed (it said: A rye loaf; A morning bun)"]);
    },
  );
});

test("2. all six hours forms give one sentence and no per-day or order line", async () => {
  const list = [
    { days: "Tue\u2013Fri", open: "07:00", close: "14:00" },
    { days: "Sat", open: "08:00", close: "13:00" },
  ];
  await expectSentences(["New Hours section: By appointment"], (previous, next) => {
    delete previous.hours;
    next.hours = "By appointment";
  });
  await expectSentences(["Hours section removed (it said: By appointment)"], (previous, next) => {
    previous.hours = "By appointment";
    delete next.hours;
  });
  await expectSentences([`New Hours section: ${HOURS}`], (previous) => {
    delete previous.hours;
  });
  await expectSentences([`Hours section removed (it said: ${HOURS})`], (_oldFacts, next) => {
    delete next.hours;
  });
  await expectSentences(
    [`Hours become: By appointment (instead of: ${HOURS})`],
    (_oldFacts, next) => {
      next.hours = "By appointment";
    },
  );
  await expectSentences(
    [`Hours become: ${HOURS} (instead of: By appointment)`],
    (previous) => {
      previous.hours = "By appointment";
    },
  );
  assert.deepEqual(list.map((slot) => `${slot.days} ${slot.open}\u2013${slot.close}`).join("; "), HOURS);
});

test("3. a renamed service is one removed and one new; reordering is its own sentence", async () => {
  await expectSentences(
    ["New service: Gift cards", "Service removed: Morning bun"],
    (_oldFacts, next) => {
      next.services[1] = { name: "Gift cards", description: "A card for a later loaf.", price: "$25" };
    },
  );
  await expectSentences(["The order of services changes"], (_oldFacts, next) => {
    next.services = [next.services[1], next.services[0]];
  });
  await expectSentences(
    ["Price of Rye loaf: $9 becomes $10", "The order of services changes"],
    (_oldFacts, next) => {
      next.services = [
        next.services[1],
        { ...next.services[0], price: "$10" },
      ];
    },
  );
  await expectSentences(["The order of hours changes"], (_oldFacts, next) => {
    next.hours = [next.hours[1], next.hours[0]];
  });
  await expectSentences(["The order of social links changes"], (_oldFacts, next) => {
    const extra = { label: "Practice sheet", url: "https://notes.marrow-lane.example/" };
    const journal = { label: "The bakery journal", url: "https://journal.marrow-lane.example/" };
    _oldFacts.social = [journal, extra];
    next.social = [extra, journal];
  });

  const loaf = cleanPng();
  const bun = otherPng();
  const base = await loadFixture(BAKERY);
  const previous = structuredClone(base);
  const next = structuredClone(base);
  previous.images = [
    { file: "loaf.png", alt: "A rye loaf" },
    { file: "bun.png", alt: "A morning bun" },
  ];
  next.images = [
    { file: "bun.png", alt: "A morning bun" },
    { file: "loaf.png", alt: "A rye loaf" },
  ];
  await withPair(
    previous,
    next,
    [...sides("loaf.png", loaf), ...sides("bun.png", bun)],
    ({ sentences }) => {
      assert.deepEqual(sentences, ["The order of photos changes"]);
    },
  );
});

test("4. repeated keys pair identical copies first, then by position", async () => {
  await expectSentences(
    ["Price of Rye loaf: $9 becomes $12", "Price of Rye loaf: $10 becomes $14"],
    (_oldFacts, next) => {
      _oldFacts.services = [rye("$9"), rye("$10")];
      next.services = [rye("$12"), rye("$14")];
    },
  );
  await expectSentences(["New service: Rye loaf"], (_oldFacts, next) => {
    _oldFacts.services = [rye("$9"), rye("$10")];
    next.services = [rye("$9"), rye("$10"), rye("$11", "A third loaf.")];
  });
  await expectSentences(["The order of services changes"], (_oldFacts, next) => {
    _oldFacts.services = [rye("$9", "First bake"), rye("$10", "Second bake")];
    next.services = [rye("$10", "Second bake"), rye("$9", "First bake")];
  });
  await expectSentences(
    [
      "Hours on Sat: 08:00\u201310:00 becomes 08:00\u201311:00",
      "Hours on Sat: 12:00\u201314:00 becomes 12:00\u201315:00",
    ],
    (_oldFacts, next) => {
      _oldFacts.hours = [
        { days: "Sat", open: "08:00", close: "10:00" },
        { days: "Sat", open: "12:00", close: "14:00" },
      ];
      next.hours = [
        { days: "Sat", open: "08:00", close: "11:00" },
        { days: "Sat", open: "12:00", close: "15:00" },
      ];
    },
  );
  await expectSentences(["The order of hours changes"], (_oldFacts, next) => {
    const early = { days: "Sat", open: "08:00", close: "10:00" };
    const late = { days: "Sat", open: "12:00", close: "14:00" };
    _oldFacts.hours = [early, late];
    next.hours = [late, early];
  });
  await expectSentences(
    [
      "Label of https://notes.example/board: First notes becomes First revision",
      "Label of https://notes.example/board: Second notes becomes Second revision",
    ],
    (_oldFacts, next) => {
      const url = "https://notes.example/board";
      _oldFacts.social = [
        { label: "First notes", url },
        { label: "Second notes", url },
      ];
      next.social = [
        { label: "First revision", url },
        { label: "Second revision", url },
      ];
    },
  );
});

test("5. a description change with line breaks prints as one line", async () => {
  const before = "a\nb\rc\td\\e\u0085\u2028\u2029\u009b";
  const after = "f\ng\rh\ti\\j\u0085\u2028\u2029\u009b";
  const sentence =
    "Description: a\\nb\\rc\\td\\\\e\\u0085\\u2028\\u2029\\u009b becomes f\\ng\\rh\\ti\\\\j\\u0085\\u2028\\u2029\\u009b";
  const oldFacts = await loadFixture(BAKERY);
  const newFacts = structuredClone(oldFacts);
  oldFacts.description = before;
  newFacts.description = after;
  await withPair(oldFacts, newFacts, [], ({ result, sentences, oldPath, newPath, root }) => {
    assert.deepEqual(sentences, [sentence]);
    assert.equal(sentence.includes("\n"), false);
    assert.equal(sentence.includes("\r"), false);
    assert.equal(result.changes[0].before, before);
    assert.equal(result.changes[0].after, after);
    const printed = runDiff(["--old", oldPath, "--new", newPath], root);
    assert.equal(printed.stdout, `${sentence}\n`);
    assert.equal(printed.stdout.split("\n").length, 2);
    const parsed = JSON.parse(runDiff(["--json", "--old", oldPath, "--new", newPath], root).stdout);
    assert.equal(parsed.changes[0].before, before);
    assert.equal(parsed.changes[0].after, after);
  });
});

test("6. changes follow the page order", async () => {
  const png = cleanPng();
  const previous = await loadFixture(BAKERY);
  const next = structuredClone(previous);
  previous.images = [{ file: "loaf.png", alt: "A rye loaf" }];
  next.images = [{ file: "loaf.png", alt: "A sliced rye loaf" }];
  next.tagline = "Rye bread and afternoon buns";
  next.services[0].price = "$10";
  next.hours[1] = { days: "Sat", open: "10:00", close: "14:00" };
  next.social[0].label = "The oven notes";
  next.brand.accent = "#8fd0b0";
  next.siteUrl = "https://oven.marrow-lane.example/";
  await withPair(previous, next, sides("loaf.png", png), ({ sentences }) => {
    assert.deepEqual(sentences, [
      "Tagline: Rye bread and morning buns becomes Rye bread and afternoon buns",
      "Photo description changes: A rye loaf becomes A sliced rye loaf",
      "Price of Rye loaf: $9 becomes $10",
      "Hours on Sat: 08:00\u201313:00 becomes 10:00\u201314:00",
      "Label of https://journal.marrow-lane.example/: The bakery journal becomes The oven notes",
      "Accent color: #f37a4a becomes #8fd0b0",
      "Site address: https://marrow-lane.example/ becomes https://oven.marrow-lane.example/. The page's canonical link and sitemap change too.",
    ]);
  });
});

test("7. photos: new, removed, alt text, replaced file, and metadata only", async () => {
  const loaf = cleanPng();
  const bun = otherPng();
  const base = await loadFixture(BAKERY);

  const withOne = structuredClone(base);
  withOne.images = [{ file: "loaf.png", alt: "A rye loaf" }];
  const withTwo = structuredClone(base);
  withTwo.images = [
    { file: "loaf.png", alt: "A rye loaf" },
    { file: "bun.png", alt: "A morning bun" },
  ];
  await withPair(
    withOne,
    withTwo,
    [...sides("loaf.png", loaf), { side: "new", name: "bun.png", bytes: bun }],
    ({ sentences }) => {
      assert.deepEqual(sentences, ["New photo: A morning bun"]);
    },
  );
  await withPair(
    withTwo,
    withOne,
    [...sides("loaf.png", loaf), { side: "old", name: "bun.png", bytes: bun }],
    ({ sentences }) => {
      assert.deepEqual(sentences, ["Photo removed: A morning bun"]);
    },
  );

  const retitled = structuredClone(withOne);
  retitled.images = [{ file: "loaf.png", alt: "A sliced rye loaf" }];
  await withPair(withOne, retitled, sides("loaf.png", loaf), ({ sentences, result }) => {
    assert.deepEqual(sentences, ["Photo description changes: A rye loaf becomes A sliced rye loaf"]);
    assert.equal(result.changes[0].path, "images[0].alt");
    assert.equal(result.changes[0].before, "A rye loaf");
    assert.equal(result.changes[0].after, "A sliced rye loaf");
  });

  const replaced = structuredClone(withOne);
  await withPair(
    withOne,
    replaced,
    [
      { side: "old", name: "loaf.png", bytes: loaf },
      { side: "new", name: "loaf.png", bytes: bun },
    ],
    ({ sentences }) => {
      assert.deepEqual(sentences, ["Photo replaced: A rye loaf"]);
    },
  );

  await withPair(
    withOne,
    withOne,
    [
      { side: "old", name: "loaf.png", bytes: loaf },
      { side: "new", name: "loaf.png", bytes: dirtyPng() },
    ],
    ({ sentences }) => {
      assert.deepEqual(sentences, []);
    },
  );
});

test("8. brand colors use the resolved value, and contrast failures are refusals", async () => {
  await expectSentences([], (previous, next) => {
    delete previous.brand;
    next.brand = { background: "#15110f", text: "#F7F2EE", accent: "#f37a4a" };
  });
  await expectSentences([], (previous, next) => {
    previous.brand = { accent: "#FFF" };
    next.brand = { accent: "#ffffff" };
  });
  await expectSentences(["Background color: #15110f becomes #0e0c0b"], (_oldFacts, next) => {
    next.brand.background = "#0e0c0b";
  });
  await expectSentences(["Text color: #f7f2ee becomes #ffffff"], (_oldFacts, next) => {
    next.brand.text = "#ffffff";
  });
  await expectSentences(["Accent color: #f37a4a becomes #8fd0b0"], (_oldFacts, next) => {
    next.brand.accent = "#8fd0b0";
  });
  await expectSentences(
    [
      "Background color: #a9a9a9 becomes #aaaaaa",
      "The page now asks browsers for a light color scheme (was dark)",
    ],
    (previous, next) => {
      previous.brand = { background: "#a9a9a9", text: "#111111", accent: "#222222" };
      next.brand = { background: "#aaaaaa", text: "#111111", accent: "#222222" };
    },
  );
  await expectSentences(
    [
      "Background color: #aaaaaa becomes #a9a9a9",
      "The page now asks browsers for a dark color scheme (was light)",
    ],
    (previous, next) => {
      previous.brand = { background: "#aaaaaa", text: "#111111", accent: "#222222" };
      next.brand = { background: "#a9a9a9", text: "#111111", accent: "#222222" };
    },
  );
  await expectSentences(
    [
      "Background color: #15110f becomes #0e0c0b",
      "Text color: #f7f2ee becomes #ffffff",
      "Accent color: #f37a4a becomes #8fd0b0",
    ],
    (_oldFacts, next) => {
      next.brand = { background: "#0e0c0b", text: "#ffffff", accent: "#8fd0b0" };
    },
  );

  const root = await tempDir();
  try {
    const good = await loadFixture(BAKERY);
    const goodPath = await writeJson(root, good, "good.json");
    const cases = [
      { background: "#ffffff", text: "#ffffff", accent: "#111111" },
      { background: "#15110f", text: "#15110f", accent: "#f37a4a" },
      { background: "#15110f", text: "#f7f2ee", accent: "#2f6f4f" },
    ];
    for (const [index, brand] of cases.entries()) {
      const bad = structuredClone(good);
      bad.brand = brand;
      const badPath = await writeJson(root, bad, `bad-${index}.json`);
      await assert.rejects(() => diffFacts(goodPath, badPath), (error) => {
        assert.ok(error instanceof SiteEngineError);
        assert.match(error.message, /Brand colors fail WCAG AA contrast/);
        assert.match(error.message, /Refused the new file/);
        assert.equal(error.message.includes("Background color"), false);
        return true;
      });
      const run = runDiff(["--old", goodPath, "--new", badPath], root);
      assert.equal(run.status, 1);
      assert.equal(run.stdout, "");
      assert.match(run.stderr, /Brand colors fail WCAG AA contrast/);
      assert.match(run.stderr, /Refused the new file/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("8a. diffFacts returns data, prints nothing, and the command prints sentences or json", async () => {
  const oldFacts = await loadFixture(BAKERY);
  const newFacts = structuredClone(oldFacts);
  newFacts.tagline = "Rye bread and afternoon buns";
  await withPair(oldFacts, newFacts, [], async ({ result, oldPath, newPath }) => {
    assert.equal(result.changes.length, 1);
    assert.equal(result.changes[0].area, "tagline");
    assert.equal(result.changes[0].kind, "changed");
    assert.equal(result.changes[0].path, "tagline");
    assert.equal(result.changes[0].before, "Rye bread and morning buns");
    assert.equal(result.changes[0].after, "Rye bread and afternoon buns");
    const quiet = runQuiet(oldPath, newPath);
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "");
    assert.equal(quiet.stderr, "");
    assert.equal(quiet.ok, true);
    assert.deepEqual(quiet.result, result);
  });

  const root = await tempDir();
  try {
    const good = await loadFixture(BAKERY);
    const bad = structuredClone(good);
    delete bad.name;
    const goodPath = await writeJson(root, good, "good.json");
    const badPath = await writeJson(root, bad, "bad.json");
    const quiet = runQuiet(badPath, goodPath);
    assert.equal(quiet.status, 0);
    assert.equal(quiet.stdout, "");
    assert.equal(quiet.stderr, "");
    assert.equal(quiet.ok, false);
    assert.equal(quiet.name, "SiteEngineError");
    assert.match(quiet.message, /Missing required field: name/);
    assert.match(quiet.message, /Refused the current file/);
    const run = runDiff(["--old", badPath, "--new", goodPath], root);
    assert.equal(run.status, 1);
    assert.equal(run.stdout, "");
    assert.match(run.stderr, /Missing required field: name/);
    assert.match(run.stderr, /Refused the current file/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("9. every build refusal is a diff refusal for either file and lists no changes", async () => {
  const root = await tempDir();
  try {
    const good = await loadFixture(BAKERY);
    const goodPath = await writeJson(root, good, "good.json");
    const outside = path.join(root, "outside.png");
    await writeFile(outside, cleanPng());

    async function refuse(which, fileName, arrange, message) {
      const dir = path.join(root, `${which}-${fileName}`);
      await mkdir(dir, { recursive: true });
      const badPath = await arrange(dir);
      const oldPath = which === "current" ? badPath : goodPath;
      const newPath = which === "new" ? badPath : goodPath;
      const quiet = runQuiet(oldPath, newPath);
      assert.equal(quiet.stdout, "", fileName);
      assert.equal(quiet.stderr, "", fileName);
      assert.equal(quiet.ok, false, fileName);
      assert.equal(quiet.name, "SiteEngineError", fileName);
      assert.match(quiet.message, message, `${fileName}: ${quiet.message}`);
      assert.match(quiet.message, new RegExp(`Refused the ${which} file`));
      assert.equal(quiet.message.includes(MARKER), false, fileName);
      const run = runDiff(["--old", oldPath, "--new", newPath], root);
      assert.equal(run.status, 1, fileName);
      assert.equal(run.stdout, "", fileName);
      assert.match(run.stderr, message, fileName);
      assert.match(run.stderr, new RegExp(`Refused the ${which} file`));
      assert.equal(run.stdout.includes(MARKER), false, fileName);
      assert.equal(run.stderr.includes(MARKER), false, fileName);
    }

    const cases = [
      [
        "unknown",
        /Unknown field: privateNotes/,
        async (dir) => {
          const facts = await loadFixture(BAKERY);
          facts.privateNotes = MARKER;
          return writeJson(dir, facts, "facts.json");
        },
      ],
      [
        "missing",
        /Missing required field: tagline/,
        async (dir) => {
          const facts = await loadFixture(BAKERY);
          delete facts.tagline;
          return writeJson(dir, facts, "facts.json");
        },
      ],
      [
        "contrast",
        /Brand colors fail WCAG AA contrast/,
        async (dir) => {
          const facts = await loadFixture(BAKERY);
          facts.brand = { background: "#ffffff", text: "#ffffff", accent: "#ffffff" };
          return writeJson(dir, facts, "facts.json");
        },
      ],
      [
        "link",
        /https:\/\//,
        async (dir) => {
          const facts = await loadFixture(BAKERY);
          facts.siteUrl = "javascript:alert(1)";
          return writeJson(dir, facts, "facts.json");
        },
      ],
      [
        "image-path",
        /Image path is not allowed/,
        async (dir) => {
          const facts = await loadFixture(BAKERY);
          facts.images = [{ file: "../secret.png", alt: "An outside photo" }];
          return writeJson(dir, facts, "facts.json");
        },
      ],
      [
        "symlink",
        /Image is a symbolic link: linked.png/,
        async (dir) => {
          await symlink(outside, path.join(dir, "linked.png"));
          const facts = await loadFixture(BAKERY);
          facts.images = [{ file: "linked.png", alt: "A linked loaf" }];
          return writeJson(dir, facts, "facts.json");
        },
      ],
      [
        "json",
        /Facts file is not valid JSON/,
        async (dir) => {
          const file = path.join(dir, "facts.json");
          await writeFile(file, "{");
          return file;
        },
      ],
      [
        "size",
        /Facts file is too large/,
        async (dir) => {
          const file = path.join(dir, "facts.json");
          await writeFile(file, Buffer.alloc(1_000_001, 0x20));
          return file;
        },
      ],
    ];

    for (const which of ["current", "new"]) {
      for (const [name, message, arrange] of cases) {
        await refuse(which, name, arrange, message);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("10. the diff writes nothing and does not import publishing", async () => {
  const source = await readFile(CLI, "utf8");
  assert.equal(source.includes("publish"), false);
  const root = await tempDir();
  try {
    const facts = await loadFixture(BAKERY);
    const oldPath = await writeJson(root, facts, "old.facts.json");
    const next = structuredClone(facts);
    next.tagline = "Rye bread and afternoon buns";
    const newPath = await writeJson(root, next, "new.facts.json");
    await writeFile(path.join(root, "keep.txt"), "keep");
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "stay.txt"), "stay");
    const before = await snapshot(root);
    const run = runDiff(["--old", oldPath, "--new", newPath], root);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(await snapshot(root), before);
    const json = runDiff(["--json", "--old", oldPath, "--new", newPath], root);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual(await snapshot(root), before);
    await diffFacts(oldPath, newPath);
    assert.deepEqual(await snapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("12. the same input twice is byte-identical", async () => {
  const root = await tempDir();
  try {
    const facts = await loadFixture(BAKERY);
    const next = structuredClone(facts);
    next.services[0].price = "$10";
    next.hours[1] = { days: "Sat", open: "10:00", close: "14:00" };
    const oldPath = await writeJson(root, facts, "old.json");
    const newPath = await writeJson(root, next, "new.json");
    const first = runDiff(["--old", oldPath, "--new", newPath], root);
    const second = runDiff(["--old", oldPath, "--new", newPath], root);
    const firstJson = runDiff(["--old", oldPath, "--new", newPath, "--json"], root);
    const secondJson = runDiff(["--old", oldPath, "--new", newPath, "--json"], root);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stderr, second.stderr);
    assert.equal(firstJson.stdout, secondJson.stdout);
    assert.equal(firstJson.stdout, `${JSON.stringify(await diffFacts(oldPath, newPath))}\n`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
