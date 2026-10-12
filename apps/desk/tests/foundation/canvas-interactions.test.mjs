import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { installNativeWriteFailure, readNativeRecord, readNativeRecordRaw, writeNativeRecordRaw } from './browser-persistence.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const canvasKey = 'true-convo:desk:canvas-layout:v1';
const workspaceKey = 'true-convo:desk:synthetic:v1';
let server, browser, origin, screenshots;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
before(async () => {
  screenshots = process.env.DESK_SCREENSHOT_DIR || await mkdtemp(join(tmpdir(), 'true-convo-canvas-browser-'));
  await mkdir(screenshots, { recursive: true });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise((done) => probe.close(done)); origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, detached: true, stdio: 'ignore' });
  let available = false;
  for (let i = 0; i < 100; i += 1) { try { if ((await fetch(origin)).ok) { available = true; break; } } catch {} await pause(100); }
  assert.ok(available, 'Focused Canvas dev fixture failed to start.');
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync) });
}, { timeout: 20_000 });
after(async () => {
  try {
    await browser?.close();
    if (server?.exitCode === null) { const ended = once(server, 'exit'); try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); } await ended; }
  } finally {
    // Only remove the isolated directory owned by this run. Explicit output
    // directories belong to the caller and retain their requested captures.
    if (screenshots && !process.env.DESK_SCREENSHOT_DIR) await rm(screenshots, { recursive: true, force: true });
  }
});
async function fixture(init) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }); if (init) await init(context);
  const page = await context.newPage(); const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin); await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click(); await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
  await expect(page.locator('.canvas-save-status')).not.toContainText('Loading');
  const item = page.locator('.canvas-item').first(); return { context, page, item, button: item.locator('button.canvas-node'), errors };
}
async function saved(page) { await expect(page.locator('.canvas-save-status')).toHaveText(/^Canvas layout (?:ready|saved in this browser)$/); }
async function drag(page, locator, dx, dy, cancel = false) {
  const bounds = await locator.boundingBox(); assert.ok(bounds); const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + dx, y + dy, { steps: 6 }); if (cancel) await page.keyboard.press('Escape'); await page.mouse.up();
}
async function choose(page, button, name, role = 'menuitemradio') { await button.click({ button: 'right' }); await page.getByRole(role, { name, exact: true }).click(); await saved(page); }
function object(item) { return item.locator('foreignObject[data-record-id]'); }
async function geometry(item) { return object(item).evaluate((node) => Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, Number(node.getAttribute(key))]))); }

test('Canvas one click selects without leaving the map; double-click, Open and Enter navigate existing folders and sessions', { timeout: 45_000 }, async () => {
  const { context, page, item, button, errors } = await fixture();
  try {
    await saved(page);
    const sessionItem = page.locator('.canvas-item[data-node-id^="session:"]').first();
    const sessionButton = sessionItem.locator('button.canvas-node');
    const folderId = (await item.getAttribute('data-node-id')).slice('domain:'.length);
    const sessionId = (await sessionItem.getAttribute('data-node-id')).slice('session:'.length);
    const before = await readNativeRecordRaw(page, workspaceKey);
    for (const [selected, other] of [[button, sessionButton], [sessionButton, button]]) {
      await selected.click();
      await expect(page.locator('.nexus-canvas')).toHaveCount(1);
      await expect(selected).toHaveAttribute('aria-current', 'true');
      await expect(other).not.toHaveAttribute('aria-current', 'true');
      assert.equal(await readNativeRecordRaw(page, workspaceKey), before, 'Canvas selection rewrote shared workspace or drafts.');
    }
    for (const [opener, kind, id] of [[button, 'folder', folderId], [sessionButton, 'session', sessionId]]) {
      for (const action of ['double-click', 'Open', 'Enter']) {
        if (action === 'double-click') await opener.dblclick();
        else if (action === 'Open') {
          await opener.click({ button: 'right' });
          await page.getByRole('menuitem', { name: 'Open', exact: true }).click();
        } else { await opener.focus(); await page.keyboard.press('Enter'); }
        await expect(page.locator('.nexus-canvas')).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Nexus Navigator', exact: true })).toHaveAttribute('aria-current', 'page');
        const target = JSON.parse(before)[kind === 'folder' ? 'goals' : 'sessions'].find((record) => record.id === id);
        if (kind === 'folder') {
          await expect(page.locator('.navigator-empty').getByRole('heading', { name: target.title, exact: true })).toBeVisible();
          await expect(page.locator(`.domain-row.selected > .domain-link[data-domain-id="${id}"]`)).toBeVisible();
        } else {
          await expect(page.getByRole('region', { name: 'Conversation', exact: true }).getByRole('heading', { name: target.title, exact: true })).toBeVisible();
          await expect(page.getByRole('complementary', { name: 'Session details', exact: true })).toHaveAttribute('data-selected-session-id', id);
        }
        const after = await readNativeRecord(page, workspaceKey);
        assert.deepEqual(after.messages, JSON.parse(before).messages);
        assert.deepEqual(after.drafts, JSON.parse(before).drafts);
        await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click(); await saved(page);
      }
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Canvas click followed by a quick second-press drag moves the item without opening or leaving fullscreen', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture();
  try {
    await saved(page);
    const before = await readNativeRecordRaw(page, workspaceKey);
    await page.getByRole('button', { name: 'Fullscreen Canvas', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.matches('.nexus-canvas') ?? false)).toBe(true);
    await page.evaluate(() => {
      window.__canvasDragDblclicks = [];
      document.addEventListener('dblclick', (event) => {
        const node = event.target.closest?.('.canvas-item');
        if (node) window.__canvasDragDblclicks.push({ id: node.getAttribute('data-node-id'), trusted: event.isTrusted });
      }, true);
    });
    const initial = await geometry(item);
    // Report the second press inside the platform's double-click sequence,
    // then drag it. Browser input produces a trusted dblclick after pointerup;
    // do not dispatch a synthetic DOM event or call the React handler.
    await button.click();
    const bounds = await button.boundingBox(); assert.ok(bounds);
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y); await page.mouse.down({ clickCount: 2 });
    await page.mouse.move(x + 28, y + 18, { steps: 6 }); await page.mouse.up({ clickCount: 2 });
    await expect(page.locator('.nexus-canvas')).toHaveCount(1);
    await saved(page);
    const moved = await geometry(item);
    assert.equal(moved.x, initial.x + 28); assert.equal(moved.y, initial.y + 18);
    assert.deepEqual(await page.evaluate(() => window.__canvasDragDblclicks), [{ id: await item.getAttribute('data-node-id'), trusted: true }]);
    await expect(page.locator('.canvas-expanded')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.matches('.nexus-canvas') ?? false)).toBe(true);
    const savedLayout = await readNativeRecord(page, canvasKey);
    assert.equal(savedLayout.nodes[await item.getAttribute('data-node-id')].x, moved.x);
    assert.equal(await readNativeRecordRaw(page, workspaceKey), before, 'Drag changed shared records or drafts.');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('rounded square and triangle connectors meet their rendered curves after resizing and moving', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture();
  try {
    await saved(page); const workspace = await readNativeRecordRaw(page, workspaceKey);
    const nodeId = await item.getAttribute('data-node-id');
    for (const shape of ['Triangle', 'Square']) {
      await choose(page, button, shape);
      const outline = item.locator('path.canvas-node-outline');
      await expect(outline).toHaveCount(1);
      assert.ok((await outline.getAttribute('d')).includes(' Q '), 'Requested rounded corners are missing.');
      for (const gesture of [async () => {}, async () => { await item.locator('.canvas-resize').focus(); await page.keyboard.press('ArrowRight'); await saved(page); },
        async () => {
          const before = await geometry(item); await drag(page, button, 28, 18); await saved(page);
          const after = await geometry(item); assert.equal(after.x, before.x + 28); assert.equal(after.y, before.y + 18);
        }]) {
        await gesture();
        const hit = await button.evaluate((element) => {
          const box = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
        });
        assert.equal(hit, true, `${shape} clipping excludes its interactive center.`);
        const connected = await item.evaluate((node) => {
          const outline = node.querySelector('.canvas-node-outline');
          const id = node.getAttribute('data-node-id');
          const links = [...document.querySelectorAll('.canvas-links path')].filter((link) => link.getAttribute('data-source') === id);
          return links.length > 0 && links.every((link) => outline.isPointInStroke(link.getPointAtLength(0)));
        });
        assert.equal(connected, true, `${shape} connectors detached from the rounded outline.`);
      }
      const clip = await button.evaluate((element) => element.style.clipPath); assert.match(clip, /canvas-clip-/);
      const titleInside = await item.locator('.canvas-node-title').evaluate((title) => {
        const node = title.closest('.canvas-item'); const box = title.getBoundingClientRect(); const matrix = node.getScreenCTM().inverse();
        return title.scrollHeight <= title.clientHeight && [[box.left + 1, box.top + 1], [box.right - 1, box.top + 1], [box.left + 1, box.bottom - 1], [box.right - 1, box.bottom - 1]]
          .every(([x, y]) => node.querySelector('.canvas-node-outline').isPointInFill(new DOMPoint(x, y).matrixTransform(matrix)));
      });
      assert.equal(titleInside, true, `${shape} clips the visible title.`);
    }
    assert.equal(await readNativeRecordRaw(page, workspaceKey), workspace, 'Changing corners modified workspace identities.');
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Canvas drag, resizing, shape locks, attached connectors and reload preserve shared workspace identities', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture();
  try {
    await saved(page); const workspace = await readNativeRecordRaw(page, workspaceKey); const first = await geometry(item); const nodeId = await item.getAttribute('data-node-id');
    const path = page.locator(`.canvas-links path[data-source="${nodeId}"]`).first(); const beforePath = await path.getAttribute('d');
    await drag(page, button, 45, 30); await saved(page); assert.equal(await page.locator('.nexus-canvas').count(), 1, 'A drag must not open Navigator.');
    const moved = await geometry(item); assert.equal(moved.x, first.x + 45); assert.equal(moved.y, first.y + 30); assert.notEqual(await path.getAttribute('d'), beforePath, 'A connector did not follow movement.');
    const record = await readNativeRecord(page, canvasKey); assert.equal(record.nodes[nodeId].x, moved.x); assert.equal(await readNativeRecordRaw(page, workspaceKey), workspace, 'Geometry modified conversation records.');
    await choose(page, button, 'Lock position', 'menuitemcheckbox'); await drag(page, button, 50, 30); assert.deepEqual(await geometry(item), moved);
    await choose(page, button, 'Circle'); const circle = await geometry(item); assert.equal(circle.width, circle.height);
    await page.screenshot({ path: join(screenshots, 'canvas-circle.png') });
    const resize = item.getByRole('button', { name: /^Resize folder / }); await resize.focus(); await page.keyboard.press('ArrowLeft'); await saved(page);
    const smaller = await geometry(item); assert.equal(smaller.width, circle.width - 12); assert.equal(smaller.height, smaller.width);
    await choose(page, button, 'Lock shape', 'menuitemcheckbox'); await button.click({ button: 'right' }); await expect(page.getByRole('menuitemradio', { name: 'Triangle', exact: true })).toBeDisabled();
    await page.screenshot({ path: join(screenshots, 'canvas-context-menu.png') });
    await page.keyboard.press('Escape'); await expect(item.locator('.canvas-resize')).toHaveCount(0);
    const durable = await readNativeRecordRaw(page, canvasKey); await page.reload(); await expect(page.getByRole('button', { name: 'Cloudwork Canvas', exact: true })).toBeVisible();
    if (!await page.locator('.nexus-canvas').count()) await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click(); await saved(page);
    await expect(item).toHaveAttribute('data-shape', 'circle'); await expect(item).toHaveAttribute('data-position-locked', 'true'); await expect(item).toHaveAttribute('data-shape-locked', 'true'); assert.equal(await readNativeRecordRaw(page, canvasKey), durable); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Canvas pointer zoom, Space panning, fullscreen, Escape cancellation and triangle labels work', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture();
  try {
    await saved(page); const viewport = page.getByLabel('Canvas viewport', { exact: true }); const transform = page.locator('.canvas-map > svg > g');
    await page.getByRole('button', { name: 'Zoom in', exact: true }).click(); await expect(page.getByLabel('Canvas zoom', { exact: true })).toHaveText('120%');
    const viewBefore = await transform.getAttribute('transform'); const bounds = await viewport.boundingBox(); await page.mouse.move(bounds.x + bounds.width - 60, bounds.y + 120);
    await page.keyboard.down('Control'); await page.mouse.wheel(0, -90); await page.keyboard.up('Control'); await expect(transform).not.toHaveAttribute('transform', viewBefore);
    await viewport.focus(); await page.keyboard.down('Space'); await expect(viewport).toHaveClass(/canvas-hand/); const panBefore = await transform.getAttribute('transform');
    await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width - 20, bounds.y + 160); await page.mouse.up(); await page.keyboard.up('Space'); assert.notEqual(await transform.getAttribute('transform'), panBefore);
    await page.getByRole('button', { name: 'Fit', exact: true }).click(); const initial = await geometry(item); await drag(page, button, 35, 20, true); assert.deepEqual(await geometry(item), initial); await expect(page.locator('[data-preview-refresh-hold="canvas-layout"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Fullscreen Canvas', exact: true }).click(); await expect(page.locator('.nexus-canvas')).toHaveClass(/canvas-expanded/);
    await page.screenshot({ path: join(screenshots, 'canvas-fullscreen.png') });
    const lastControl = page.locator('.nexus-canvas button:not(:disabled)').last();
    await lastControl.focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeFocused();
    const expandedStart = await geometry(item); await drag(page, button, 35, 20, true); assert.deepEqual(await geometry(item), expandedStart);
    if (await page.locator('.canvas-expanded').count()) await page.getByRole('button', { name: 'Exit fullscreen Canvas', exact: true }).click(); await expect(page.locator('.canvas-expanded')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fullscreen Canvas', exact: true })).toBeFocused();
    await page.evaluate(() => { Element.prototype.requestFullscreen = () => Promise.reject(new Error('Invented unsupported fullscreen')); });
    await page.getByRole('button', { name: 'Fullscreen Canvas', exact: true }).click();
    await expect(page.locator('.canvas-expanded')).toHaveCount(1); assert.equal(await page.evaluate(() => document.fullscreenElement), null);
    await page.keyboard.press('Escape'); await expect(page.locator('.canvas-expanded')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fullscreen Canvas', exact: true })).toBeFocused();
    await choose(page, button, 'Triangle'); const visible = await item.locator('.canvas-node-title').evaluate((node) => { const title = node.getBoundingClientRect(); const owner = node.closest('foreignObject').getBoundingClientRect(); return title.height > 0 && title.bottom <= owner.bottom && title.top >= owner.top; }); assert.equal(visible, true, 'Triangle name escaped its visible shape.');
    await page.screenshot({ path: join(screenshots, 'canvas-triangle.png') }); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('failed Canvas geometry remains visible across routes and protects the previous bytes', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture((context) => installNativeWriteFailure(context, canvasKey, '__failCanvas'));
  try {
    await saved(page); await drag(page, button, 20, 12); await saved(page); const bytes = await readNativeRecordRaw(page, canvasKey); await page.evaluate(() => { window.__failCanvas = true; }); await drag(page, button, 45, 15); await expect(page.locator('.canvas-save-status')).toContainText('could not be saved'); const attempted = await geometry(item); await expect(page.locator('[data-preview-refresh-hold="canvas-layout"]')).toHaveCount(1);
    await page.getByRole('button', { name: 'Nexus Navigator', exact: true }).click(); assert.equal(await page.locator('.nexus-canvas').count(), 0); await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click(); assert.deepEqual(await geometry(item), attempted); await expect(page.locator('.canvas-save-status')).toContainText('could not be saved'); assert.equal(await readNativeRecordRaw(page, canvasKey), bytes);
    let unloadGuarded = false; page.once('dialog', async (dialog) => { unloadGuarded = dialog.type() === 'beforeunload'; await dialog.dismiss(); }); await page.evaluate(() => { setTimeout(() => window.location.reload(), 0); }); await expect.poll(() => unloadGuarded).toBe(true); assert.equal(unloadGuarded, true, 'Temporary Canvas geometry was lost without a reload guard.'); assert.deepEqual(await geometry(item), attempted); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Canvas newer layout blocks writes and silent competing writer triggers CAS preservation', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture();
  try {
    await saved(page); await drag(page, button, 15, 12); await saved(page); const valid = await readNativeRecord(page, canvasKey); const competing = JSON.stringify({ ...valid, revision: valid.revision + 1 }); await writeNativeRecordRaw(page, canvasKey, competing, { notify: false }); await drag(page, button, 20, 10); await expect(page.locator('.canvas-save-status')).toContainText('changed in another tab'); assert.equal(await readNativeRecordRaw(page, canvasKey), competing);
    page.once('dialog', (dialog) => dialog.accept()); await page.reload(); if (!await page.locator('.nexus-canvas').count()) await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click(); await saved(page);
    const newer = JSON.stringify({ ...valid, version: 88 }); await writeNativeRecordRaw(page, canvasKey, newer); await expect(page.locator('.canvas-save-status')).toContainText('could not be read'); await drag(page, button, 20, 10); assert.equal(await readNativeRecordRaw(page, canvasKey), newer); assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Canvas pending save survives route exit and remount publishes the committed revision before another edit', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture((context) => context.addInitScript(({ canvasKey }) => {
    const native = IDBDatabase.prototype.transaction;
    const handler = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    IDBDatabase.prototype.transaction = function (...args) {
      const transaction = native.apply(this, args);
      if (this.name === canvasKey && args[1] === 'readwrite') {
        Object.defineProperty(transaction, 'oncomplete', {
          configurable: true,
          set(callback) { handler.set.call(transaction, (event) => {
            if (window.__holdCanvasCommit) window.__releaseCanvasCommit = () => callback.call(transaction, event);
            else callback.call(transaction, event);
          }); },
        });
      }
      return transaction;
    };
  }, { canvasKey }));
  try {
    await saved(page); await page.evaluate(() => { window.__holdCanvasCommit = true; });
    await drag(page, button, 35, 20); await expect(page.locator('.canvas-save-status')).toHaveText('Saving Canvas layout…');
    const attempted = await geometry(item);
    await page.getByRole('button', { name: 'Nexus Navigator', exact: true }).click(); await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    assert.deepEqual(await geometry(item), attempted); await expect(page.locator('.canvas-save-status')).toHaveText('Saving Canvas layout…');
    await expect(item.locator('.canvas-resize')).toBeDisabled();
    await page.evaluate(() => { window.__holdCanvasCommit = false; window.__releaseCanvasCommit(); }); await saved(page);
    assert.equal((await readNativeRecord(page, canvasKey)).revision, 1);
    await button.focus(); await page.keyboard.press('ArrowRight'); await saved(page);
    const committed = await readNativeRecord(page, canvasKey); assert.equal(committed.revision, 2);
    assert.equal(committed.nodes[await item.getAttribute('data-node-id')].x, attempted.x + 12);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('Canvas native fullscreen menus and shared folder/session rename remain visible and synchronize existing identities', { timeout: 30_000 }, async () => {
  const { context, page, item, button, errors } = await fixture();
  try {
    await saved(page); const before = await readNativeRecord(page, workspaceKey);
    const folderId = (await item.getAttribute('data-node-id')).slice('domain:'.length);
    await page.getByRole('button', { name: 'Fullscreen Canvas', exact: true }).click();
    await button.click({ button: 'right' }); await expect(page.getByRole('menu', { name: /^Canvas options for / })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const folderDialog = page.getByRole('dialog', { name: 'Rename folder', exact: true }); await expect(folderDialog).toBeVisible();
    await expect(folderDialog.getByRole('textbox', { name: 'Folder name', exact: true })).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.matches('.nexus-canvas') ?? false)).toBe(true);
    await expect(page.locator('.canvas-expanded')).toHaveCount(1);
    assert.equal(await folderDialog.evaluate((dialog) => document.fullscreenElement?.contains(dialog)), true, 'Shared rename was hidden outside native fullscreen.');
    await folderDialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented Canvas folder'); await folderDialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(button).toHaveAttribute('aria-label', 'Open folder Invented Canvas folder'); await expect(page.locator(`.domain-link[data-domain-id="${folderId}"]`)).toContainText('Invented Canvas folder');
    await expect(button).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.matches('.nexus-canvas') ?? false)).toBe(true);
    const sessionItem = page.locator('.canvas-item[data-node-id^="session:"]').first(); const sessionButton = sessionItem.locator('button.canvas-node'); const sessionId = (await sessionItem.getAttribute('data-node-id')).slice('session:'.length);
    await sessionButton.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const sessionDialog = page.getByRole('dialog', { name: 'Rename session', exact: true }); await expect(sessionDialog).toBeVisible(); await expect(sessionDialog.getByRole('textbox', { name: 'Session name', exact: true })).toBeFocused();
    await sessionDialog.getByRole('textbox', { name: 'Session name', exact: true }).fill('Invented Canvas session'); await sessionDialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(sessionButton).toHaveAttribute('aria-label', 'Open session Invented Canvas session'); await expect(page.locator(`.session-link[data-session-id="${sessionId}"]`)).toContainText('Invented Canvas session');
    await expect.poll(async () => (await readNativeRecord(page, workspaceKey)).sessions.find((session) => session.id === sessionId).title).toBe('Invented Canvas session');
    await expect(sessionButton).toBeFocused();
    await expect(page.locator('.canvas-expanded')).toHaveCount(1);
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.matches('.nexus-canvas') ?? false)).toBe(true);
    await sessionButton.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    await sessionDialog.getByRole('textbox', { name: 'Session name', exact: true }).fill('Invented discarded session name');
    await sessionDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(sessionDialog).toHaveCount(0); await expect(sessionButton).toBeFocused();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.matches('.nexus-canvas') ?? false)).toBe(true);
    await expect(sessionButton).toHaveAttribute('aria-label', 'Open session Invented Canvas session');
    const after = await readNativeRecord(page, workspaceKey); assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.drafts, before.drafts); assert.deepEqual(after.sessions.map(({ id, createdAt }) => ({ id, createdAt })), before.sessions.map(({ id, createdAt }) => ({ id, createdAt })));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('fallback maximized Canvas keeps shared rename autofocus, keyboard trap and focus return on cancel', { timeout: 30_000 }, async () => {
  const { context, page, item, errors } = await fixture((context) => context.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new Error('Invented unsupported fullscreen'));
  }));
  try {
    await saved(page);
    const before = await readNativeRecordRaw(page, workspaceKey);
    await page.getByRole('button', { name: 'Fullscreen Canvas', exact: true }).click();
    await expect(page.locator('.canvas-expanded')).toHaveCount(1);
    assert.equal(await page.evaluate(() => document.fullscreenElement), null);
    for (const [node, kind] of [[item, 'folder'], [page.locator('.canvas-item[data-node-id^="session:"]').first(), 'session']]) {
      const opener = node.locator('button.canvas-node');
      await opener.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Rename ${kind}`, exact: true });
      const input = dialog.getByRole('textbox', { name: `${kind === 'folder' ? 'Folder' : 'Session'} name`, exact: true });
      await expect(dialog).toBeVisible(); await expect(input).toBeFocused();
      await expect(page.locator('.canvas-expanded')).toHaveCount(1);
      assert.equal(await dialog.evaluate((element) => element.closest('.canvas-expanded') !== null), true);
      await input.fill(`Invented unsaved ${kind} name`);
      await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await page.keyboard.press('Shift+Tab'); await expect(input).toBeFocused();
      await dialog.getByRole('button', { name: 'Save name', exact: true }).focus();
      await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: `Close rename ${kind}`, exact: true })).toBeFocused();
      if (kind === 'folder') await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
      await expect(page.locator('.canvas-expanded')).toHaveCount(1);
      assert.equal(await readNativeRecordRaw(page, workspaceKey), before, 'Cancel modified shared names or drafts.');
    }
    await page.getByRole('button', { name: 'Exit fullscreen Canvas', exact: true }).click();
    await expect(page.locator('.canvas-expanded')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Fullscreen Canvas', exact: true })).toBeFocused();
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('external native fullscreen exit preserves the open rename editor, typing, keyboard trap and unsaved-name cancellation', { timeout: 30_000 }, async () => {
  const { context, page, item, errors } = await fixture();
  try {
    await saved(page);
    const before = await readNativeRecordRaw(page, workspaceKey);
    for (const [node, kind] of [[item, 'folder'], [page.locator('.canvas-item[data-node-id^="session:"]').first(), 'session']]) {
      const opener = node.locator('button.canvas-node');
      await page.getByRole('button', { name: 'Fullscreen Canvas', exact: true }).click();
      await expect.poll(() => page.evaluate(() => document.fullscreenElement?.matches('.nexus-canvas') ?? false)).toBe(true);
      await opener.click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: `Rename ${kind}`, exact: true });
      const input = dialog.getByRole('textbox', { name: `${kind === 'folder' ? 'Folder' : 'Session'} name`, exact: true });
      await expect(input).toBeFocused();
      const original = await input.inputValue();
      // The OS/browser may leave fullscreen independently of this editor.
      // Do not re-focus the field: subsequent ordinary keystrokes must keep
      // using the open shared form and its existing keyboard trap.
      await page.evaluate(() => document.exitFullscreen());
      await expect(page.locator('.canvas-expanded')).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(input).toBeFocused();
      await page.keyboard.press('End'); await page.keyboard.type(' draft');
      await expect(input).toHaveValue(`${original} draft`); await expect(input).toBeFocused();
      await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: 'Save name', exact: true }).focus();
      await page.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: `Close rename ${kind}`, exact: true })).toBeFocused();
      await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();
      assert.equal(await readNativeRecordRaw(page, workspaceKey), before, 'An external fullscreen exit or Cancel changed shared records.');
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
