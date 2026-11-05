import fs from "node:fs";
import path from "node:path";
import { applyOperation, emptyState, read, renderWrites } from "./index.mjs";

const args = process.argv.slice(2);
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? path.resolve(args[dirAt + 1]) : null;
const nowAt = args.indexOf("--now");
const now = nowAt >= 0 ? args[nowAt + 1] : "2040-01-02T12:00:00.000Z";
const rest = args.filter((_, i) => ![dirAt, dirAt + 1, nowAt, nowAt + 1].includes(i));
const [verb, ...values] = rest;
if (!dir || !verb) fail("Use --dir <sample folder> <verb>.");
const marker = path.join(dir, "SAMPLE-ONLY");
if (verb === "init") {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) fail("Init needs an empty folder.");
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, "Invented sample data only.\n");
  save(emptyState([{ id: "personal", name: "Personal", kind: "personal" }, { id: "studio", name: "Invented Studio", kind: "business" }]));
  console.log("Sample memory folder created."); process.exit(0);
}
if (!fs.existsSync(marker)) fail("This isn't a sample memory folder. Run init in an empty folder first.");
let interrupted = false;
let state = load();
if (verb === "read") { const found = read(state, { space: values[0], cloud: values.includes("--cloud") }); console.log(found.length ? JSON.stringify(found, null, 2) : "Nothing kept in this space yet."); process.exit(0); }
if (verb === "show") { if (interrupted) console.log("The last change didn't finish and was not saved."); console.log(JSON.stringify(state, null, 2)); process.exit(0); }
const dataAt = values.indexOf("--data");
if (dataAt < 0) fail("This verb needs --data followed by an invented JSON operation.");
let op; try { op = JSON.parse(values[dataAt + 1]); } catch { fail("The --data value must be JSON."); }
op.type = verb; op.now ??= now;
try { const out = applyOperation(state, op); save(out.state, verb === "purge"); console.log(JSON.stringify(out.result, null, 2)); } catch (error) { fail(error.message); }

function statePath() { return path.join(dir, ".sample-state.json"); }
function committedPath() { return path.join(dir, ".sample-committed.json"); }
function purgePath() { return path.join(dir, ".purge-first.json"); }
function load() {
  if (fs.existsSync(purgePath())) {
    interrupted = true;
    const purged = JSON.parse(fs.readFileSync(purgePath(), "utf8"));
    save(purged, true);
    return purged;
  }
  try {
    const current = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    const expectedLog = renderWrites(current).find((write) => write.path === ".log/log.jsonl").text;
    const actualLog = fs.readFileSync(path.join(dir, ".log/log.jsonl"), "utf8");
    if (expectedLog === actualLog) return current;
    interrupted = true;
    const recovered = JSON.parse(fs.readFileSync(committedPath(), "utf8"));
    save(recovered);
    return recovered;
  } catch {
    if (fs.existsSync(committedPath())) { interrupted = true; const recovered = JSON.parse(fs.readFileSync(committedPath(), "utf8")); save(recovered); return recovered; }
    fail("The last change didn't finish and was not saved.");
  }
}
function atomic(file, text) { const full = path.resolve(dir, file); if (full !== marker && !full.startsWith(dir + path.sep)) fail("A sample write tried to leave the sample folder."); fs.mkdirSync(path.dirname(full), { recursive: true }); const temp = full + ".tmp"; fs.writeFileSync(temp, text); fs.renameSync(temp, full); }
function save(next, purgeFirst = false) {
  const writes = renderWrites(next); const log = writes.find((w) => w.path === ".log/log.jsonl");
  if (purgeFirst) { atomic(".purge-first.json", JSON.stringify(next, null, 2) + "\n"); atomic(log.path, log.text); }
  atomic(".sample-state.json", JSON.stringify(next, null, 2) + "\n");
  for (const write of writes) if (write !== log) atomic(write.path, write.text);
  if (!purgeFirst) atomic(log.path, log.text);
  atomic(".sample-committed.json", JSON.stringify(next, null, 2) + "\n");
  if (purgeFirst && fs.existsSync(purgePath())) fs.rmSync(purgePath());
}
function fail(message) { console.error(message); process.exit(1); }
