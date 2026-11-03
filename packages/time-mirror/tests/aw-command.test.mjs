import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { makeFetchJson, run } from '../src/aw-command.mjs';

const marker = 'PRIVATE-WINDOW-MARKER';
const buckets = {
  window: { type: 'currentwindow', hostname: 'test-mac' },
  idle: { type: 'afkstatus', hostname: 'test-mac' },
};
const windows = [{ timestamp: '2026-10-01T10:00:00Z', duration: 60, data: { app: 'Editor', title: marker, url: `https://${marker}` } }];
const idle = [{ timestamp: '2026-10-01T10:00:00Z', duration: 60, data: { status: 'not-afk', title: marker } }];

function response(value, init) { return new Response(typeof value === 'string' ? value : JSON.stringify(value), init); }

function inventedFetch(calls = []) {
  return async (url, options) => {
    calls.push({ url, options });
    if (url === 'http://127.0.0.1:5600/api/0/buckets/') return response(buckets);
    if (url.includes('/window/events?')) return response(windows);
    if (url.includes('/idle/events?')) return response(idle);
    throw new Error('unexpected URL');
  };
}

test('command reads only literal loopback, lists apps without titles or URLs, and writes nothing', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'time-mirror-command-'));
  const tags = join(folder, 'tags.json');
  await writeFile(tags, '{}');
  const calls = [];
  const lines = [];
  const result = await run(['--from', '2026-10-01', '--to', '2026-10-01', '--tz', 'UTC', '--host', 'test-mac', '--tags', tags, '--list-apps'],
    { fetchImpl: inventedFetch(calls), stdout: line => lines.push(line) });
  assert.equal(result.apps.Editor, 1);
  assert.ok(calls.every(call => call.url.startsWith('http://127.0.0.1:5600/api/0/buckets/')));
  assert.ok(calls.every(call => call.options.redirect === 'manual'));
  assert.match(lines.join('\n'), /Editor\t1\.00 minutes/);
  assert.doesNotMatch(lines.join('\n'), new RegExp(marker));
  await assert.rejects(readFile(join(folder, 'page.html')), /ENOENT/);
  await assert.rejects(run(['--from', '2026-10-01', '--to', '2026-10-01', '--tz', 'UTC', '--host', 'test-mac', '--tags', tags, '--list-apps', '--base', 'http://localhost:5600'],
    { fetchImpl: inventedFetch() }), /only be read at 127\.0\.0\.1/);
});

test('command writes mode 0600 through a temporary name and refuses overwrite without force', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'time-mirror-write-'));
  const tags = join(folder, 'tags.json');
  const output = join(folder, 'page.html');
  await writeFile(tags, JSON.stringify({ Editor: 'coding' }));
  const lines = [];
  await run(['--from', '2026-10-01', '--to', '2026-10-01', '--tz', 'UTC', '--host', 'test-mac', '--tags', tags, '--out', output],
    { fetchImpl: inventedFetch(), stdout: line => lines.push(line) });
  const html = await readFile(output, 'utf8');
  assert.match(html, /coding/);
  assert.doesNotMatch(html, new RegExp(marker));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  await assert.rejects(run(['--from', '2026-10-01', '--to', '2026-10-01', '--tz', 'UTC', '--host', 'test-mac', '--tags', tags, '--out', output],
    { fetchImpl: inventedFetch() }), /Refused to overwrite/);
  assert.equal(await readFile(output, 'utf8'), html);
  await run(['--from', '2026-10-01', '--to', '2026-10-01', '--tz', 'UTC', '--host', 'test-mac', '--tags', tags, '--out', output, '--force'],
    { fetchImpl: inventedFetch() });
  assert.equal((await readdir(folder)).some(name => name.endsWith('.tmp')), false);
});

test('request reader refuses redirects, caps responses, and times out', async () => {
  await assert.rejects(makeFetchJson(async () => response('', { status: 302, headers: { location: BASE } }))('/api/0/buckets/'), /redirect/);
  const capped = await makeFetchJson(async () => response('x', { headers: { 'content-length': String(2 * 1024 * 1024 + 1) } }))('/api/0/buckets/');
  assert.deepEqual(capped, { truncated: true });
  await assert.rejects(makeFetchJson((_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { name: 'AbortError' })));
  }), 5)('/api/0/buckets/'), /longer than 10 seconds/);
});

const BASE = 'http://127.0.0.1:5600/next';

test('request timeout remains active after headers while the response body stalls', async () => {
  let sentHeaders = false;
  const server = createServer((_request, response) => {
    sentHeaders = true;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    response.write('[');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const localFetch = (_url, options) => fetch(`http://127.0.0.1:${server.address().port}/`, options);
    await assert.rejects(makeFetchJson(localFetch, 100)('/api/0/buckets/'), /longer than 10 seconds/);
    assert.equal(sentHeaders, true);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
