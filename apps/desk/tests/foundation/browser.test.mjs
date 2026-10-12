import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { installNativeWriteFailure, readNativeRecord, readNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const storageKey = 'true-convo:desk:synthetic:v1';
const tabViewKey = 'true-convo:desk:synthetic:tab-view:v1';
let server;
let browser;
let origin;
let screenshots;
let serverOutput = '';

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function openManualWork(page) {
  await expect(page.locator('.roadmap-create')).toBeVisible();
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
  return port;
}

async function cleanup() {
  try {
    await browser?.close();
  } finally {
    browser = undefined;
    if (server) {
      const running = server.exitCode === null && server.signalCode === null;
      const exited = running ? once(server, 'exit') : Promise.resolve();
      // Kill the detached group even if npm exited first, so no preview child
      // can outlive this test session.
      try { process.kill(-server.pid, 'SIGTERM'); } catch { if (running) server.kill('SIGTERM'); }
      if (await Promise.race([exited.then(() => true), pause(2_000).then(() => false)]) === false) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
        await exited;
      }
    }
    server = undefined;
  }
}

before(async () => {
  assert.ok(existsSync(join(root, 'dist/index.html')), 'Run npm run build before browser checks.');
  try {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    screenshots = process.env.DESK_SCREENSHOT_DIR || await mkdtemp(join(tmpdir(), 'true-convo-d1-browser-'));
    await mkdir(screenshots, { recursive: true });
    server = spawn('npm', ['run', 'start', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream.on('data', (part) => { serverOutput = (serverOutput + part).slice(-12_000); });
    }
    let available = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Preview server exited: ${serverOutput}`);
      try { if ((await fetch(origin)).ok) { available = true; break; } } catch { /* startup */ }
      await pause(100);
    }
    assert.ok(available, `Preview server did not become ready: ${serverOutput}`);
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
  const blocked = [];
  const api = [];
  const errors = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { blocked.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) api.push(url.pathname);
    return route.continue();
  });
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') {
        // Keep the CSP cause readable without dumping an embedded font payload.
        errors.push(message.text().replace(/data:[^'"\s)]+/g, 'data:[embedded asset omitted]'));
      }
    });
  });
  const page = await context.newPage();
  return {
    context, page, errors,
    verify: () => {
      assert.deepEqual(blocked, [], 'Foundation attempted an outside-origin request.');
      assert.deepEqual(api, [], 'Synthetic foundation attempted a legacy/private API request.');
      assert.deepEqual(errors, [], 'Browser reported an application or CSP error.');
    },
  };
}

function selectedDomain(page) {
  return page.getByRole('navigation', { name: 'Session folders', exact: true }).locator('.domain-link[aria-current="true"]');
}
function domainPicker(page) {
  return {
    inputValue: () => selectedDomain(page).getAttribute('data-domain-id'),
    selectOption: (id) => page.locator(`.domain-link[data-domain-id="${id}"]`).click(),
  };
}
function currentDomainSessions(page) {
  return page.getByRole('navigation', { name: 'Session folders', exact: true }).locator('.domain-row.selected + .domain-contents');
}
async function selectedSessionId(page) {
  const id = await page.locator('.session-link[aria-current="true"]').getAttribute('data-session-id');
  assert.ok(id, 'The selected session must expose its saved identity.');
  return id;
}
function sessionLink(page, id) {
  return page.locator(`.session-link[data-session-id="${id}"]`);
}
async function createSessionInSelectedDomain(page) {
  const title = await selectedDomain(page).textContent();
  await page.getByRole('button', { name: `New session in ${title}`, exact: true }).click();
}
async function setAppearance(page, theme) {
  await page.getByRole('button', { name: 'Appearance options', exact: true }).click();
  await page.getByRole('dialog', { name: 'Appearance options', exact: true }).getByRole('radio', { name: theme === 'light' ? 'Light' : theme === 'dark' ? 'Dark' : 'Follow system', exact: true }).check();
  await page.getByRole('button', { name: 'Close options', exact: true }).click();
}

async function enterDesk(page) {
  await page.goto(origin);
  await expect(page.getByText('Sample preview · sample data only', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
}

async function openRoadmap(page) {
  await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Roadmap', exact: true }).click();
}

test('normal preview keeps the source CSP and blocks an injected inline stylesheet', async () => {
  const { context, page, errors, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const sourceHtml = await readFile(join(root, 'index.html'), 'utf8');
    const sourcePolicies = [...sourceHtml.matchAll(/http-equiv="Content-Security-Policy" content="([^"]+)"/g)];
    assert.equal(sourcePolicies.length, 1, 'The source entry must have exactly one CSP.');
    const policy = sourcePolicies[0][1];
    const meta = page.locator('meta[http-equiv="Content-Security-Policy"]');
    assert.equal(await meta.count(), 1, 'The normal preview must have exactly one CSP.');
    assert.equal(await meta.getAttribute('content'), policy, 'The normal build changed the source CSP.');
    verify();

    const result = await page.evaluate(async () => {
      const target = document.createElement('div');
      target.id = 'desk-policy-style-canary';
      const style = document.createElement('style');
      style.textContent = '#desk-policy-style-canary { --desk-inline-style-canary: applied; }';
      let listener;
      let timer;
      const violation = new Promise((resolve) => {
        listener = (event) => resolve({
          effectiveDirective: event.effectiveDirective,
          blockedURI: event.blockedURI,
          disposition: event.disposition,
          originalPolicy: event.originalPolicy,
        });
        document.addEventListener('securitypolicyviolation', listener, { once: true });
        timer = setTimeout(() => resolve(null), 2_000);
      });
      try {
        document.body.append(target);
        document.head.append(style);
        return {
          violation: await violation,
          applied: getComputedStyle(target).getPropertyValue('--desk-inline-style-canary').trim(),
        };
      } finally {
        clearTimeout(timer);
        document.removeEventListener('securitypolicyviolation', listener);
        style.remove();
        target.remove();
      }
    });
    assert.equal(result.applied, '', 'An untrusted inline stylesheet changed the normal preview.');
    assert.deepEqual(result.violation, {
      effectiveDirective: 'style-src-elem', blockedURI: 'inline', disposition: 'enforce', originalPolicy: policy,
    }, 'The injected stylesheet did not produce the expected enforced CSP violation.');
    await expect.poll(() => errors.length).toBe(1);
    assert.match(errors[0], /^(?:Applying inline style violates|Refused to apply inline style because it violates) the following Content Security Policy directive/);
    assert.ok(errors[0].includes("style-src 'self'"), 'The console violation named an unexpected policy.');
    // Consume only this proved, deliberate violation. Outside requests, API
    // access and every other application/CSP error retain the usual checks.
    errors.shift();
    verify();
  } finally { await context.close(); }
});

test('desktop foundation creates goals, preserves drafts and keeps demo messages with their session', async (t) => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    await expect(page.getByText('Demo replies · no model connected', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create folder' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Make one useful sample worksheet');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await page.getByRole('main').getByRole('button', { name: 'New session', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(selectedDomain(page)).toHaveText('Make one useful sample worksheet');
    await page.getByRole('button', { name: 'Edit domain note', exact: true }).click();
    await page.getByRole('textbox', { name: 'Domain note', exact: true }).fill('Collect three clear questions for the sample worksheet.');
    await page.getByRole('button', { name: 'Save domain note', exact: true }).click();
    await expect(page.getByText('Collect three clear questions for the sample worksheet.', { exact: true })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented draft retained across a reload.');
    await expect.poll(async () => readNativeRecord(page, storageKey).then((state) => {
      return state?.drafts[state.selection.sessionId];
    })).toBe('Invented draft retained across a reload.');
    await page.reload();
    await expect(composer).toHaveValue('Invented draft retained across a reload.');
    await expect(selectedDomain(page)).toHaveText('Make one useful sample worksheet');
    const sourceSessionId = await readNativeRecord(page, storageKey).then((state) => state.selection.sessionId);
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await expect(composer).toHaveValue('');
    await expect(page.getByText(/Simulated reply — no model call\./)).toBeVisible();
    await createSessionInSelectedDomain(page);
    await expect(composer).toHaveValue('');
    await expect(page.getByText(/Your draft was: Invented draft retained/)).not.toBeVisible();
    await expect.poll(async () => readNativeRecord(page, storageKey).then((state) => state.messages
      .filter((message) => message.body.includes('Invented draft retained')).map((message) => ({
        origin: message.sessionId === sourceSessionId, role: message.role, provenance: message.provenance,
      })))).toEqual([
      { origin: true, role: 'user', provenance: 'simulation' },
      { origin: true, role: 'assistant', provenance: 'simulation' },
    ]);
    await sessionLink(page, sourceSessionId).click();
    await expect(page.getByText(/Your draft was: Invented draft retained/)).toBeVisible();
    await openRoadmap(page);
    await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
    await openManualWork(page);
    await page.getByRole('textbox', { name: 'Card title', exact: true }).fill('Invented worksheet draft');
    await page.getByRole('button', { name: 'Create card', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Invented worksheet draft', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    await page.reload();
    await openManualWork(page);
    await expect(page.getByRole('button', { name: 'Open Invented worksheet draft', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Memories', exact: true })).toBeVisible();
    await expect(page.getByText('Invented-data preview · unencrypted browser storage. No AI memory or learning is connected.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'DATA', exact: true }).click();
    await expect(page.getByRole('main')).toContainText('no encryption or lock');
    await expect(page.getByRole('button', { name: /Lock workspace/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Encrypted transfer/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Manage Trash/ })).toBeDisabled();
    await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(screenshots, 'desktop.png'), fullPage: true });
    verify();
    t.diagnostic(`Screenshots: ${screenshots}`);
  } finally { await context.close(); }
});

test('mobile navigation is keyboard operable and the conversation fits the viewport', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(origin);
    const open = page.getByRole('button', { name: 'Open navigation', exact: true });
    await open.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('navigation', { name: 'Session folders', exact: true })).toBeVisible();
    await drawer.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
    await expect(drawer).not.toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Your message' })).toBeVisible();
    await open.click();
    await expect(drawer).toBeVisible();
    for (let i = 0; i < 16; i += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await drawer.evaluate((node) => node.contains(document.activeElement)), true, 'Focus escaped mobile navigation.');
    }
    await page.keyboard.press('Escape');
    await expect(drawer).not.toBeVisible();
    await expect(open).toBeFocused();
    const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    assert.ok(sizes.scroll <= sizes.width, `Horizontal overflow: ${sizes.scroll} > ${sizes.width}`);
    await page.getByRole('textbox', { name: 'Your message' }).fill('Mobile invented message.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await expect(page.getByText(/Simulated reply — no model call\./)).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(screenshots, 'mobile.png'), fullPage: true });
    verify();
  } finally { await context.close(); }
});

test('theme, reduced motion and keyboard entry remain usable', async () => {
  const { context, page, verify } = await isolatedPage({ colorScheme: 'dark', reducedMotion: 'reduce' });
  try {
    await enterDesk(page);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(screenshots, 'dark.png'), fullPage: true });
    await setAppearance(page, 'light');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    await page.screenshot({ path: join(screenshots, 'light.png'), fullPage: true });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await setAppearance(page, 'dark');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    const transitionDurations = await page.getByRole('button', { name: 'Create folder', exact: true }).evaluate((node) => getComputedStyle(node).transitionDuration);
    assert.ok(transitionDurations.split(',').every((duration) => Number.parseFloat(duration) <= 0.02), 'Reduced-motion actions retain a long transition.');
    await page.goto(origin);
    const skip = page.getByRole('link', { name: /Skip/ });
    await expect(skip).toBeAttached();
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('main').evaluate((node) => node === document.activeElement || node.contains(document.activeElement)), true);
    verify();
  } finally { await context.close(); }
});

test('corrupt sample storage opens recovery without overwriting or displaying its raw contents', async () => {
  const { context, page, verify } = await isolatedPage();
  const damaged = '{"schemaVersion":1,"broken":"invented-record-do-not-render"}';
  try {
    await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: storageKey, value: damaged });
    await page.goto(origin);
    await expect(page.getByRole('heading', { name: 'Workspace needs recovery', exact: true })).toBeVisible();
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), damaged);
    assert.equal(await readNativeRecordRaw(page, storageKey), null, 'Damaged legacy bytes must not become a native record.');
    await expect(page.locator('body')).not.toContainText('invented-record-do-not-render');
    await expect(page.getByRole('textbox', { name: 'Your message' })).not.toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('a failed sample save retains the attempted draft and can retry without a false saved claim', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await installNativeWriteFailure(context, storageKey);
    await enterDesk(page);
    const legacyBytes = await page.evaluate((key) => localStorage.getItem(key), storageKey);
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Last successfully saved sample draft.');
    await expect.poll(async () => readNativeRecord(page, storageKey).then((state) => {
      return state.drafts[state.selection.sessionId];
    })).toBe('Last successfully saved sample draft.');
    await page.evaluate(() => { window.__deskFailWrites = true; });
    await composer.fill('Keep this failed-save attempt visible.');
    const recovery = page.getByRole('alert', { name: 'Save recovery' });
    await expect(recovery).toBeVisible();
    await expect(composer).toHaveValue('Keep this failed-save attempt visible.');
    assert.equal(await readNativeRecord(page, storageKey).then((state) => {
      return state.drafts[state.selection.sessionId];
    }), 'Last successfully saved sample draft.');
    await expect(recovery.getByRole('button', { name: 'Download sample work', exact: true })).toBeVisible();
    await page.evaluate(() => { window.__deskFailWrites = false; });
    await recovery.getByRole('button', { name: 'Retry save', exact: true }).evaluate((node) => {
      node.click();
      node.click();
    });
    await expect(recovery).not.toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    await page.reload();
    await expect(composer).toHaveValue('Keep this failed-save attempt visible.');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), storageKey), legacyBytes, 'Native saves and retries must preserve the legacy recovery input.');
    verify();
  } finally { await context.close(); }
});

test('domain-scoped Work and intent drafts survive switches, panel changes and reload', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const goals = domainPicker(page);
    const firstGoal = await goals.inputValue();
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create folder' });
    await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Second invented goal');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await page.getByRole('main').getByRole('button', { name: 'New session', exact: true }).click();
    const secondGoal = await goals.inputValue();
    await goals.selectOption(firstGoal);
    await openRoadmap(page);
    await openManualWork(page);
    const work = page.getByRole('textbox', { name: 'Card title', exact: true });
    await work.fill('Work belonging to the first goal');
    await goals.selectOption(secondGoal);
    await expect(work).toHaveValue('');
    await work.fill('Unsubmitted work for the second goal');
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await openRoadmap(page);
    await openManualWork(page);
    await expect(work).toHaveValue('Unsubmitted work for the second goal');
    await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    await page.reload();
    await openManualWork(page);
    await expect(work).toHaveValue('Unsubmitted work for the second goal');
    await goals.selectOption(firstGoal);
    await expect(work).toHaveValue('Work belonging to the first goal');
    await page.getByRole('button', { name: 'Create card', exact: true }).click();
    await expect(work).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Open Work belonging to the first goal', exact: true })).toBeVisible();
    await expect.poll(async () => (await readNativeRecord(page, storageKey)).workItems
      .filter((item) => item.title === 'Work belonging to the first goal')
      .map((item) => item.goalId)).toEqual([firstGoal]);
    const createdWork = (await readNativeRecord(page, storageKey)).workItems
      .find((item) => item.title === 'Work belonging to the first goal');
    await goals.selectOption(secondGoal);
    await expect(work).toHaveValue('Unsubmitted work for the second goal');
    await expect(page.getByRole('button', { name: 'Open Work belonging to the first goal', exact: true })).toBeVisible();
    assert.deepEqual((await readNativeRecord(page, storageKey)).workItems
      .find((item) => item.id === createdWork.id), createdWork, 'The shared board preserves the original folder ownership and work identity.');
    await goals.selectOption(firstGoal);
    await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    await expect(page.locator('.session-link[aria-current="true"]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit domain note', exact: true }).click();
    const intent = page.getByRole('textbox', { name: 'Domain note', exact: true });
    await intent.fill('Unsubmitted grouping intent for the first domain.');
    await page.getByRole('button', { name: 'Hide session details', exact: true }).click();
    await page.getByRole('button', { name: 'Show session details', exact: true }).click();
    await expect(intent).toHaveValue('Unsubmitted grouping intent for the first domain.');
    await openRoadmap(page);
    await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    await expect(intent).toHaveValue('Unsubmitted grouping intent for the first domain.');
    await goals.selectOption(secondGoal);
    await expect(intent).not.toBeVisible();
    await goals.selectOption(firstGoal);
    await expect(intent).toHaveValue('Unsubmitted grouping intent for the first domain.');
    await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    await page.reload();
    await expect(intent).toHaveValue('Unsubmitted grouping intent for the first domain.');
    await page.getByRole('button', { name: 'Save domain note', exact: true }).click();
    await expect(intent).not.toBeVisible();
    await expect(page.getByText('Unsubmitted grouping intent for the first domain.', { exact: true })).toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('per-tab navigation, appearance and selection preserve shared work and each tab view', async () => {
  const { context, page, verify } = await isolatedPage({ colorScheme: 'dark' });
  try {
    await enterDesk(page);
    const firstGoal = await domainPicker(page).inputValue();
    await createSessionInSelectedDomain(page);
    const firstGoalSessionId = await selectedSessionId(page);
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create folder' });
    await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Another invented goal for separate views');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await page.getByRole('main').getByRole('button', { name: 'New session', exact: true }).click();
    const secondGoal = await domainPicker(page).inputValue();
    const secondGoalInitialSessionId = await selectedSessionId(page);
    await createSessionInSelectedDomain(page);
    const secondGoalNewSessionId = await selectedSessionId(page);
    await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    const sharedBytes = await readNativeRecordRaw(page, storageKey);
    assert.ok(sharedBytes, 'The fixture must be saved before opening the other tab.');

    const other = await context.newPage();
    await enterDesk(other);
    const assertViewsOnly = async () => {
      for (const tab of [page, other]) {
        assert.equal(await readNativeRecordRaw(tab, storageKey), sharedBytes,
          'A view-only command changed the shared workspace bytes.');
        await expect(tab.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
        await expect(tab.getByRole('button', { name: 'Create folder', exact: true })).toBeEnabled();
      }
    };
    await assertViewsOnly();

    // Both tabs exercise all four view commands. Their routes, themes, goals
    // and sessions remain independent, while the shared content is untouched.
    await domainPicker(page).selectOption(firstGoal);
    await assertViewsOnly();
    await expect(page.locator('.session-link[aria-current="true"]')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    await sessionLink(page, firstGoalSessionId).click();
    await assertViewsOnly();
    await setAppearance(page, 'light');
    await assertViewsOnly();
    await openRoadmap(page);
    await assertViewsOnly();

    await domainPicker(other).selectOption(firstGoal);
    await domainPicker(other).selectOption(secondGoal);
    await assertViewsOnly();
    await expect(other.locator('.session-link[aria-current="true"]')).toHaveCount(0);
    await expect(other.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    await sessionLink(other, secondGoalNewSessionId).click();
    await sessionLink(other, secondGoalInitialSessionId).click();
    await assertViewsOnly();
    await setAppearance(other, 'light');
    await setAppearance(other, 'dark');
    await assertViewsOnly();
    await other.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await assertViewsOnly();

    await page.reload();
    await other.reload();
    await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
    await expect(other.getByRole('heading', { name: 'Memories', exact: true })).toBeVisible();
    assert.equal(await domainPicker(page).inputValue(), firstGoal);
    assert.equal(await domainPicker(other).inputValue(), secondGoal);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(other.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(sessionLink(page, firstGoalSessionId)).toHaveAttribute('aria-current', 'true');
    await expect(sessionLink(other, secondGoalInitialSessionId)).toHaveAttribute('aria-current', 'true');
    await assertViewsOnly();

    // View changes must not strand the other tab. A genuine edit still saves
    // to its chosen session and produces the usual conflict in the stale tab.
    await other.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
    const composer = other.getByRole('textbox', { name: 'Your message', exact: true });
    await expect(composer).toBeEnabled();
    await composer.fill('Invented edit after both tabs changed their views.');
    await expect(other.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    await expect.poll(() => readNativeRecord(other, storageKey).then((state) => state.drafts[secondGoalInitialSessionId])).toBe('Invented edit after both tabs changed their views.');
    await expect(page.getByRole('alert', { name: 'Save recovery' })).toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('opening and cancelling an untouched domain-intent editor leaves other tabs editable while real typing conflicts', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const sharedBytes = await readNativeRecordRaw(page, storageKey);
    const revision = JSON.parse(sharedBytes).revision;
    const other = await context.newPage();
    await enterDesk(other);
    const assertUntouched = async () => {
      assert.equal(await readNativeRecordRaw(page, storageKey), sharedBytes);
      assert.equal(await readNativeRecord(other, storageKey).then((state) => state.revision), revision);
      await expect(other.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
      await expect(other.getByRole('textbox', { name: 'Your message', exact: true })).toBeEnabled();
      await expect(other.getByRole('button', { name: 'Create folder', exact: true })).toBeEnabled();
    };
    await page.getByRole('button', { name: 'Edit domain note', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Domain note', exact: true })).toBeVisible();
    await assertUntouched();
    await page.getByRole('region', { name: 'Domain note', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Domain note', exact: true })).not.toBeVisible();
    await assertUntouched();
    await page.getByRole('button', { name: 'Edit domain note', exact: true }).click();
    await page.getByRole('button', { name: 'Save domain note', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Domain note', exact: true })).not.toBeVisible();
    await assertUntouched();
    await page.getByRole('button', { name: 'Edit domain note', exact: true }).click();
    await page.getByRole('textbox', { name: 'Domain note', exact: true }).fill('An edited sample grouping intent.');
    await expect.poll(() => readNativeRecord(page, storageKey).then((state) => {
      return state.goalDrafts[state.selection.goalId].purpose;
    })).toBe('An edited sample grouping intent.');
    const editedState = await readNativeRecord(page, storageKey);
    const originalState = JSON.parse(sharedBytes);
    for (const field of ['goals', 'sessions', 'messages', 'drafts', 'workItems', 'notes']) {
      assert.deepEqual(editedState[field], originalState[field], `Typing an intent draft changed unrelated ${field}.`);
    }
    await expect(other.getByRole('alert', { name: 'Save recovery' })).toBeVisible();
    await expect(other.getByRole('textbox', { name: 'Your message', exact: true })).toBeDisabled();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Domain note', exact: true })).toHaveValue('An edited sample grouping intent.');
    verify();
  } finally { await context.close(); }
});

test('blocked tab-view storage warns about screen resets while shared drafts keep saving', async () => {
  const { context, page, verify } = await isolatedPage({ colorScheme: 'dark' });
  try {
    await context.addInitScript((key) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name, value) {
        if (this === window.sessionStorage && name === key) {
          throw new DOMException('Invented blocked tab storage', 'QuotaExceededError');
        }
        return setItem.call(this, name, value);
      };
    }, tabViewKey);
    await enterDesk(page);
    const warning = page.getByRole('status').filter({
      hasText: 'This tab’s screen and theme may reset on reload. Work saving is handled separately; check the save status.',
    });
    await expect(warning).toBeVisible();
    const sharedBytes = await readNativeRecordRaw(page, storageKey);
    await setAppearance(page, 'light');
    await openRoadmap(page);
    await expect(page.getByRole('heading', { name: 'Roadmap', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    assert.equal(await readNativeRecordRaw(page, storageKey), sharedBytes);
    await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented work retained despite blocked tab-view storage.');
    await expect.poll(() => readNativeRecord(page, storageKey).then((state) => {
      return state.drafts[state.selection.sessionId];
    })).toBe('Invented work retained despite blocked tab-view storage.');
    await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
    await expect(warning).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
    await expect(composer).toHaveValue('Invented work retained despite blocked tab-view storage.');
    await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('another tab changing the workspace pauses stale edits until the saved copy is reloaded', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Sample draft before another tab changes it.');
    await expect.poll(async () => readNativeRecord(page, storageKey).then((state) => {
      return state.drafts[state.selection.sessionId];
    })).toBe('Sample draft before another tab changes it.');
    const other = await context.newPage();
    await enterDesk(other);
    await expect(other.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Sample draft before another tab changes it.');
    await composer.fill('Newer saved draft from the first tab.');
    const recovery = other.getByRole('alert', { name: 'Save recovery' });
    await expect(recovery).toBeVisible();
    await expect(other.getByRole('button', { name: 'Send demo message', exact: true })).toBeDisabled();
    other.once('dialog', (dialog) => void dialog.accept());
    await recovery.getByRole('button', { name: 'Reload saved copy', exact: true }).click();
    await expect(recovery).not.toBeVisible();
    await expect(other.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Newer saved draft from the first tab.');
    assert.equal(await readNativeRecord(other, storageKey).then((state) => {
      return state.drafts[state.selection.sessionId];
    }), 'Newer saved draft from the first tab.');
    verify();
  } finally { await context.close(); }
});

test('rail modes, drag snapping and keyboard resizing persist without changing saved conversations', async (t) => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented draft held across navigation layout changes.');
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    const bytes = await readNativeRecordRaw(page, storageKey);
    const rail = page.getByRole('complementary', { name: 'Navigation rail', exact: true });
    await expect.poll(async () => (await rail.boundingBox()).width).toBe(260);
    const openIcon = await page.getByRole('button', { name: 'Collapse navigation', exact: true }).innerHTML();
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    await expect.poll(async () => (await rail.boundingBox()).width).toBe(64);
    await expect(page.getByRole('button', { name: 'Expand navigation', exact: true })).toHaveAttribute('aria-expanded', 'false');
    assert.notEqual(await page.getByRole('button', { name: 'Expand navigation', exact: true }).innerHTML(), openIcon);
    await expect(rail.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true })).toBeVisible();
    await expect(rail.locator('.brand-copy')).not.toBeVisible();
    await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
    const divider = page.getByRole('separator', { name: 'Navigation width', exact: true });
    const box = await divider.boundingBox();
    await page.mouse.move(box.x + 4, box.y + 250);
    await page.mouse.down();
    await page.mouse.move(box.x + 49, box.y + 250, { steps: 6 });
    await page.mouse.up();
    await expect(divider).toHaveAttribute('aria-valuenow', '300');
    await expect.poll(async () => (await rail.boundingBox()).width).toBe(300);
    const details = page.getByRole('separator', { name: 'Session details width', exact: true });
    await details.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(details).toHaveAttribute('aria-valuenow', '314');
    await details.focus();
    await page.keyboard.press('Home');
    await expect(details).toHaveAttribute('aria-valuenow', '220');
    await page.reload();
    await expect.poll(async () => (await rail.boundingBox()).width).toBe(300);
    await expect(details).toHaveAttribute('aria-valuenow', '220');
    await expect(composer).toHaveValue('Invented draft held across navigation layout changes.');

    await page.getByRole('button', { name: 'User options', exact: true }).click();
    let options = page.getByRole('dialog', { name: 'User options', exact: true });
    await options.getByRole('radio', { name: /^Expand on hover/ }).check();
    await page.keyboard.press('Control+Backslash');
    assert.equal(await options.evaluate((node) => node.contains(document.activeElement)), true, 'Rail shortcuts must not take focus out of an open modal.');
    await options.getByRole('button', { name: 'Close options', exact: true }).click();
    await page.getByRole('main').focus();
    await page.mouse.move(950, 120);
    await expect.poll(async () => (await rail.boundingBox()).width).toBe(64);
    await rail.hover();
    await expect.poll(async () => (await rail.boundingBox()).width).toBe(300);
    await expect.poll(async () => (await page.locator('.desk-main-column').boundingBox()).x).toBe(300);
    assert.equal((await page.locator('.desk-main-column').boundingBox()).x,
      (await rail.boundingBox()).x + (await rail.boundingBox()).width,
      'Hover expansion must reserve space for the rail without covering the working area.');
    await page.mouse.move(950, 120);
    await expect.poll(async () => (await rail.boundingBox()).width).toBe(64);
    await rail.hover();
    await page.getByRole('button', { name: 'User options', exact: true }).click();
    options = page.getByRole('dialog', { name: 'User options', exact: true });
    await options.getByRole('radio', { name: /^Hide completely/ }).check();
    await options.getByRole('button', { name: 'Close options', exact: true }).click();
    await page.mouse.move(950, 120);
    await expect(rail).not.toBeVisible();
    assert.equal((await page.locator('.desk-main-column').boundingBox()).x, 0);
    await page.reload();
    await expect(rail).not.toBeVisible();
    await page.mouse.move(2, 260);
    await expect(rail).toBeVisible();
    await expect.poll(async () => (await page.locator('.desk-main-column').boundingBox()).x).toBe(300);
    // Exercise revealed-rail entry and departure without platform-specific
    // CSS :hover assertions; pointer behavior and resulting visibility matter.
    await rail.hover({ position: { x: 20, y: 200 } });
    await page.mouse.move(950, 120);
    await expect(rail).not.toBeVisible();
    // Reveal and focus are separate: the application schedules focus on the
    // next animation frame. Exercise a delayed frame as on a loaded Mac.
    await page.evaluate(() => {
      const schedule = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        window.requestAnimationFrame = schedule;
        return schedule((time) => setTimeout(() => callback(time), 200));
      };
    });
    await page.keyboard.press('Control+Backslash');
    await expect(rail).toBeVisible();
    await expect(rail.locator('button').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(rail).not.toBeVisible();
    await expect(page.getByRole('main')).toBeFocused();
    assert.equal(await readNativeRecordRaw(page, storageKey), bytes);
    await expect(composer).toHaveValue('Invented draft held across navigation layout changes.');
    await page.screenshot({ path: join(screenshots, 'hidden-rail.png'), fullPage: true });
    verify();
    t.diagnostic(`Nexus layout screenshot: ${screenshots}`);
  } finally { await context.close(); }
});

test('hover and hidden navigation animate while reserving the entire Nexus viewport', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const before = await readNativeRecordRaw(page, storageKey);
    const rail = page.getByRole('complementary', { name: 'Navigation rail', exact: true });
    const layout = page.locator('.desk-layout');
    const middle = page.locator('.desk-main-column');
    for (const mode of ['hover', 'hidden']) {
      await page.evaluate((mode) => localStorage.setItem('true-convo:desk:layout:v1',
        JSON.stringify({ mode, railWidth: 300, inspectorWidth: 294 })), mode);
      await page.reload();
      await page.getByRole('main').focus();
      await page.mouse.move(1000, 100);
      const collapsed = mode === 'hidden' ? 0 : 64;
      await expect.poll(async () => (await middle.boundingBox()).x).toBe(collapsed);
      const motion = await layout.evaluate((element) => {
        const style = getComputedStyle(element);
        return { properties: style.transitionProperty.split(',').map((value) => value.trim()),
          durations: style.transitionDuration.split(',').map((value) => parseFloat(value) * 1000) };
      });
      const duration = motion.durations[motion.properties.indexOf('grid-template-columns')];
      assert.ok(duration >= 300 && duration <= 500, 'Rail layout motion must take approximately a third to half a second.');
      for (const view of ['Nexus Navigator', 'Cloudwork Canvas', 'Cloudwork Atlas', 'Roadmap']) {
        await page.locator('.nexus-view-tabs').getByRole('button', { name: view, exact: true }).click();
        await expect(page.getByRole('heading', { name: view, exact: true })).toBeVisible();
        await page.mouse.move(2, 260);
        await expect.poll(async () => (await middle.boundingBox()).x).toBe(300);
        const navigation = await rail.boundingBox();
        const content = await middle.boundingBox();
        assert.equal(content.x, navigation.x + navigation.width, `${mode} navigation covered ${view}.`);
        assert.ok(content.x + content.width <= 1440, `${view} extended outside the viewport.`);
        await page.mouse.move(1000, 100);
        await expect.poll(async () => (await middle.boundingBox()).x).toBe(collapsed);
        if (mode === 'hidden') await expect(rail).not.toBeVisible();
      }
    }
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => layout.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe('0s');
    await expect.poll(() => page.locator('.desktop-navigation').evaluate((element) => getComputedStyle(element).transitionDelay)).toBe('0s');
    await page.mouse.move(2, 260);
    await expect.poll(async () => (await middle.boundingBox()).x).toBe(300);
    await page.mouse.move(1000, 100);
    await expect(rail).not.toBeVisible();
    assert.equal(await readNativeRecordRaw(page, storageKey), before, 'Rail and Nexus view changes must preserve saved work.');
    verify();
  } finally { await context.close(); }
});

test('empty nested domains and unassigned sessions share their saved identities across Navigator, Canvas and Atlas', async (t) => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const original = await readNativeRecord(page, storageKey);
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented creative interests');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(page.locator('.navigator-empty')).toContainText('Invented creative interests');
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    let stored = await readNativeRecord(page, storageKey);
    const rootId = stored.selection.goalId;
    assert.equal(stored.selection.sessionId, null);
    assert.deepEqual(stored.sessions, original.sessions, 'Creating a folder must not silently create a session.');
    await page.getByRole('button', { name: 'Folder options for Invented creative interests', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Create folder…', exact: true }).click();
    dialog = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await expect(dialog.getByRole('combobox', { name: 'Inside', exact: true })).toHaveValue(rootId);
    await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented writing ideas');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    stored = await readNativeRecord(page, storageKey);
    const childId = stored.selection.goalId;
    assert.equal(stored.goals.find((item) => item.id === childId).parentId, rootId);
    await expect(page.locator(`.domain-row:has(.domain-link[data-domain-id="${rootId}"]) + .domain-contents`).getByRole('button', { name: 'Invented writing ideas', exact: true })).toBeVisible();
    const sessionsRail = page.getByRole('region', { name: 'Ungrouped sessions', exact: true });
    await sessionsRail.getByRole('button', { name: 'New session', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill('Invented unassigned discussion.');
    await page.getByRole('button', { name: 'Send demo message', exact: true }).click();
    await composer.fill('Invented follow-up kept through refiling and view changes.');
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    const before = await readNativeRecord(page, storageKey);
    const sessionId = before.selection.sessionId;
    const session = before.sessions.find((item) => item.id === sessionId);
    assert.equal(session.goalId, null);
    await expect(sessionLink(page, sessionId)).toBeVisible();
    await sessionsRail.getByRole('button', { name: `Session options for ${session.title}`, exact: true }).click();
    await page.getByRole('menuitem', { name: 'Move to folder…', exact: true }).click();
    const moveDialog = page.getByRole('dialog', { name: 'Move session', exact: true });
    await moveDialog.getByRole('combobox', { name: 'Move to folder', exact: true }).selectOption(childId);
    await moveDialog.getByRole('button', { name: 'Move session', exact: true }).click();
    await expect(sessionsRail.locator(`[data-session-id="${sessionId}"]`)).toHaveCount(0);
    await expect(currentDomainSessions(page).locator(`[data-session-id="${sessionId}"]`)).toBeVisible();
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    const filed = await readNativeRecord(page, storageKey);
    assert.deepEqual(filed.messages, before.messages);
    assert.deepEqual(filed.drafts, before.drafts);
    assert.equal(filed.selection.sessionId, sessionId);
    const bytes = await readNativeRecordRaw(page, storageKey);
    await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cloudwork Canvas', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Canvas', exact: true })).toContainText('Invented writing ideas');
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, 'canvas.png'), fullPage: true });
    await page.getByRole('button', { name: 'Cloudwork Atlas', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Cloudwork Atlas', exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Atlas', exact: true })).toContainText('Planned · not connected');
    await expect(page.getByRole('region', { name: 'Atlas', exact: true }).getByRole('button', { name: `Open session ${session.title}`, exact: true })).toHaveCount(0);
    await page.screenshot({ path: join(screenshots, 'atlas.png'), fullPage: true });
    await page.getByRole('button', { name: 'Cloudwork Canvas', exact: true }).click();
    const canvasSession = page.getByRole('region', { name: 'Canvas', exact: true }).getByRole('button', { name: `Open session ${session.title}`, exact: true });
    await expect(canvasSession).toBeVisible();
    await canvasSession.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Nexus Navigator', exact: true })).toBeVisible();
    await expect(composer).toHaveValue('Invented follow-up kept through refiling and view changes.');
    assert.equal(await readNativeRecordRaw(page, storageKey), bytes);
    await page.reload();
    await expect(composer).toHaveValue('Invented follow-up kept through refiling and view changes.');
    await expect(page.getByRole('button', { name: 'Model and harness picker: demo only', exact: true })).toBeDisabled();
    await expect(page.locator('.desk-header')).not.toContainText('New domain');
    verify();
    t.diagnostic(`Nexus view screenshots: ${screenshots}`);
  } finally { await context.close(); }
});

test('blocked layout saving warns without disabling workspace saves or damaging drafts', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'true-convo:desk:layout:v1') throw new DOMException('Invented layout-only quota failure', 'QuotaExceededError');
        return original.call(this, key, value);
      };
    });
    await enterDesk(page);
    await page.getByRole('button', { name: 'Collapse navigation', exact: true }).click();
    await expect(page.getByText('Layout settings could not be restored or saved. Your sessions and drafts are kept separately.', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented work still saves while layout settings fail.');
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented work still saves while layout settings fail.');
    verify();
  } finally { await context.close(); }
});
