import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readRecordRaw, writeNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceKey = 'true-convo:desk:synthetic:v1';
const identityKey = 'true-convo:desk:identity:v1';
const identityDatabase = 'true-convo:desk:identity:records:v1';
const layoutKey = 'true-convo:desk:layout:v1';
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

const bytes = (page, key = workspaceKey) => readRecordRaw(page, key === identityKey ? identityDatabase : key, key);
const stored = async (page) => JSON.parse(await bytes(page));
const rail = (page) => page.getByRole('complementary', { name: 'Navigation rail', exact: true });
const userDialog = (page) => page.getByRole('dialog', { name: 'User options', exact: true });
async function saved(page) {
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}
async function enter(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await saved(page);
}
async function toggleRail(page) {
  const modifier = await page.evaluate(() => /Mac/i.test(navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.press(`${modifier}+Backslash`);
}
async function setRailMode(page, mode) {
  await page.mouse.move(1100, 130);
  await page.evaluate(({ key, mode }) => localStorage.setItem(key, JSON.stringify({ mode, railWidth: 260, inspectorWidth: 294 })), { key: layoutKey, mode });
  await page.reload();
  await page.getByRole('main').focus();
}
async function openUserOptions(page) {
  await page.getByRole('button', { name: 'User options', exact: true }).click();
  await expect(userDialog(page)).toBeVisible();
}

test('one Sessions heading and permanent Ungrouped folder preserve null-linked sessions; Appearance has one entry', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await expect(rail(page).getByRole('heading', { name: 'SESSIONS', exact: true })).toHaveCount(1);
    assert.deepEqual(await rail(page).getByRole('navigation', { name: 'Modules', exact: true }).getByRole('button').allTextContents(), ['Cloudwork Nexus', 'CONTINUITY', 'DATA']);
    const initial = await stored(page);
    const ungrouped = rail(page).getByRole('region', { name: 'Ungrouped sessions', exact: true });
    const folder = ungrouped.getByRole('button', { name: 'Ungrouped sessions', exact: true });
    await expect(folder).toBeVisible();
    assert.equal(await folder.getAttribute('data-domain-id'), null);
    await ungrouped.getByRole('button', { name: 'New session', exact: true }).click();
    await saved(page);
    const created = await stored(page);
    const session = created.sessions.find((item) => item.id === created.selection.sessionId);
    assert.equal(session.goalId, null);
    assert.deepEqual(created.goals, initial.goals);
    const preserved = await bytes(page);
    await ungrouped.getByRole('button', { name: 'Collapse Ungrouped sessions folder', exact: true }).click();
    await expect(ungrouped.getByRole('navigation', { name: 'Ungrouped session list', exact: true })).not.toBeVisible();
    await expect(folder).toBeVisible();
    await ungrouped.getByRole('button', { name: 'Expand Ungrouped sessions folder', exact: true }).click();
    await expect(ungrouped.locator(`[data-session-id="${session.id}"]`)).toBeVisible();
    await folder.click();
    const folderSelection = await page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);
    assert.deepEqual(folderSelection, { goalId: null, sessionId: null, route: 'sessions' });
    assert.equal(await bytes(page), preserved);
    await expect(rail(page).locator('.user-options-row').getByRole('button', { name: 'Appearance options', exact: true })).toHaveCount(1);
    await page.getByRole('button', { name: 'Help and application options', exact: true }).click();
    const help = page.getByRole('dialog', { name: 'Help and application options', exact: true });
    await expect(help.getByRole('radio', { name: /^(Light|Dark|Follow system)$/ })).toHaveCount(0);
    await expect(help).toContainText('Atlas is planned');
    await help.getByRole('button', { name: 'Close options', exact: true }).click();
    await openUserOptions(page);
    await expect(userDialog(page).getByRole('radio', { name: /^(Light|Dark|Follow system)$/ })).toHaveCount(0);
    await userDialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Appearance options', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
    await page.getByRole('button', { name: 'Appearance options', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Appearance options', exact: true }).getByRole('radio', { name: /^(Light|Dark|Follow system)$/ })).toHaveCount(3);
    await page.getByRole('button', { name: 'Close options', exact: true }).click();
    assert.equal(await bytes(page), preserved);
    verify();
  } finally { await context.close(); }
});

test('folder and session creation menus use the right parent and restore keyboard focus in hidden and hover rails', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const state = await stored(page);
    const domain = state.goals.find((item) => item.id === state.selection.goalId);
    const session = state.sessions.find((item) => item.id === state.selection.sessionId);
    const preserved = await bytes(page);
    for (const mode of ['hidden', 'hover']) {
      await setRailMode(page, mode);
      await toggleRail(page);
      const options = rail(page).getByRole('button', { name: `Folder options for ${domain.title}`, exact: true });
      await expect(options).toBeVisible();
      await options.focus();
      await options.press('Shift+F10');
      const create = page.getByRole('menuitem', { name: 'Create folder…', exact: true });
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).press('End');
      await expect(create).toBeFocused();
      await create.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Create folder', exact: true });
      assert.equal(await dialog.evaluate((node) => Boolean(node.closest('.desktop-navigation'))), false);
      await expect(dialog.getByRole('combobox', { name: 'Inside', exact: true })).toHaveValue(domain.id);
      await expect(dialog.getByRole('textbox', { name: 'Folder name', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(options).toBeFocused();
      await expect(options).toBeVisible();
      const sessionButton = rail(page).locator(`[data-session-id="${session.id}"]`);
      await sessionButton.click({ button: 'right' });
      await expect(page.getByRole('menuitem', { name: 'Move to folder…', exact: true })).toBeVisible();
      await page.getByRole('menuitem', { name: 'Create folder…', exact: true }).click();
      await expect(dialog.getByRole('combobox', { name: 'Inside', exact: true })).toHaveValue('');
      await page.keyboard.press('Escape');
      await expect(sessionButton).toBeFocused();
      await expect(sessionButton).toBeVisible();
      assert.equal(await bytes(page), preserved);
    }
    verify();
  } finally { await context.close(); }
});

test('permanent rails keep focus on pointer leave and transient portaled menus hold the rail until dismissal', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const domain = (await stored(page)).goals[0];
    const preserved = await bytes(page);
    for (const mode of ['expanded', 'icons']) {
      await setRailMode(page, mode);
      await rail(page).hover();
      const module = rail(page).getByRole('button', { name: 'DATA', exact: true });
      await module.focus();
      await page.mouse.move(1100, 130);
      await expect(module).toBeFocused();
    }
    for (const mode of ['hidden', 'hover']) {
      await setRailMode(page, mode);
      await toggleRail(page);
      const options = rail(page).getByRole('button', { name: `Folder options for ${domain.title}`, exact: true });
      await options.click();
      const menu = page.getByRole('menu', { name: `Folder options for ${domain.title}`, exact: true });
      const bounds = await rail(page).boundingBox();
      const menuBounds = await menu.boundingBox();
      assert.ok(bounds && menuBounds);
      const outsideRail = Math.max(bounds.x + bounds.width + 12, menuBounds.x + 12);
      assert.ok(outsideRail < menuBounds.x + menuBounds.width - 5, 'The menu has a usable portion outside the rail.');
      await page.mouse.move(outsideRail, menuBounds.y + 20);
      await expect(menu).toBeVisible();
      await expect(options).toBeVisible();
      assert.equal(await rail(page).getAttribute('inert'), null);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(options).toBeFocused();
      await expect(options).toBeVisible();
      await page.mouse.move(1100, 130);
      await expect(options).not.toBeVisible();

      await toggleRail(page);
      await options.focus();
      await options.press('Shift+F10');
      await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
      await expect(options).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(options).toBeFocused();
      await expect(options).toBeVisible();
      await options.press('Shift+F10');
      await expect(menu).toBeVisible();
      await page.getByRole('main').click({ position: { x: 400, y: 30 } });
      await expect(menu).toHaveCount(0);
      await expect(options).not.toBeVisible();
    }
    assert.equal(await bytes(page), preserved);
    verify();
  } finally { await context.close(); }
});

test('Move session opens outside a hidden rail, restores focus and refiles without changing the draft or messages', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const destination = (await stored(page)).selection.goalId;
    await rail(page).getByRole('region', { name: 'Ungrouped sessions', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented message before sidebar refiling.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await composer.fill('Invented unfinished text carried through a lifted Move dialog.');
    await saved(page);
    const before = await stored(page);
    const session = before.sessions.find((item) => item.id === before.selection.sessionId);
    const preserved = await bytes(page);
    await setRailMode(page, 'hidden');
    await toggleRail(page);
    const row = rail(page).locator(`[data-session-id="${session.id}"]`).locator('..');
    const options = row.getByRole('button', { name: `Session options for ${session.title}`, exact: true });
    await expect(options).toBeVisible();
    await options.click();
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Move session', exact: true });
    assert.equal(await dialog.evaluate((node) => Boolean(node.closest('.desktop-navigation, .navigation-drawer'))), false);
    await expect(dialog.getByRole('combobox', { name: 'Move to folder', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(options).toBeFocused();
    await expect(options).toBeVisible();
    assert.equal(await bytes(page), preserved);
    await options.click();
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Move to folder', exact: true }).selectOption(destination);
    await dialog.getByRole('button', { name: 'Move session', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rail(page).locator(`[data-session-id="${session.id}"]`)).toBeFocused();
    await saved(page);
    const filed = await stored(page);
    assert.equal(filed.sessions.find((item) => item.id === session.id).goalId, destination);
    assert.equal(filed.selection.sessionId, session.id);
    assert.equal(filed.selection.goalId, destination);
    assert.deepEqual(filed.messages, before.messages);
    assert.deepEqual(filed.drafts, before.drafts);
    assert.deepEqual(filed.activity.slice(0, before.activity.length), before.activity);
    await page.reload();
    await expect(composer).toHaveValue('Invented unfinished text carried through a lifted Move dialog.');
    verify();
  } finally { await context.close(); }
});

test('moving a nonselected session reveals collapsed destinations and preserves selection without later focus theft', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const selected = initial.sessions.find((item) => item.id === initial.selection.sessionId);
    const parent = initial.goals.find((item) => item.id === selected.goalId);
    await rail(page).getByRole('button', { name: `Folder options for ${parent.title}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Create folder…', exact: true }).click();
    const create = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await create.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented collapsed move destination');
    await create.getByRole('button', { name: 'Create folder', exact: true }).click();
    await saved(page);
    const destination = (await stored(page)).selection.goalId;
    await rail(page).getByRole('button', { name: 'Collapse Invented collapsed move destination folder', exact: true }).click();
    await rail(page).getByRole('region', { name: 'Ungrouped sessions', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented message in the nonselected session.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await composer.fill('Unfinished text preserved while a different session stays selected.');
    await saved(page);
    const before = await stored(page);
    const source = before.sessions.find((item) => item.id === before.selection.sessionId);
    await rail(page).locator(`[data-session-id="${selected.id}"]`).click();
    await rail(page).getByRole('button', { name: `Collapse ${parent.title} folder`, exact: true }).click();
    const selectedView = await page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);
    const sourceRow = rail(page).locator(`[data-session-id="${source.id}"]`);
    const options = sourceRow.locator('..').getByRole('button', { name: `Session options for ${source.title}`, exact: true });
    const dialog = page.getByRole('dialog', { name: 'Move session', exact: true });
    const unchanged = await bytes(page);
    await options.click();
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Move to folder', exact: true }).selectOption(destination);
    await page.keyboard.press('Escape');
    await expect(options).toBeFocused();
    await expect(rail(page).getByRole('button', { name: `Expand ${parent.title} folder`, exact: true })).toBeVisible();
    assert.equal(await bytes(page), unchanged);

    await options.click();
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Move to folder', exact: true }).selectOption(destination);
    await dialog.getByRole('button', { name: 'Move session', exact: true }).click();
    await expect(sourceRow).toBeFocused();
    await expect(sourceRow).toBeVisible();
    await expect(rail(page).getByRole('button', { name: `Collapse ${parent.title} folder`, exact: true })).toBeVisible();
    await expect(rail(page).getByRole('button', { name: 'Collapse Invented collapsed move destination folder', exact: true })).toBeVisible();
    await saved(page);
    const filed = await stored(page);
    assert.equal(filed.sessions.find((item) => item.id === source.id).goalId, destination);
    assert.deepEqual(filed.selection, selectedView);
    assert.deepEqual(filed.messages, before.messages);
    assert.deepEqual(filed.drafts, before.drafts);

    await rail(page).getByRole('button', { name: 'Collapse Ungrouped sessions folder', exact: true }).click();
    await sourceRow.locator('..').getByRole('button', { name: `Session options for ${source.title}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Move to folder', exact: true }).selectOption('');
    await dialog.getByRole('button', { name: 'Move session', exact: true }).click();
    await expect(sourceRow).toBeFocused();
    await expect(rail(page).getByRole('button', { name: 'Collapse Ungrouped sessions folder', exact: true })).toBeVisible();
    await saved(page);
    const ungrouped = await stored(page);
    assert.equal(ungrouped.sessions.find((item) => item.id === source.id).goalId, null);
    assert.deepEqual(ungrouped.selection, selectedView);
    assert.deepEqual(ungrouped.messages, before.messages);
    assert.deepEqual(ungrouped.drafts, before.drafts);
    await composer.fill('The original selected session keeps focus during its next edit.');
    await saved(page);
    await expect(composer).toBeFocused();
    verify();
  } finally { await context.close(); }
});

test('domain and session pins use the same menus and preserve order, relationships and immutable identity on reload', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await stored(page);
    const activeSelection = await page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);
    const domain = before.goals.find((item) => item.id === activeSelection.goalId);
    const session = before.sessions.find((item) => item.id === activeSelection.sessionId);
    const domainRow = rail(page).locator(`[data-domain-id="${domain.id}"]`);
    const sessionRow = rail(page).locator(`[data-session-id="${session.id}"]`);
    const domainPin = rail(page).getByRole('button', { name: `Pin folder ${domain.title}`, exact: true });
    await expect(domainPin).toHaveAttribute('aria-pressed', 'false');
    await expect(domainPin.locator('path[fill="currentColor"]')).toHaveCount(0);
    await domainRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).press('ArrowDown');
    const pin = page.getByRole('menuitem', { name: 'Pin', exact: true });
    await expect(pin).toBeFocused();
    await pin.press('Enter');
    await expect(domainRow).toBeFocused();
    await saved(page);
    const domainUnpin = rail(page).getByRole('button', { name: `Unpin folder ${domain.title}`, exact: true });
    await expect(domainUnpin).toHaveAttribute('aria-pressed', 'true');
    await expect(domainUnpin.locator('path[fill="currentColor"]')).toHaveCount(1);
    await sessionRow.locator('..').getByRole('button', { name: `Session options for ${session.title}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Pin', exact: true }).click();
    await saved(page);
    await page.reload();
    await expect(domainUnpin).toHaveAttribute('aria-pressed', 'true');
    const sessionUnpin = rail(page).getByRole('button', { name: `Unpin session ${session.title}`, exact: true });
    await expect(sessionUnpin).toHaveAttribute('aria-pressed', 'true');
    await expect(sessionUnpin.locator('path[fill="currentColor"]')).toHaveCount(1);
    const pinned = await stored(page);
    assert.equal(pinned.revision, before.revision + 2);
    assert.equal(pinned.goals.find((item) => item.id === domain.id).pinned, true);
    assert.equal(pinned.sessions.find((item) => item.id === session.id).pinned, true);
    assert.deepEqual(pinned.selection, activeSelection);
    assert.deepEqual(pinned.goals.map(({ id, createdAt, parentId }) => ({ id, createdAt, parentId })), before.goals.map(({ id, createdAt, parentId }) => ({ id, createdAt, parentId })));
    assert.deepEqual(pinned.sessions.map(({ id, createdAt, goalId }) => ({ id, createdAt, goalId })), before.sessions.map(({ id, createdAt, goalId }) => ({ id, createdAt, goalId })));
    assert.deepEqual(pinned.drafts, before.drafts);
    assert.deepEqual(pinned.messages, before.messages);
    await sessionUnpin.click();
    await saved(page);
    await domainRow.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Unpin', exact: true }).click();
    await saved(page);
    await expect(domainPin).toHaveAttribute('aria-pressed', 'false');
    await expect(rail(page).getByRole('button', { name: `Pin session ${session.title}`, exact: true })).toHaveAttribute('aria-pressed', 'false');
    const unpinned = await stored(page);
    assert.equal(unpinned.revision, before.revision + 4);
    assert.deepEqual(unpinned.selection, activeSelection);
    verify();
  } finally { await context.close(); }
});

test('new date-prefixed session aliases can be renamed through the sidebar while IDs, creation time and unfinished text stay saved', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await rail(page).getByRole('region', { name: 'Ungrouped sessions', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented draft carried through a session alias change.');
    await saved(page);
    const before = await stored(page);
    const session = before.sessions.find((item) => item.id === before.selection.sessionId);
    const date = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: '2-digit', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date(session.createdAt)).map(({ type, value }) => [type, value]));
    assert.equal(session.title, `${date.year}${date.month}${date.day} New conversation`);
    const row = rail(page).locator(`[data-session-id="${session.id}"]`);
    const options = row.locator('..').getByRole('button', { name: `Session options for ${session.title}`, exact: true });
    const preserved = await bytes(page);
    await options.focus();
    await options.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Rename session', exact: true });
    const name = dialog.getByRole('textbox', { name: 'Session name', exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue(session.title);
    await name.fill('Invented cancelled alias');
    await page.keyboard.press('Escape');
    await expect(options).toBeFocused();
    assert.equal(await bytes(page), preserved);
    await options.click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await name.fill('   ');
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('180');
    assert.equal(await bytes(page), preserved);
    await name.fill('  Invented manually chosen session alias  ');
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(row.locator('..').getByRole('button', { name: 'Session options for Invented manually chosen session alias', exact: true })).toBeFocused();
    await saved(page);
    const after = await stored(page);
    const renamed = after.sessions.find((item) => item.id === session.id);
    assert.equal(renamed.title, 'Invented manually chosen session alias');
    assert.equal(renamed.createdAt, session.createdAt);
    assert.equal(renamed.goalId, session.goalId);
    assert.deepEqual(renamed.titleHistory.map((item) => item.text), [session.title, renamed.title]);
    assert.deepEqual(after.messages, before.messages);
    assert.deepEqual(after.drafts, before.drafts);
    assert.deepEqual(after.selection, before.selection);
    await page.reload();
    await expect(row).toHaveAttribute('aria-label', renamed.title);
    await expect(composer).toHaveValue('Invented draft carried through a session alias change.');
    verify();
  } finally { await context.close(); }
});

test('browser identity names and a valid PNG save and reload independently of workspace bytes', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const preserved = await bytes(page);
    await openUserOptions(page);
    const dialog = userDialog(page);
    await dialog.getByRole('textbox', { name: 'Workspace name', exact: true }).fill('  Invented Studio  ');
    await dialog.getByRole('textbox', { name: 'Display name', exact: true }).fill('  Invented Owner  ');
    await dialog.getByRole('textbox', { name: 'Future session naming guidance', exact: true }).fill('  Keep future names short and mention the main topic.  ');
    await expect(dialog).toContainText('Automatic session naming is planned; this guidance does not rename sessions.');
    await dialog.getByLabel('Workspace image', { exact: true }).setInputFiles({ name: 'unsupported.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
    await expect(dialog.getByRole('status').filter({ hasText: 'Choose a PNG, JPEG or WebP image' })).toBeVisible();
    const png = await readFile(join(root, 'brand/logo.png'));
    await dialog.getByLabel('Workspace image', { exact: true }).setInputFiles({ name: 'invented-brand.png', mimeType: 'image/png', buffer: png });
    await expect(dialog.getByRole('status').filter({ hasText: 'Image ready.' })).toBeVisible();
    await expect(dialog.locator('[data-preview-refresh-hold="browser-identity"]')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Save identity', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Browser identity saved.' })).toBeVisible();
    const identity = JSON.parse(await bytes(page, identityKey));
    assert.equal(identity.brandName, 'Invented Studio');
    assert.equal(identity.displayName, 'Invented Owner');
    assert.equal(identity.sessionNamingGuidance, 'Keep future names short and mention the main topic.');
    assert.equal(identity.brandImage, `data:image/png;base64,${png.toString('base64')}`);
    assert.equal(await bytes(page), preserved);
    await expect(rail(page).locator('.brand-name')).toHaveText('Invented Studio');
    await expect(rail(page).locator('.user-copy strong')).toHaveText('Invented Owner');
    await expect(rail(page).locator('.custom-brand-mark img')).toHaveAttribute('src', identity.brandImage);
    await dialog.getByRole('button', { name: 'Close options', exact: true }).click();
    await page.reload();
    await expect(rail(page).locator('.brand-name')).toHaveText('Invented Studio');
    await expect(rail(page).locator('.user-copy strong')).toHaveText('Invented Owner');
    await expect(rail(page).locator('.custom-brand-mark img')).toHaveAttribute('src', identity.brandImage);
    await openUserOptions(page);
    await expect(userDialog(page).getByRole('textbox', { name: 'Future session naming guidance', exact: true })).toHaveValue(identity.sessionNamingGuidance);
    await userDialog(page).getByRole('button', { name: 'Close options', exact: true }).click();
    assert.equal(await bytes(page), preserved);
    verify();
  } finally { await context.close(); }
});

test('failed identity saves retain editable input and refresh hold; discard and unsupported stored bytes preserve the saved copy', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const preserved = await bytes(page);
    await openUserOptions(page);
    let dialog = userDialog(page);
    await dialog.getByRole('textbox', { name: 'Display name', exact: true }).fill('Previously saved owner');
    await dialog.getByRole('button', { name: 'Save identity', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Browser identity saved.' })).toBeVisible();
    const previousIdentity = await bytes(page, identityKey);
    await dialog.getByRole('button', { name: 'Close options', exact: true }).click();
    await page.evaluate((key) => {
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === key) throw new DOMException('Invented identity-only quota failure', 'QuotaExceededError');
        return original.apply(this, args);
      };
    }, identityDatabase);
    await openUserOptions(page);
    dialog = userDialog(page);
    const displayName = dialog.getByRole('textbox', { name: 'Display name', exact: true });
    await displayName.fill('Unsaved owner kept for recovery');
    await dialog.getByRole('textbox', { name: 'Future session naming guidance', exact: true }).fill('Invented unsaved naming guidance.');
    await dialog.getByRole('button', { name: 'Save identity', exact: true }).click();
    await expect(dialog.getByRole('status').filter({ hasText: 'Display settings could not be saved.' })).toBeVisible();
    await expect(displayName).toBeEnabled();
    await expect(displayName).toHaveValue('Unsaved owner kept for recovery');
    await expect(dialog.getByRole('textbox', { name: 'Future session naming guidance', exact: true })).toHaveValue('Invented unsaved naming guidance.');
    await expect(dialog.locator('[data-preview-refresh-hold="browser-identity"]')).toHaveCount(1);
    assert.equal(await bytes(page, identityKey), previousIdentity);
    assert.equal(await bytes(page), preserved);
    await page.keyboard.press('Escape');
    await expect(dialog.getByRole('alert')).toContainText('Your identity changes are not saved.');
    await dialog.getByRole('button', { name: 'Keep editing', exact: true }).click();
    await expect(displayName).toHaveValue('Unsaved owner kept for recovery');
    await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(rail(page).locator('.user-copy strong')).toHaveText('Previously saved owner');
    assert.equal(await bytes(page, identityKey), previousIdentity);
    const unsupported = JSON.stringify({ version: 2, brandName: 'Unknown future name', displayName: 'Unknown future owner', brandImage: null });
    await writeNativeRecordRaw(page, identityDatabase, unsupported);
    await page.reload();
    await openUserOptions(page);
    dialog = userDialog(page);
    await expect(dialog.getByRole('textbox', { name: 'Workspace name', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('textbox', { name: 'Display name', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('textbox', { name: 'Future session naming guidance', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('button', { name: 'Save identity', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('status').filter({ hasText: 'Their original contents were kept' })).toBeVisible();
    assert.equal(await bytes(page, identityKey), unsupported);
    assert.equal(await bytes(page), preserved);
    verify();
  } finally { await context.close(); }
});
