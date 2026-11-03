import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";

function command(args) {
  const script = new URL("../src/sample.mjs", import.meta.url);
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(script, { argv: args, stdout: true, stderr: true });
    let stdout = "", stderr = "";
    worker.stdout.on("data", (part) => { stdout += part; });
    worker.stderr.on("data", (part) => { stderr += part; });
    worker.once("error", reject);
    worker.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("sample refuses unmarked folders and accepts no action text", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "approval-sample-")); context.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, "occupied")); await writeFile(join(root, "occupied", "other"), "not a marker");
  const unmarked = await command(["--dir", join(root, "occupied"), "ask"]);
  assert.equal(unmarked.code, 1); assert.match(unmarked.stderr, /SAMPLE-ONLY/);
  const extra = await command(["--dir", join(root, "sample"), "ask", "extra action text"]);
  assert.equal(extra.code, 1); assert.match(extra.stderr, /one fixed verb and no action text/);
  const valid = await command(["--dir", join(root, "sample"), "ask"]);
  assert.equal(valid.code, 0); assert.equal(JSON.parse(valid.stdout).ok, true);
});

test("fixed late and changed sample commands print the approval refusals", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "approval-scenarios-")); context.after(() => rm(root, { recursive: true, force: true }));
  for (const [verb, reason] of [["claim-late", "This yes expired at 2030-01-01T12:30:00.000Z"], ["claim-changed", "This yes was for a different action"]]) {
    const folder = join(root, verb);
    for (const step of ["ask", "yes"]) assert.equal(JSON.parse((await command(["--dir", folder, step])).stdout).ok, true);
    const result = await command(["--dir", folder, verb]);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), { ok: false, reason });
    const extra = await command(["--dir", folder, verb, "free-form action"]);
    assert.equal(extra.code, 1);
  }
});
