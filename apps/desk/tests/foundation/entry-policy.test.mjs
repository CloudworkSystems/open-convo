import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

test("the foundation entry keeps connections and executable assets local", () => {
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /base-uri '(?:self|none)'/);
  assert.doesNotMatch(html, /<script[^>]+src=["'](?:https?:|\/\/)/i);
});

test("one React entry replaces the legacy default shell", () => {
  assert.match(html, /id=["']root["']/);
  assert.match(html, /type=["']module["'][^>]+src=["']\/src\/main\.tsx["']/);
  assert.doesNotMatch(html, /<script[^>]+src=["'][^"']*\bapp\.js/);
});
