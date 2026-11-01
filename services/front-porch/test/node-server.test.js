import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { createFrontPorchServer } from '../src/node-server.js';

// Sends raw bytes, so the test can send a request no HTTP client would build.
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => socket.end(text));
    let data = '';
    socket.on('data', (chunk) => { data += chunk; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

test('the Node entry point serves the same handler over HTTP', async (t) => {
  const server = createFrontPorchServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;

  const about = await fetch(`${base}/v1/about`);
  assert.equal(about.status, 200);
  assert.equal(about.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await about.json()).name, 'True Convo');

  const mcp = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'status' } }),
  });
  assert.equal(mcp.status, 200);
  assert.equal((await mcp.json()).result.structuredContent.stage, 'in development');

  const big = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'x'.repeat(20000),
  });
  assert.equal(big.status, 413);

  assert.equal((await fetch(`${base}/v1/about`, { method: 'DELETE' })).status, 405);
});

test('a malformed Host header gets an answer and the server keeps running', async (t) => {
  const server = createFrontPorchServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;

  for (const host of ['bad host', '[::', 'a:b:c', '%%%']) {
    const reply = await raw(port, `GET /v1/about HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    assert.match(reply, /^HTTP\/1\.1 (200|400) /, host);
  }
  const about = await fetch('http://127.0.0.1:' + port + '/v1/about');
  assert.equal(about.status, 200);
});

test('the service imports nothing host-specific', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['handler.js', 'mcp.js', 'faq.js']) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    for (const spec of imports) assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${file} imports ${spec}`);
  }
});
