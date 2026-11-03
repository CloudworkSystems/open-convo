import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

test("source uses no network, child process, or ambient clock and only public routing API", async () => {
  const root = new URL("../src/", import.meta.url); const names = await readdir(root);
  const source = (await Promise.all(names.map((name) => readFile(new URL(name, root), "utf8")))).join("\n");
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|dgram|dns|child_process)/);
  assert.doesNotMatch(source, /Date\.now\s*\(|new Date\s*\(\s*\)/);
  assert.doesNotMatch(source, /prime-routing\/src\/(?!index\.mjs)/);
});
