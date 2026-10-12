import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readNativeRecord, readNativeRecordRaw } from './browser-persistence.mjs';

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
  await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nexus Navigator', exact: true })).toBeVisible();
  await saved(page);
}
const stored = (page) => readNativeRecord(page, storageKey);
const bytes = (page) => readNativeRecordRaw(page, storageKey);
const tabSelection = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);

async function hideNavigation(page) {
  await page.getByRole('button', { name: 'User options', exact: true }).click();
  const options = page.getByRole('dialog', { name: 'User options', exact: true });
  await options.getByRole('radio', { name: /^Hide completely/ }).check();
  await options.getByRole('button', { name: 'Close options', exact: true }).click();
  await page.mouse.move(1000, 130);
  await expect(page.locator('.desktop-navigation')).toBeHidden();
}

async function coverNavigationEdge(page) {
  // Invented page overlay: the edge receives no enter event and movement
  // stops bubbling. This does not model or prove Codex browser internals.
  await page.evaluate(() => {
    const overlay = document.createElement('div'); overlay.id = 'invented-edge-overlay';
    Object.assign(overlay.style, { position: 'fixed', left: '0', top: '0', bottom: '0', width: '8px', zIndex: '32' });
    overlay.addEventListener('pointermove', (event) => event.stopPropagation());
    document.body.append(overlay);
  });
}

for (const mode of ['hover', 'hidden']) test(`${mode} navigation stays open while dragging wider and hovering the handle's outer half`, async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 858 } });
  try {
    await enter(page);
    const draft = page.getByRole('textbox', { name: 'Your message', exact: true });
    await draft.fill('Invented draft retained while widening navigation.');
    await saved(page);
    const retained = await bytes(page);
    await page.getByRole('button', { name: 'User options', exact: true }).click();
    const options = page.getByRole('dialog', { name: 'User options', exact: true });
    await options.getByRole('radio', { name: mode === 'hover' ? /^Expand on hover/ : /^Hide completely/ }).check();
    await options.getByRole('button', { name: 'Close options', exact: true }).click();
    await page.mouse.move(1000, 130);
    const layout = page.locator('.desk-layout');
    await expect(layout).not.toHaveClass(/rail-revealed/);
    await page.mouse.move(1, 429);
    await expect(layout).toHaveClass(/rail-revealed/);
    const handle = page.getByRole('separator', { name: 'Navigation width', exact: true });
    await expect.poll(async () => {
      const rail = await page.locator('.desktop-navigation').boundingBox();
      return { x: rail.x, width: rail.width };
    }).toEqual({ x: 0, width: 260 });
    const bounds = await handle.boundingBox();
    const x = bounds.x + 3, y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (const dx of [20, 40, 60, 80]) {
      await page.mouse.move(x + dx, y);
      await expect(layout).toHaveClass(/rail-revealed/);
      await expect(handle).toBeFocused();
    }
    await page.mouse.up();
    await expect(handle).toHaveAttribute('aria-valuenow', '340');
    await expect.poll(async () => (await page.locator('.desk-main-column').boundingBox()).x).toBe(340);
    const widened = await handle.boundingBox();
    const outerX = widened.x + widened.width - 1;
    assert.ok(outerX > 340, 'Exercise the handle outside the rail border.');
    await page.mouse.move(outerX, y);
    await expect(layout).toHaveClass(/rail-revealed/);
    await expect(handle).toBeVisible();
    if (process.env.DESK_SCREENSHOT_DIR) {
      mkdirSync(process.env.DESK_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.DESK_SCREENSHOT_DIR, `${mode}-navigation-widened.png`), fullPage: true });
    }
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('true-convo:desk:layout:v1')).railWidth), 340);
    await page.mouse.move(outerX + 10, y);
    await expect(layout).not.toHaveClass(/rail-revealed/);
    assert.equal(await bytes(page), retained);
    await expect(draft).toHaveValue('Invented draft retained while widening navigation.');
    verify();
  } finally { await context.close(); }
});

test('hidden navigation stays closed during a captured Canvas pan past an overlay and a held-button edge entry', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 858 } });
  try {
    await enter(page);
    const draft = page.getByRole('textbox', { name: 'Your message', exact: true });
    await draft.fill('Invented draft retained through a captured Canvas pan.');
    await saved(page);
    const retained = await bytes(page);
    await hideNavigation(page);
    await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    await expect(page.locator('.canvas-save-status')).toHaveText(/^Canvas layout (?:ready|saved in this browser)$/);
    const canvasBytes = await readNativeRecordRaw(page, 'true-convo:desk:canvas-layout:v1');
    await coverNavigationEdge(page);
    const viewport = page.getByLabel('Canvas viewport', { exact: true });
    const transform = page.locator('.canvas-map > svg > g');
    const view = () => transform.evaluate((element) => {
      const matrix = element.transform.baseVal.consolidate().matrix;
      return { x: matrix.e, y: matrix.f, scale: matrix.a };
    });
    const initial = await view();
    const bounds = await viewport.boundingBox();
    const x = Math.round(bounds.x + bounds.width - 60), y = Math.round(bounds.y + 120);
    await viewport.focus();
    await page.keyboard.down('Space');
    await page.mouse.move(x, y);
    await page.mouse.down();
    // Real input must retain pointer capture while the hit-tested element at
    // the edge is the overlay, exercising the document listener's button guard.
    await page.mouse.move(1, y, { steps: 6 });
    assert.equal(await viewport.evaluate((element) => element.hasPointerCapture(1)), true);
    assert.equal(await page.evaluate((y) => document.elementFromPoint(1, y)?.id, y), 'invented-edge-overlay');
    await expect(page.locator('.desk-layout')).not.toHaveClass(/rail-revealed/);
    assert.deepEqual(await view(), { ...initial, x: initial.x + 1 - x });
    await expect.poll(async () => (await page.locator('.desk-main-column').boundingBox()).x).toBe(0);
    await page.mouse.up();
    await page.keyboard.up('Space');
    assert.deepEqual(await view(), { ...initial, x: initial.x + 1 - x });
    assert.equal(await readNativeRecordRaw(page, 'true-convo:desk:canvas-layout:v1'), canvasBytes);
    await page.locator('#invented-edge-overlay').evaluate((element) => element.remove());
    await page.mouse.move(1000, 15);
    await page.mouse.down();
    await page.mouse.move(1, 2);
    await expect(page.locator('.desk-layout')).not.toHaveClass(/rail-revealed/);
    await page.mouse.up();
    await page.mouse.move(1000, 15);
    await page.getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    assert.equal(await bytes(page), retained);
    await expect(draft).toHaveValue('Invented draft retained through a captured Canvas pan.');
    verify();
  } finally { await context.close(); }
});

test('hidden navigation recovers through an overlay that stops bubbling across the whole application edge', async (t) => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 858 } });
  try {
    await enter(page);
    const draft = page.getByRole('textbox', { name: 'Your message', exact: true });
    await draft.fill('Invented draft retained while recovering hidden navigation.');
    await saved(page);
    const retained = await bytes(page);
    await hideNavigation(page);
    const rail = page.locator('.desktop-navigation');
    t.diagnostic(`Hidden edge geometry and hit target: ${JSON.stringify(await page.locator('.rail-edge').evaluate((element) => {
      const bounds = element.getBoundingClientRect(); const style = getComputedStyle(element);
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, position: style.position,
        zIndex: style.zIndex, hitTarget: document.elementFromPoint(1, 2)?.className };
    }))}`);
    await coverNavigationEdge(page);
    assert.equal(await page.evaluate(() => document.elementFromPoint(1, 2)?.id), 'invented-edge-overlay');
    for (const y of [2, 429, 856]) {
      await page.mouse.move(1000, 130);
      await expect(rail).toBeHidden();
      await page.mouse.move(1, y);
      await expect(rail).toBeVisible();
      await page.mouse.move(120, y);
      await expect.poll(async () => (await rail.boundingBox()).x).toBe(0);
      await expect.poll(async () => (await page.locator('.desk-main-column').boundingBox()).x).toBe(260);
    }
    await page.mouse.move(1000, 130);
    await expect(rail).toBeHidden();
    assert.equal(await bytes(page), retained);
    await expect(draft).toHaveValue('Invented draft retained while recovering hidden navigation.');
    verify();
  } finally { await context.close(); }
});

test('hidden navigation has a visible header recovery button and both keyboard shortcuts without changing saved work', async (t) => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 858 } });
  const screenshots = process.env.DESK_SCREENSHOT_DIR || mkdtempSync(join(tmpdir(), 'true-convo-hidden-navigation-'));
  mkdirSync(screenshots, { recursive: true });
  try {
    await enter(page);
    const draft = page.getByRole('textbox', { name: 'Your message', exact: true });
    await draft.fill('Invented draft kept through click and keyboard recovery.');
    await saved(page);
    const retained = await bytes(page);
    await hideNavigation(page);
    const rail = page.locator('.desktop-navigation');
    const recovery = page.locator('.desk-header').getByRole('button', { name: 'Show navigation', exact: true });
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText('Navigation');
    await expect(rail).toHaveAttribute('inert', '');
    await expect.poll(async () => (await page.locator('.desk-main-column').boundingBox()).x).toBe(0);
    await page.screenshot({ path: join(screenshots, 'hidden-navigation-header.png'), fullPage: true });
    await recovery.click();
    await expect(recovery).toHaveCount(0);
    await expect(rail.locator('button').first()).toBeFocused();
    await expect.poll(async () => (await page.locator('.desk-main-column').boundingBox()).x).toBe(260);
    await page.screenshot({ path: join(screenshots, 'hidden-navigation-recovered.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(rail).toBeHidden();
    await expect(page.getByRole('main')).toBeFocused();
    for (const shortcut of ['Control+Backslash', 'Meta+Backslash']) {
      await page.keyboard.press(shortcut);
      await expect(rail).toBeVisible();
      await expect(rail.locator('button').first()).toBeFocused();
      await page.keyboard.press(shortcut);
      await expect(rail).toBeHidden();
      await expect(page.getByRole('main')).toBeFocused();
    }
    await recovery.click();
    await rail.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await page.mouse.move(1000, 130);
    await expect(rail).toBeHidden();
    await expect(page.locator('.primary-module-heading')).toHaveText('Memories');
    await page.screenshot({ path: join(screenshots, 'hidden-navigation-memories.png'), fullPage: true });
    await recovery.click();
    await page.getByRole('button', { name: 'User options', exact: true }).click();
    const options = page.getByRole('dialog', { name: 'User options', exact: true });
    await options.getByRole('radio', { name: /^Expanded/ }).check();
    await options.getByRole('button', { name: 'Close options', exact: true }).click();
    await expect(recovery).toHaveCount(0);
    await rail.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
    assert.equal(await bytes(page), retained);
    await expect(draft).toHaveValue('Invented draft kept through click and keyboard recovery.');
    verify();
    t.diagnostic(`Hidden navigation screenshots: ${screenshots}`);
  } finally {
    try { await context.close(); } finally {
      if (!process.env.DESK_SCREENSHOT_DIR) rmSync(screenshots, { recursive: true, force: true });
    }
  }
});

test('hidden recovery respects dialogs, fullscreen Canvas and the mobile drawer', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 858 } });
  try {
    await enter(page);
    const retained = await bytes(page);
    await hideNavigation(page);
    const layout = page.locator('.desk-layout');
    await page.getByRole('button', { name: 'Work primitives', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'NEXUS work primitives', exact: true });
    await page.mouse.move(1, 2);
    await page.keyboard.press('Control+Backslash');
    await expect(layout).not.toHaveClass(/rail-revealed/);
    assert.equal(await dialog.evaluate((element) => element.contains(document.activeElement)), true);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    for (const fallback of [false, true]) {
      if (fallback) await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('Invented unsupported fullscreen')); });
      await page.getByRole('button', { name: 'Fullscreen Canvas', exact: true }).click();
      await expect(page.locator('.nexus-canvas')).toHaveClass(/canvas-expanded/);
      await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(!fallback);
      await page.mouse.move(1, 2);
      await page.keyboard.press('Meta+Backslash');
      await expect(layout).not.toHaveClass(/rail-revealed/);
      assert.equal(await page.locator('.nexus-canvas').evaluate((element) => element.contains(document.activeElement)), true);
      await page.getByRole('button', { name: 'Exit fullscreen Canvas', exact: true }).click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.hidden-navigation-recovery')).toBeHidden();
    await page.mouse.move(1, 2);
    await expect(layout).not.toHaveClass(/rail-revealed/);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    let drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await page.keyboard.press('Control+Backslash');
    drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(drawer).toBeVisible();
    await page.keyboard.press('Escape');
    assert.equal(await bytes(page), retained);
    verify();
  } finally { await context.close(); }
});

test('hidden rail expands from the far-left edge across the full application height with all titles', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 858 } });
  try {
    await enter(page);
    const preserved = await bytes(page);
    await page.evaluate(() => localStorage.setItem('true-convo:desk:layout:v1', JSON.stringify({ mode: 'hidden', railWidth: 300, inspectorWidth: 294 })));
    await page.reload();
    const rail = page.locator('.desktop-navigation');
    const edge = page.getByRole('button', { name: 'Reveal navigation', exact: true });
    await expect(rail).toHaveAttribute('inert', '');
    const bounds = await edge.boundingBox();
    assert.equal(bounds.x, 0); assert.equal(bounds.y, 0); assert.equal(bounds.height, 858);
    for (const y of [2, 429, 856]) {
      await page.mouse.move(800, 130);
      await expect(rail).toBeHidden();
      await page.mouse.move(1, y);
      await expect(rail).toBeVisible();
      await expect(rail.locator('.navigation-content')).not.toHaveClass(/navigation-compact/);
      await expect(rail.locator('.brand-name')).toBeVisible();
      await expect(rail.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).locator('span').first()).toBeVisible();
      await expect(rail.getByRole('button', { name: 'User options', exact: true }).locator('.user-copy')).toBeVisible();
      // Visibility starts at the beginning of the slide. Verify the exact
      // completed geometry rather than a transformed subpixel intermediate.
      await expect.poll(async () => {
        const expanded = await rail.boundingBox();
        return { x: expanded.x, width: expanded.width };
      }).toEqual({ x: 0, width: 300 });
      const expanded = await rail.boundingBox();
      assert.equal(expanded.width, 300); assert.equal(expanded.y, 0); assert.equal(expanded.height, 858);
    }
    assert.equal(await bytes(page), preserved);
    verify();
  } finally { await context.close(); }
});

test('folder plus creates a subordinate session; ellipsis retains nested folder creation and compact symbols', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await stored(page);
    const folder = before.goals[0];
    const create = page.getByRole('button', { name: `Create session in ${folder.title}`, exact: true });
    await create.click();
    await saved(page);
    const after = await stored(page);
    assert.deepEqual(after.goals, before.goals);
    assert.deepEqual(after.messages, before.messages);
    assert.equal(after.sessions.length, before.sessions.length + 1);
    assert.equal(after.sessions.at(-1).goalId, folder.id);
    assert.equal(after.selection.sessionId, after.sessions.at(-1).id);
    assert.equal(after.drafts[after.sessions.at(-1).id], '');
    const options = page.getByRole('button', { name: `Folder options for ${folder.title}`, exact: true });
    assert.equal(await options.locator('svg circle').count(), 3);
    const control = await options.boundingBox();
    assert.ok(control.width <= 22 && control.height <= 28);
    await options.focus(); await options.press('Enter');
    await page.getByRole('menuitem', { name: 'Create folder…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await expect(dialog.getByRole('combobox', { name: 'Inside', exact: true })).toHaveValue(folder.id);
    await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented subordinate folder');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await saved(page);
    const nested = await stored(page);
    assert.equal(nested.goals.at(-1).parentId, folder.id);
    assert.deepEqual(nested.sessions, after.sessions);
    verify();
  } finally { await context.close(); }
});

test('folder icon changes need explicit save, persist locally and retain IDs, drafts and records', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await stored(page);
    const beforeView = await tabSelection(page);
    const folder = before.goals[0];
    const options = page.getByRole('button', { name: `Folder options for ${folder.title}`, exact: true });
    await options.click(); await page.getByRole('menuitem', { name: 'Change icon…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Folder icon', exact: true });
    await dialog.getByRole('radio', { name: 'Idea', exact: true }).check();
    assert.deepEqual(await stored(page), before);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(options).toBeFocused();
    assert.deepEqual(await stored(page), before);
    await options.click(); await page.getByRole('menuitem', { name: 'Change icon…', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Idea', exact: true }).check();
    await dialog.getByRole('button', { name: 'Save icon', exact: true }).click();
    await saved(page);
    const changed = await stored(page);
    assert.equal(changed.goals.find((goal) => goal.id === folder.id).icon, 'lightbulb');
    for (const field of ['sessions', 'messages', 'drafts', 'goalDrafts', 'workItems', 'notes']) assert.deepEqual(changed[field], before[field]);
    assert.deepEqual(await tabSelection(page), beforeView);
    await page.reload();
    assert.equal((await stored(page)).goals.find((goal) => goal.id === folder.id).icon, 'lightbulb');
    const rendered = page.locator(`.domain-link[data-domain-id="${folder.id}"] svg`);
    assert.equal(await rendered.locator('path').count(), 3);
    await options.click(); await page.getByRole('menuitem', { name: 'Change icon…', exact: true }).click();
    await dialog.getByRole('radio', { name: 'Folder', exact: true }).check();
    await dialog.getByRole('button', { name: 'Save icon', exact: true }).click();
    await saved(page);
    assert.equal(Object.hasOwn((await stored(page)).goals.find((goal) => goal.id === folder.id), 'icon'), false);
    verify();
  } finally { await context.close(); }
});

test('session drag refiling round trip preserves messages, draft, name history and selected identity; external drops do nothing', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const folder = initial.goals[0];
    await page.getByRole('region', { name: 'Ungrouped sessions', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
    await saved(page);
    const id = (await stored(page)).selection.sessionId;
    await page.locator(`.session-link[data-session-id="${id}"]`).press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename session', exact: true });
    await rename.getByRole('textbox', { name: 'Session name', exact: true }).fill('Invented renamed session to move');
    await rename.getByRole('button', { name: 'Save name', exact: true }).click();
    await saved(page);
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented message before moving.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await composer.fill('Invented unfinished message survives the move.');
    await saved(page);
    const before = await stored(page);
    const session = page.locator(`.session-link[data-session-id="${id}"]`);
    const target = page.locator(`[data-drop-goal-id="${folder.id}"]`);
    await target.dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    assert.deepEqual(await stored(page), before);
    await session.dragTo(target);
    await saved(page);
    const filed = await stored(page);
    assert.equal(filed.sessions.find((item) => item.id === id).goalId, folder.id);
    assert.equal((await tabSelection(page)).sessionId, id);
    assert.equal((await tabSelection(page)).goalId, folder.id);
    assert.deepEqual(filed.messages, before.messages); assert.deepEqual(filed.drafts, before.drafts);
    assert.deepEqual(filed.activity.slice(0, before.activity.length), before.activity);
    const priorSession = before.sessions.find((item) => item.id === id);
    const movedSession = filed.sessions.find((item) => item.id === id);
    assert.equal(movedSession.createdAt, priorSession.createdAt);
    assert.equal(movedSession.title, 'Invented renamed session to move');
    assert.equal(priorSession.titleHistory.length, 2);
    assert.deepEqual(movedSession.titleHistory, priorSession.titleHistory);
    await expect(composer).toHaveValue('Invented unfinished message survives the move.');
    await expect(session).toBeFocused();
    await session.dragTo(page.locator('[data-drop-goal-id="ungrouped"]'));
    await saved(page);
    assert.equal((await stored(page)).sessions.find((item) => item.id === id).goalId, null);
    assert.deepEqual((await stored(page)).messages, before.messages); assert.deepEqual((await stored(page)).drafts, before.drafts);
    await page.reload();
    await expect(composer).toHaveValue('Invented unfinished message survives the move.');
    await expect(session).toBeVisible();
    // Keyboard fallback remains available when dragging is inconvenient.
    await session.press('Shift+F10');
    await expect(page.getByRole('menuitem', { name: 'Move to folder…', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    verify();
  } finally { await context.close(); }
});
