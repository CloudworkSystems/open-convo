import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { copyAllowedSourceFiles, DEVELOPMENT_SOURCE_FILES } from '../../scripts/development-source.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return port;
}

test('development server confines files to the app and keeps loopback HMR working on its actual port', { timeout: 45_000 }, async () => {
  // Vite checks physical paths. macOS temp aliases must not make an outside
  // canary look outside the workspace for a reason unrelated to fs.allow.
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'true-convo-dev-boundary-')));
  const destination = join(workspace, 'desk');
  const sibling = join(workspace, 'elsewhere');
  let child;
  let browser;
  let output = '';
  try {
    await mkdir(destination);
    await mkdir(sibling);
    // A realistic enclosing workspace would otherwise widen Vite's default
    // fs.allow to the parent. Every record here is an invented test fixture.
    await writeFile(join(workspace, 'package.json'), JSON.stringify({ name: 'invented-workspace', private: true, workspaces: ['desk', 'elsewhere'] }));
    copyAllowedSourceFiles(source, destination, DEVELOPMENT_SOURCE_FILES);
    // Dependencies are read through this symlink. No canary is ever created in
    // the real repo, its prior owner store, or the shared installed packages.
    await symlink(join(source, 'node_modules'), join(destination, 'node_modules'), 'dir');
    const canary = `invented-private-canary-${randomUUID()}`;
    const outsideCanary = `invented-outside-app-canary-${randomUUID()}`;
    const outsideFile = join(sibling, 'ordinary-notes.txt');
    await writeFile(outsideFile, outsideCanary);
    const paths = [
      '.true-convo-local/lifecycle.json', 'runtime-state/owner.json', 'auth.json',
      '.npmrc', '.yarnrc.yml', '.env', '.env.local', '.git/config',
      'private.pem', 'private.crt', 'private.key', 'private.p12', 'private.pfx',
      'private.cer', 'private.der', 'private.p8', 'private.mobileprovision',
    ];
    for (const path of paths) {
      await mkdir(dirname(join(destination, path)), { recursive: true });
      await writeFile(join(destination, path), canary);
    }
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: destination, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (part) => { output = (output + part).slice(-12_000); });
    let available = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Isolated development server exited: ${output}`);
      try { if ((await fetch(origin)).ok) { available = true; break; } } catch { /* startup */ }
      await pause(100);
    }
    assert.ok(available, `Isolated development server did not start: ${output}`);
    for (const query of ['', '?raw', '?import', '?url']) {
      const response = await fetch(`${origin}/@fs${outsideFile}${query}`);
      const body = await response.text();
      assert.equal(body.includes(outsideCanary), false, 'The sibling workspace canary was exposed.');
      if (response.status === 200 && ['?import', '?url'].includes(query)) {
        // Vite may produce an inert asset-URL module before checking fs.allow.
        // Its code and source map must contain only that URL, never file bytes;
        // following the exported URL must still hit the filesystem boundary.
        const code = `export default ${JSON.stringify(`/@fs${outsideFile}`)}`;
        const lines = body.trim().split('\n');
        assert.equal(lines[0], code, 'An outside-app asset proxy contains more than its URL.');
        assert.equal(lines.length, 2, 'Unexpected content in an outside-app asset proxy.');
        const map = lines[1].match(/^\/\/# sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)$/)?.[1];
        assert.ok(map, 'Unexpected outside-app asset proxy source map.');
        const decoded = JSON.parse(Buffer.from(map, 'base64').toString('utf8'));
        assert.deepEqual(decoded.sourcesContent, [code], 'The asset proxy source map contains file bytes.');
        assert.equal(JSON.stringify(decoded).includes(outsideCanary), false, 'The asset proxy source map exposes the canary.');
        const target = await fetch(`${origin}/@fs${outsideFile}`);
        assert.ok([403, 404].includes(target.status), 'The asset proxy target was not refused.');
        assert.equal((await target.text()).includes(outsideCanary), false, 'The asset proxy target exposes the canary.');
      } else {
        assert.ok([403, 404].includes(response.status), `An outside-app file was not refused (${response.status}) for ${query || 'normal'} URL.`);
      }
    }
    for (const path of paths) {
      for (const prefix of [`/${path}`, `/@fs${join(destination, path)}`]) {
        for (const query of ['', '?raw', '?import', '?url']) {
          const response = await fetch(`${origin}${prefix}${query}`);
          const body = await response.text();
          assert.ok([403, 404].includes(response.status), `${prefix}${query} was not refused (${response.status}).`);
          assert.equal(body.includes(canary), false, `${prefix}${query} exposed private canary contents.`);
        }
      }
    }
    const page = await fetch(origin);
    assert.equal(page.status, 200, 'Normal entry stopped working while denying private files.');
    const html = await page.text();
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    assert.ok(csp, 'The dev entry has no CSP.');
    const directives = csp.split(';').map((part) => part.trim());
    assert.equal(directives.find((part) => part.startsWith('connect-src ')),
      `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
      'The CSP must name only the actual port and trusted loopback hosts.');
    assert.equal(csp.includes("'unsafe-inline'"), false, 'Development must not allow unrestricted inline content.');
    assert.equal(directives.some((part) => /^style-src-(elem|attr)(?:\s|$)/.test(part)), false,
      'Development must retain the nonce style policy without hosted style overrides.');
    const styleNonce = directives.find((part) => part.startsWith('style-src '))
      ?.match(/^style-src 'self' 'nonce-([A-Za-z0-9+/]+={0,2})'$/)?.[1];
    assert.ok(styleNonce, 'Development styles must require the server nonce.');
    assert.equal(directives.find((part) => part.startsWith('script-src ')),
      `script-src 'self' 'nonce-${styleNonce}'`, 'Development scripts must require the same server nonce.');

    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
    for (const [index, hostname] of ['127.0.0.1', 'localhost'].entries()) {
      const context = await browser.newContext();
      const errors = [];
      const refused = [];
      const socketFrames = [];
      context.setDefaultTimeout(5_000);
      context.setDefaultNavigationTimeout(5_000);
      try {
        await context.route('**/*', (route) => {
          const url = new URL(route.request().url());
          if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== String(port) || url.pathname.startsWith('/api/')) {
            refused.push(`${url.origin}${url.pathname}`);
            return route.abort();
          }
          return route.continue();
        });
        const tab = await context.newPage();
        tab.on('pageerror', (error) => errors.push(error.message));
        tab.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
        tab.on('websocket', (socket) => {
          const url = new URL(socket.url());
          assert.equal(url.protocol, 'ws:');
          assert.equal(url.hostname, hostname);
          assert.equal(url.port, String(port));
          socket.on('framereceived', ({ payload }) => {
            try { socketFrames.push(JSON.parse(String(payload))); } catch { /* non-JSON keepalive */ }
          });
        });
        await tab.goto(`http://${hostname}:${port}`);
        await expect(tab.getByText('Sample preview · sample data only', { exact: true })).toBeVisible();
        await expect.poll(() => socketFrames.some((frame) => frame.type === 'connected')).toBe(true);
        await tab.evaluate(() => { document.body.dataset.hmrMarker = 'kept-without-reload'; });
        const width = `${index + 4}px`;
        await appendFile(join(destination, 'src/shell/foundation.css'), `\n/* invented HMR proof */\n.cloud-banner { outline: ${width} solid rgb(1, 23, 45); }\n`);
        await expect.poll(() => tab.locator('.cloud-banner').evaluate((node) => getComputedStyle(node).outlineWidth)).toBe(width);
        assert.equal(await tab.evaluate(() => document.body.dataset.hmrMarker), 'kept-without-reload', 'CSS update reloaded the app instead of HMR.');
        assert.ok(socketFrames.some((frame) => frame.type === 'update'), 'No HMR update was received.');
        const nonces = await tab.evaluate(() => ({
          styles: [...document.querySelectorAll('style')].map((element) => element.nonce),
          scripts: [...document.querySelectorAll('script')].map((element) => ({ nonce: element.nonce, inline: !element.src })),
        }));
        assert.ok(nonces.styles.length > 0, 'Development did not inject any nonce-bearing styles.');
        assert.ok(nonces.scripts.some((script) => script.inline), 'The refresh preamble did not exercise inline script nonces.');
        assert.deepEqual(nonces.styles, nonces.styles.map(() => styleNonce), 'An injected development stylesheet lost its nonce.');
        assert.deepEqual(nonces.scripts.map((script) => script.nonce), nonces.scripts.map(() => styleNonce),
          'A development script lost its nonce.');
        assert.deepEqual(refused, [], 'Dev browser attempted an outside or legacy API request.');
        assert.deepEqual(errors, [], 'Dev browser reported a runtime or CSP error.');
      } finally { await context.close(); }
    }
  } finally {
    try { await browser?.close(); } finally {
      try {
        if (child) {
          const running = child.exitCode === null && child.signalCode === null;
          const exited = running ? once(child, 'exit') : Promise.resolve();
          try { process.kill(-child.pid, 'SIGTERM'); } catch { if (running) child.kill('SIGTERM'); }
          if (await Promise.race([exited.then(() => true), pause(2_000).then(() => false)]) === false) {
            try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
            await exited;
          }
        }
      } finally {
        await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  }
});
