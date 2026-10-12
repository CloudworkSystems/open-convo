import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { installNativeWriteFailure, readNativeRecord, readNativeRecordRaw, WORKSPACE_DATABASE_NAME, writeNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let browser;
let server;
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
  assert.ok(existsSync(join(root, 'dist/index.html')), 'Build the checked source before browser tests.');
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
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Preview exited: ${output}`);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Startup only. */ }
      await pause(100);
    }
    assert.ok(ready, `Preview did not start: ${output}`);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

async function isolated() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const outside = [];
  const privateApi = [];
  const errors = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) privateApi.push(url.pathname);
    return route.continue();
  });
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const page = await context.newPage();
  return { context, page, verify: () => {
    assert.deepEqual(outside, []);
    assert.deepEqual(privateApi, []);
    assert.deepEqual(errors, []);
  } };
}

async function enter(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}
const panel = (page) => page.getByRole('complementary', { name: 'Session details', exact: true });
const composer = (page) => page.getByRole('textbox', { name: 'Your message', exact: true });
const recovery = (page) => page.getByRole('alert', { name: 'Save recovery', exact: true });
const legacyRaw = (page) => page.evaluate((key) => localStorage.getItem(key), WORKSPACE_DATABASE_NAME);

test('native concurrent composer and intent writes preserve one committed state and the other complete attempt', { timeout: 90_000 }, async () => {
  // No Web Lock, localStorage, IndexedDB or notification shims in this proof.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const { context, page, verify } = await isolated();
    try {
      await enter(page);
      const other = await context.newPage();
      await enter(other);
      await panel(other).getByRole('button', { name: 'Edit session intent', exact: true }).click();
      const before = await readNativeRecord(page);
      const sessionId = before.selection.sessionId;
      const messageText = `Concurrent invented message ${attempt}`;
      const intentText = `Concurrent invented intent ${attempt}`;
      const deadline = Date.now() + 150;
      const schedule = (tab, selector, text) => tab.evaluate(async ({ selector, text, deadline }) => {
        await new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now())));
        const input = document.querySelector(selector);
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, { selector, text, deadline });
      await Promise.all([schedule(page, '#message-draft', messageText), schedule(other, '#session-intent', intentText)]);
      await expect.poll(async () => (await readNativeRecord(page)).revision).toBe(before.revision + 1);
      await expect.poll(async () => (await recovery(page).count()) + (await recovery(other).count())).toBeGreaterThan(0);
      const saved = await readNativeRecord(page);
      const savedMessage = saved.drafts[sessionId] === messageText;
      const savedIntent = saved.sessions.find((session) => session.id === sessionId).intentDraft === intentText;
      assert.equal(Number(savedMessage) + Number(savedIntent), 1);
      assert.equal(await composer(page).inputValue(), messageText);
      assert.equal(await panel(other).getByRole('textbox', { name: 'Session intent', exact: true }).inputValue(), intentText);
      const losing = savedMessage ? other : page;
      await expect(recovery(losing)).toBeVisible();
      await expect(losing.getByRole('button', { name: 'Download sample work', exact: true })).toBeVisible();
      assert.equal(await legacyRaw(page), null, 'Native saves must not publish another localStorage authority.');
      verify();
    } finally { await context.close(); }
  }
});

test('rapid queued own-tab edits save both fields and never turn own commit notices into conflicts', async () => {
  const { context, page, verify } = await isolated();
  try {
    await enter(page);
    await panel(page).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    const before = await readNativeRecord(page);
    await page.evaluate(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      for (let index = 1; index <= 20; index += 1) {
        for (const [selector, text] of [['#message-draft', `Queued message ${index}`], ['#session-intent', `Queued intent ${index}`]]) {
          const input = document.querySelector(selector);
          setter.call(input, text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });
    await expect.poll(async () => (await readNativeRecord(page)).revision).toBe(before.revision + 40);
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    const saved = await readNativeRecord(page);
    assert.equal(saved.drafts[before.selection.sessionId], 'Queued message 20');
    assert.equal(saved.sessions.find((session) => session.id === before.selection.sessionId).intentDraft, 'Queued intent 20');
    await expect(recovery(page)).toHaveCount(0);
    await page.reload();
    await expect(composer(page)).toHaveValue('Queued message 20');
    await expect(panel(page).getByRole('textbox', { name: 'Session intent', exact: true })).toHaveValue('Queued intent 20');
    verify();
  } finally { await context.close(); }
});

test('a notification read held across a later own save is discarded instead of producing a false conflict', async () => {
  const { context, page, verify } = await isolated();
  try {
    await context.addInitScript((databaseName) => {
      const transact = IDBDatabase.prototype.transaction;
      const completed = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
      IDBDatabase.prototype.transaction = function (...args) {
        const transaction = transact.apply(this, args);
        if (this.name === databaseName && transaction.mode === 'readonly' && window.__holdNextWorkspaceRead) {
          window.__holdNextWorkspaceRead = false;
          Object.defineProperty(transaction, 'oncomplete', {
            set(callback) { completed.set.call(transaction, (event) => {
              window.__workspaceReadHeld = true;
              window.__releaseWorkspaceRead = () => { window.__workspaceReadHeld = false; callback.call(transaction, event); };
            }); },
          });
        }
        return transaction;
      };
      const post = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (...args) {
        // Suppress one own notification to deterministically expose the stale
        // read; storage transactions remain native and commit normally.
        if (this.name === `${databaseName}:commits` && window.__holdOwnWorkspaceNotice) return;
        return post.apply(this, args);
      };
    }, WORKSPACE_DATABASE_NAME);
    await enter(page);
    const before = await readNativeRecord(page);
    await page.evaluate(() => {
      window.__holdOwnWorkspaceNotice = true;
      window.__holdNextWorkspaceRead = true;
      window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(() => page.evaluate(() => window.__workspaceReadHeld === true)).toBe(true);
    await composer(page).fill('Own saved edit after the stale read started');
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    assert.equal((await readNativeRecord(page)).revision, before.revision + 1);
    await page.evaluate(() => { window.__holdOwnWorkspaceNotice = false; window.__releaseWorkspaceRead(); });
    await pause(150);
    await expect(recovery(page)).toHaveCount(0);
    await composer(page).fill('Still editable after the old read completed');
    await expect.poll(async () => (await readNativeRecord(page)).drafts[before.selection.sessionId]).toBe('Still editable after the old read completed');
    await expect(recovery(page)).toHaveCount(0);
    verify();
  } finally { await context.close(); }
});

test('valid legacy work stays unmodified until an explicit content save; primary bytes then ignore incompatible legacy bytes', async () => {
  const fixture = await isolated();
  let oldRaw;
  try { await enter(fixture.page); oldRaw = await readNativeRecordRaw(fixture.page); } finally { await fixture.context.close(); }
  const { context, page, verify } = await isolated();
  try {
    await context.addInitScript(({ key, raw }) => { if (localStorage.getItem(key) === null) localStorage.setItem(key, raw); }, { key: WORKSPACE_DATABASE_NAME, raw: oldRaw });
    await enter(page);
    assert.equal(await readNativeRecordRaw(page), null, 'Loading legacy work must not migrate it.');
    assert.equal(await legacyRaw(page), oldRaw);
    await composer(page).fill('First deliberate transactional edit');
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    const primary = await readNativeRecordRaw(page);
    assert.notEqual(primary, null);
    assert.equal(await legacyRaw(page), oldRaw);
    await page.evaluate((key) => localStorage.setItem(key, '{preserved incompatible backup'), WORKSPACE_DATABASE_NAME);
    await page.reload();
    await expect(composer(page)).toHaveValue('First deliberate transactional edit');
    assert.equal(await readNativeRecordRaw(page), primary);
    assert.equal(await legacyRaw(page), '{preserved incompatible backup');
    verify();
  } finally { await context.close(); }
});

test('invalid primary records are retained and cannot be masked by a valid legacy backup on bootstrap', async () => {
  for (const raw of ['{malformed primary', JSON.stringify({ schemaVersion: 91 })]) {
    const { context, page, verify } = await isolated();
    try {
      await enter(page);
      const backup = await readNativeRecordRaw(page);
      await page.evaluate(({ key, backup }) => localStorage.setItem(key, backup), { key: WORKSPACE_DATABASE_NAME, backup });
      await writeNativeRecordRaw(page, WORKSPACE_DATABASE_NAME, raw, { notify: false });
      await page.reload();
      await expect(page.getByRole('heading', { name: 'Workspace needs recovery', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Cloudwork Nexus', exact: true })).toHaveCount(0);
      assert.equal(await readNativeRecordRaw(page), raw);
      assert.equal(await legacyRaw(page), backup);
      verify();
    } finally { await context.close(); }
  }
});

test('an unavailable native database fails closed and offers a clearly older retained copy without seeding or editing', async () => {
  const fixture = await isolated();
  let backup;
  try { await enter(fixture.page); backup = await readNativeRecordRaw(fixture.page); } finally { await fixture.context.close(); }
  const { context, page, verify } = await isolated();
  try {
    await context.addInitScript(({ key, backup }) => {
      localStorage.setItem(key, backup);
      Object.defineProperty(window, 'indexedDB', { value: undefined });
    }, { key: WORKSPACE_DATABASE_NAME, backup });
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Workspace needs recovery', exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('may be older');
    await expect(page.getByRole('button', { name: 'Download retained browser copy', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cloudwork Nexus', exact: true })).toHaveCount(0);
    assert.equal(await legacyRaw(page), backup);
    verify();
  } finally { await context.close(); }
});

test('an aborted native save keeps the committed record and latest attempted work for explicit Retry', async () => {
  const { context, page, verify } = await isolated();
  try {
    await installNativeWriteFailure(context);
    await enter(page);
    const before = await readNativeRecordRaw(page);
    const sessionId = JSON.parse(before).selection.sessionId;
    await page.evaluate(() => { window.__deskFailWrites = true; });
    await composer(page).fill('The transaction-aborted composer attempt');
    await expect(recovery(page)).toBeVisible();
    assert.equal(await readNativeRecordRaw(page), before);
    await panel(page).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    await panel(page).getByRole('textbox', { name: 'Session intent', exact: true }).fill('Latest independent intent attempt');
    assert.equal(await readNativeRecordRaw(page), before);
    await page.evaluate(() => { window.__deskFailWrites = false; });
    await page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(recovery(page)).toHaveCount(0);
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    const saved = await readNativeRecord(page);
    assert.equal(saved.drafts[sessionId], 'The transaction-aborted composer attempt');
    assert.equal(saved.sessions.find((session) => session.id === sessionId).intentDraft, 'Latest independent intent attempt');
    assert.equal(await legacyRaw(page), null);
    verify();
  } finally { await context.close(); }
});
