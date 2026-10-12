import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let server; let browser; let origin; let output = '';
async function cleanup() {
  try { await browser?.close(); } finally {
    browser = undefined;
    if (server) {
      const running = server.exitCode === null && server.signalCode === null;
      const exited = running ? once(server, 'exit') : Promise.resolve();
      try { process.kill(-server.pid, 'SIGTERM'); } catch { if (running) server.kill('SIGTERM'); }
      if (!await Promise.race([exited.then(() => true), pause(2000).then(() => false)])) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
        await exited;
      }
      server = undefined;
    }
  }
}
before(async () => {
  try {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;
    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (part) => { output = (output + part).slice(-8000); });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null) throw Error(output);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Startup only. */ }
      await pause(100);
    }
    assert.ok(ready, output);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

// This injected entry exists only inside Playwright's intercepted main request.
// Production never reads this test global or discovers a runtime from it.
function harness(config) {
  return `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import '/brand/fonts/fonts.css';
import '/brand/tokens.css';
import '/src/shell/foundation.css';
import '/src/shell/nexus.css';
import '/src/app/recovery.css';
import { App } from '/src/app/App.tsx';
import { createNativeProofRuntime } from '/src/app/runtime.tsx';
import { createDemoState } from '/src/domain/demo.ts';
const config = ${JSON.stringify(config)};
let fixtureId = 0;
const createId = () => '00000000-0000-4000-8000-' + String(++fixtureId).padStart(12, '0');
const state = createDemoState({ id: createId }); state.selection.route = 'sessions';
const calls = { loads: 0, saves: [], reconciles: 0 };
let stored = structuredClone(state); let firstAttempt; let releaseSave; let releaseLoad;
let active = true; const invalidations = new Set();
const lifecycle = {
  isActive: () => active,
  subscribeInvalidation: (fn) => { invalidations.add(fn); return () => invalidations.delete(fn); },
  revoke: () => { if (!active) return; active = false; for (const fn of invalidations) fn(); },
};
const repository = {
  loadLatest: async () => {
    calls.loads++;
    if (config.load === 'pending') await new Promise((done) => { releaseLoad = done; });
    if (config.load === 'empty') return { kind: 'empty' };
    if (config.load === 'invalid') return { kind: 'invalid', error: 'Invented corrupt native record.', raw: 'Never export this invented retained payload' };
    if (config.load === 'unavailable') return { kind: 'unavailable', error: 'Invented missing native store.' };
    return { kind: 'ready', state: structuredClone(stored) };
  },
  subscribe: () => () => {},
  save: async (snapshot, revision) => {
    calls.saves.push({ snapshot: structuredClone(snapshot), revision });
    if (config.save === 'defer-first' && calls.saves.length === 1) {
      firstAttempt = structuredClone(snapshot);
      return await new Promise((done) => { releaseSave = done; });
    }
    if (config.save === 'failed') return { kind: 'failed', error: 'Invented native refusal.', attemptedState: structuredClone(snapshot) };
    stored = structuredClone(snapshot);
    return { kind: 'saved', state: structuredClone(stored) };
  },
  reconcilePending: async () => {
    calls.reconciles++;
    stored = structuredClone(firstAttempt);
    return { kind: 'saved', state: structuredClone(stored) };
  },
};
const runtime = createNativeProofRuntime(repository, lifecycle, { createId });
window.__nativeTest = {
  calls,
  revoke: () => lifecycle.revoke(),
  releaseLoad: () => releaseLoad(),
  unknown: () => releaseSave({ kind: 'unknown', error: 'Original native save unconfirmed.', attemptedState: structuredClone(firstAttempt), requestId: 'invented-original-id' }),
  saved: () => releaseSave({ kind: 'saved', state: structuredClone(firstAttempt) }),
};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App, { runtime }));
`;
}

async function fixture(config = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; const outside = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((noRandomUUID) => {
    if (noRandomUUID) Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
    window.__forbidden = [];
    for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) {
      Object.defineProperty(window, key, { configurable: true, get() { window.__forbidden.push(key); throw Error(`Forbidden browser authority: ${key}`); } });
    }
    URL.createObjectURL = () => { window.__forbidden.push('object-url'); throw Error('Forbidden plaintext export'); };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.hasAttribute('download')) { window.__forbidden.push('download'); throw Error('Forbidden plaintext download'); }
      return click.call(this);
    };
  }, config.noRandomUUID ?? false);
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
    if (url.pathname === '/src/main.tsx') return route.fulfill({ contentType: 'application/javascript', body: harness(config) });
    return route.continue();
  });
  await page.goto(origin);
  await expect.poll(() => errors.length ? errors.join('\n') : page.evaluate(() => Boolean(window.__nativeTest)), { timeout: 20_000 }).toBe(true);
  return {
    page,
    async check() { assert.deepEqual(await page.evaluate(() => window.__forbidden), []); assert.deepEqual(errors, []); assert.deepEqual(outside, []); },
    close: () => context.close(),
  };
}

test('same App runs native proof with zero browser persistence across hidden Work, identity, layout and all modules', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toBeVisible();
    await expect(page.getByText('Native join proof · invented data only', { exact: true })).toBeVisible();
    await page.getByLabel('Your message', { exact: true }).fill('Invented native draft');
    await expect.poll(() => page.evaluate(() => window.__nativeTest.calls.saves.length)).toBe(1);
    await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Recorded workspace relationships' })).toBeVisible();
    await page.locator('.canvas-node').first().click({ button: 'right' });
    await page.getByRole('menuitemradio', { name: 'Square', exact: true }).click();
    await expect(page.getByText('Canvas layout kept for this visit', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cloudwork Atlas', exact: true }).click();
    await page.getByRole('button', { name: 'Roadmap', exact: true }).click();
    await expect(page.getByText('Roadmap placement lasts for this visit.', { exact: true })).toBeVisible();
    const move = page.locator('.roadmap-move select').first();
    await move.selectOption({ label: 'In progress' });
    await expect(page.getByText(/Placement kept for this visit\./)).toHaveCount(1);
    await page.getByRole('button', { name: 'User options', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Identity, photos and rail layout preferences last for this visit only.')).toBeVisible();
    await dialog.getByLabel('Display name', { exact: true }).fill('Invented visiting owner');
    await dialog.getByRole('button', { name: 'Save identity', exact: true }).click();
    await expect(dialog.getByText('Identity kept for this visit.', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close options', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance options', exact: true }).click();
    await page.getByRole('radio', { name: 'Icons only', exact: false }).check();
    await page.getByRole('dialog').getByRole('button', { name: 'Close options', exact: true }).click();
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await page.getByRole('button', { name: 'DATA', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Read old sessions', exact: true })).toBeDisabled();
    assert.equal(await page.evaluate(() => window.__nativeTest.calls.loads), 1);
    await f.check();
  } finally { await f.close(); }
});

test('native proof creates a chosen memory with its injected ID factory when randomUUID is unavailable', async () => {
  const f = await fixture({ noRandomUUID: true }); const { page } = f;
  try {
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await expect(page.getByText('Invented native workspace · private use unavailable. No AI memory or learning is connected.', { exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), 'undefined');
    const body = 'Invented proof preference: use short paragraphs.';
    await page.getByLabel('Detail to remember', { exact: true }).fill(body);
    await page.getByRole('button', { name: 'Save memory', exact: true }).click();
    const card = page.getByRole('article', { name: `Memory: ${body}`, exact: true });
    await expect(card).toBeVisible();
    await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toBeVisible();
    const memoryId = await card.getAttribute('data-memory-id');
    assert.match(memoryId, /^00000000-0000-4000-8000-\d{12}$/);
    const saved = await page.evaluate(() => window.__nativeTest.calls.saves.at(-1).snapshot.memories);
    assert.ok(saved.some((entry) => entry.id === memoryId && entry.body === body));
    await f.check();
  } finally { await f.close(); }
});

test('missing, corrupt and even an invalid empty native result never seed a browser workspace or expose downloads', async () => {
  for (const load of ['empty', 'invalid', 'unavailable']) {
    const f = await fixture({ load });
    try {
      await expect(f.page.getByRole('heading', { name: 'Workspace needs recovery' })).toBeVisible();
      await expect(f.page.getByRole('button', { name: /Download/ })).toHaveCount(0);
      assert.equal(await f.page.evaluate(() => window.__nativeTest.calls.saves.length), 0);
      await f.check();
    } finally { await f.close(); }
  }
});

test('an unknown commit reconciles the original attempt before saving later retained edits', async () => {
  const f = await fixture({ save: 'defer-first' }); const { page } = f;
  try {
    const draft = page.getByLabel('Your message', { exact: true });
    await expect(draft).toBeVisible();
    await draft.fill('First captured invented draft');
    await expect.poll(() => page.evaluate(() => window.__nativeTest.calls.saves.length)).toBe(1);
    await draft.fill('Later invented edit while the original result is pending');
    await page.evaluate(() => window.__nativeTest.unknown());
    await expect(draft).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reload saved copy', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Download/ })).toHaveCount(0);
    await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.__nativeTest.calls.saves.length), 1);
    await page.getByRole('button', { name: 'Reconcile original save', exact: true }).click();
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue('Later invented edit while the original result is pending');
    await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toBeVisible();
    const calls = await page.evaluate(() => window.__nativeTest.calls);
    assert.equal(calls.reconciles, 1);
    assert.equal(calls.saves.length, 2);
    const id = calls.saves[0].snapshot.selection.sessionId;
    assert.equal(calls.saves[0].snapshot.drafts[id], 'First captured invented draft');
    assert.equal(calls.saves[1].snapshot.drafts[id], 'Later invented edit while the original result is pending');
    assert.equal(calls.saves[1].revision, calls.saves[0].snapshot.revision);
    await f.check();
  } finally { await f.close(); }
});

test('revocation clears visible content and open dialogs; late read/save results cannot resurrect them', async () => {
  for (const pending of ['load', 'save']) {
    const f = await fixture(pending === 'load' ? { load: 'pending' } : { save: 'defer-first' });
    const { page } = f;
    try {
      if (pending === 'save') {
        await page.getByLabel('Your message', { exact: true }).fill('Invented text cleared at revocation');
        await expect.poll(() => page.evaluate(() => window.__nativeTest.calls.saves.length)).toBe(1);
        await page.getByRole('button', { name: 'User options', exact: true }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
      } else await expect.poll(() => page.evaluate(() => window.__nativeTest?.calls.loads ?? 0)).toBe(1);
      await page.evaluate(() => window.__nativeTest.revoke());
      await expect(page.getByRole('heading', { name: 'Workspace connection closed' })).toBeVisible();
      await page.evaluate((pending) => pending === 'load' ? window.__nativeTest.releaseLoad() : window.__nativeTest.saved(), pending);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.locator('#message-draft')).toHaveCount(0);
      await expect(page.getByText('Invented workspace saved by the native host', { exact: true })).toHaveCount(0);
      await f.check();
    } finally { await f.close(); }
  }
});
