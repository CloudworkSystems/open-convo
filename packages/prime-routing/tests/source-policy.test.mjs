import assert from "node:assert/strict";
import test from "node:test";

const FORBIDDEN_MODULES = ["fs", "child_process", "http", "https", "net", "dns", "dgram"];

test("the ESM guard blocks static and dynamic network and child_process imports", async () => {
  await assert.rejects(import("./fixtures/static-network-import.mjs"), /test blocked node:net/u);
  await assert.rejects(import("./fixtures/dynamic-network-import.mjs"), /test blocked node:https/u);
  await assert.rejects(import("./fixtures/static-child-process-import.mjs"), /test blocked node:child_process/u);
  await assert.rejects(import("./fixtures/dynamic-child-process-import.mjs"), /test blocked node:child_process/u);
});

test("the routing library has no static or dynamic forbidden built-in import", async () => {
  const { readFile } = process.getBuiltinModule("node:fs/promises");
  const source = await readFile(new URL("../src/index.mjs", import.meta.url), "utf8");

  for (const moduleName of FORBIDDEN_MODULES) {
    const specifier = `(?:node:)?${moduleName}(?:/promises)?`;
    const staticImport = new RegExp(`\\b(?:import|export)\\s+(?:[^;]*?\\s+from\\s+)?["']${specifier}["']`, "u");
    const dynamicImport = new RegExp(`\\bimport\\s*\\(\\s*["']${specifier}["']\\s*\\)`, "u");
    assert.doesNotMatch(source, staticImport, `src/index.mjs must not statically import ${moduleName}`);
    assert.doesNotMatch(source, dynamicImport, `src/index.mjs must not dynamically import ${moduleName}`);
  }
});
