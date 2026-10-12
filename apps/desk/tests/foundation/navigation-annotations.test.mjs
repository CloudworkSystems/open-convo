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
import { readNativeRecord, readNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const storageKey = 'true-convo:desk:synthetic:v1';
let server;
let browser;
let origin;
let screenshots;
let output = '';
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function cleanup() {
  try {
    await browser?.close();
    browser = undefined;
    if (server) {
      const exited = server.exitCode === null && server.signalCode === null ? once(server, 'exit') : Promise.resolve();
      try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
      if (!await Promise.race([exited.then(() => true), pause(2_000).then(() => false)])) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
        await exited;
      }
    }
    server = undefined;
  } finally {
    // Never delete a caller-selected output folder.
    if (screenshots && !process.env.DESK_SCREENSHOT_DIR) await rm(screenshots, { recursive: true, force: true });
  }
}

before(async () => {
  assert.ok(existsSync(join(root, 'dist/index.html')), 'Run npm run build before browser checks.');
  try {
    screenshots = process.env.DESK_SCREENSHOT_DIR || await mkdtemp(join(tmpdir(), 'true-convo-navigation-browser-'));
    await mkdir(screenshots, { recursive: true });
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
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nexus Navigator', exact: true })).toBeVisible();
  await saved(page);
}
const stored = (page) => readNativeRecord(page, storageKey);
const bytes = (page) => readNativeRecordRaw(page, storageKey);
const tabSelection = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);

async function openRoadmap(page) {
  await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Roadmap', exact: true }).click();
}

test('the four Nexus choices share the main header without a duplicate module title', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const header = page.locator('.desk-header');
    const choices = header.getByRole('navigation', { name: 'Nexus views', exact: true });
    assert.equal(await choices.evaluate((element) => Boolean(element.closest('.desk-heading'))), true);
    await expect(header.locator('h1')).toHaveCount(1);
    await expect(page.getByText("Make room for what's next.", { exact: true })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Session domain', exact: true })).toHaveCount(0);
    await expect(header.getByText('CLOUDWORK NEXUS', { exact: true })).toHaveCount(0);
    await expect(header.locator('.primary-module-heading')).toHaveCount(0);
    for (const name of ['Nexus Navigator', 'Cloudwork Canvas', 'Cloudwork Atlas', 'Roadmap']) {
      const headingBounds = await header.locator('.desk-heading').boundingBox();
      const button = choices.getByRole('button', { name, exact: true });
      const bounds = await button.boundingBox();
      assert.ok(bounds.y >= headingBounds.y, `${name} should stay inside the heading area.`);
      assert.ok(bounds.x >= headingBounds.x && bounds.x + bounds.width <= headingBounds.x + headingBounds.width, `${name} should stay within the left heading area.`);
      await button.click();
      await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
      await expect(button).toHaveAttribute('aria-current', 'page');
    }
    verify();
  } finally { await context.close(); }
});

test('domain context menus validate rename and preserve saved domain relationships and work', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const selectedSession = initial.sessions.find((item) => item.goalId === initial.selection.goalId);
    assert.ok(selectedSession, 'The invented domain must have a saved session to select explicitly.');
    await page.locator(`.domain-link[data-domain-id="${initial.selection.goalId}"]`).click();
    assert.equal((await tabSelection(page)).sessionId, null);
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    await page.locator(`.session-link[data-session-id="${selectedSession.id}"]`).click();
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented draft held through domain rename.');
    await saved(page);
    const before = await stored(page);
    const id = before.selection.goalId;
    const domain = page.locator(`.domain-link[data-domain-id="${id}"]`);
    await domain.click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(domain).toBeFocused();
    assert.deepEqual(await stored(page), before);
    await domain.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename folder', exact: true });
    const input = dialog.getByRole('textbox', { name: 'Folder name', exact: true });
    await expect(input).toBeFocused();
    await input.fill('   ');
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('1 to 180 characters');
    await input.fill('x'.repeat(181));
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    assert.deepEqual(await stored(page), before);
    await input.fill('  Invented renamed domain  ');
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(domain).toHaveAccessibleName('Invented renamed domain');
    await expect(domain).toBeFocused();
    await saved(page);
    const afterRename = await stored(page);
    assert.equal(afterRename.goals.find((goal) => goal.id === id).title, 'Invented renamed domain');
    assert.equal(afterRename.revision, before.revision + 1);
    for (const field of ['sessions', 'messages', 'drafts', 'goalDrafts', 'workItems', 'notes', 'selection']) assert.deepEqual(afterRename[field], before[field]);
    assert.deepEqual(afterRename.goals.map(({ title, updatedAt, ...goal }) => goal), before.goals.map(({ title, updatedAt, ...goal }) => goal));
    assert.deepEqual(afterRename.activity.slice(0, before.activity.length), before.activity);
    await domain.press('ContextMenu');
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(domain).toBeFocused();
    assert.deepEqual(await stored(page), afterRename);
    await page.reload();
    await expect(domain).toHaveAccessibleName('Invented renamed domain');
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented draft held through domain rename.');
    verify();
  } finally { await context.close(); }
});

test('double-clicking folder and session names opens the shared rename dialog and persists the same records', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await stored(page);
    const folder = before.goals.find((item) => item.id === before.selection.goalId);
    const session = before.sessions.find((item) => item.goalId === folder.id);
    assert.ok(session, 'The invented folder must contain a session.');
    const folderButton = page.locator(`.domain-link[data-domain-id="${folder.id}"]`);
    const sessionButton = page.locator(`.session-link[data-session-id="${session.id}"]`);
    await sessionButton.click();
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented draft retained across double-click rename.');
    await saved(page);
    const workBefore = await stored(page);

    await folderButton.locator('span').dblclick();
    const folderDialog = page.getByRole('dialog', { name: 'Rename folder', exact: true });
    const folderName = folderDialog.getByRole('textbox', { name: 'Folder name', exact: true });
    await expect(folderName).toBeFocused();
    await folderName.fill('Invented double-click folder');
    await folderDialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(folderDialog).toHaveCount(0);
    await expect(folderButton).toHaveAccessibleName('Invented double-click folder');
    await expect(folderButton).toBeFocused();

    await sessionButton.locator('span').last().dblclick();
    const sessionDialog = page.getByRole('dialog', { name: 'Rename session', exact: true });
    const sessionName = sessionDialog.getByRole('textbox', { name: 'Session name', exact: true });
    await expect(sessionName).toBeFocused();
    await sessionName.fill('Invented double-click session');
    await sessionDialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(sessionDialog).toHaveCount(0);
    await expect(sessionButton).toHaveAccessibleName('Invented double-click session');
    await expect(sessionButton).toBeFocused();
    await expect(page.locator('#workspace-details')).toContainText('Invented double-click session');
    await saved(page);
    const after = await stored(page);
    assert.equal(after.goals.find((item) => item.id === folder.id).title, 'Invented double-click folder');
    assert.equal(after.sessions.find((item) => item.id === session.id).title, 'Invented double-click session');
    assert.deepEqual(after.goals.map(({ title, updatedAt, ...item }) => item), workBefore.goals.map(({ title, updatedAt, ...item }) => item));
    assert.deepEqual(after.sessions.map(({ title, updatedAt, titleHistory, ...item }) => item), workBefore.sessions.map(({ title, updatedAt, titleHistory, ...item }) => item));
    assert.deepEqual(after.sessions.find((item) => item.id === session.id).titleHistory.map((entry) => entry.text),
      [session.title, 'Invented double-click session'], 'The shared rename must retain both names in the same session history.');
    for (const field of ['messages', 'drafts', 'goalDrafts', 'workItems', 'notes']) assert.deepEqual(after[field], workBefore[field]);
    await page.reload();
    await expect(folderButton).toHaveAccessibleName('Invented double-click folder');
    await expect(sessionButton).toHaveAccessibleName('Invented double-click session');
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented draft retained across double-click rename.');
    await page.locator('.nexus-view-tabs').getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open folder Invented double-click folder', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open session Invented double-click session', exact: true })).toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('an empty domain can be renamed beside its main title with the sidebar hidden', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await creation.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented mind map');
    await creation.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(page.locator('.navigator-empty').getByRole('heading', { name: 'Invented mind map', exact: true })).toBeVisible();
    await saved(page);
    const before = await stored(page);
    const id = before.selection.goalId;
    // A title-area action must not depend on a visible/focusable rail.
    await page.evaluate(() => {
      const key = 'true-convo:desk:layout:v1';
      localStorage.setItem(key, JSON.stringify({ mode: 'hidden', railWidth: 260, inspectorWidth: 294 }));
    });
    await page.reload();
    const rename = page.getByRole('main').getByRole('button', { name: 'Rename folder', exact: true });
    await expect(rename).toBeVisible();
    await expect(page.getByRole('button', { name: 'Folder options for Invented mind map', exact: true })).toHaveCount(0);
    await rename.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Rename folder', exact: true });
    const input = dialog.getByRole('textbox', { name: 'Folder name', exact: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Invented mind map');
    await input.fill('   ');
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('1 to 180 characters');
    assert.deepEqual(await stored(page), before);
    await input.fill('An unsaved name');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(rename).toBeFocused();
    assert.deepEqual(await stored(page), before);
    await rename.click();
    await input.fill('  Invented renamed mind map  ');
    await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(rename).toBeFocused();
    await expect(page.locator('.navigator-empty').getByRole('heading', { name: 'Invented renamed mind map', exact: true })).toBeVisible();
    await saved(page);
    const after = await stored(page);
    assert.equal(after.goals.find((goal) => goal.id === id).title, 'Invented renamed mind map');
    assert.equal(after.revision, before.revision + 1);
    for (const field of ['sessions', 'messages', 'drafts', 'goalDrafts', 'workItems', 'notes', 'selection']) assert.deepEqual(after[field], before[field]);
    assert.deepEqual(after.goals.map(({ title, updatedAt, ...goal }) => goal), before.goals.map(({ title, updatedAt, ...goal }) => goal));
    await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open folder Invented renamed mind map', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Open folder Invented renamed mind map', exact: true }).dblclick();
    await page.reload();
    await expect(page.locator('.navigator-empty').getByRole('heading', { name: 'Invented renamed mind map', exact: true })).toBeVisible();
    // Reveal the same rail and inspect the shared name without selecting or duplicating it.
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator(`.domain-link[data-domain-id="${id}"]`)).toHaveAccessibleName('Invented renamed mind map');
    const options = page.getByRole('button', { name: 'Folder options for Invented renamed mind map', exact: true });
    await options.click();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await expect(input).toBeFocused();
    // The shared dialog lives outside the rail; closing it must reveal its
    // originating rail before returning focus to an otherwise inert button.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(options).toBeFocused();
    await expect(options).toBeVisible();
    assert.deepEqual(await stored(page), after);
    verify();
  } finally { await context.close(); }
});

test('sidebar refiling preserves a session and sidebar selection returns every module and view to Navigator', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const parent = initial.goals.find((goal) => goal.id === initial.selection.goalId);
    await page.getByRole('button', { name: `Folder options for ${parent.title}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Create folder…', exact: true }).click();
    const domainDialog = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await domainDialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented nested session destination');
    await domainDialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await saved(page);
    const targetId = (await stored(page)).selection.goalId;
    await page.getByRole('button', { name: `Collapse ${parent.title} folder`, exact: true }).click();
    await page.getByRole('region', { name: 'Ungrouped sessions', exact: true }).getByRole('button', { name: 'New session', exact: true }).click();
    await saved(page);
    const createdSessionId = (await stored(page)).selection.sessionId;
    assert.ok(createdSessionId, 'Creating a session must select its saved identity.');
    await page.locator(`.session-link[data-session-id="${createdSessionId}"]`).click();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented session message before refiling.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await composer.fill('Invented unfinished draft carried with the session.');
    await saved(page);
    const before = await stored(page);
    const id = before.selection.sessionId;
    const title = before.sessions.find((item) => item.id === id).title;
    assert.match(title, /^\d{6} New conversation$/);
    const session = page.locator(`.session-link[data-session-id="${id}"]`);
    await session.locator('..').getByRole('button', { name: `Session options for ${title}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Move session', exact: true });
    await dialog.getByRole('combobox', { name: 'Move to folder', exact: true }).selectOption(targetId);
    await dialog.getByRole('button', { name: 'Move session', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`.domain-link[data-domain-id="${targetId}"]`)).toBeVisible();
    await expect(session).toBeFocused();
    await saved(page);
    const filed = await stored(page);
    assert.equal(filed.sessions.find((item) => item.id === id).goalId, targetId);
    assert.equal(filed.selection.sessionId, id);
    assert.equal(filed.selection.goalId, targetId);
    assert.deepEqual(filed.messages, before.messages);
    assert.deepEqual(filed.drafts, before.drafts);
    assert.deepEqual(filed.activity.slice(0, before.activity.length), before.activity);
    const preserved = await bytes(page);
    for (const route of ['Roadmap', 'CONTINUITY', 'DATA', 'Cloudwork Canvas', 'Cloudwork Atlas']) {
      if (route === 'Roadmap') await openRoadmap(page);
      else await page.getByRole('button', { name: route, exact: true }).click();
      await session.click();
      await expect(page.getByRole('heading', { name: 'Nexus Navigator', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true })).toHaveAttribute('aria-current', 'page');
      await expect(composer).toHaveValue('Invented unfinished draft carried with the session.');
      assert.equal(await bytes(page), preserved);
    }
    await page.reload();
    await expect(composer).toHaveValue('Invented unfinished draft carried with the session.');
    verify();
  } finally { await context.close(); }
});

test('touch domain options keep rename Escape within the navigation drawer and return focus', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    const options = drawer.getByRole('button', { name: /^Folder options for / }).first();
    await expect(options).toBeVisible();
    await options.tap();
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: 'Rename folder', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Rename folder', exact: true })).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await expect(options).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open navigation', exact: true })).toBeFocused();
    verify();
  } finally { await context.close(); }
});

test('full-height details resize to a browser-sized rail while keeping the middle usable', async (t) => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 1368, height: 858 } });
  try {
    await enter(page);
    const before = await bytes(page);
    const rail = page.getByRole('complementary', { name: 'Navigation rail', exact: true });
    const panel = page.getByRole('complementary', { name: 'Session details', exact: true });
    const left = await rail.boundingBox();
    const right = await panel.boundingBox();
    assert.ok(Math.abs(left.y - right.y) < 1 && Math.abs(left.height - right.height) < 1);
    const header = page.locator('.desk-header');
    await expect(header.getByRole('button', { name: 'Hide session details', exact: true })).toBeVisible();
    await expect(header.locator('.primary-module-heading')).toHaveCount(0);
    assert.ok(await header.getByRole('button', { name: 'Nexus Navigator', exact: true }).evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize)) >= 16);
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    const divider = page.getByRole('separator', { name: 'Session details width', exact: true });
    await divider.press('End');
    await expect.poll(async () => (await panel.boundingBox()).width).toBe(944);
    assert.ok((await page.locator('.desk-main-column').boundingBox()).width >= 360);
    assert.equal(await bytes(page), before);
    await page.reload();
    await expect.poll(async () => (await panel.boundingBox()).width).toBe(944);
    await header.getByRole('button', { name: 'Hide session details', exact: true }).click();
    await expect(panel).not.toBeVisible();
    await header.getByRole('button', { name: 'Show session details', exact: true }).click();
    await expect(panel).toBeVisible();
    await divider.press('Home');
    const capture = join(screenshots, 'annotation13-full-height.png');
    await page.screenshot({ path: capture });
    if (process.env.DESK_SCREENSHOT_DIR) t.diagnostic(`Full-height rail screenshot: ${capture}`);
    verify();
  } finally { await context.close(); }
});

test('domain note edits recover after navigation and reload without changing session work', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    await page.locator(`.domain-link[data-domain-id="${initial.selection.goalId}"]`).click();
    assert.equal((await tabSelection(page)).sessionId, null);
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    const before = await stored(page);
    const id = before.selection.goalId;
    const domain = page.locator(`.domain-link[data-domain-id="${id}"]`);
    await domain.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Edit folder note…', exact: true }).click();
    const note = page.getByRole('textbox', { name: 'Domain note', exact: true });
    await expect(note).toBeFocused();
    await note.fill('Collect related invented ideas and refine their shared purpose later.');
    await saved(page);
    await openRoadmap(page);
    await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    await expect(note).toHaveValue('Collect related invented ideas and refine their shared purpose later.');
    await page.reload();
    await expect(note).toHaveValue('Collect related invented ideas and refine their shared purpose later.');
    await page.getByRole('button', { name: 'Save domain note', exact: true }).click();
    await saved(page);
    await expect(note).not.toBeVisible();
    const after = await stored(page);
    assert.equal((await tabSelection(page)).sessionId, null);
    assert.equal(after.goals.find((goal) => goal.id === id).purpose, 'Collect related invented ideas and refine their shared purpose later.');
    for (const key of ['sessions', 'messages', 'drafts', 'workItems', 'notes']) assert.deepEqual(after[key], before[key]);
    await page.getByRole('button', { name: 'Edit domain note', exact: true }).click();
    await note.fill('An invented edit that will be cancelled.');
    await page.getByRole('region', { name: 'Domain note', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal((await stored(page)).goals.find((goal) => goal.id === id).purpose, after.goals.find((goal) => goal.id === id).purpose);
    await page.reload();
    await expect(note).not.toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('mobile domain notes retain keyboard focus inside details after Save and Cancel', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await drawer.getByRole('button', { name: /^Folder options for / }).first().click();
    await page.getByRole('menuitem', { name: 'Edit folder note…', exact: true }).click();
    assert.equal((await tabSelection(page)).sessionId, null);
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    const details = page.getByRole('dialog', { name: 'Session details', exact: true });
    const note = details.getByRole('textbox', { name: 'Domain note', exact: true });
    await expect(note).toBeFocused();
    await note.fill('An invented mobile grouping note.');
    await details.getByRole('button', { name: 'Save domain note', exact: true }).click();
    const edit = details.getByRole('button', { name: 'Edit domain note', exact: true });
    await expect(edit).toBeFocused();
    await edit.click();
    await note.fill('An invented edit to discard.');
    await details.getByRole('region', { name: 'Domain note', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(edit).toBeFocused();
    await expect(details.getByText('An invented mobile grouping note.', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(details).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Show session details', exact: true })).toBeFocused();
    verify();
  } finally { await context.close(); }
});

test('the eight recovered primitives are visible as availability, with no active execution controls', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await bytes(page);
    const trigger = page.getByRole('button', { name: 'Work primitives', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'NEXUS work primitives', exact: true });
    const list = dialog.getByRole('list', { name: 'Eight planned work types', exact: true });
    await expect(list.getByRole('listitem')).toHaveCount(8);
    for (const name of ['Plan', 'Build', 'Research', 'Investigate', 'Remember', 'Delegate', 'Review', 'Publish']) {
      await expect(list.getByRole('heading', { name, exact: true })).toBeVisible();
    }
    await expect(list.getByText('Planned · not connected', { exact: true })).toHaveCount(8);
    await expect(dialog.getByRole('heading', { name: 'Classify connects the steps', exact: true })).toBeVisible();
    assert.equal(await bytes(page), before);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await dialog.getByRole('button', { name: 'Open ROADMAP', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
    const after = await stored(page);
    const original = JSON.parse(before);
    for (const key of ['goals', 'sessions', 'messages', 'drafts', 'goalDrafts']) assert.deepEqual(after[key], original[key]);
    verify();
  } finally { await context.close(); }
});
