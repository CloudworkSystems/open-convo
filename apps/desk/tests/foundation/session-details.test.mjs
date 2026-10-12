import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readNativeRecord, readNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const storageKey = 'true-convo:desk:synthetic:v1';
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
    assert.deepEqual(outside, [], 'Composer requested another origin.');
    assert.deepEqual(privateApi, [], 'Composer requested a private API.');
    assert.deepEqual(errors, [], 'Composer reported browser errors.');
  } };
}

async function enter(page) {
  await page.goto(origin);
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
  const nexus = page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true });
  if (!await nexus.isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await nexus.click();
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}
const stored = (page) => readNativeRecord(page, storageKey);
const bytes = (page) => readNativeRecordRaw(page, storageKey);
const panel = (page) => page.getByRole('complementary', { name: 'Session details', exact: true });
const current = async (page) => { const state = await stored(page); return state.sessions.find((item) => item.id === state.selection.sessionId); };
const selectedSession = (page, id) => page.locator(`.desktop-navigation .session-link[data-session-id="${id}"]`);
const details = (page) => panel(page).locator('details.session-metadata');
const intentInput = (page) => panel(page).getByRole('textbox', { name: 'Session intent', exact: true });
async function saveComplete(page) {
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}
async function openDetails(page) {
  if (!await details(page).evaluate((node) => node.open)) await details(page).locator('summary').click();
}
async function assertActivityScope(page, state, sessionId, goalId) {
  const activity = panel(page).locator('details.session-activity');
  if (!await activity.evaluate((node) => node.open)) await activity.locator('summary').click();
  const expected = state.activity.filter((item) => sessionId ? item.sessionId === sessionId : item.goalId === goalId)
    .sort((first, second) => Date.parse(first.createdAt) - Date.parse(second.createdAt));
  assert.deepEqual(await activity.locator('li').evaluateAll((items) => items.map((item) => item.dataset.activityId)), expected.map((item) => item.id));
  assert.deepEqual(await activity.locator('time').evaluateAll((items) => items.map((item) => item.dateTime)), expected.map((item) => item.createdAt));
}

test('folder context and exact session details synchronize through the folder list, with chronological scoped activity', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = await stored(page);
    const first = await current(page);
    const folder = initial.goals.find((item) => item.id === first.goalId);
    await expect(panel(page).getByText('SESSION FOLDER', { exact: true })).toBeVisible();
    await expect(panel(page).locator('.session-folder-context h2')).toHaveText(folder.title);
    await expect(panel(page).locator('.selected-session-context h3')).toHaveText(first.title);
    await expect(panel(page).locator('.next-step-card, .goal-intro, .goal-panel-note')).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented message in the first session.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await page.getByRole('button', { name: `New session in ${folder.title}`, exact: true }).click();
    const second = await current(page);
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented message in the second session.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await saveComplete(page);
    const withSessions = await stored(page);
    await assertActivityScope(page, withSessions, second.id, folder.id);
    const beforeView = await bytes(page);
    await page.locator(`.desktop-navigation .domain-link[data-domain-id="${folder.id}"]`).click();
    await expect(panel(page).locator('.selected-session-context')).toHaveCount(0);
    await expect(panel(page).getByRole('region', { name: 'Sessions in this folder', exact: true })).toBeVisible();
    assert.deepEqual(await panel(page).locator('[data-details-session-id]').evaluateAll((items) => items.map((item) => item.dataset.detailsSessionId)), [first.id, second.id]);
    await assertActivityScope(page, await stored(page), null, folder.id);
    assert.equal(await bytes(page), beforeView, 'Folder selection should not rewrite workspace records.');
    await panel(page).locator(`[data-details-session-id="${first.id}"]`).click();
    await expect(selectedSession(page, first.id)).toHaveAttribute('aria-current', 'true');
    await expect(panel(page)).toHaveAttribute('data-selected-session-id', first.id);
    await expect(page.locator('.conversation-heading h2')).toHaveText(first.title);
    await assertActivityScope(page, await stored(page), first.id, folder.id);
    assert.equal((await stored(page)).goals.find((item) => item.id === folder.id).nextStep, folder.nextStep);
    assert.equal((await stored(page)).goalDrafts[folder.id].nextStep, initial.goalDrafts[folder.id].nextStep);
    verify();
  } finally { await context.close(); }
});

test('session intent is explicit, has its own durable draft, and retains first and updated history without changing message drafts', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const first = await current(page);
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented separate conversation draft.');
    await expect.poll(async () => (await stored(page)).drafts[first.id]).toBe('Invented separate conversation draft.');
    const beforeOpen = await bytes(page);
    await panel(page).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    await expect(intentInput(page)).toBeFocused();
    await expect(intentInput(page)).toHaveValue('');
    assert.equal(await bytes(page), beforeOpen, 'Opening an untouched intent editor must not create a shared draft or revision.');
    await intentInput(page).fill('First explicit invented intent.');
    await expect.poll(async () => (await current(page)).intentDraft).toBe('First explicit invented intent.');
    assert.equal((await current(page)).intent, undefined);
    assert.equal((await current(page)).intentHistory, undefined);
    await page.reload();
    await expect(intentInput(page)).toHaveValue('First explicit invented intent.');
    await expect(composer).toHaveValue('Invented separate conversation draft.');
    await panel(page).getByRole('button', { name: 'Save session intent', exact: true }).click();
    await expect(intentInput(page)).toHaveCount(0);
    await expect.poll(async () => (await current(page)).intent).toBe('First explicit invented intent.');
    assert.equal((await current(page)).intentHistory.length, 1);
    await panel(page).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    await intentInput(page).fill('Updated explicit invented intent.');
    await panel(page).getByRole('button', { name: 'Save session intent', exact: true }).click();
    await expect.poll(async () => (await current(page)).intentHistory?.length).toBe(2);
    await panel(page).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    await intentInput(page).fill('Invented canceled intent edit.');
    await panel(page).getByRole('region', { name: 'Session intent', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'Edit session intent', exact: true })).toBeFocused();
    await expect.poll(async () => (await current(page)).intentDraft).toBeUndefined();
    await openDetails(page);
    const history = panel(page).getByRole('region', { name: 'Session intent history', exact: true });
    await expect(history).toContainText('First recorded intent');
    assert.deepEqual(await history.locator('li p').allTextContents(), ['First explicit invented intent.', 'Updated explicit invented intent.']);
    await expect(composer).toHaveValue('Invented separate conversation draft.');
    const state = await stored(page);
    assert.equal(state.sessions.find((item) => item.id === first.id).createdAt, first.createdAt);
    assert.equal(state.messages.length, JSON.parse(beforeOpen).messages.length);
    assert.deepEqual(state.workItems, JSON.parse(beforeOpen).workItems);
    verify();
  } finally { await context.close(); }
});

test('Ungrouped sessions use a factual folder and header rename/pin retain stable identity and recorded names', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await stored(page);
    const ungrouped = page.getByRole('complementary', { name: 'Navigation rail', exact: true }).getByRole('region', { name: 'Ungrouped sessions', exact: true });
    await ungrouped.getByRole('button', { name: 'New session', exact: true }).click();
    const session = await current(page);
    assert.equal(session.goalId, null);
    assert.match(session.title, /^\d{6} New conversation$/);
    await expect(panel(page).locator('.session-folder-context h2')).toHaveText('Ungrouped sessions');
    await expect(panel(page).getByRole('region', { name: 'Domain note', exact: true })).toHaveCount(0);
    await expect(panel(page).locator('.session-intent-card')).toContainText('Describe the intent for this session.');
    await expect(panel(page).locator('.session-stable-id')).not.toBeVisible();
    await panel(page).getByRole('button', { name: 'Rename selected session', exact: true }).click();
    const rename = page.getByRole('dialog', { name: 'Rename session', exact: true });
    await rename.getByRole('textbox', { name: 'Session name', exact: true }).fill('Invented editable session alias');
    await rename.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(panel(page).locator('.selected-session-context h3')).toHaveText('Invented editable session alias');
    await panel(page).getByRole('button', { name: 'Pin selected session', exact: true }).click();
    await expect(panel(page).getByRole('button', { name: 'Unpin selected session', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await saveComplete(page);
    await openDetails(page);
    await expect(panel(page).locator('.session-stable-id')).toHaveText(session.id);
    const history = panel(page).getByRole('region', { name: 'Session name history', exact: true });
    assert.deepEqual(await history.locator('li p').allTextContents(), [session.title, 'Invented editable session alias']);
    const after = await stored(page);
    assert.equal(after.sessions.find((item) => item.id === session.id).createdAt, session.createdAt);
    assert.deepEqual(after.goals, before.goals, 'Ungrouped sessions must not create a fake domain record.');
    assert.equal(after.sessions.find((item) => item.id === session.id).intent, undefined);
    assert.deepEqual(after.messages, before.messages);
    await page.reload();
    await expect(panel(page).getByRole('button', { name: 'Unpin selected session', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page).locator('.session-stable-id')).not.toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('untouched intent editors do not lock another tab and read-only recovery prevents submitting stale intent', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await bytes(page);
    const originalSession = await current(page);
    await panel(page).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    assert.equal(await bytes(page), before);
    const renameOrigin = panel(page).getByRole('button', { name: 'Rename selected session', exact: true });
    await renameOrigin.click();
    const rename = page.getByRole('dialog', { name: 'Rename session', exact: true });
    await rename.getByRole('textbox', { name: 'Session name', exact: true }).fill('Invented canceled alias from the stale tab.');
    assert.equal(await bytes(page), before, 'Opening and typing in the local rename dialog must not change shared records.');
    const other = await context.newPage();
    await enter(other);
    await panel(other).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    assert.equal(await bytes(page), before);
    await expect(page.getByRole('alert', { name: 'Save recovery' })).toHaveCount(0);
    await intentInput(other).fill('Invented explicit intent from the other tab.');
    await expect(page.getByRole('alert', { name: 'Save recovery' })).toBeVisible();
    await expect(intentInput(page)).toBeDisabled();
    await expect(renameOrigin).toBeDisabled();
    await expect(rename.getByRole('textbox', { name: 'Session name', exact: true })).toBeDisabled();
    const latest = await bytes(other);
    await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(page.locator('#desk-main')).toBeFocused();
    assert.equal(await bytes(other), latest, 'Canceling after conflict must not save the stale rename or alter the other tab\'s records.');
    assert.equal((await current(other)).title, originalSession.title);
    assert.deepEqual((await current(other)).titleHistory, originalSession.titleHistory);
    await panel(page).locator('.session-intent-card form').evaluate((node) => node.requestSubmit());
    assert.equal(await bytes(other), latest);
    assert.equal((await current(other)).intent, undefined);
    assert.equal((await current(other)).intentHistory, undefined);
    await panel(other).getByRole('button', { name: 'Save session intent', exact: true }).click();
    await expect.poll(async () => (await current(other)).intent).toBe('Invented explicit intent from the other tab.');
    assert.equal((await current(other)).intentHistory.length, 1);
    verify();
  } finally { await context.close(); }
});

test('mobile session details recover a separate intent draft after closing the rail and retain the selected session', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 } });
  try {
    await enter(page);
    const session = await current(page);
    await page.getByRole('button', { name: 'Show session details', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Session details', exact: true });
    await expect(dialog).toBeVisible();
    await panel(page).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    await intentInput(page).fill('Invented recoverable mobile intent draft.');
    await expect.poll(async () => (await current(page)).intentDraft).toBe('Invented recoverable mobile intent draft.');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Show session details', exact: true }).click();
    await expect(intentInput(page)).toHaveValue('Invented recoverable mobile intent draft.');
    await expect(panel(page)).toHaveAttribute('data-selected-session-id', session.id);
    await panel(page).getByRole('button', { name: 'Save session intent', exact: true }).click();
    await expect(intentInput(page)).toHaveCount(0);
    await expect.poll(async () => (await current(page)).intent).toBe('Invented recoverable mobile intent draft.');
    await openDetails(page);
    await expect(panel(page).locator('.session-stable-id')).toHaveText(session.id);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.conversation-heading h2')).toHaveText(session.title);
    assert.equal((await current(page)).createdAt, session.createdAt);
    verify();
  } finally { await context.close(); }
});

test('mobile rename cancellation after conflict restores enabled focus inside the remaining session details dialog', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 } });
  try {
    await enter(page);
    const originalSession = await current(page);
    await page.getByRole('button', { name: 'Show session details', exact: true }).click();
    const parent = page.getByRole('dialog', { name: 'Session details', exact: true });
    const renameOrigin = panel(page).getByRole('button', { name: 'Rename selected session', exact: true });
    await renameOrigin.click();
    const rename = page.getByRole('dialog', { name: 'Rename session', exact: true });
    await rename.getByRole('textbox', { name: 'Session name', exact: true }).fill('Invented canceled mobile alias.');

    const other = await context.newPage();
    await enter(other);
    await other.getByRole('button', { name: 'Show session details', exact: true }).click();
    await panel(other).getByRole('button', { name: 'Edit session intent', exact: true }).click();
    await intentInput(other).fill('Invented durable intent draft from the other mobile tab.');
    await expect(page.getByRole('alert', { name: 'Save recovery' })).toBeVisible();
    await expect(renameOrigin).toBeDisabled();
    await expect(rename.getByRole('textbox', { name: 'Session name', exact: true })).toBeDisabled();
    const latest = await bytes(other);

    await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(rename).toHaveCount(0);
    await expect(parent).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-selected-session-id', originalSession.id);
    await expect.poll(() => parent.evaluate((node) => {
      const active = document.activeElement;
      return Boolean(active && (active === node || node.contains(active))
        && !active.matches(':disabled, [aria-disabled="true"]') && !active.closest('[inert]'));
    })).toBe(true);
    const closeParent = parent.getByRole('button', { name: 'Close session details', exact: true });
    await expect(closeParent).toBeEnabled();
    await page.keyboard.press('Tab');
    await expect(closeParent).toBeFocused();
    assert.equal(await bytes(other), latest, 'Closing the stale child dialog must preserve the other tab\'s workspace and typed draft.');
    assert.equal((await current(other)).title, originalSession.title);
    assert.deepEqual((await current(other)).titleHistory, originalSession.titleHistory);
    await expect(intentInput(other)).toHaveValue('Invented durable intent draft from the other mobile tab.');
    verify();
  } finally { await context.close(); }
});
