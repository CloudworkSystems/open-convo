import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(root, 'native-dist');
const vectors = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/native-host-v1.json'), 'utf8'));
const sessionId = vectors.cases.find((entry) => entry.name === 'workspace.read').reply.record.selection.sessionId;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
let server; let browser; let origin;

async function cleanup() {
  try { await browser?.close(); } finally {
    browser = undefined;
    if (server) {
      const owned = server; server = undefined;
      await new Promise((done) => { owned.close(done); owned.closeAllConnections(); });
    }
  }
}

before(async () => {
  try {
    assert.ok(existsSync(resolve(build, 'index.html')), 'Run npm run build:native-proof before this compiled-entry test.');
    // Serve the compiled bytes unchanged. There is no Vite dev server, source
    // entry interception or replacement App in this proof.
    server = createServer(async (request, response) => {
      try {
        const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
        const file = resolve(build, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!file.startsWith(`${build}${sep}`) || !(await stat(file)).isFile()) throw Error('Not found');
        response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
        response.end(await readFile(file));
      } catch { response.writeHead(404); response.end('Not found'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    origin = `http://127.0.0.1:${server.address().port}`;
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

async function fixture(mode = 'ready') {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage();
    const errors = []; const outside = []; const resources = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('request', (request) => resources.push(new URL(request.url()).pathname));
    await page.route('**/*', async (route) => {
      const target = new URL(route.request().url());
      if (target.origin !== origin) { outside.push(target.origin); return route.abort(); }
      return route.continue();
    });
    await page.addInitScript(({ vectors, mode }) => {
      const forbidden = []; const failures = []; const sent = []; const replies = new Map();
      const clone = (value) => JSON.parse(JSON.stringify(value));
      let record = clone(vectors.cases.find((entry) => entry.name === 'workspace.read').reply.record);
      const capabilities = clone(vectors.cases.find((entry) => entry.name === 'host.capabilities').reply.capabilities);
      const bootstrap = Object.freeze({ v: 1, connectionId: vectors.context.connectionId, generation: vectors.context.documentGeneration });
      let hostLocked = false;
      let bindings = 0;
      const lock = () => {
        hostLocked = true;
        window.dispatchEvent(new CustomEvent('trueconvo-host', { detail: { type: 'host.connection',
          connectionId: bootstrap.connectionId, generation: bootstrap.generation, state: 'locked', reason: 'locked' } }));
      };
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
      for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) {
        Object.defineProperty(window, key, { configurable: true, get() {
          forbidden.push(key); throw Error(`Forbidden browser authority: ${key}`);
        } });
      }
      URL.createObjectURL = () => { forbidden.push('object-url'); throw Error('Forbidden plaintext export'); };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.hasAttribute('download')) { forbidden.push('download'); throw Error('Forbidden plaintext download'); }
        return click.call(this);
      };
      const postMessage = async (input) => {
        try {
          const request = clone(input); const wire = JSON.stringify(request);
          if (JSON.stringify(Object.keys(request).sort()) !== JSON.stringify(['v', 'requestId', 'connectionId', 'generation', 'operation', 'payload'].sort())
            || request.v !== 1 || request.connectionId !== bootstrap.connectionId || request.generation !== bootstrap.generation
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.requestId)) throw Error('Invalid fixture request correlation');
          sent.push(request);
          const previous = replies.get(request.requestId);
          if (previous) {
            if (previous.wire !== wire) throw Error('A request ID was reused with different bytes');
            return clone(previous.reply);
          }
          const base = { v: 1, requestId: request.requestId, connectionId: request.connectionId,
            generation: request.generation, operation: request.operation };
          let reply;
          if (request.operation === 'host.capabilities') {
            if (Object.keys(request.payload).length !== 0) throw Error('Unexpected capability payload');
            reply = { ...base, outcome: 'ok', capabilities: clone(capabilities) };
          } else if (request.operation === 'dictation.unbindDraft') {
            // Unbind names only the binding, never the workspace handle.
            reply = hostLocked ? { ...base, outcome: 'refused', reason: 'store-locked' } : { ...base, outcome: 'ok' };
          } else {
            if (request.payload.workspaceHandle !== capabilities.workspaceHandle) throw Error('Unexpected workspace handle');
            if (hostLocked || mode === 'lock-on-commit' && request.operation === 'workspace.commitProof') {
              hostLocked = true;
              reply = { ...base, outcome: 'refused', reason: 'store-locked' };
            } else if (request.operation === 'workspace.read') {
              reply = { ...base, outcome: 'ok', revision: record.revision, record: clone(record) };
            } else if (request.operation === 'workspace.commitProof') {
              if (request.payload.expectedRevision !== record.revision) {
                reply = { ...base, outcome: 'conflict', revision: record.revision, reason: 'revision-mismatch' };
              } else {
                if (!Number.isSafeInteger(request.payload.record?.revision) || request.payload.record.revision <= record.revision) throw Error('Invalid proposed fixture revision');
                record = clone(request.payload.record);
                reply = { ...base, outcome: 'ok', revision: record.revision };
              }
            } else if (request.operation === 'dictation.bindDraft') {
              // Like the real host: the Desk keeps the focused draft bound for dictation.
              bindings += 1;
              reply = { ...base, outcome: 'ok', revision: request.payload.expectedRevision,
                bindingId: `b1000000-0000-4000-8000-${String(bindings).padStart(12, '0')}` };
            } else throw Error('Unexpected fixture operation');
          }
          replies.set(request.requestId, { wire, reply: clone(reply) });
          return clone(reply);
        } catch (error) { failures.push(error.message); throw error; }
      };
      // The test supplies invented WK-shaped inputs. These objects do not
      // authenticate a native host or prove Mac/private-data readiness.
      if (mode !== 'missing-host') {
        Object.defineProperty(window, 'trueConvoHostBootstrap', { value: bootstrap });
        Object.defineProperty(window, 'webkit', { value: Object.freeze({ messageHandlers: Object.freeze({
          trueConvoHost: Object.freeze({ postMessage }),
        }) }) });
      }
      Object.defineProperty(window, '__nativeEntryFixture', { value: Object.freeze({ lock,
        inspect: () => clone({ forbidden, failures, sent, record }),
      }) });
    }, { vectors, mode });
    await page.goto(origin);
    return {
      page,
      inspect: () => page.evaluate(() => window.__nativeEntryFixture.inspect()),
      async check() {
        const inspected = await page.evaluate(() => window.__nativeEntryFixture.inspect());
        assert.deepEqual(inspected.forbidden, [], 'Compiled native entry touched browser persistence or export');
        assert.deepEqual(inspected.failures, [], 'Invented compare-and-commit host rejected the app request');
        assert.deepEqual(errors, []); assert.deepEqual(outside, []);
        assert.ok(resources.some((path) => /^\/assets\/index-.*\.js$/.test(path)), 'The compiled entry was not loaded');
        assert.ok(!resources.some((path) => path.startsWith('/src/')), 'A source entry was loaded instead of the compiled build');
      },
      close: () => context.close(),
    };
  } catch (error) { await context.close(); throw error; }
}

test('compiled native entry negotiates, loads, edits and commits through the full App; a lock event clears it', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const draft = page.getByLabel('Your message', { exact: true });
    await expect(draft).toHaveValue('Before 😀 after');
    await expect(page.getByText('Native join proof · invented data only', { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    const initial = await f.inspect();
    assert.deepEqual(initial.sent.map((request) => request.operation), ['host.capabilities', 'workspace.read']);
    const text = 'Invented compiled-entry draft 😀 with literal text.';
    await draft.fill(text);
    await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toBeVisible();
    const saved = await f.inspect();
    assert.deepEqual(saved.sent.map((request) => request.operation), ['host.capabilities', 'workspace.read', 'workspace.commitProof']);
    const commit = saved.sent.at(-1);
    assert.equal(commit.payload.expectedRevision, initial.record.revision);
    assert.equal(commit.payload.record.revision, initial.record.revision + 1);
    assert.equal(commit.payload.record.drafts[sessionId], text);
    assert.equal(saved.record.drafts[sessionId], text);
    assert.equal(new Set(saved.sent.map((request) => request.requestId)).size, saved.sent.length);
    await page.getByRole('button', { name: 'User options', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => window.__nativeEntryFixture.lock());
    await expect(page.getByRole('heading', { name: 'Workspace connection closed', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(draft).toHaveCount(0);
    await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toHaveCount(0);
    assert.equal((await f.inspect()).sent.length, saved.sent.length);
    await f.check();
  } finally { await f.close(); }
});

test('compiled native entry without a host refuses to open and never seeds browser storage', async () => {
  const f = await fixture('missing-host');
  try {
    await expect(f.page.getByRole('heading', { name: 'Workspace unavailable', exact: true })).toBeVisible();
    await expect(f.page.getByLabel('Your message', { exact: true })).toHaveCount(0);
    assert.deepEqual((await f.inspect()).sent, []);
    await f.check();
  } finally { await f.close(); }
});

test('compiled native entry keeps saving a 300-character sequence beyond the request retention limit', async () => {
  const f = await fixture(); const { page } = f;
  try {
    const draft = page.getByLabel('Your message', { exact: true });
    await expect(draft).toHaveValue('Before 😀 after');
    const text = 'Invented sequential edit 0123456789. '.repeat(9).slice(0, 300);
    assert.equal(text.length, 300);
    await draft.focus();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.press('Backspace');
    // Separate real keyboard events exercise normal per-keystroke saves. A
    // fill or one synthetic input would never reach the former 256-ID limit.
    await draft.pressSequentially(text, { delay: 2 });
    const afterTyping = await f.inspect();
    assert.ok(afterTyping.sent.length > 256,
      `Expected more than 256 native requests; got ${afterTyping.sent.length}, with ${afterTyping.record.drafts[sessionId].length}/300 characters persisted.`);
    await expect.poll(async () => (await f.inspect()).record.drafts[sessionId]).toBe(text);
    await expect(draft).toHaveValue(text);
    await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toBeVisible();
    await expect(page.locator('.save-recovery')).toHaveCount(0);
    const saved = await f.inspect();
    const commits = saved.sent.filter((request) => request.operation === 'workspace.commitProof');
    assert.ok(commits.length > 256, 'The regression must exercise more than 256 commits, not a batched input.');
    assert.equal(new Set(saved.sent.map((request) => request.requestId)).size, saved.sent.length);
    assert.equal(saved.record.revision, commits.at(-1).payload.record.revision);
    for (let index = 1; index < commits.length; index++) {
      assert.equal(commits[index].payload.expectedRevision, commits[index - 1].payload.record.revision,
        'Each committed edit must compare against the preceding confirmed revision.');
    }
    await f.check();
  } finally { await f.close(); }
});

test('a correlated store-locked commit reply clears the compiled App even without a lock event', async () => {
  const f = await fixture('lock-on-commit'); const { page } = f;
  try {
    const draft = page.getByLabel('Your message', { exact: true });
    await expect(draft).toHaveValue('Before 😀 after');
    await draft.fill('Invented edit refused after the proof store locked.');
    await expect(page.getByRole('heading', { name: 'Workspace connection closed', exact: true })).toBeVisible();
    await expect(draft).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0);
    const inspected = await f.inspect();
    assert.deepEqual(inspected.sent.map((request) => request.operation), ['host.capabilities', 'workspace.read', 'workspace.commitProof']);
    assert.equal(inspected.record.revision, 1);
    assert.equal(inspected.record.drafts[sessionId], 'Before 😀 after');
    await f.check();
  } finally { await f.close(); }
});
