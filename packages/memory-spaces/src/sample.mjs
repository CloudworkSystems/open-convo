import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyOperation, emptyState, read, renderWrites } from "./index.mjs";

export function runSample(args, { output = () => {}, afterWrite = () => {} } = {}) {
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? path.resolve(args[dirAt + 1]) : null;
const nowAt = args.indexOf("--now");
const now = nowAt >= 0 ? args[nowAt + 1] : "2040-01-02T12:00:00.000Z";
const rest = args.filter((_, i) => !(dirAt >= 0 && [dirAt, dirAt + 1].includes(i)) && !(nowAt >= 0 && [nowAt, nowAt + 1].includes(i)));
const [verb, ...values] = rest;
if (!dir || !verb) fail("Use --dir <sample folder> <verb>.");
const marker = path.join(dir, "SAMPLE-ONLY");
if (verb === "init") {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !partialInit()) fail("Init needs an empty folder.");
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(marker, "Invented sample data only.\n");
  afterWrite('SAMPLE-ONLY:written');
  save(initialState());
  output("Sample memory folder created."); return;
}
if (!fs.existsSync(marker)) fail("This isn't a sample memory folder. Run init in an empty folder first.");
let interrupted = false;
let state = load();
if (verb === "read") { const found = read(state, { space: values[0], cloud: values.includes("--cloud") }); output(found.length ? JSON.stringify(found, null, 2) : "Nothing kept in this space yet."); return; }
if (verb === "show") { if (interrupted) output("The last change didn't finish and was not saved."); output(JSON.stringify(state, null, 2)); return; }
const dataAt = values.indexOf("--data");
if (dataAt < 0) fail("This verb needs --data followed by an invented JSON operation.");
let op; try { op = JSON.parse(values[dataAt + 1]); } catch { fail("The --data value must be JSON."); }
op.type = verb; op.now ??= now;
const out = applyOperation(state, op); save(out.state, verb === "purge"); output(JSON.stringify(out.result, null, 2));

function statePath() { return path.join(dir, ".sample-state.json"); }
function committedPath() { return path.join(dir, ".sample-committed.json"); }
function purgePath() { return path.join(dir, ".purge-first.json"); }
function initialState() { return emptyState([{ id: 'personal', name: 'Personal', kind: 'personal' }, { id: 'studio', name: 'Invented Studio', kind: 'business' }]); }
function partialInit() {
  return fs.existsSync(marker) && fs.readdirSync(dir).every(name => ['SAMPLE-ONLY', '.sample-committed.json.tmp'].includes(name));
}
function load() {
  if (partialInit()) {
    interrupted = true;
    const initial = initialState();
    save(initial);
    return initial;
  }
  if (fs.existsSync(purgePath()) || fs.existsSync(purgePath() + '.tmp')) {
    interrupted = true;
    const purged = JSON.parse(fs.readFileSync(fs.existsSync(purgePath()) ? purgePath() : purgePath() + '.tmp', "utf8"));
    save(purged, true);
    return purged;
  }
  try {
    const current = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    const expectedLog = renderWrites(current).find((write) => write.path === ".log/log.jsonl").text;
    const actualLog = fs.readFileSync(path.join(dir, ".log/log.jsonl"), "utf8");
    if (expectedLog === actualLog) {
      const mismatch = renderWrites(current).some((w) => !fs.existsSync(path.join(dir, w.path)) || fs.readFileSync(path.join(dir, w.path), "utf8") !== w.text);
      const history = JSON.parse(fs.readFileSync(committedPath(), 'utf8'));
      const pending = JSON.stringify(history.at(-1)) !== JSON.stringify(current) || fs.existsSync(committedPath() + '.tmp') || fs.existsSync(statePath() + '.tmp');
      if (mismatch || pending) { interrupted = true; save(current, false, true); }
      return current;
    }
    interrupted = true;
    const recovered = JSON.parse(fs.readFileSync(committedPath(), "utf8")).findLast(s => renderWrites(s).find(w => w.path === '.log/log.jsonl').text === actualLog);
    if (!recovered) fail("The saved log has no complete sample state.");
    save(recovered, false, true);
    return recovered;
  } catch {
    if (fs.existsSync(committedPath())) { interrupted = true; const recovered = JSON.parse(fs.readFileSync(committedPath(), "utf8")).at(-1); save(recovered, false, true); return recovered; }
    fail("The last change didn't finish and was not saved.");
  }
}
function atomic(file, text) { const full = path.resolve(dir, file); if (full !== marker && !full.startsWith(dir + path.sep)) fail("A sample write tried to leave the sample folder."); fs.mkdirSync(path.dirname(full), { recursive: true }); const temp = full + ".tmp"; fs.writeFileSync(temp, text); afterWrite(`${file}:temporary`); fs.renameSync(temp, full); afterWrite(`${file}:renamed`); }
function save(next, purgeFirst = false, recovering = false) {
  const writes = renderWrites(next); const log = writes.find((w) => w.path === ".log/log.jsonl");
  if (purgeFirst) { atomic(".purge-first.json", JSON.stringify(next, null, 2) + "\n"); atomic(log.path, log.text); }
  let history = !purgeFirst && fs.existsSync(committedPath()) ? JSON.parse(fs.readFileSync(committedPath(), 'utf8')) : [];
  if (recovering) {
    const index = history.findLastIndex(state => JSON.stringify(state) === JSON.stringify(next));
    const expected = new Set(writes.map(write => write.path));
    const discarded = history.slice(index + 1).flatMap(state => renderWrites(state)).map(write => write.path);
    // Keep the pending history until cleanup completes, so an interrupted cleanup retries.
    for (const file of new Set(discarded)) if (!expected.has(file)) {
      for (const suffix of ['', '.tmp']) {
        const full = path.resolve(dir, file + suffix);
        if (!full.startsWith(dir + path.sep)) fail('A sample cleanup tried to leave the sample folder.');
        if (fs.existsSync(full)) { fs.rmSync(full); afterWrite(`${file}${suffix}:discarded`); }
      }
    }
    history = index >= 0 ? history.slice(0, index + 1) : [];
  }
  if (!history.some(s => JSON.stringify(s) === JSON.stringify(next))) history.push(next);
  atomic('.sample-committed.json', JSON.stringify(history, null, 2) + '\n');
  atomic(".sample-state.json", JSON.stringify(next, null, 2) + "\n");
  for (const write of writes) if (write !== log) atomic(write.path, write.text);
  if (!purgeFirst) atomic(log.path, log.text);
  if (purgeFirst && fs.existsSync(purgePath())) fs.rmSync(purgePath());
}
function fail(message) { throw new Error(message); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runSample(process.argv.slice(2), { output: console.log }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
