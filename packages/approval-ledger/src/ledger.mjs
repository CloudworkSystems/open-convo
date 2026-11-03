import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstat,
  mkdir,
  open as openFile,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const EMPTY_HEAD = "0".repeat(64);
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_AGE_MS = 30 * 60 * 1000;
const queues = new Map();
const DAMAGE = "The approval record was changed outside True Convo, so nothing can run until you reset it";

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashEntry(entry) {
  const { hash, ...body } = entry;
  return createHash("sha256").update(canonical(body)).digest("hex");
}

function refusal(reason) { return { ok: false, reason }; }
function success(value = {}) { return { ok: true, ...value }; }

function instant(value, field) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${field} must be an RFC 3339 UTC instant`);
  }
  return Date.parse(value);
}

function text(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

async function exists(path) {
  try { await lstat(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function assertNoSymlink(path, allowMissing = true) {
  const target = resolve(path);
  const targetExists = await exists(target);
  if (targetExists && (await lstat(target)).isSymbolicLink()) throw new Error(DAMAGE);
  let parent = dirname(target);
  while (true) {
    if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) throw new Error(DAMAGE);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  if (!allowMissing && !targetExists) throw Object.assign(new Error("missing"), { code: "ENOENT" });
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveExistingAncestor(path) {
  let ancestor = path;
  while (!(await exists(ancestor))) ancestor = dirname(ancestor);
  return resolve(await realpath(ancestor), relative(ancestor, path));
}

async function safeLocations(ledgerDir, storePath) {
  const ledger = resolve(ledgerDir);
  const store = resolve(storePath);
  if (isWithin(store, ledger)) throw new Error("storePath must be outside ledgerDir");
  // Ancestor aliases are resolved once, but the chosen endpoints may not be links.
  for (const endpoint of [ledger, store, `${store}.journal.json`, join(ledger, ".lock")]) {
    if (await exists(endpoint) && (await lstat(endpoint)).isSymbolicLink()) throw new Error(DAMAGE);
  }
  const effectiveLedger = await resolveExistingAncestor(ledger);
  const effectiveStore = await resolveExistingAncestor(store);
  if (isWithin(effectiveStore, effectiveLedger)) throw new Error("storePath must be outside ledgerDir");
  return { ledger: effectiveLedger, store: effectiveStore, file: join(effectiveLedger, "ledger.json"), lock: join(effectiveLedger, ".lock") };
}

async function readJson(path, fallback) {
  try {
    await assertNoSymlink(path, false);
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicJson(path, value) {
  await assertNoSymlink(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${path.split("/").at(-1)}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await assertNoSymlink(path);
  await rename(temp, path);
}

function verifyEntries(entries) {
  if (!Array.isArray(entries)) return refusal(DAMAGE);
  let previous = EMPTY_HEAD;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || entry.seq !== index + 1 || entry.previousHash !== previous || entry.hash !== hashEntry(entry)) return refusal(DAMAGE);
    previous = entry.hash;
  }
  return success({ head: previous, count: entries.length });
}

function append(entries, type, data) {
  const entry = { seq: entries.length + 1, type, ...data, previousHash: entries.at(-1)?.hash ?? EMPTY_HEAD };
  entry.hash = hashEntry(entry);
  return [...entries, entry];
}

function requestState(entries, requestId) {
  const relevant = entries.filter((entry) => entry.requestId === requestId);
  return {
    asked: relevant.find((entry) => entry.type === "asked"),
    answers: relevant.filter((entry) => entry.type === "answered" && entry.source === "person"),
    ignoredAnswers: relevant.filter((entry) => entry.type === "answered" && entry.source !== "person"),
    claim: relevant.find((entry) => entry.type === "claimed"),
    finish: relevant.find((entry) => entry.type === "finished"),
    withdrawn: relevant.find((entry) => entry.type === "withdrawn")
  };
}

function validRequestIds(ids) {
  return Array.isArray(ids) && ids.every((id) => typeof id === "string" && id.length > 0) && new Set(ids).size === ids.length;
}

function chainRequestIds(entries) {
  const ids = new Set();
  for (const entry of entries) {
    if (typeof entry?.requestId === "string") ids.add(entry.requestId);
    if (entry?.type === "reset") {
      if (!validRequestIds(entry.usedRequestIds)) return null;
      for (const id of entry.usedRequestIds) ids.add(id);
    }
  }
  return [...ids];
}

function statusFor(entries, requestId) {
  const state = requestState(entries, requestId);
  if (!state.asked) return refusal("This request was never asked");
  if (state.claim && !state.finish) return success({ status: "inFlight", message: "This action may or may not have happened", ...state });
  if (state.finish) return success({ status: "finished", ...state });
  if (state.withdrawn) return success({ status: "withdrawn", ...state });
  return success({ status: state.answers.at(-1)?.answer ?? "pending", ...state });
}

async function withQueue(key, operation) {
  const previous = queues.get(key) ?? Promise.resolve();
  let release;
  const current = new Promise((resolvePromise) => { release = resolvePromise; });
  queues.set(key, previous.then(() => current));
  await previous;
  try { return await operation(); } finally { release(); if (queues.get(key) === current) queues.delete(key); }
}

export async function openApprovalLedger({ ledgerDir, storePath }) {
  text(ledgerDir, "ledgerDir"); text(storePath, "storePath");
  const paths = await safeLocations(ledgerDir, storePath);
  const journalPath = `${paths.store}.journal.json`;

  async function checkLocations() {
    async function scan(path) {
      await assertNoSymlink(path);
      if (!(await exists(path))) return;
      if ((await lstat(path)).isDirectory()) {
        for (const name of await readdir(path)) await scan(join(path, name));
      }
    }
    await scan(paths.ledger);
    await assertNoSymlink(paths.store);
    await assertNoSymlink(journalPath);
  }

  function validPair(entries, store) {
    const checked = verifyEntries(entries);
    const ids = Array.isArray(entries) ? chainRequestIds(entries) : null;
    return checked.ok && ids && store && store.head === checked.head && store.count === checked.count && validRequestIds(store.usedRequestIds) && ids.every((id) => store.usedRequestIds.includes(id));
  }

  async function journalSnapshot() {
    await checkLocations();
    const journal = await readJson(journalPath, null);
    if (!journal) return null;
    const { before, entries, store, previousText } = journal;
    if (!validPair(entries, store) || !before || !validRequestIds(before.usedRequestIds) || !before.usedRequestIds.every((id) => store.usedRequestIds.includes(id))) throw new Error(DAMAGE);
    const currentStore = await readJson(paths.store, null);
    // Missing state is never reconstructed from an untrusted journal.
    if (!currentStore || (canonical(currentStore) !== canonical(before) && canonical(currentStore) !== canonical(store))) throw new Error(DAMAGE);
    const reset = entries.length === 1 && entries[0].type === "reset";
    if (reset) {
      if (entries[0].oldHead !== before.head) throw new Error(DAMAGE);
    } else {
      const prefix = entries.slice(0, before.count);
      if (!validPair(prefix, before) || entries.length !== before.count + 1) throw new Error(DAMAGE);
    }
    let currentText;
    try { await assertNoSymlink(paths.file); currentText = await readFile(paths.file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; currentText = null; }
    let isNew = false;
    try { isNew = canonical(JSON.parse(currentText)) === canonical(entries); } catch {}
    if (!isNew && currentText !== previousText) throw new Error(DAMAGE);
    return { entries, store, damaged: false };
  }

  async function recover() {
    try {
      const pending = await journalSnapshot();
      if (pending) {
        await atomicJson(paths.file, pending.entries);
        await atomicJson(paths.store, pending.store);
        await rm(journalPath);
      }
      return success();
    } catch { return refusal(DAMAGE); }
  }

  async function commit(entries, store, before) {
    let previousText;
    try { previousText = await readFile(paths.file, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; previousText = null; }
    // Initialize the empty protected state before publishing the first journal.
    if (!(await exists(paths.store))) await atomicJson(paths.store, before);
    await atomicJson(journalPath, { before, previousText, entries, store });
    await atomicJson(paths.file, entries);
    await atomicJson(paths.store, store);
    await rm(journalPath);
  }

  async function load({ tolerateDamage = false } = {}) {
    try { const pending = await journalSnapshot(); if (pending) return pending; }
    catch { return { refusal: refusal(DAMAGE), retryable: true }; }
    let entries;
    let store;
    let damaged = false;
    try { await assertNoSymlink(paths.ledger); entries = await readJson(paths.file, []); } catch { if (!tolerateDamage) return { refusal: refusal(DAMAGE) }; entries = []; damaged = true; }
    try { await assertNoSymlink(dirname(paths.store)); store = await readJson(paths.store, null); } catch { if (!tolerateDamage) return { refusal: refusal(DAMAGE) }; store = null; damaged = true; }
    // Only a genuinely empty ledger may initialize an absent store. A reset
    // entry can summarize ids no longer present as individual requests.
    if (store === null && !damaged && Array.isArray(entries) && entries.length === 0 && !(await exists(paths.file))) {
      store = { head: EMPTY_HEAD, count: 0, usedRequestIds: [] };
    }
    const checked = verifyEntries(entries);
    const chainIds = Array.isArray(entries) ? chainRequestIds(entries) : null;
    const validStore = store && checked.ok && chainIds && store.head === checked.head && store.count === checked.count && validRequestIds(store.usedRequestIds) && chainIds.every((id) => store.usedRequestIds.includes(id));
    if (damaged || !checked.ok || !validStore) {
      if (tolerateDamage) return { entries: Array.isArray(entries) ? entries : [], store, damaged: true };
      return { refusal: refusal(DAMAGE), retryable: !damaged && checked.ok && Array.isArray(store?.usedRequestIds) };
    }
    return { entries, store, damaged: false };
  }

  async function write(kind, data, validate) {
    return withQueue(paths.lock, async () => {
      try { await checkLocations(); } catch { return refusal(DAMAGE); }
      await mkdir(paths.ledger, { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await openFile(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch (error) {
        if (error.code === "EEXIST") return refusal(`Another approval is being recorded. If nothing is running, remove ${paths.lock}.`);
        throw error;
      }
      try {
        const recovered = await recover();
        if (!recovered.ok) return recovered;
        const loaded = await load();
        if (loaded.refusal) return loaded.refusal;
        const checked = validate(loaded.entries, loaded.store);
        if (!checked.ok) return checked;
        const entries = append(loaded.entries, kind, { ...data, ...checked.data });
        const usedRequestIds = [...new Set([...loaded.store.usedRequestIds, ...(checked.usedRequestIds ?? [])])].sort();
        const nextStore = { head: entries.at(-1).hash, count: entries.length, usedRequestIds };
        await commit(entries, nextStore, loaded.store);
        return success(checked.result ?? {});
      } finally {
        await handle?.close();
        await rm(paths.lock, { force: true });
      }
    });
  }

  async function readSnapshot(view) {
    for (let attempt = 0; attempt < 21; attempt += 1) {
      const loaded = await load();
      if (!loaded.refusal) return view(loaded);
      if (!loaded.retryable || attempt === 20) return loaded.refusal;
      // A valid chain with a different store head can be the interval between
      // the writer's two renames. Delay without reading the current time.
      await new Promise((resume) => setTimeout(resume, 5));
    }
  }

  return {
    async ask({ requestId, actionId, digest, description, kind, askedAt, expiresAt }) {
      [requestId, actionId, digest, description, kind].forEach((value, index) => text(value, ["requestId", "actionId", "digest", "description", "kind"][index]));
      const askedMs = instant(askedAt, "askedAt");
      const expiry = expiresAt ?? new Date(askedMs + DEFAULT_AGE_MS).toISOString();
      const expiresMs = instant(expiry, "expiresAt");
      if (expiresMs <= askedMs || expiresMs - askedMs > MAX_AGE_MS) return refusal("expiresAt must be after askedAt and no more than 24 hours later");
      return write("asked", { requestId, actionId, digest, description, kind, askedAt, expiresAt: expiry }, (entries, store) => {
        if (store.usedRequestIds.includes(requestId) || chainRequestIds(entries).includes(requestId)) return refusal("This request id was already used");
        return success({ usedRequestIds: [requestId] });
      });
    },
    async answer({ requestId, answer, answeredAt, source }) {
      instant(answeredAt, "answeredAt");
      if (!["yes", "no"].includes(answer) || !["person", "agent", "system"].includes(source)) throw new TypeError("answer or source is invalid");
      return write("answered", { requestId, answer, answeredAt, source }, (entries) => {
        const state = requestState(entries, requestId);
        if (!state.asked) return refusal("This request was never asked");
        if (state.claim) return refusal("This yes was already used");
        if (state.withdrawn) return refusal("This yes was withdrawn");
        return success();
      });
    },
    async withdraw({ requestId, withdrawnAt }) {
      instant(withdrawnAt, "withdrawnAt");
      return write("withdrawn", { requestId, withdrawnAt }, (entries) => {
        const state = requestState(entries, requestId);
        if (!state.asked) return refusal("This request was never asked");
        if (state.claim) return refusal("This yes was already used");
        if (state.withdrawn) return refusal("This yes was already withdrawn");
        return success();
      });
    },
    async claim({ requestId, actionId, digest, now }) {
      const nowMs = instant(now, "now");
      const claimId = randomUUID();
      return write("claimed", { requestId, claimId, claimedAt: now }, (entries) => {
        const state = requestState(entries, requestId);
        if (!state.asked) return refusal("This request was never asked");
        if (state.claim) return refusal("This yes was already used");
        if (state.withdrawn) return refusal("This yes was withdrawn");
        if (state.asked.actionId !== actionId || state.asked.digest !== digest) return refusal("This yes was for a different action");
        if (nowMs > instant(state.asked.expiresAt, "expiresAt")) return refusal(`This yes expired at ${state.asked.expiresAt}`);
        const last = state.answers.at(-1);
        if (!last || last.answer !== "yes" || last.source !== "person") return refusal("The person has not said yes to this action");
        return success({ result: { claimId } });
      });
    },
    async finish({ requestId, claimId, outcome, finishedAt }) {
      instant(finishedAt, "finishedAt");
      if (!["done", "failed", "unknown"].includes(outcome)) throw new TypeError("outcome is invalid");
      return write("finished", { requestId, claimId, outcome, finishedAt }, (entries) => {
        const state = requestState(entries, requestId);
        if (!state.asked) return refusal("This request was never asked");
        if (!state.claim || state.claim.claimId !== claimId) return refusal("This claim does not match the request");
        if (state.finish) return refusal("This claim was already finished");
        return success();
      });
    },
    async status(requestId) { return readSnapshot((loaded) => statusFor(loaded.entries, requestId)); },
    async pending(now) {
      const nowMs = instant(now, "now"); return readSnapshot((loaded) => {
      const ids = loaded.entries.filter((entry) => entry.type === "asked").map((entry) => entry.requestId);
      const requests = ids.filter((id) => { const state = requestState(loaded.entries, id); return !state.answers.length && !state.claim && !state.withdrawn && nowMs <= instant(state.asked.expiresAt, "expiresAt"); });
      return success({ requests, message: requests.length ? `${requests.length} request(s) waiting for your yes.` : "Nothing is waiting for your yes." });
      });
    },
    async history({ from = 1, to = Number.MAX_SAFE_INTEGER } = {}) { return readSnapshot((loaded) => success({ entries: loaded.entries.filter((entry) => entry.seq >= from && entry.seq <= to) })); },
    async verify() { return readSnapshot((loaded) => success({ head: loaded.store.head, count: loaded.store.count })); },
    async reset() {
      return withQueue(paths.lock, async () => {
        try { await checkLocations(); } catch { return refusal(DAMAGE); }
        await mkdir(paths.ledger, { recursive: true, mode: 0o700 });
        let handle;
        try { handle = await openFile(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
        catch (error) { if (error.code === "EEXIST") return refusal(`Another approval is being recorded. If nothing is running, remove ${paths.lock}.`); throw error; }
        try {
          const recovered = await recover();
          if (!recovered.ok) return recovered;
          const loaded = await load({ tolerateDamage: true });
          if (loaded.refusal) return loaded.refusal;
          const readableIds = chainRequestIds(loaded.entries);
          const protectedIds = Array.isArray(loaded.store?.usedRequestIds) ? loaded.store.usedRequestIds : [];
          if (readableIds === null || !validRequestIds(loaded.store?.usedRequestIds)) return refusal(DAMAGE);
          const usedRequestIds = [...new Set([...protectedIds, ...readableIds])].sort();
          const oldHead = typeof loaded.store?.head === "string" ? loaded.store.head : EMPTY_HEAD;
          const entries = append([], "reset", { oldHead, usedRequestIds });
          await commit(entries, { head: entries[0].hash, count: 1, usedRequestIds }, loaded.store);
          return success({ usedRequestIds });
        } finally { await handle?.close(); await rm(paths.lock, { force: true }); }
      });
    }
  };
}

async function command() {
  const args = process.argv.slice(2);
  const dirAt = args.indexOf("--dir"); const storeAt = args.indexOf("--store");
  if (dirAt < 0 || storeAt < 0) throw new Error("Usage: ledger.mjs --dir <folder> --store <file> <status|pending|history|verify> [value]");
  const verb = args.find((value, index) => !value.startsWith("--") && index !== dirAt + 1 && index !== storeAt + 1);
  const ledger = await openApprovalLedger({ ledgerDir: args[dirAt + 1], storePath: args[storeAt + 1] });
  let result;
  if (verb === "status") result = await ledger.status(args.at(-1));
  else if (verb === "pending") result = await ledger.pending(args.at(-1));
  else if (verb === "history") result = await ledger.history();
  else if (verb === "verify") result = await ledger.verify();
  else throw new Error("Unknown read-only verb");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) command().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
