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
import { installNativeWriteFailure, readNativeRecord, readNativeRecordRaw } from './foundation/browser-persistence.mjs';

// Explicitly run after DESK_CLOUD_PREVIEW=1 npm run build. This does not
// contact Sites, publish files, or exercise a real owner's browser data.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceKey = 'true-convo:desk:synthetic:v1';
const roadmapKey = 'true-convo:desk:roadmap:v1';
const viewKey = 'true-convo:desk:synthetic:tab-view:v1';
const reloadKey = 'true-convo:desk:preview-reload:v1';
let server, browser, origin, loadedBuild;
let output = '';
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function cleanup() {
  try { await browser?.close(); }
  finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, 'exit');
      server.kill('SIGTERM');
      if (!await Promise.race([exited.then(() => true), pause(2_000).then(() => false)])) server.kill('SIGKILL');
      await exited;
    }
  }
}

before(async () => {
  try {
    loadedBuild = JSON.parse(await readFile(join(root, 'dist/desk-build.json'), 'utf8'));
    assert.equal(loadedBuild.application, 'true-convo-desk-preview');
    assert.equal(loadedBuild.protocol, 1);
    assert.match(loadedBuild.source_commit, /^[a-f0-9]{40}$/);
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (part) => { output = (output + part).slice(-8_000); });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (server.exitCode !== null) throw new Error(output);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* startup */ }
      await pause(50);
    }
    assert.ok(ready, output);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 15_000 });
after(cleanup);

async function samplePage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installNativeWriteFailure(context, workspaceKey);
  await installNativeWriteFailure(context, roadmapKey, '__roadmapFailWrites');
  const blocked = [], errors = [];
  let announced = loadedBuild;
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      blocked.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/desk-build.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(announced) }));
  await page.clock.install();
  await page.goto(origin);
  await page.bringToFront();
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Nexus Navigator', exact: true }).click();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
  return {
    context, page,
    announce: () => {
      announced = { ...loadedBuild, source_commit: (loadedBuild.source_commit === 'e'.repeat(40) ? 'f' : 'e').repeat(40), working_copy: false };
      return announced.source_commit;
    },
    verify: () => { assert.deepEqual(blocked, []); assert.deepEqual(errors, []); assert.equal(context.pages().length, 1); },
  };
}

async function openRoadmap(page) {
  await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Roadmap', exact: true }).click();
}

test('a published preview waits for input and a modal, then refreshes the same tab once and keeps saved work', { timeout: 30_000 }, async () => {
  const { context, page, announce, verify } = await samplePage();
  try {
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Create folder' });
    await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Invented hosted preview goal');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await page.getByRole('main').getByRole('button', { name: 'New session', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    const draft = 'Invented long draft retained when a checked preview updates. '.repeat(50);
    await composer.fill(draft);
    await expect.poll(async () => Object.values((await readNativeRecord(page, workspaceKey)).drafts).includes(draft)).toBe(true);
    const nativeBytes = await readNativeRecordRaw(page, workspaceKey);
    const legacyBytes = await page.evaluate((key) => localStorage.getItem(key), workspaceKey);
    const view = await page.evaluate((key) => sessionStorage.getItem(key), viewKey);
    let reloads = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) reloads += 1; });
    const nextCommit = announce();
    await page.clock.fastForward(31_000);
    const notice = page.getByRole('status', { name: 'Preview update' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await page.clock.fastForward(12_000);
    assert.equal(reloads, 0, 'An active composer must block an automatic reload.');

    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Folder name' }).fill('Unsubmitted invented modal text');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.clock.fastForward(12_000);
    assert.equal(reloads, 0, 'An open modal must block reload even when no input is focused.');
    await expect(notice.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).focus();
    assert.equal(await page.evaluate(() => document.hasFocus()), true);
    // Headless Chromium keeps hasFocus() true when another page is fronted.
    // Genuine browser/annotation focus loss and return require a manual trial.
    const navigated = page.waitForEvent('domcontentloaded');
    await page.clock.fastForward(12_000);
    await navigated;
    await expect(composer).toHaveValue(draft);
    assert.equal(reloads, 1);
    assert.equal(await readNativeRecordRaw(page, workspaceKey), nativeBytes);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), workspaceKey), legacyBytes);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), viewKey), view);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), reloadKey), nextCommit);
    await expect(page.getByRole('navigation', { name: 'Session folders', exact: true }).locator('.domain-link[aria-current="true"]')).toHaveText('Invented hosted preview goal');
    // This fixture deliberately serves old HTML after announcing a new build.
    // Its attempted-build marker must prevent repeated automatic reloads.
    await page.clock.fastForward(65_000);
    await expect(page.getByText('Refresh this tab when your work is saved and you are ready.', { exact: true })).toBeVisible();
    assert.equal(reloads, 1);
    verify();
  } finally { await context.close(); }
});

test('an actual browser save failure keeps attempted work and disables preview refresh', { timeout: 20_000 }, async () => {
  const { context, page, announce, verify } = await samplePage();
  try {
    const nativeBytes = await readNativeRecordRaw(page, workspaceKey);
    const legacyBytes = await page.evaluate((key) => localStorage.getItem(key), workspaceKey);
    await page.evaluate(() => { window.__deskFailWrites = true; });
    const draft = 'Invented attempted work that has not been saved.';
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill(draft);
    await expect(page.getByText('Changes kept in this tab · save needs attention', { exact: true })).toBeVisible();
    let reloads = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) reloads += 1; });
    announce();
    await page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).focus();
    await page.clock.fastForward(31_000);
    const notice = page.getByRole('status', { name: 'Preview update' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await page.clock.fastForward(65_000);
    assert.equal(reloads, 0);
    await expect(composer).toHaveValue(draft);
    assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), reloadKey), null);
    assert.equal(Object.values((await readNativeRecord(page, workspaceKey)).drafts).includes(draft), false);
    assert.equal(await readNativeRecordRaw(page, workspaceKey), nativeBytes, 'A failed native save must preserve the last committed workspace.');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), workspaceKey), legacyBytes, 'Legacy recovery input must remain unchanged.');
    verify();
  } finally { await context.close(); }
});

test('a temporary roadmap move holds preview refresh even after leaving Roadmap', { timeout: 20_000 }, async () => {
  const { context, page, announce, verify } = await samplePage();
  try {
    await openRoadmap(page);
    await expect(page.getByText('Roadmap placement saves in this browser.', { exact: true })).toBeVisible();
    const nativeBytes = await readNativeRecordRaw(page, roadmapKey);
    const legacyBytes = await page.evaluate((key) => localStorage.getItem(key), roadmapKey);
    await page.evaluate(() => { window.__roadmapFailWrites = true; });
    const card = page.locator('.roadmap-card[data-card-id="dictation-audio-default"]');
    await card.getByRole('combobox').selectOption('in-progress');
    await expect(page.getByText('Roadmap placement is temporary for this visit.', { exact: true })).toBeVisible();
    let reloads = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) reloads += 1; });
    announce();
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).focus();
    await page.clock.fastForward(31_000);
    const notice = page.getByRole('status', { name: 'Preview update' });
    await expect(notice).toBeVisible();
    await expect(notice.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await page.clock.fastForward(65_000);
    assert.equal(reloads, 0, 'Temporary planning must survive an idle published update away from Roadmap.');
    await openRoadmap(page);
    await expect(page.locator('.roadmap-column[data-column="in-progress"] .roadmap-card[data-card-id="dictation-audio-default"]')).toBeVisible();
    assert.equal(await readNativeRecordRaw(page, roadmapKey), nativeBytes, 'Temporary placement must not change the committed board.');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), roadmapKey), legacyBytes);
    verify();
  } finally { await context.close(); }
});

test('an already visible update notice explains a later failed roadmap save without leaving the board', { timeout: 20_000 }, async () => {
  const { context, page, announce, verify } = await samplePage();
  try {
    await openRoadmap(page);
    const card = page.locator('.roadmap-card[data-card-id="dictation-audio-default"]');
    const move = card.getByRole('combobox');
    await expect(move).toBeEnabled();
    const nativeBytes = await readNativeRecordRaw(page, roadmapKey);
    const legacyBytes = await page.evaluate((key) => localStorage.getItem(key), roadmapKey);
    await move.focus();
    let reloads = 0;
    page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) reloads += 1; });
    announce();
    await page.clock.fastForward(31_000);
    const notice = page.getByRole('status', { name: 'Preview update' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('This tab will refresh after your work is saved');
    await expect(notice.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await page.evaluate(() => { window.__roadmapFailWrites = true; });
    await move.selectOption('in-progress');
    await expect(page.getByText('Roadmap placement is temporary for this visit.', { exact: true })).toBeVisible();
    await page.clock.fastForward(2_001);
    await expect(notice).toContainText('Temporary changes are keeping this tab open.');
    await expect(notice).toContainText('reloading will discard changes that could not be saved');
    await expect(notice.getByRole('button', { name: 'Refresh preview' })).toBeDisabled();
    await page.clock.fastForward(65_000);
    await expect(page.locator('.roadmap-column[data-column="in-progress"] .roadmap-card[data-card-id="dictation-audio-default"]')).toBeVisible();
    assert.equal(reloads, 0, 'The existing notice must retain the temporary planning move.');
    assert.equal(await readNativeRecordRaw(page, roadmapKey), nativeBytes, 'The failed later save must retain the committed board.');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), roadmapKey), legacyBytes);
    verify();
  } finally { await context.close(); }
});
