import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  lstat,
  mkdir,
  open as openFile,
  readFile,
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
  const parent = dirname(target);
  if (await exists(parent) && (await lstat(parent)).isSymbolicLink()) throw new Error(DAMAGE);
  if (!allowMissing && !targetExists) throw Object.assign(new Error("missing"), { code: "ENOENT" });
}

function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function safeLocations(ledgerDir, storePath) {
  const ledger = resolve(ledgerDir);
  const store = resolve(storePath);
  if (isWithin(store, ledger)) throw new Error("storePath must be outside ledgerDir");
  await assertNoSymlink(ledger);
  await assertNoSymlink(dirname(store));
  await assertNoSymlink(store);
  const ledgerBase = await realpath((await exists(ledger)) ? ledger : dirname(ledger));
  const storeBase = await realpath((await exists(dirname(store))) ? dirname(store) : dirname(dirname(store)));
  const effectiveLedger = (await exists(ledger)) ? ledgerBase : join(ledgerBase, ledger.split("/").at(-1));
  const effectiveStore = join(storeBase, store.split("/").at(-1));
  if (isWithin(effectiveStore, effectiveLedger)) throw new Error("storePath must be outside ledgerDir");
  return { ledger, store, file: join(ledger, "ledger.json"), lock: join(ledger, ".lock") };
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
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `.${path.split("/").at(-1)}.${randomUUID()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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
    answers: relevant.filter((entry) => entry.type === "answered"),
    claim: relevant.find((entry) => entry.type === "claimed"),
    finish: relevant.find((entry) => entry.type === "finished"),
    withdrawn: relevant.find((entry) => entry.type === "withdrawn")
  };
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
  await mkdir(paths.ledger, { recursive: true, mode: 0o700 });

  async function load({ tolerateDamage = false } = {}) {
    let entries;
    let store;
    let damaged = false;
    try { await assertNoSymlink(paths.ledger, false); entries = await readJson(paths.file, []); } catch { if (!tolerateDamage) return { refusal: refusal(DAMAGE) }; entries = []; damaged = true; }
    try { await assertNoSymlink(dirname(paths.store)); store = await readJson(paths.store, { head: EMPTY_HEAD, count: 0, usedRequestIds: [] }); } catch { if (!tolerateDamage) return { refusal: refusal(DAMAGE) }; store = null; damaged = true; }
    const checked = verifyEntries(entries);
    const validStore = store && checked.ok && store.head === checked.head && store.count === checked.count && Array.isArray(store.usedRequestIds);
    if (damaged || !checked.ok || !validStore) {
      if (tolerateDamage) return { entries: Array.isArray(entries) ? entries : [], store, damaged: true };
      return { refusal: refusal(DAMAGE) };
    }
    return { entries, store, damaged: false };
  }

  async function write(kind, data, validate) {
    return withQueue(paths.lock, async () => {
      let handle;
      try {
        handle = await openFile(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch (error) {
        if (error.code === "EEXIST") return refusal(`Another approval is being recorded. If nothing is running, remove ${paths.lock}.`);
        throw error;
      }
      try {
        const loaded = await load();
        if (loaded.refusal) return loaded.refusal;
        const checked = validate(loaded.entries, loaded.store);
        if (!checked.ok) return checked;
        const entries = append(loaded.entries, kind, { ...data, ...checked.data });
        const usedRequestIds = [...new Set([...loaded.store.usedRequestIds, ...(checked.usedRequestIds ?? [])])].sort();
        const nextStore = { head: entries.at(-1).hash, count: entries.length, usedRequestIds };
        await atomicJson(paths.file, entries);
        await atomicJson(paths.store, nextStore);
        return success(checked.result ?? {});
      } finally {
        await handle?.close();
        await rm(paths.lock, { force: true });
      }
    });
  }

  return {
    async ask({ requestId, actionId, digest, description, kind, askedAt, expiresAt }) {
      [requestId, actionId, digest, description, kind].forEach((value, index) => text(value, ["requestId", "actionId", "digest", "description", "kind"][index]));
      const askedMs = instant(askedAt, "askedAt");
      const expiry = expiresAt ?? new Date(askedMs + DEFAULT_AGE_MS).toISOString();
      const expiresMs = instant(expiry, "expiresAt");
      if (expiresMs <= askedMs || expiresMs - askedMs > MAX_AGE_MS) return refusal("expiresAt must be after askedAt and no more than 24 hours later");
      return write("asked", { requestId, actionId, digest, description, kind, askedAt, expiresAt: expiry }, (entries, store) => {
        if (store.usedRequestIds.includes(requestId) || entries.some((entry) => entry.requestId === requestId)) return refusal("This request id was already used");
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
    async status(requestId) { const loaded = await load(); return loaded.refusal ?? statusFor(loaded.entries, requestId); },
    async pending(now) {
      const nowMs = instant(now, "now"); const loaded = await load(); if (loaded.refusal) return loaded.refusal;
      const ids = loaded.entries.filter((entry) => entry.type === "asked").map((entry) => entry.requestId);
      const requests = ids.filter((id) => { const state = requestState(loaded.entries, id); return !state.answers.length && !state.claim && !state.withdrawn && nowMs <= instant(state.asked.expiresAt, "expiresAt"); });
      return success({ requests, message: requests.length ? `${requests.length} request(s) waiting for your yes.` : "Nothing is waiting for your yes." });
    },
    async history({ from = 1, to = Number.MAX_SAFE_INTEGER } = {}) { const loaded = await load(); return loaded.refusal ?? success({ entries: loaded.entries.filter((entry) => entry.seq >= from && entry.seq <= to) }); },
    async verify() { const loaded = await load(); return loaded.refusal ?? success({ head: loaded.store.head, count: loaded.store.count }); },
    async reset() {
      return withQueue(paths.lock, async () => {
        let handle;
        try { handle = await openFile(paths.lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
        catch (error) { if (error.code === "EEXIST") return refusal(`Another approval is being recorded. If nothing is running, remove ${paths.lock}.`); throw error; }
        try {
          const loaded = await load({ tolerateDamage: true });
          const readableIds = Array.isArray(loaded.entries) ? loaded.entries.map((entry) => entry?.requestId).filter((id) => typeof id === "string") : [];
          const protectedIds = Array.isArray(loaded.store?.usedRequestIds) ? loaded.store.usedRequestIds : [];
          if (loaded.damaged && !Array.isArray(loaded.store?.usedRequestIds)) return refusal("The approval record is damaged and its used request ids cannot be preserved");
          const usedRequestIds = [...new Set([...protectedIds, ...readableIds])].sort();
          const oldHead = typeof loaded.store?.head === "string" ? loaded.store.head : EMPTY_HEAD;
          const entries = append([], "reset", { oldHead, usedRequestIds });
          await atomicJson(paths.file, entries);
          await atomicJson(paths.store, { head: entries[0].hash, count: 1, usedRequestIds });
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
