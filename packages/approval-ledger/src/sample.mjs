import { constants, lstat, mkdir, open as openFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { actionDigest, openApprovalLedger } from "./index.mjs";

const ACTION = { actionId: "invented-send", description: "Send the invented note to Robin", kind: "send", payload: { note: "Invented hello" } };
const DIGEST = actionDigest({ description: ACTION.description, kind: ACTION.kind, payload: ACTION.payload });
const TIMES = { asked: "2030-01-01T12:00:00.000Z", answered: "2030-01-01T12:01:00.000Z", claim: "2030-01-01T12:02:00.000Z", finish: "2030-01-01T12:03:00.000Z" };

async function missing(path) { try { await lstat(path); return false; } catch (error) { if (error.code === "ENOENT") return true; throw error; } }

async function setup(root) {
  const marker = join(root, "SAMPLE-ONLY");
  if (await missing(root)) await mkdir(root, { recursive: true, mode: 0o700 });
  const entries = await (await import("node:fs/promises")).readdir(root);
  if (entries.length === 0) await writeFile(marker, "Invented approval-ledger sample only.\n", { mode: 0o600, flag: "wx" });
  if (await missing(marker) || (await readFile(marker, "utf8")) !== "Invented approval-ledger sample only.\n") throw new Error("Refusing this folder because it does not have the SAMPLE-ONLY marker created by this driver");
  return openApprovalLedger({ ledgerDir: join(root, "ledger"), storePath: join(root, "state", "head.json") });
}

export async function runSample(rootValue, verb) {
  const root = resolve(rootValue);
  const ledger = await setup(root); const requestId = "invented-request";
  let result;
  if (verb === "ask") result = await ledger.ask({ requestId, actionId: ACTION.actionId, digest: DIGEST, description: ACTION.description, kind: ACTION.kind, askedAt: TIMES.asked });
  else if (verb === "yes" || verb === "no") result = await ledger.answer({ requestId, answer: verb, answeredAt: TIMES.answered, source: "person" });
  else if (verb === "withdraw") result = await ledger.withdraw({ requestId, withdrawnAt: TIMES.answered });
  else if (verb === "claim") result = await ledger.claim({ requestId, actionId: ACTION.actionId, digest: DIGEST, now: TIMES.claim });
  else if (verb === "claim-late") result = await ledger.claim({ requestId, actionId: ACTION.actionId, digest: DIGEST, now: "2030-01-01T12:30:01.000Z" });
  else if (verb === "claim-changed") result = await ledger.claim({ requestId, actionId: ACTION.actionId, digest: actionDigest({ description: "Send the different invented note to Robin", kind: ACTION.kind, payload: ACTION.payload }), now: TIMES.claim });
  else if (verb === "finish") {
    const status = await ledger.status(requestId); result = await ledger.finish({ requestId, claimId: status.claim?.claimId ?? "missing", outcome: "done", finishedAt: TIMES.finish });
  } else if (verb === "reset") result = await ledger.reset();
  else if (verb === "lock") { const path = join(root, "ledger", ".lock"); await mkdir(join(root, "ledger"), { recursive: true }); const handle = await openFile(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); await handle.close(); result = { ok: true, message: `Left the invented crash lock at ${path}` }; }
  else throw new Error("Unknown sample verb");
  return result;
}

async function main() {
  const args = process.argv.slice(2); const at = args.indexOf("--dir");
  if (at < 0 || !args[at + 1]) throw new Error("Usage: sample.mjs --dir <folder> <ask|yes|no|withdraw|claim|claim-late|claim-changed|finish|reset|lock>");
  const operands = args.filter((value, index) => index !== at && index !== at + 1 && !value.startsWith("--"));
  if (operands.length !== 1) throw new Error("The sample accepts one fixed verb and no action text");
  process.stdout.write(`${JSON.stringify(await runSample(args[at + 1], operands[0]), null, 2)}\n`);
}

if (resolve(process.argv[1] ?? "") === resolve(fileURLToPath(import.meta.url))) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
