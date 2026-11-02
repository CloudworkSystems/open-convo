// The public docs page (site/api.html) must list every REST path in
// openapi.json and every MCP tool, so it can't fall behind the API. This runs
// whenever the service changes, which is when the page could go stale.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tools } from '../src/mcp.js';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const page = read('../../../site/api.html');
const openapi = JSON.parse(read('../openapi.json'));
const content = JSON.parse(read('../content.json'));

test('the docs page lists every path in openapi.json', () => {
  for (const path of Object.keys(openapi.paths)) {
    assert.ok(page.includes(`<code>${path}</code>`), `site/api.html is missing ${path}`);
  }
});

test('the docs page lists every MCP tool', () => {
  assert.ok(page.includes('<code>POST /mcp</code>'));
  for (const name of Object.keys(tools(content))) {
    assert.ok(page.includes(`<code>${name}</code>`), `site/api.html is missing the ${name} tool`);
  }
});

test('the docs page and the privacy policy link each other', () => {
  assert.ok(page.includes('href="privacy.html"'));
  assert.ok(read('../../../site/privacy.html').includes('href="api.html"'));
});
