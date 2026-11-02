import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkTarget, expectedPaths, judge, scanSpec, ZAP_IMAGE } from '../scan/zap-scan.mjs';

const openapi = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
const local = 'http://127.0.0.1:8787';

test('the scan only targets the local server or the Worker\'s staging address', () => {
  assert.equal(checkTarget(local), local);
  assert.equal(checkTarget('https://front-porch.example-team.workers.dev'), 'https://front-porch.example-team.workers.dev');
  for (const bad of [undefined, '', 'https://api.trueconvo.com', 'https://trueconvo.com', 'http://localhost:8787',
    'https://front-porch.a.workers.dev.evil.test', 'https://other.a.workers.dev', 'http://127.0.0.1:8787/x', 'http://127.0.0.1:8787\nx']) {
    assert.throws(() => checkTarget(bad), /scan target/, String(bad));
  }
});

test('the scanned copy points only at the target and leaves the public file alone', () => {
  const spec = scanSpec(openapi, local);
  assert.deepEqual(spec.servers, [{ url: local }]);
  assert.deepEqual(spec.paths, openapi.paths);
  assert.equal(openapi.servers[0].url.startsWith('https://api.'), true);
});

test('the scan fails on medium or high alerts and on any path ZAP missed', () => {
  const paths = expectedPaths(openapi);
  assert.ok(paths.includes('/mcp') && paths.includes('/v1/faq') && paths.includes('/openapi.json'));
  const urls = paths.map((p) => local + p + (p === '/v1/faq' ? '?q=privacy' : ''));
  const clean = { site: [{ '@name': local, alerts: [{ name: 'Info', riskcode: '0' }, { name: 'Low', riskcode: '1' }] }] };
  assert.deepEqual(judge(clean, urls, paths, local), []);

  const medium = { site: [{ '@name': local, alerts: [{ name: 'Bad', riskcode: '2', instances: [{ uri: local + '/mcp' }] }] }] };
  assert.match(judge(medium, urls, paths, local).join(), /Medium alert: Bad/);
  const high = { site: [{ '@name': local, alerts: [{ name: 'Worse', riskcode: '3' }] }] };
  assert.match(judge(high, urls, paths, local).join(), /High alert: Worse/);

  const missing = judge(clean, urls.filter((u) => !u.endsWith('/mcp')), paths, local);
  assert.deepEqual(missing, ['ZAP never reached /mcp.']);
  // A URL on some other host doesn't count as reaching the path.
  assert.deepEqual(judge(clean, ['https://elsewhere.test/mcp', ...urls.filter((u) => !u.endsWith('/mcp'))], paths, local), ['ZAP never reached /mcp.']);
});

test('the scanner image is pinned by digest', () => {
  assert.match(ZAP_IMAGE, /@sha256:[0-9a-f]{64}$/);
});
