import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSample } from "../src/sample.mjs";

test("sample refuses unmarked folders and accepts no action text", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "approval-sample-")); context.after(() => rm(root, { recursive: true, force: true })); await mkdir(join(root, "occupied")); await writeFile(join(root, "occupied", "other"), "not a marker");
  assert.rejects(() => runSample(join(root, "occupied"), "ask"), /SAMPLE-ONLY/);
  assert.equal((await runSample(join(root, "sample"), "ask")).ok, true);
});
