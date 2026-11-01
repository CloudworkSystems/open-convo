import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, guarded, REST_PATHS } from '../src/handler.js';

const content = JSON.parse(readFileSync(new URL('../content.json', import.meta.url), 'utf8'));
const openapi = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const get = (path, init) => handle(new Request(`https://api.trueconvo.com${path}`, init));

const SECURITY = {
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
};
function assertSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY)) assert.equal(response.headers.get(name), value, name);
}

test('each REST path answers with JSON from the content file', async () => {
  const expected = {
    '/v1/about': content.about,
    '/v1/features': { features: content.features },
    '/v1/faq': { faq: content.faq },
    '/v1/privacy': content.privacy,
    '/v1/status': content.status,
    '/openapi.json': openapi,
  };
  for (const [path, body] of Object.entries(expected)) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.equal(r.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(r.headers.get('cache-control'), 'public, max-age=300');
    assertSecurityHeaders(r);
    assert.deepEqual(await r.json(), body, path);
  }
});

test('updates come newest first', async () => {
  const { updates } = await (await get('/v1/updates')).json();
  const dates = updates.map((u) => u.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
  assert.equal(updates.length, content.updates.length);
});

test('faq filters by every word, case-insensitively', async () => {
  const { faq } = await (await get('/v1/faq?q=ACCOUNT%20chatgpt')).json();
  assert.deepEqual(faq.map((f) => f.id), ['account']);
  const none = await (await get('/v1/faq?q=zebra')).json();
  assert.deepEqual(none.faq, []);
  const blank = await (await get('/v1/faq?q=%20')).json();
  assert.equal(blank.faq.length, content.faq.length);
});

test('a query over 200 characters is refused and not echoed', async () => {
  const q = 'x'.repeat(201);
  const r = await get(`/v1/faq?q=${q}`);
  assert.equal(r.status, 400);
  assertSecurityHeaders(r);
  assert.ok(!(await r.text()).includes(q));
  assert.equal((await get(`/v1/faq?q=${'x'.repeat(200)}`)).status, 200);
});

test('other methods get 405 and unknown paths 404', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
    const r = await get('/v1/about', { method });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.get('allow'), 'GET');
    assertSecurityHeaders(r);
  }
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const r = await get('/mcp', { method });
    assert.equal(r.status, 405, `${method} /mcp`);
    assert.equal(r.headers.get('allow'), 'POST');
  }
  const missing = await get('/v1/secrets');
  assert.equal(missing.status, 404);
  assertSecurityHeaders(missing);
  assert.deepEqual(await missing.json(), { error: { status: 404, message: 'Not found.' } });
});

test('an internal error returns no stack trace or file path', async () => {
  const boom = guarded(() => {
    throw new Error('secret detail at /home/user/front-porch/src/handler.js:42');
  });
  const r = await boom(new Request('https://api.trueconvo.com/v1/about'));
  assert.equal(r.status, 500);
  assertSecurityHeaders(r);
  const text = await r.text();
  assert.deepEqual(JSON.parse(text), { error: { status: 500, message: 'Internal error.' } });
  assert.ok(!/secret|\/home|\.js|at /.test(text));
});

test('openapi.json is OpenAPI 3.1 and lists exactly the REST paths', () => {
  assert.match(openapi.openapi, /^3\.1\.\d+$/);
  assert.ok(openapi.info.title && openapi.info.version);
  assert.deepEqual(Object.keys(openapi.paths).sort(), [...REST_PATHS].sort());
  for (const [path, item] of Object.entries(openapi.paths)) {
    assert.deepEqual(Object.keys(item), ['get'], path);
    assert.ok(item.get.operationId && item.get.responses['200'], path);
  }
  // Every $ref points at something that exists.
  const refs = JSON.stringify(openapi).match(/"\$ref":"[^"]+"/g) ?? [];
  for (const ref of refs) {
    const pointer = ref.slice(8, -1).replace(/^#\//, '').split('/');
    let node = openapi;
    for (const part of pointer) node = node?.[part];
    assert.ok(node, `${ref} resolves`);
  }
});
