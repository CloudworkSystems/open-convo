import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, MAX_MCP_BYTES } from '../src/handler.js';

const content = JSON.parse(readFileSync(new URL('../content.json', import.meta.url), 'utf8'));
const post = (body, headers = { 'content-type': 'application/json' }) =>
  handle(new Request('https://api.trueconvo.com/mcp', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
const rpc = async (method, params, id = 1) => {
  const r = await post({ jsonrpc: '2.0', id, method, params });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  return r.json();
};

test('initialize, initialized, tools/list and tools/call', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'true-convo-front-porch');

  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(await note.text(), '');

  const list = await rpc('tools/list', {}, 2);
  assert.deepEqual(list.result.tools.map((t) => t.name), ['about', 'features', 'faq', 'privacy', 'status', 'updates']);
  assert.ok(list.result.tools.every((t) => t.annotations.readOnlyHint === true));

  const about = await rpc('tools/call', { name: 'about', arguments: {} }, 3);
  assert.equal(about.id, 3);
  assert.deepEqual(about.result.structuredContent, content.about);
  assert.deepEqual(JSON.parse(about.result.content[0].text), content.about);

  const faq = await rpc('tools/call', { name: 'faq', arguments: { q: 'ads' } }, 4);
  assert.deepEqual(faq.result.structuredContent.faq.map((f) => f.id), ['ads']);
});

test('an unknown protocol version gets the newest supported one', async () => {
  const init = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(init.result.protocolVersion, '2025-06-18');
});

test('unknown tools, bad arguments and unknown methods are refused', async () => {
  assert.equal((await rpc('tools/call', { name: 'delete_everything' })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'constructor' })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'faq', arguments: { q: 'x'.repeat(201) } })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'faq', arguments: { other: 'x' } })).error.code, -32602);
  assert.equal((await rpc('tools/call', { name: 'about', arguments: 'text' })).error.code, -32602);
  assert.equal((await rpc('resources/list')).error.code, -32601);
});

test('malformed requests', async () => {
  assert.equal((await post('{not json')).status, 400);
  assert.equal((await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }])).status, 400);
  assert.equal((await post({ jsonrpc: '1.0', id: 1, method: 'ping' })).status, 400);
  assert.equal((await post({ jsonrpc: '2.0', id: null, method: 'ping' })).status, 400);
  assert.equal((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'content-type': 'text/plain' })).status, 415);
});

test('requests over 16 KB are refused', async () => {
  const pad = 'x'.repeat(MAX_MCP_BYTES);
  const big = await post({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad } });
  assert.equal(big.status, 413);
  assert.equal(big.headers.get('x-content-type-options'), 'nosniff');
  // Also without a Content-Length header, read as a stream.
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad } })));
      c.close();
    },
  });
  const r = await handle(new Request('https://api.trueconvo.com/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half',
  }));
  assert.equal(r.status, 413);
  const ok = await post({ jsonrpc: '2.0', id: 1, method: 'ping' });
  assert.equal(ok.status, 200);
});
