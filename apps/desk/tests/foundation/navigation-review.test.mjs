import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readNativeRecord, readNativeRecordRaw, writeNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const storageKey = 'true-convo:desk:synthetic:v1';
let server;
let browser;
let origin;
let output = '';
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function cleanup() {
  await browser?.close();
  browser = undefined;
  if (!server) return;
  const exited = server.exitCode === null && server.signalCode === null ? once(server, 'exit') : Promise.resolve();
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  if (!await Promise.race([exited.then(() => true), pause(2_000).then(() => false)])) {
    try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
    await exited;
  }
  server = undefined;
}

before(async () => {
  try {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;
    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
  } catch (error) {
    await cleanup();
    throw error;
  }
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
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  return { context, page, verify: () => {
    assert.deepEqual(outside, [], 'Annotation flow requested another origin.');
    assert.deepEqual(privateApi, [], 'Annotation flow requested a private API.');
    assert.deepEqual(errors, [], 'Annotation flow reported browser errors.');
  } };
}

async function saved(page) {
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}
async function enter(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nexus Navigator', exact: true })).toBeVisible();
  await saved(page);
}
const stored = (page) => readNativeRecord(page, storageKey);
const bytes = (page) => readNativeRecordRaw(page, storageKey);
const tabSelection = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);


test('Move and Create folder dialogs stay outside transient rails and retain focus after dismissal', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const folder = initial.goals[0];
    const item = initial.sessions[0];
    const retained = await bytes(page);
    for (const mode of ['hidden', 'hover']) {
      await page.evaluate((mode) => localStorage.setItem('true-convo:desk:layout:v1', JSON.stringify({ mode, railWidth: 260, inspectorWidth: 294 })), mode);
      await page.reload();
      await page.mouse.move(1100, 150);
      await page.getByRole('main').focus();
      await page.keyboard.press('Control+Backslash');
      await expect(page.locator('.desktop-navigation .navigation-content')).not.toHaveClass(/navigation-compact/);
      const session = page.locator(`.desktop-navigation [data-session-id="${item.id}"]`);
      await session.press('Shift+F10');
      await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
      await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
      const move = page.getByRole('dialog', { name: 'Move session', exact: true });
      assert.equal(await move.evaluate((element) => Boolean(element.closest('.desktop-navigation'))), false);
      await expect(move.getByRole('combobox', { name: 'Move to folder', exact: true })).toBeFocused();
      assert.equal(await page.locator('.desktop-navigation .navigation-content').evaluate((element) => element.scrollLeft), 0,
        'Programmatic focus must not scroll the rail horizontally during its opening transition.');
      await page.mouse.move(1100, 150);
      await expect(move).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(move).toHaveCount(0);
      // The modal cleanup restores focus immediately; let the shared queued
      // restoration finish before focusing a different row for the next menu.
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
      await expect(session).toBeVisible(); await expect(session).toBeFocused();
      const options = page.getByRole('button', { name: `Folder options for ${folder.title}`, exact: true });
      await options.press('Shift+F10');
      await expect(page.getByRole('menu', { name: `Folder options for ${folder.title}`, exact: true })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Create folder…', exact: true }).click();
      const create = page.getByRole('dialog', { name: 'Create folder', exact: true });
      assert.equal(await create.evaluate((element) => Boolean(element.closest('.desktop-navigation'))), false);
      await expect(create.getByRole('textbox', { name: 'Folder name', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(create).toHaveCount(0);
      await expect(options).toBeVisible(); await expect(options).toBeFocused();
      assert.equal(await bytes(page), retained);
    }
    verify();
  } finally { await context.close(); }
});

test('a real wheel scroll in the navigation list still dismisses its portaled row menu', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1440, height: 420 } });
  try {
    await enter(page);
    const before = await stored(page);
    const retained = await bytes(page);
    const list = page.locator('.desktop-navigation .navigation-lists');
    const options = page.getByRole('button', { name: `Folder options for ${before.goals[0].title}`, exact: true });
    await options.scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    await options.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
    const scrollTop = await list.evaluate((element) => element.scrollTop);
    const scrollable = await list.evaluate((element) => element.scrollHeight > element.clientHeight);
    assert.equal(scrollable, true, 'The short viewport fixture must exercise actual list scrolling.');
    const bounds = await list.boundingBox();
    assert.ok(bounds, 'The navigation list must have a visible wheel target.');
    const wheelPoint = { x: bounds.x + 8, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    assert.equal(await list.evaluate((element, point) => element.contains(document.elementFromPoint(point.x, point.y)), wheelPoint), true,
      'The wheel target must hit the navigation list rather than its portaled menu.');
    await expect(menu).toBeVisible();
    await page.mouse.wheel(0, 100);
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(scrollTop);
    await expect(menu).toHaveCount(0);
    assert.equal(await bytes(page), retained);
    verify();
  } finally { await context.close(); }
});

test('hover and hidden rails dismiss after an ordinary click and pointer departure while keeping the draft intact', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const item = initial.sessions[0];
    await page.locator(`.session-link[data-session-id="${item.id}"]`).click();
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Keep this invented draft through transient rail dismissal.');
    await saved(page);
    const retained = await bytes(page);
    for (const mode of ['hover', 'hidden']) {
      await page.evaluate((mode) => localStorage.setItem('true-convo:desk:layout:v1', JSON.stringify({ mode, railWidth: 260, inspectorWidth: 294 })), mode);
      await page.reload();
      // The opening placeholder also has a main role. Wait for the saved Desk
      // and its chosen rail mode before generating an actual pointer enter.
      await saved(page);
      await expect(page.locator('.desk-layout')).toHaveClass(new RegExp(`(?:^|\\s)rail-${mode}(?:\\s|$)`));
      const rail = page.locator('.desktop-navigation');
      await page.mouse.move(1100, 150);
      await page.mouse.move(1, 220);
      await expect(rail.locator('.navigation-content')).not.toHaveClass(/navigation-compact/);
      await rail.getByRole('button', { name: 'DATA', exact: true }).click();
      await page.mouse.move(1100, 150);
      if (mode === 'hidden') await expect(rail).toBeHidden();
      else await expect(rail.locator('.navigation-content')).toHaveClass(/navigation-compact/);
      await page.mouse.move(1, 220);
      await expect(rail.locator('.navigation-content')).not.toHaveClass(/navigation-compact/);
      await rail.locator(`[data-session-id="${item.id}"]`).click();
      await page.mouse.move(1100, 150);
      if (mode === 'hidden') await expect(rail).toBeHidden();
      else await expect(rail.locator('.navigation-content')).toHaveClass(/navigation-compact/);
      await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Keep this invented draft through transient rail dismissal.');
      assert.equal(await bytes(page), retained);
    }
    verify();
  } finally { await context.close(); }
});

test('folder pickers distinguish nested folders by ancestry while submitting their existing IDs', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const fixture = structuredClone(initial);
    const time = initial.updatedAt;
    const rootA = crypto.randomUUID(); const rootB = crypto.randomUUID();
    const childA = crypto.randomUUID(); const childB = crypto.randomUUID();
    fixture.goals.push(
      { id: rootA, title: 'Invented Projects A', nextStep: '', createdAt: time, updatedAt: time },
      { id: rootB, title: 'Invented Projects B', nextStep: '', createdAt: time, updatedAt: time },
      { id: childA, parentId: rootA, title: 'Shared idea', nextStep: '', createdAt: time, updatedAt: time },
      { id: childB, parentId: rootB, title: 'Shared idea', nextStep: '', createdAt: time, updatedAt: time },
    );
    for (const id of [rootA, rootB, childA, childB]) fixture.goalDrafts[id] = { nextStep: null, workTitle: '' };
    fixture.revision += 1;
    await writeNativeRecordRaw(page, storageKey, JSON.stringify(fixture), { notify: false });
    await page.reload();
    await expect(page.getByRole('main')).toBeVisible();
    const item = fixture.sessions[0];
    await page.locator(`.session-link[data-session-id="${item.id}"]`).press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    const move = page.getByRole('dialog', { name: 'Move session', exact: true });
    const picker = move.getByRole('combobox', { name: 'Move to folder', exact: true });
    await expect(picker.getByRole('option', { name: 'Invented Projects A / Shared idea', exact: true })).toHaveAttribute('value', childA);
    await expect(picker.getByRole('option', { name: 'Invented Projects B / Shared idea', exact: true })).toHaveAttribute('value', childB);
    await picker.selectOption(childB);
    await move.getByRole('button', { name: 'Move session', exact: true }).click();
    await saved(page);
    const moved = await stored(page);
    assert.equal(moved.sessions.find((session) => session.id === item.id).goalId, childB);
    for (const field of ['goals', 'messages', 'drafts', 'goalDrafts', 'workItems', 'notes']) assert.deepEqual(moved[field], fixture[field]);
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create folder', exact: true });
    const parent = create.getByRole('combobox', { name: 'Inside', exact: true });
    await expect(parent.getByRole('option', { name: 'Invented Projects A / Shared idea', exact: true })).toHaveAttribute('value', childA);
    await expect(parent.getByRole('option', { name: 'Invented Projects B / Shared idea', exact: true })).toHaveAttribute('value', childB);
    await create.getByRole('button', { name: 'Cancel', exact: true }).click();
    verify();
  } finally { await context.close(); }
});
