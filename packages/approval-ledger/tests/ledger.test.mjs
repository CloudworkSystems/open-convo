import assert from "node:assert/strict";
import { readFile, readdir, rm, symlink, writeFile, mkdir, lstat, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import { actionDigest, openApprovalLedger } from "../src/index.mjs";

const action = { actionId: "send-invented", description: "Send an invented note", kind: "send", payload: { to: "Robin", body: "Hello" } };
const digest = actionDigest({ description: action.description, kind: action.kind, payload: action.payload });
const t = { ask: "2030-01-01T00:00:00.000Z", yes: "2030-01-01T00:01:00.000Z", claim: "2030-01-01T00:02:00.000Z", finish: "2030-01-01T00:03:00.000Z" };

test("missing store after reset refuses another reset and cannot revive an old id", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  await ask(f.ledger); await yes(f.ledger);
  assert.equal((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).ok, true);
  assert.equal((await f.ledger.reset()).ok, true);
  const before = await readFile(join(f.ledgerDir, "ledger.json"), "utf8");
  await rm(f.storePath);
  const damage = "The approval record was changed outside True Convo, so nothing can run until you reset it";
  assert.deepEqual(await f.ledger.reset(), { ok: false, reason: damage });
  for (const result of await Promise.all([f.ledger.status("r1"), f.ledger.pending(t.yes), f.ledger.history(), f.ledger.verify()])) {
    assert.deepEqual(result, { ok: false, reason: damage });
  }
  assert.deepEqual(await ask(f.ledger), { ok: false, reason: damage });
  assert.deepEqual(await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim }), { ok: false, reason: damage });
  assert.equal(await readFile(join(f.ledgerDir, "ledger.json"), "utf8"), before);
  await assert.rejects(lstat(f.storePath), { code: "ENOENT" });
});

test("cleared store ids fail verification and reset recovers ids from reset entries", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  await ask(f.ledger); await yes(f.ledger);
  await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim });
  await f.ledger.reset();
  const store = JSON.parse(await readFile(f.storePath, "utf8"));
  await writeFile(f.storePath, JSON.stringify({ ...store, usedRequestIds: [] }));
  assert.equal((await f.ledger.verify()).ok, false);
  assert.equal((await ask(f.ledger)).ok, false);
  assert.equal((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).ok, false);
  assert.deepEqual((await f.ledger.reset()).usedRequestIds, ["r1"]);
  assert.equal((await ask(f.ledger)).reason, "This request id was already used");
  assert.equal((await f.ledger.reset()).ok, true);
  assert.equal((await ask(f.ledger)).ok, false);
});

test("unreadable ledger with missing store refuses reset without replacing the log", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  await ask(f.ledger); await rm(f.storePath);
  const path = join(f.ledgerDir, "ledger.json"); await writeFile(path, "unreadable invented log");
  assert.match((await f.ledger.reset()).reason, /changed outside True Convo/);
  assert.equal(await readFile(path, "utf8"), "unreadable invented log");
  await assert.rejects(lstat(f.storePath), { code: "ENOENT" });
});

test("restoring an older ledger folder preserves an id found only in the current store", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  await ask(f.ledger, "older-id");
  const backup = join(f.root, "backup"); await cp(f.ledgerDir, backup, { recursive: true });
  await ask(f.ledger, "lost-id"); await yes(f.ledger, "lost-id");
  await f.ledger.claim({ requestId: "lost-id", actionId: action.actionId, digest, now: t.claim });
  await rm(f.ledgerDir, { recursive: true }); await cp(backup, f.ledgerDir, { recursive: true });
  assert.equal((await f.ledger.verify()).ok, false);
  assert.deepEqual((await f.ledger.reset()).usedRequestIds, ["lost-id", "older-id"]);
  assert.equal((await ask(f.ledger, "lost-id")).ok, false);
  assert.equal((await yes(f.ledger, "lost-id")).ok, false);
  assert.equal((await f.ledger.claim({ requestId: "lost-id", actionId: action.actionId, digest, now: t.claim })).ok, false);
});

test("journal recovers crashes after journal, ledger, and store publication", async (context) => {
  for (const stage of ["journal", "ledger", "store"]) {
    for (const next of ["write", "reset"]) {
      const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
      await ask(f.ledger);
      const file = join(f.ledgerDir, "ledger.json");
      const previousText = await readFile(file, "utf8");
      const before = JSON.parse(await readFile(f.storePath, "utf8"));
      await yes(f.ledger);
      const entries = JSON.parse(await readFile(file, "utf8"));
      const store = JSON.parse(await readFile(f.storePath, "utf8"));
      await writeFile(file, stage === "journal" ? previousText : JSON.stringify(entries));
      await writeFile(f.storePath, JSON.stringify(stage === "store" ? store : before));
      const journal = `${f.storePath}.journal.json`;
      await writeFile(journal, JSON.stringify({ before, previousText, entries, store }));
      const unchanged = await readFile(journal, "utf8");
      assert.equal((await f.ledger.verify()).ok, true);
      assert.equal((await f.ledger.status("r1")).status, "yes");
      assert.equal((await f.ledger.pending(t.yes)).ok, true);
      assert.equal((await f.ledger.history()).ok, true);
      assert.equal(await readFile(journal, "utf8"), unchanged);
      assert.equal((next === "reset" ? await f.ledger.reset() : await ask(f.ledger, "r2")).ok, true);
      await assert.rejects(lstat(journal), { code: "ENOENT" });
      assert.equal((await f.ledger.verify()).ok, true);
    }
  }
});

test("tampered journal is refused by reads, writes, and reset", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger);
  const file = join(f.ledgerDir, "ledger.json");
  const previousText = await readFile(file, "utf8"); const before = JSON.parse(await readFile(f.storePath, "utf8"));
  await yes(f.ledger);
  const entries = JSON.parse(await readFile(file, "utf8")); const store = JSON.parse(await readFile(f.storePath, "utf8"));
  await writeFile(file, previousText); await writeFile(f.storePath, JSON.stringify(before));
  entries.at(-1).answer = "no";
  await writeFile(`${f.storePath}.journal.json`, JSON.stringify({ before, previousText, entries, store }));
  for (const result of [await f.ledger.verify(), await ask(f.ledger, "r2"), await f.ledger.reset()]) assert.match(result.reason, /changed outside True Convo/);
});

test("reading missing nested locations creates nothing", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "approval-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const ledger = await openApprovalLedger({ ledgerDir: join(root, "missing", "ledger"), storePath: join(root, "state", "head.json") });
  assert.equal((await ledger.status("never-asked")).reason, "This request was never asked");
  assert.deepEqual((await ledger.pending(t.ask)).requests, []);
  assert.deepEqual((await ledger.history()).entries, []);
  assert.equal((await ledger.verify()).count, 0);
  assert.deepEqual(await readdir(root), []);
  await assert.rejects(lstat(join(root, "missing")), { code: "ENOENT" });
});

test("first write creates deeply missing ledger and store parents", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "approval-nested-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const ledgerDir = join(root, "a", "b", "c", "ledger");
  const ledger = await openApprovalLedger({ ledgerDir, storePath: join(root, "state", "nested", "head.json") });
  assert.equal((await ask(ledger)).ok, true);
  assert.equal((await ledger.verify()).count, 1);
  assert.equal((await lstat(ledgerDir)).isDirectory(), true);
});

test("approval views ignore agent and system answers, including after a person answers", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  await ask(f.ledger);
  for (const source of ["agent", "system"]) {
    await yes(f.ledger, "r1", source);
    const status = await f.ledger.status("r1");
    assert.equal(status.status, "pending");
    assert.equal(status.answers.length, 0);
    assert.ok(status.ignoredAnswers.some((entry) => entry.source === source));
    assert.deepEqual((await f.ledger.pending(t.yes)).requests, ["r1"]);
  }
  await yes(f.ledger);
  await f.ledger.answer({ requestId: "r1", answer: "no", answeredAt: t.claim, source: "agent" });
  assert.equal((await f.ledger.status("r1")).status, "yes");
  assert.deepEqual((await f.ledger.pending(t.claim)).requests, []);
  assert.equal((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).ok, true);
  assert.equal((await f.ledger.history()).entries.filter((entry) => entry.type === "answered").length, 4);
});

test("all read methods remain consistent during worker writes", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger);
  const workerSource = `import { parentPort, workerData } from 'node:worker_threads'; import { openApprovalLedger } from ${JSON.stringify(new URL("../src/index.mjs", import.meta.url).href)}; const l=await openApprovalLedger(workerData); parentPort.postMessage('ready'); parentPort.once('message', async () => { for(let i=0;i<80;i++) await l.answer({requestId:'r1',answer:'yes',source:'person',answeredAt:'2030-01-01T00:01:00.000Z'}); parentPort.postMessage('done'); });`;
  const worker = new Worker(workerSource, { eval: true, type: "module", workerData: { ledgerDir: f.ledgerDir, storePath: f.storePath } });
  await new Promise((resolvePromise, reject) => { worker.once("message", resolvePromise); worker.once("error", reject); });
  const done = new Promise((resolvePromise, reject) => { worker.once("message", resolvePromise); worker.once("error", reject); });
  worker.postMessage("start");
  for (let i = 0; i < 80; i += 1) {
    const results = await Promise.all([f.ledger.status("r1"), f.ledger.pending(t.yes), f.ledger.history(), f.ledger.verify()]);
    for (const result of results) assert.equal(result.ok, true, JSON.stringify(result));
  }
  await done;
  assert.equal((await f.ledger.verify()).ok, true);
});

test("stale lock does not block reads and reads leave files unchanged", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  await ask(f.ledger);
  const lockPath = join(f.ledgerDir, ".lock");
  await writeFile(lockPath, "invented stale lock");
  const before = (await readdir(f.ledgerDir)).sort();
  const contents = await Promise.all(before.map((name) => readFile(join(f.ledgerDir, name), "utf8")));
  assert.equal((await f.ledger.status("r1")).status, "pending");
  assert.equal((await f.ledger.pending(t.yes)).ok, true);
  assert.equal((await f.ledger.history()).ok, true);
  assert.equal((await f.ledger.verify()).ok, true);
  assert.deepEqual((await readdir(f.ledgerDir)).sort(), before);
  assert.deepEqual(await Promise.all(before.map((name) => readFile(join(f.ledgerDir, name), "utf8"))), contents);
  assert.equal(await readFile(lockPath, "utf8"), "invented stale lock");
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "approval-ledger-"));
  const ledgerDir = join(root, "ledger"); const storePath = join(root, "state", "head.json");
  const ledger = await openApprovalLedger({ ledgerDir, storePath });
  // Most fixtures exercise existing folders. Missing-folder behavior has its own tests.
  await mkdir(ledgerDir, { recursive: true });
  return { root, ledgerDir, storePath, ledger };
}
async function ask(ledger, requestId = "r1", extra = {}) { return ledger.ask({ requestId, actionId: action.actionId, digest, description: action.description, kind: action.kind, askedAt: t.ask, ...extra }); }
async function yes(ledger, requestId = "r1", source = "person") { return ledger.answer({ requestId, answer: "yes", answeredAt: t.yes, source }); }

test("person yes is claimed and finished exactly once", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal((await ask(f.ledger)).ok, true); const answered = await yes(f.ledger); assert.equal(answered.ok, true, JSON.stringify(answered));
  const claimed = await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim }); assert.equal(claimed.ok, true);
  assert.equal((await f.ledger.finish({ requestId: "r1", claimId: claimed.claimId, outcome: "done", finishedAt: t.finish })).ok, true);
  assert.equal((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).reason, "This yes was already used");
});

test("agent and system answers never count", async (context) => {
  for (const source of ["agent", "system"]) { const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger); await yes(f.ledger, "r1", source); assert.match((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).reason, /person/); }
});

test("changed digest or action id is refused", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger); await yes(f.ledger);
  for (const changed of [
    actionDigest({ description: `${action.description}!`, kind: action.kind, payload: action.payload }),
    actionDigest({ description: action.description, kind: "publish", payload: action.payload }),
    actionDigest({ description: action.description, kind: action.kind, payload: { ...action.payload, body: "Hellp" } })
  ]) assert.match((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest: changed, now: t.claim })).reason, /different action/);
  assert.match((await f.ledger.claim({ requestId: "r1", actionId: "other", digest, now: t.claim })).reason, /different action/);
});

test("expiry, answers, withdrawal, and unknown ids", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true }));
  assert.equal((await ask(f.ledger, "too-long", { expiresAt: "2030-01-02T00:00:01.000Z" })).ok, false);
  assert.equal((await f.ledger.answer({ requestId: "missing", answer: "yes", answeredAt: t.yes, source: "person" })).ok, false);
  await ask(f.ledger, "expired", { expiresAt: "2030-01-01T00:01:00.000Z" }); await yes(f.ledger, "expired");
  assert.match((await f.ledger.claim({ requestId: "expired", actionId: action.actionId, digest, now: "2030-01-01T00:01:01.000Z" })).reason, /expired/);
  await ask(f.ledger); await yes(f.ledger); await f.ledger.answer({ requestId: "r1", answer: "no", answeredAt: t.claim, source: "person" });
  assert.equal((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).ok, false);
  await f.ledger.answer({ requestId: "r1", answer: "yes", answeredAt: t.claim, source: "person" }); assert.equal((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).ok, true);
  assert.equal((await f.ledger.answer({ requestId: "r1", answer: "no", answeredAt: t.finish, source: "person" })).ok, false);
  await ask(f.ledger, "withdraw"); await yes(f.ledger, "withdraw"); assert.equal((await f.ledger.withdraw({ requestId: "withdraw", withdrawnAt: t.claim })).ok, true); assert.equal((await f.ledger.claim({ requestId: "withdraw", actionId: action.actionId, digest, now: t.claim })).ok, false);
});

test("twenty worker claims produce one success", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger); await yes(f.ledger);
  const workerSource = `import { parentPort, workerData } from 'node:worker_threads'; import { openApprovalLedger } from ${JSON.stringify(new URL("../src/index.mjs", import.meta.url).href)}; const l=await openApprovalLedger(workerData.paths); parentPort.postMessage(await l.claim(workerData.claim));`;
  const results = await Promise.all(Array.from({ length: 20 }, () => new Promise((resolvePromise, reject) => { const worker = new Worker(workerSource, { eval: true, type: "module", workerData: { paths: { ledgerDir: f.ledgerDir, storePath: f.storePath }, claim: { requestId: "r1", actionId: action.actionId, digest, now: t.claim } } }); worker.once("message", resolvePromise); worker.once("error", reject); })));
  assert.equal(results.filter((result) => result.ok).length, 1);
});

test("unfinished claim is in flight and cannot be reused", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger); await yes(f.ledger); await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim });
  assert.equal((await f.ledger.status("r1")).status, "inFlight"); assert.equal((await f.ledger.claim({ requestId: "r1", actionId: action.actionId, digest, now: t.claim })).ok, false);
});

test("damage fails closed, reset preserves every protected request id", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger); await yes(f.ledger);
  const path = join(f.ledgerDir, "ledger.json"); const original = await readFile(path, "utf8"); const entries = JSON.parse(original);
  for (const damaged of [entries.slice(1), [{ ...entries[0], description: "edited" }, ...entries.slice(1)], [...entries].reverse()]) {
    await writeFile(path, JSON.stringify(damaged)); assert.equal((await f.ledger.verify()).ok, false); await writeFile(path, original);
  }
  await writeFile(path, JSON.stringify(entries.slice(0, 1))); assert.equal((await f.ledger.verify()).ok, false);
  assert.equal((await f.ledger.reset()).ok, true); assert.equal((await ask(f.ledger)).ok, false); assert.equal((await f.ledger.answer({ requestId: "r1", answer: "yes", answeredAt: t.yes, source: "person" })).ok, false);
});

test("symlinks, inside stores, and stale locks are refused", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); await ask(f.ledger); const path = join(f.ledgerDir, "ledger.json"); const target = join(f.root, "copy.json"); await writeFile(target, await readFile(path)); await rm(path); await symlink(target, path); assert.equal((await f.ledger.verify()).ok, false); assert.equal((await f.ledger.reset()).ok, true); assert.equal((await ask(f.ledger)).ok, false);
  await assert.rejects(() => openApprovalLedger({ ledgerDir: join(f.root, "inside"), storePath: join(f.root, "inside", "head.json") }), /outside/);
  const g = await fixture(); context.after(() => rm(g.root, { recursive: true, force: true })); await writeFile(join(g.ledgerDir, ".lock"), "stale"); const result = await ask(g.ledger); assert.match(result.reason, /remove/); assert.ok((await readdir(g.ledgerDir)).includes(".lock"));
});

test("pending and history use supplied times", async (context) => {
  const f = await fixture(); context.after(() => rm(f.root, { recursive: true, force: true })); assert.match((await f.ledger.pending(t.ask)).message, /Nothing/); await ask(f.ledger); assert.deepEqual((await f.ledger.pending(t.yes)).requests, ["r1"]); assert.equal((await f.ledger.history()).entries.length, 1);
});
