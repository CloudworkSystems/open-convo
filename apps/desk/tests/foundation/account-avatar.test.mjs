import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceKey = 'true-convo:desk:synthetic:v1';
const identityKey = 'true-convo:desk:identity:v1';
const identityDatabase = 'true-convo:desk:identity:records:v1';
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
    assert.deepEqual(outside, [], 'Navigation requested another origin.');
    assert.deepEqual(privateApi, [], 'Navigation requested a private API.');
    assert.deepEqual(errors, [], 'Navigation reported browser errors.');
  } };
}

const userDialog = (page) => page.getByRole('dialog', { name: 'User options', exact: true });
const identityBytes = (page) => readRecordRaw(page, identityDatabase, identityKey);
const workspaceBytes = (page) => readRecordRaw(page, workspaceKey, workspaceKey);
async function enter(page, mobile = false) {
  await page.goto(origin);
  if (mobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
  if (mobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'User options', exact: true }).click();
  await expect(userDialog(page).getByRole('textbox', { name: 'Display name', exact: true })).toBeEnabled();
}
async function photo(page, color = null) {
  const data = await page.evaluate((color) => {
    const canvas = document.createElement('canvas'); canvas.width = 600; canvas.height = 300;
    const context = canvas.getContext('2d');
    context.fillStyle = color || '#ff0000'; context.fillRect(0, 0, 300, 300);
    context.fillStyle = color || '#0000ff'; context.fillRect(300, 0, 300, 300);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color);
  return { name: 'invented-local-photo.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') };
}

test('Save identity commits the visible photo crop directly and every clean close control responds', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initialWorkspace = await workspaceBytes(page);
    await userDialog(page).getByRole('textbox', { name: 'Display name', exact: true }).fill('Direct crop owner');
    await userDialog(page).getByLabel('Profile photo', { exact: true }).setInputFiles(await photo(page));
    await expect(userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true })).toBeVisible();
    await userDialog(page).getByRole('slider', { name: 'Zoom', exact: true }).fill('2');
    await expect(userDialog(page).getByRole('button', { name: 'Save identity', exact: true })).toBeEnabled();
    await userDialog(page).getByRole('button', { name: 'Save identity', exact: true }).click();
    await expect(userDialog(page).locator('.identity-save-message')).toHaveText('Browser identity saved.');
    await expect(userDialog(page).getByText('Browser identity changed in another window.', { exact: false })).toHaveCount(0);
    const saved = JSON.parse(await identityBytes(page));
    assert.equal(saved.displayName, 'Direct crop owner');
    assert.ok(saved.avatarImage.startsWith('data:image/png;base64,'));
    const pixels = await page.evaluate(async (source) => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0);
      return { size: [image.width, image.height], left: Array.from(ctx.getImageData(64, 128, 1, 1).data), right: Array.from(ctx.getImageData(192, 128, 1, 1).data) };
    }, saved.avatarImage);
    assert.deepEqual(pixels, { size: [256, 256], left: [255, 0, 0, 255], right: [0, 0, 255, 255] });
    assert.equal(await workspaceBytes(page), initialWorkspace);
    await userDialog(page).getByRole('button', { name: 'Close user options', exact: true }).click();
    await expect(userDialog(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'User options', exact: true }).click();
    await expect(userDialog(page).getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('Direct crop owner');
    await userDialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
    await expect(userDialog(page)).toHaveCount(0);
    await page.reload();
    assert.deepEqual(JSON.parse(await identityBytes(page)), saved);
    verify();
  } finally { await context.close(); }
});

test('closing a dirty profile brings the safe discard decision into focus at a short viewport', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 600 } });
  try {
    await enter(page);
    const initialIdentity = await identityBytes(page);
    await userDialog(page).getByRole('textbox', { name: 'Display name', exact: true }).fill('Keep this draft');
    await userDialog(page).getByLabel('Profile photo', { exact: true }).setInputFiles(await photo(page));
    await expect(userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true })).toBeVisible();
    for (const control of ['Close user options', 'Close options', 'Escape']) {
      if (control === 'Escape') await page.keyboard.press('Escape');
      else await userDialog(page).getByRole('button', { name: control, exact: true }).click();
      const keep = userDialog(page).getByRole('button', { name: 'Keep editing', exact: true });
      await expect(keep).toBeFocused();
      await expect(keep).toBeInViewport();
      await expect(userDialog(page).getByRole('alert')).toContainText('Your identity changes are not saved');
      await userDialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
      await expect(keep).toBeFocused();
      await expect(keep).toBeInViewport();
      assert.equal(await identityBytes(page), initialIdentity);
      await keep.click();
      await expect(userDialog(page).getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('Keep this draft');
      await expect(userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true })).toBeVisible();
    }
    await userDialog(page).getByRole('button', { name: 'Close user options', exact: true }).click();
    await userDialog(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(userDialog(page)).toHaveCount(0);
    assert.equal(await identityBytes(page), initialIdentity);
    verify();
  } finally { await context.close(); }
});

test('Appearance and Help shortcuts keep profile edits and a crop until an explicit save or discard', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initialWorkspace = await workspaceBytes(page);
    const initialIdentity = await identityBytes(page);
    await userDialog(page).getByRole('textbox', { name: 'Display name', exact: true }).fill('Unfinished local profile');
    await userDialog(page).getByLabel('Profile photo', { exact: true }).setInputFiles(await photo(page));
    await expect(userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true })).toBeVisible();
    await userDialog(page).getByRole('slider', { name: 'Zoom', exact: true }).fill('2');
    await userDialog(page).getByRole('button', { name: 'Appearance options', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Appearance options', exact: true });
    await expect(appearance).toBeVisible();
    await expect(appearance.getByRole('status')).toContainText('Your profile edits are kept');
    await appearance.getByRole('button', { name: 'Close options', exact: true }).click();
    await expect(appearance.getByRole('alert')).toContainText('Your identity changes are not saved');
    await appearance.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await appearance.getByRole('button', { name: 'Help', exact: true }).click();
    const help = page.getByRole('dialog', { name: 'Help and application options', exact: true });
    await help.getByRole('button', { name: 'User options', exact: true }).click();
    await expect(userDialog(page).getByRole('textbox', { name: 'Display name', exact: true })).toHaveValue('Unfinished local profile');
    await expect(userDialog(page).getByRole('slider', { name: 'Zoom', exact: true })).toHaveValue('2');
    await expect(userDialog(page).getByRole('button', { name: 'Save identity', exact: true })).toBeEnabled();
    await userDialog(page).getByRole('button', { name: 'Cancel crop', exact: true }).click();
    await userDialog(page).getByRole('button', { name: 'Discard changes', exact: true }).click();
    assert.equal(await identityBytes(page), initialIdentity);
    assert.equal(await workspaceBytes(page), initialWorkspace);
    verify();
  } finally { await context.close(); }
});

test('a moved avatar crop, email and name commit together while the workspace image and session bytes stay separate', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initialWorkspace = await workspaceBytes(page);
    const selectedPhoto = await photo(page);
    await userDialog(page).getByLabel('Workspace image', { exact: true }).setInputFiles(selectedPhoto);
    await expect(userDialog(page).getByRole('status').filter({ hasText: 'Image ready.' })).toBeVisible();
    await userDialog(page).getByRole('textbox', { name: 'Display name', exact: true }).fill('Invented avatar owner');
    await userDialog(page).getByRole('textbox', { name: 'Email address (optional)', exact: true }).fill('owner@example.test');
    await userDialog(page).getByLabel('Profile photo', { exact: true }).setInputFiles(selectedPhoto);
    const crop = userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true });
    await expect(crop).toBeVisible();
    await userDialog(page).getByRole('slider', { name: 'Zoom', exact: true }).fill('2');
    await crop.focus();
    for (let index = 0; index < 20; index += 1) await page.keyboard.press('Shift+ArrowRight');
    await userDialog(page).getByRole('button', { name: 'Use this crop', exact: true }).click();
    await expect(userDialog(page).locator('.identity-avatar-preview img')).toBeVisible();
    await userDialog(page).getByRole('button', { name: 'Save identity', exact: true }).click();
    await expect(userDialog(page).getByRole('status').filter({ hasText: 'Browser identity saved.' })).toBeVisible();
    const identity = JSON.parse(await identityBytes(page));
    assert.equal(identity.displayName, 'Invented avatar owner');
    assert.equal(identity.email, 'owner@example.test');
    assert.equal(identity.brandImage, `data:image/png;base64,${selectedPhoto.buffer.toString('base64')}`);
    assert.notEqual(identity.avatarImage, identity.brandImage);
    const cropPixels = await page.evaluate(async (source) => {
      const image = new Image(); image.src = source; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
      return { width: image.naturalWidth, height: image.naturalHeight, pixel: Array.from(context.getImageData(128, 128, 1, 1).data) };
    }, identity.avatarImage);
    assert.deepEqual(cropPixels, { width: 256, height: 256, pixel: [255, 0, 0, 255] });
    assert.equal(await workspaceBytes(page), initialWorkspace);
    await userDialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
    const rail = page.getByRole('complementary', { name: 'Navigation rail', exact: true });
    await expect(rail.locator('.user-avatar img')).toHaveAttribute('src', identity.avatarImage);
    await expect(rail).not.toContainText(identity.email);
    await page.reload();
    await expect(rail.locator('.user-avatar img')).toHaveAttribute('src', identity.avatarImage);
    await page.getByRole('button', { name: 'User options', exact: true }).click();
    await expect(userDialog(page).getByRole('textbox', { name: 'Email address (optional)', exact: true })).toHaveValue(identity.email);
    assert.equal(await workspaceBytes(page), initialWorkspace);
    verify();
  } finally { await context.close(); }
});

test('canceled decoding cannot replace a newer selected photo or remove its draft hold', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const firstPhoto = await photo(page, '#ff0000');
    const secondPhoto = await photo(page, '#0000ff');
    await page.evaluate(() => {
      const decode = HTMLImageElement.prototype.decode;
      let count = 0;
      HTMLImageElement.prototype.decode = async function () {
        await decode.call(this);
        count += 1;
        if (count === 1) await new Promise((resolve) => { window.releaseFirstAvatarDecode = resolve; });
      };
    });
    await userDialog(page).getByLabel('Profile photo', { exact: true }).setInputFiles(firstPhoto);
    await expect(userDialog(page).getByRole('button', { name: 'Cancel photo selection', exact: true })).toBeVisible();
    await page.waitForFunction(() => typeof window.releaseFirstAvatarDecode === 'function');
    await userDialog(page).getByRole('button', { name: 'Cancel photo selection', exact: true }).click();
    await userDialog(page).getByLabel('Profile photo', { exact: true }).setInputFiles(secondPhoto);
    await expect(userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true })).toBeVisible();
    await page.evaluate(() => window.releaseFirstAvatarDecode());
    await expect(userDialog(page).locator('[data-preview-refresh-hold="browser-identity"]')).toHaveCount(1);
    await expect(userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true }).locator('img')).toHaveAttribute('src', `data:image/png;base64,${secondPhoto.buffer.toString('base64')}`);
    await userDialog(page).getByRole('button', { name: 'Cancel crop', exact: true }).click();
    await expect(userDialog(page).locator('[data-preview-refresh-hold="browser-identity"]')).toHaveCount(0);
    verify();
  } finally { await context.close(); }
});

test('mobile profile and Appearance bodies scroll while their close controls remain visible', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true });
  try {
    await enter(page, true);
    await userDialog(page).getByLabel('Profile photo', { exact: true }).setInputFiles(await photo(page));
    const crop = userDialog(page).getByRole('group', { name: 'Avatar crop', exact: true });
    await expect(crop).toBeVisible();
    const bounds = await crop.boundingBox();
    assert.ok(Math.abs(bounds.width - bounds.height) < 1, 'The mobile crop remains circular.');
    await crop.tap();
    await userDialog(page).getByRole('button', { name: 'Cancel crop', exact: true }).click();
    await userDialog(page).getByRole('textbox', { name: 'Future session naming guidance', exact: true }).fill('Unfinished mobile guidance.');
    await userDialog(page).getByRole('textbox', { name: 'Future session naming guidance', exact: true }).evaluate((element) => { element.style.height = '900px'; });
    await userDialog(page).locator('.modal-body').evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect(userDialog(page).getByRole('button', { name: 'Close user options', exact: true })).toBeInViewport();
    await userDialog(page).getByRole('button', { name: 'Appearance options', exact: true }).click();
    const appearance = page.getByRole('dialog', { name: 'Appearance options', exact: true });
    await appearance.locator('.modal-body').evaluate((element) => { element.style.maxHeight = '160px'; });
    await appearance.getByRole('radio', { name: /Hide completely/ }).scrollIntoViewIfNeeded();
    await expect(appearance.getByRole('button', { name: 'Close appearance options', exact: true })).toBeInViewport();
    await appearance.getByRole('button', { name: 'Close appearance options', exact: true }).click();
    await expect(appearance.getByRole('alert')).toContainText('Your identity changes are not saved');
    verify();
  } finally { await context.close(); }
});
