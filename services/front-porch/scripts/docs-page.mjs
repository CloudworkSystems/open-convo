// Generates the reference parts of the public docs page (site/api.html) from
// the API contract: the REST table from openapi.json, and the MCP table and
// size limit from the tools the server actually offers. The page's own prose
// stays hand-written; everything between the generated markers comes from
// here. Run `npm run docs` after changing the API; a test fails until you do.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tools } from '../src/mcp.js';
import { MAX_MCP_BYTES } from '../src/handler.js';

const here = (rel) => new URL(rel, import.meta.url);
export const PAGE = fileURLToPath(here('../../../site/api.html'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function describeParam(name, schema, description, required) {
  const limits = schema.maxLength ? `, up to ${schema.maxLength} characters` : '';
  return `<code>${esc(name)}</code> (${required ? 'required' : 'optional'} ${esc(schema.type)}${limits}): ${esc(description ?? '')}`;
}

export function restTable(openapi) {
  const rows = [];
  for (const [path, ops] of Object.entries(openapi.paths)) {
    for (const [method, op] of Object.entries(ops)) {
      const params = (op.parameters ?? []).map((p) => describeParam(p.name, p.schema, p.description, p.required));
      rows.push(`          <tr><td><code>${method.toUpperCase()} ${esc(path)}</code></td><td>${esc(op.summary)}.</td><td>${params.length ? params.join('<br>') : 'None'}</td></tr>`);
    }
  }
  return [
    '      <table>',
    '        <thead><tr><th>Request</th><th>What it returns</th><th>Parameters</th></tr></thead>',
    '        <tbody>',
    ...rows,
    '        </tbody>',
    '      </table>',
  ].join('\n');
}

export function mcpTable(toolset) {
  const rows = Object.entries(toolset).map(([name, tool]) => {
    const props = Object.entries(tool.inputSchema.properties ?? {});
    const required = tool.inputSchema.required ?? [];
    const args = props.map(([key, schema]) => describeParam(key, schema, schema.description, required.includes(key)));
    return `          <tr><td><code>${esc(name)}</code></td><td>${esc(tool.description)}</td><td>${args.length ? args.join('<br>') : 'None'}</td></tr>`;
  });
  return [
    '      <table>',
    '        <thead><tr><th>Tool</th><th>What it returns</th><th>Arguments</th></tr></thead>',
    '        <tbody>',
    ...rows,
    '        </tbody>',
    '      </table>',
    `      <p>Requests over ${MAX_MCP_BYTES / 1024} KB are refused.</p>`,
  ].join('\n');
}

export function sections() {
  const openapi = JSON.parse(readFileSync(here('../openapi.json'), 'utf8'));
  const content = JSON.parse(readFileSync(here('../content.json'), 'utf8'));
  return { rest: restTable(openapi), mcp: mcpTable(tools(content)) };
}

const marker = (name) => new RegExp(`(<!-- generated:${name} from services/front-porch, npm run docs -->\\n)[\\s\\S]*?<!-- /generated:${name} -->`);

export function render(page, generated = sections()) {
  let out = page;
  for (const [name, html] of Object.entries(generated)) {
    if (!marker(name).test(out)) throw new Error(`site/api.html has no generated:${name} markers`);
    out = out.replace(marker(name), (_, start) => `${start}${html}\n      <!-- /generated:${name} -->`);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(PAGE, render(readFileSync(PAGE, 'utf8')));
  console.log('Updated site/api.html');
}
