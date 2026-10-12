import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceKey = 'true-convo:desk:synthetic:v1';
const tabKey = 'true-convo:desk:synthetic:tab-view:v1';
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
let server;
let browser;
let origin;
let output = '';

async function cleanup() {
  try { await browser?.close(); } finally {
    browser = undefined;
    if (server) {
      const running = server.exitCode === null && server.signalCode === null;
      const exited = running ? once(server, 'exit') : Promise.resolve();
      try { process.kill(-server.pid, 'SIGTERM'); } catch { if (running) server.kill('SIGTERM'); }
      if (!await Promise.race([exited.then(() => true), pause(2_000).then(() => false)])) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
        await exited;
      }
      server = undefined;
    }
  }
}

before(async () => {
  assert.ok(existsSync(join(root, 'dist/index.html')), 'Run npm run build before browser checks.');
  try {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;
    server = spawn('npm', ['run', 'start', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (part) => { output = (output + part).slice(-8_000); });
    let available = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Preview exited: ${output}`);
      try { if ((await fetch(origin)).ok) { available = true; break; } } catch { /* startup */ }
      await pause(100);
    }
    assert.ok(available, `Preview did not become ready: ${output}`);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

async function isolatedPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const outside = [];
  const privateApi = [];
  const errors = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) privateApi.push(url.pathname);
    return route.continue();
  });
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  });
  const page = await context.newPage();
  return { context, page, verify: () => {
    assert.deepEqual(outside, [], 'Nexus hierarchy requested another origin.');
    assert.deepEqual(privateApi, [], 'Nexus hierarchy requested a private API.');
    assert.deepEqual(errors, [], 'Nexus hierarchy reported browser errors.');
  } };
}

const views = ['Nexus Navigator', 'Cloudwork Canvas', 'Cloudwork Atlas', 'Roadmap'];
const choices = (page) => page.getByRole('navigation', { name: 'Nexus views', exact: true });
async function enter(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}

test('Nexus keeps all four subviews together and preserves session and Roadmap drafts across reload', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const modules = page.getByRole('navigation', { name: 'Modules', exact: true });
    await expect(modules.getByRole('button', { name: 'Cloudwork Nexus', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(modules.getByRole('button', { name: 'Roadmap', exact: true })).toHaveCount(0);
    assert.deepEqual(await choices(page).getByRole('button').allTextContents(), views);
    await expect(page.locator('.desk-header .primary-module-heading')).toHaveCount(0);
    const sessionDraft = 'Invented session draft retained through Nexus subviews.';
    const cardDraft = 'Invented suggested card draft retained through Nexus subviews.';
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(sessionDraft);
    await expect.poll(async () => Object.values(JSON.parse(await readNativeRecordRaw(page)).drafts)).toContain(sessionDraft);
    await choices(page).getByRole('button', { name: 'Roadmap', exact: true }).click();
    const title = page.getByRole('textbox', { name: 'Card title', exact: true });
    await expect(title).toBeFocused();
    await title.fill(cardDraft);
    await expect.poll(async () => Object.values(JSON.parse(await readNativeRecordRaw(page)).goalDrafts).map((draft) => draft.workTitle)).toContain(cardDraft);
    const durable = await readNativeRecordRaw(page);
    for (const name of views) {
      await choices(page).getByRole('button', { name, exact: true }).click();
      await expect(choices(page).getByRole('button', { name, exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      assert.equal(await readNativeRecordRaw(page), durable, 'Subview selection must not replace saved content.');
    }
    await page.reload();
    await expect(choices(page).getByRole('button', { name: 'Roadmap', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(title).toHaveValue(cardDraft);
    await choices(page).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(sessionDraft);
    assert.equal(await readNativeRecordRaw(page), durable);
    verify();
  } finally { await context.close(); }
});

test('a saved legacy Work route opens the Nexus Roadmap without rewriting its workspace or view cache', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const durable = await readNativeRecordRaw(page);
    const workspace = JSON.parse(durable);
    const legacyView = JSON.stringify({ schemaVersion: 1,
      selection: { ...workspace.selection, route: 'work' },
      preferences: { theme: 'system', nexusView: 'canvas' } });
    await page.evaluate(({ key, value }) => sessionStorage.setItem(key, value), { key: tabKey, value: legacyView });
    await page.reload();
    await expect(choices(page).getByRole('button', { name: 'Roadmap', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Card title', exact: true })).toBeEnabled();
    await expect(page.getByRole('navigation', { name: 'Modules', exact: true }).getByRole('button', { name: 'Cloudwork Nexus', exact: true })).toHaveAttribute('aria-current', 'page');
    assert.equal(await readNativeRecordRaw(page), durable);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), tabKey), legacyView);
    await page.getByRole('navigation', { name: 'Modules', exact: true }).getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
    await expect(choices(page).getByRole('button', { name: 'Roadmap', exact: true })).toHaveAttribute('aria-current', 'page');
    const promoted = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), tabKey);
    assert.equal(promoted.selection.route, 'sessions');
    assert.equal(promoted.preferences.nexusView, 'roadmap');
    assert.equal(await readNativeRecordRaw(page), durable);
    await choices(page).getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    const current = await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), tabKey);
    assert.equal(current.selection.route, 'sessions');
    assert.equal(current.preferences.nexusView, 'canvas');
    assert.equal(await readNativeRecordRaw(page), durable);
    verify();
  } finally { await context.close(); }
});
