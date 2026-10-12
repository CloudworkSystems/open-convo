import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readNativeRecordRaw, readRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const identityKey = 'true-convo:desk:identity:v1';
const identityDatabase = 'true-convo:desk:identity:records:v1';
const recordStore = 'records';
const recordKey = 'current';
const legacyIdentity = JSON.stringify({ version: 1, brandName: 'Invented legacy brand', displayName: 'Invented legacy owner', brandImage: null }, null, 2);
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

async function isolatedPage() {
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
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  });
  const page = await context.newPage();
  return { context, page, verify: () => {
    assert.deepEqual(outside, [], 'Identity requested another origin.');
    assert.deepEqual(privateApi, [], 'Identity requested a private API.');
    assert.deepEqual(errors, [], 'Identity reported browser errors.');
  } };
}

const dialog = (page) => page.getByRole('dialog', { name: 'User options', exact: true });
const nameInput = (page) => dialog(page).getByRole('textbox', { name: 'Display name', exact: true });
const guidanceInput = (page) => dialog(page).getByRole('textbox', { name: 'Future session naming guidance', exact: true });
const saveButton = (page) => dialog(page).getByRole('button', { name: 'Save identity', exact: true });
const savedMessage = (page) => dialog(page).getByRole('status').filter({ hasText: 'Browser identity saved.' });
const hold = (page) => dialog(page).locator('[data-preview-refresh-hold="browser-identity"]');
const legacyBytes = (page) => page.evaluate((key) => localStorage.getItem(key), identityKey);
const identityBytes = (page) => readNativeRecordRaw(page, identityDatabase);

async function enter(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}

async function openOptions(page, { readOnly = false } = {}) {
  await page.getByRole('button', { name: 'User options', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  if (readOnly) await expect(nameInput(page)).toBeDisabled();
  else await expect(nameInput(page)).toBeEnabled();
}

test('simultaneous native identity saves commit once and keep the conflicting draft visible', async () => {
  const { context, page: first, verify } = await isolatedPage();
  try {
    await enter(first);
    await openOptions(first);
    await nameInput(first).fill('Invented shared saved owner');
    await guidanceInput(first).fill('Invented shared saved guidance.');
    await saveButton(first).click();
    await expect(savedMessage(first)).toBeVisible();
    const baseline = await identityBytes(first);
    const workspace = await readRecordRaw(first);
    await dialog(first).getByRole('button', { name: 'Close options', exact: true }).click();
    const second = await context.newPage();
    await enter(second);
    await Promise.all([openOptions(first), openOptions(second)]);
    const pages = [first, second];
    const attempts = [
      { displayName: 'Invented first pending owner', sessionNamingGuidance: 'Invented first pending guidance.' },
      { displayName: 'Invented second pending owner', sessionNamingGuidance: 'Invented second pending guidance.' },
    ];
    for (const [index, page] of pages.entries()) {
      await expect(nameInput(page)).toHaveValue('Invented shared saved owner');
      await expect(guidanceInput(page)).toHaveValue('Invented shared saved guidance.');
      assert.equal(await identityBytes(page), baseline);
      await nameInput(page).fill(attempts[index].displayName);
      await guidanceInput(page).fill(attempts[index].sessionNamingGuidance);
      await expect(saveButton(page)).toBeEnabled();
    }
    // Hold an actual native transaction until both submitted writes have queued.
    await first.evaluate(({ databaseName, storeName, key }) => new Promise((resolve, reject) => {
      const opening = indexedDB.open(databaseName, 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction(storeName, 'readwrite');
        const store = transaction.objectStore(storeName);
        window.__identityReleaseGate = false;
        window.__identityGateCompletion = new Promise((done, failed) => {
          transaction.oncomplete = () => { database.close(); done(); };
          transaction.onabort = () => { database.close(); failed(transaction.error); };
        });
        const keepActive = () => {
          const request = store.get(key);
          request.onsuccess = () => { if (!window.__identityReleaseGate) keepActive(); };
        };
        keepActive();
        resolve();
      };
    }), { databaseName: identityDatabase, storeName: recordStore, key: recordKey });
    for (const page of pages) await page.evaluate((databaseName) => {
      window.__identitySaveTransactions = 0;
      window.__identityFormSubmissions = 0;
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (this.name === databaseName && args[1] === 'readwrite') window.__identitySaveTransactions += 1;
        return transaction.apply(this, args);
      };
      document.querySelector('.identity-settings').addEventListener('submit', () => { window.__identityFormSubmissions += 1; }, true);
    }, identityDatabase);
    await Promise.all(pages.map((page) => page.evaluate(() => document.querySelector('.identity-settings').requestSubmit())));
    await expect.poll(async () => Promise.all(pages.map((page) => page.evaluate(() => window.__identitySaveTransactions)))).toEqual([1, 1]);
    assert.deepEqual(await Promise.all(pages.map((page) => page.evaluate(() => window.__identityFormSubmissions))), [1, 1]);
    await first.evaluate(async () => { window.__identityReleaseGate = true; await window.__identityGateCompletion; });
    await expect.poll(async () => (await Promise.all(pages.map((page) => savedMessage(page).isVisible()))).filter(Boolean).length).toBe(1);
    const winner = await savedMessage(first).isVisible() ? 0 : 1;
    const loser = 1 - winner;
    await expect(dialog(pages[loser]).getByRole('status').filter({ hasText: /changed|another window/i }).first()).toBeVisible();
    await expect(savedMessage(pages[loser])).toHaveCount(0);
    await expect(nameInput(pages[loser])).toHaveValue(attempts[loser].displayName);
    await expect(guidanceInput(pages[loser])).toHaveValue(attempts[loser].sessionNamingGuidance);
    await expect(hold(pages[loser])).toHaveCount(1);
    await expect(hold(pages[winner])).toHaveCount(0);
    const committed = await identityBytes(first);
    assert.notEqual(committed, baseline);
    assert.equal(await identityBytes(second), committed);
    const restored = JSON.parse(committed);
    assert.equal(restored.displayName, attempts[winner].displayName);
    assert.equal(restored.sessionNamingGuidance, attempts[winner].sessionNamingGuidance);
    assert.equal(await legacyBytes(first), null);
    assert.equal(await readRecordRaw(first), workspace);
    assert.equal(await readRecordRaw(second), workspace);
    await pages[loser].keyboard.press('Escape');
    await expect(dialog(pages[loser]).getByRole('alert')).toContainText('Your identity changes are not saved.');
    assert.equal(await identityBytes(first), committed);
    verify();
  } finally { await context.close(); }
});

test('loading and explicitly saving legacy identity preserve its exact localStorage bytes', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await context.addInitScript(({ key, raw, expectedOrigin }) => {
      if (location.origin === expectedOrigin && localStorage.getItem(key) === null) localStorage.setItem(key, raw);
    }, { key: identityKey, raw: legacyIdentity, expectedOrigin: origin });
    await enter(page);
    const workspace = await readRecordRaw(page);
    await openOptions(page);
    await expect(nameInput(page)).toHaveValue('Invented legacy owner');
    await expect(guidanceInput(page)).toHaveValue('');
    assert.equal(await legacyBytes(page), legacyIdentity);
    assert.equal(await identityBytes(page), null, 'Reading legacy identity must not create a committed replacement.');
    await guidanceInput(page).fill('  Invented guidance saved only after an explicit request.  ');
    await saveButton(page).click();
    await expect(savedMessage(page)).toBeVisible();
    const committed = await identityBytes(page);
    assert.deepEqual(JSON.parse(committed), {
      version: 1, brandName: 'Invented legacy brand', displayName: 'Invented legacy owner', brandImage: null,
      sessionNamingGuidance: 'Invented guidance saved only after an explicit request.',
    });
    assert.equal(await legacyBytes(page), legacyIdentity);
    assert.equal(await readRecordRaw(page), workspace);
    await dialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
    await page.reload();
    await openOptions(page);
    await expect(guidanceInput(page)).toHaveValue('Invented guidance saved only after an explicit request.');
    assert.equal(await identityBytes(page), committed);
    assert.equal(await legacyBytes(page), legacyIdentity);
    assert.equal(await readRecordRaw(page), workspace);
    verify();
  } finally { await context.close(); }
});

test('unavailable identity IndexedDB keeps identity read-only and leaves legacy bytes intact', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await context.addInitScript(({ key, raw, expectedOrigin, databaseName }) => {
      if (location.origin !== expectedOrigin) return;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, raw);
      window.__identityLegacyWriteAttempts = 0;
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) window.__identityLegacyWriteAttempts += 1;
        return setItem.call(this, name, value);
      };
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, version) {
        if (name === databaseName) throw new DOMException('Invented unavailable identity database', 'SecurityError');
        return open.call(this, name, version);
      };
    }, { key: identityKey, raw: legacyIdentity, expectedOrigin: origin, databaseName: identityDatabase });
    await page.goto(origin);
    await expect(page.getByText('Sample preview · sample data only', { exact: true })).toBeVisible();
    await openOptions(page, { readOnly: true });
    await expect(dialog(page).getByRole('status').filter({ hasText: /could not be read|unavailable|blocked/i }).first()).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();
    await expect(guidanceInput(page)).toBeDisabled();
    assert.equal(await legacyBytes(page), legacyIdentity);
    assert.equal(await page.evaluate(() => window.__identityLegacyWriteAttempts), 0);
    await dialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
    await page.reload();
    await openOptions(page, { readOnly: true });
    await expect(dialog(page).getByRole('status').filter({ hasText: /could not be read|unavailable|blocked/i }).first()).toBeVisible();
    assert.equal(await legacyBytes(page), legacyIdentity);
    assert.equal(await page.evaluate(() => window.__identityLegacyWriteAttempts), 0);
    verify();
  } finally { await context.close(); }
});

test('a genuinely blocked native database open fails closed without replacing legacy identity', async () => {
  const { context, page: holder, verify } = await isolatedPage();
  try {
    await enter(holder);
    await openOptions(holder);
    await dialog(holder).getByRole('button', { name: 'Close options', exact: true }).click();
    await holder.evaluate(({ databaseName, key, raw }) => new Promise((resolve, reject) => {
      localStorage.setItem(key, raw);
      const request = indexedDB.open(databaseName, 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        window.__identityUpgradeBlocker = request.result;
        // Keep this real version-one connection open when the other page upgrades.
        request.result.onversionchange = () => {};
        resolve();
      };
    }), { databaseName: identityDatabase, key: identityKey, raw: legacyIdentity });
    const page = await context.newPage();
    await page.addInitScript(({ databaseName, key }) => {
      window.__identityBlockedOpens = 0;
      window.__identityNativeWriteAttempts = 0;
      window.__identityLegacyWriteAttempts = 0;
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (name, version) {
        const request = name === databaseName ? open.call(this, name, 2) : open.call(this, name, version);
        if (name === databaseName) request.addEventListener('blocked', () => { window.__identityBlockedOpens += 1; });
        return request;
      };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === databaseName) window.__identityNativeWriteAttempts += 1;
        return put.apply(this, args);
      };
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (name === key) window.__identityLegacyWriteAttempts += 1;
        return setItem.call(this, name, value);
      };
    }, { databaseName: identityDatabase, key: identityKey });
    await page.goto(origin);
    await expect(page.getByText('Sample preview · sample data only', { exact: true })).toBeVisible();
    await openOptions(page, { readOnly: true });
    await expect.poll(() => page.evaluate(() => window.__identityBlockedOpens)).toBe(1);
    await expect(dialog(page).getByRole('status').filter({ hasText: /could not be read|unavailable|blocked/i }).first()).toBeVisible();
    await expect(saveButton(page)).toBeDisabled();
    await expect(guidanceInput(page)).toBeDisabled();
    assert.equal(await legacyBytes(page), legacyIdentity);
    assert.deepEqual(await page.evaluate(() => [window.__identityNativeWriteAttempts, window.__identityLegacyWriteAttempts]), [0, 0]);
    verify();
  } finally { await context.close(); }
});

for (const failure of ['abort after successful put', 'quota error']) {
  test(`identity ${failure} retains attempted text and the previous committed bytes`, async () => {
    const { context, page, verify } = await isolatedPage();
    try {
      await enter(page);
      await openOptions(page);
      await nameInput(page).fill('Invented previously committed owner');
      await guidanceInput(page).fill('Invented previously committed guidance.');
      await saveButton(page).click();
      await expect(savedMessage(page)).toBeVisible();
      const previous = await identityBytes(page);
      const workspace = await readRecordRaw(page);
      const legacy = await legacyBytes(page);
      await dialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
      const observer = await context.newPage();
      await enter(observer);
      await openOptions(observer);
      await expect(nameInput(observer)).toHaveValue('Invented previously committed owner');
      await page.evaluate(({ databaseName, storeName, failure }) => {
        window.__identityFailedWrite = { put: 0, success: 0, abort: 0, complete: 0, notifications: 0 };
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.transaction.db.name !== databaseName || this.name !== storeName) return put.apply(this, args);
          window.__identityFailedWrite.put += 1;
          const transaction = this.transaction;
          transaction.addEventListener('abort', () => { window.__identityFailedWrite.abort += 1; }, { once: true });
          transaction.addEventListener('complete', () => { window.__identityFailedWrite.complete += 1; }, { once: true });
          if (failure === 'quota error') throw new DOMException('Invented identity-only quota error', 'QuotaExceededError');
          const request = put.apply(this, args);
          request.addEventListener('success', () => {
            window.__identityFailedWrite.success += 1;
            transaction.abort();
          }, { once: true });
          return request;
        };
        const postMessage = BroadcastChannel.prototype.postMessage;
        BroadcastChannel.prototype.postMessage = function (...args) {
          if (this.name === `${databaseName}:commits`) window.__identityFailedWrite.notifications += 1;
          return postMessage.apply(this, args);
        };
      }, { databaseName: identityDatabase, storeName: recordStore, failure });
      await openOptions(page);
      await nameInput(page).fill('Invented attempted owner kept for recovery');
      await guidanceInput(page).fill('Invented attempted guidance kept for recovery.');
      await saveButton(page).click();
      await expect(dialog(page).getByRole('status').filter({ hasText: 'Display settings could not be saved.' })).toBeVisible();
      await expect(savedMessage(page)).toHaveCount(0);
      await expect(nameInput(page)).toBeEnabled();
      await expect(nameInput(page)).toHaveValue('Invented attempted owner kept for recovery');
      await expect(guidanceInput(page)).toHaveValue('Invented attempted guidance kept for recovery.');
      await expect(hold(page)).toHaveCount(1);
      assert.equal(await identityBytes(page), previous);
      assert.equal(await identityBytes(observer), previous);
      assert.equal(await legacyBytes(page), legacy);
      assert.equal(await readRecordRaw(page), workspace);
      assert.deepEqual(await page.evaluate(() => window.__identityFailedWrite), {
        put: 1, success: failure === 'quota error' ? 0 : 1, abort: 1, complete: 0, notifications: 0,
      });
      await expect(nameInput(observer)).toHaveValue('Invented previously committed owner');
      await expect(guidanceInput(observer)).toHaveValue('Invented previously committed guidance.');
      await page.keyboard.press('Escape');
      await expect(dialog(page).getByRole('alert')).toContainText('Your identity changes are not saved.');
      await dialog(page).getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(guidanceInput(page)).toHaveValue('Invented attempted guidance kept for recovery.');
      await dialog(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
      await page.reload();
      await openOptions(page);
      await expect(nameInput(page)).toHaveValue('Invented previously committed owner');
      await expect(guidanceInput(page)).toHaveValue('Invented previously committed guidance.');
      assert.equal(await identityBytes(page), previous);
      assert.equal(await legacyBytes(page), legacy);
      assert.equal(await readRecordRaw(page), workspace);
      verify();
    } finally { await context.close(); }
  });
}
