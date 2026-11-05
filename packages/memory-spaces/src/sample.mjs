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
function pendingPath() { return path.join(dir, '.sample-pending.json'); }
function initialState() { return emptyState([{ id: 'personal', name: 'Personal', kind: 'personal' }, { id: 'studio', name: 'Invented Studio', kind: 'business' }]); }
function partialInit() {
  const allowed = ['SAMPLE-ONLY', '.sample-committed.json', '.sample-committed.json.tmp', '.sample-pending.json', '.sample-pending.json.tmp'];
  const history = readHistory(committedPath()) ?? readHistory(committedPath() + '.tmp');
  return fs.existsSync(marker) && fs.readdirSync(dir).every(name => allowed.includes(name)) && (!history || history.every(state => state.log.length === 0));
}
function readJson(file, validate) {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return validate(value) ? value : undefined; } catch { return undefined; }
}
function validState(value) { try { renderWrites(value); return true; } catch { return false; } }
function readState(file) { return readJson(file, validState); }
function readHistory(file) { return readJson(file, value => Array.isArray(value) && value.length > 0 && value.every(validState)); }
function readText(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return undefined; } }
function load() {
  for (const file of [purgePath(), purgePath() + '.tmp']) {
    const purged = readState(file);
    if (purged && purged.log.at(-1)?.type === 'purge') {
      interrupted = true; save(purged, true); return purged;
    }
  }
  const current = readState(statePath());
  const fullHistory = readHistory(committedPath());
  const history = fullHistory ?? readHistory(committedPath() + '.tmp') ?? [];
  const actualLog = readText(path.join(dir, '.log/log.jsonl'));
  const logText = state => renderWrites(state).find(write => write.path === '.log/log.jsonl').text;
  const validPending = value => value && value.saving === true;
  const pending = readJson(pendingPath(), validPending) ?? readJson(pendingPath() + '.tmp', validPending);
  const fromLog = history.findLast(state => logText(state) === actualLog && (!pending || [pending.baseLogId, pending.nextLogId].includes(state.log.at(-1)?.id)));
  const recovered = fromLog ?? current ?? history.at(-1) ?? readState(statePath() + '.tmp') ?? (partialInit() ? initialState() : undefined);
  if (!recovered) fail("The last change didn't finish and was not saved.");
  const controlFiles = [pendingPath(), pendingPath() + '.tmp', purgePath(), purgePath() + '.tmp', committedPath() + '.tmp', statePath() + '.tmp'];
  const writes = renderWrites(recovered);
  const dirty = !current || !fullHistory || controlFiles.some(file => fs.existsSync(file)) ||
    JSON.stringify(current) !== JSON.stringify(recovered) || JSON.stringify(history.at(-1)) !== JSON.stringify(recovered) ||
    writes.some(write => readText(path.join(dir, write.path)) !== write.text || fs.existsSync(path.join(dir, write.path + '.tmp')));
  if (dirty) { interrupted = true; save(recovered, false, true); }
  return recovered;
}
function atomic(file, text) { const full = path.resolve(dir, file); if (full !== marker && !full.startsWith(dir + path.sep)) fail("A sample write tried to leave the sample folder."); fs.mkdirSync(path.dirname(full), { recursive: true }); const temp = full + ".tmp"; fs.writeFileSync(temp, text); afterWrite(`${file}:temporary`); fs.renameSync(temp, full); afterWrite(`${file}:renamed`); }
function save(next, purgeFirst = false, recovering = false) {
  const writes = renderWrites(next); const log = writes.find((w) => w.path === ".log/log.jsonl");
  if (purgeFirst) { atomic(".purge-first.json", JSON.stringify(next, null, 2) + "\n"); atomic(log.path, log.text); }
  atomic('.sample-pending.json', JSON.stringify({ saving: true, baseLogId: readState(statePath())?.log.at(-1)?.id, nextLogId: next.log.at(-1)?.id }) + '\n');
  let history = !purgeFirst ? readHistory(committedPath()) ?? readHistory(committedPath() + '.tmp') ?? [] : [];
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
  for (const file of [pendingPath(), pendingPath() + '.tmp', ...(purgeFirst || recovering ? [purgePath(), purgePath() + '.tmp'] : [])]) if (fs.existsSync(file)) fs.rmSync(file);
}
function fail(message) { throw new Error(message); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { runSample(process.argv.slice(2), { output: console.log }); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
