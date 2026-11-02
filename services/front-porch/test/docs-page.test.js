// The public docs page (site/api.html) must match the API contract exactly:
// its REST and MCP reference tables are generated from openapi.json and the
// server's tools by scripts/docs-page.mjs. Any change to a path, method,
// summary, parameter, tool, argument or the size limit (added, removed or
// edited) fails here until `npm run docs` regenerates the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PAGE, render, restTable, mcpTable } from '../scripts/docs-page.mjs';
import { tools } from '../src/mcp.js';

const page = readFileSync(PAGE, 'utf8');
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('site/api.html is up to date with openapi.json and the MCP tools (run npm run docs)', () => {
  assert.equal(page, render(page));
});

test('a removed path or tool would show up as a difference', () => {
  const openapi = JSON.parse(read('../openapi.json'));
  const fewer = { ...openapi, paths: { ...openapi.paths } };
  delete fewer.paths['/v1/faq'];
  assert.notEqual(restTable(fewer), restTable(openapi));
  const toolset = tools(JSON.parse(read('../content.json')));
  const { faq, ...rest } = toolset;
  assert.notEqual(mcpTable(rest), mcpTable(toolset));
});

test('the docs page and the privacy policy link each other', () => {
  assert.ok(page.includes('href="privacy.html"'));
  assert.ok(read('../../../site/privacy.html').includes('href="api.html"'));
});
