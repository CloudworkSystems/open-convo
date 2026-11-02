import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readNativeRecord } from './browser-persistence.mjs';

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


// Owner decision, November 2, 2026: a newly opened Desk shows the session list
// and a fresh blank session in the middle; a blank session he never types in
// adds no row. These contexts are brand-new tabs, so no returningTab mark.
async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  await context.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  return { context, page, verify: () => assert.deepEqual(errors, []) };
}
const sessionLinks = (page) => page.getByRole('complementary', { name: 'Navigation rail', exact: true }).locator('.session-link');

test('a new tab opens on a blank session in the middle, and only typing saves it as a row', async () => {
  const { context, page, verify } = await freshPage();
  try {
    await page.goto(origin);
    await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
    const box = page.getByRole('textbox', { name: 'Your message', exact: true });
    await expect(box).toBeVisible();
    await expect(box).toBeEnabled();
    await expect(page.locator('.navigator-empty')).toContainText('Ungrouped sessions');
    await expect(page.getByRole('heading', { name: 'Nexus Navigator', exact: true })).toBeAttached();
    await expect(page.getByRole('complementary', { name: 'Session details', exact: true })).toHaveCount(0);
    const before = await readNativeRecord(page, storageKey);
    const rows = await sessionLinks(page).count();

    // Reloading and switching folders without typing saves nothing.
    await page.reload();
    await expect(box).toBeVisible();
    await page.getByRole('button', { name: 'New session in Shape a useful idea', exact: true }).click();
    await expect(page.locator('.navigator-empty')).toContainText('Shape a useful idea');
    await expect(box).toBeFocused();
    assert.equal(await sessionLinks(page).count(), rows);
    assert.deepEqual((await readNativeRecord(page, storageKey)).sessions, before.sessions);

    // The first typed letter saves the session with its draft; typing carries on in the same box.
    await box.pressSequentially('Plan the week');
    await expect(box).toHaveValue('Plan the week');
    await expect(box).toBeFocused();
    await expect(sessionLinks(page)).toHaveCount(rows + 1);
    await expect.poll(async () => {
      const saved = await readNativeRecord(page, storageKey);
      const created = saved.sessions.find((session) => !before.sessions.some((old) => old.id === session.id));
      return created && { goalId: created.goalId, draft: saved.drafts[created.id] };
    }).toEqual({ goalId: before.goals[0].id, draft: 'Plan the week' });
    await page.keyboard.press('Enter');
    await expect(page.locator('.message-user')).toContainText('Plan the week');
    verify();
  } finally { await context.close(); }
});

test('reloading the same tab keeps the session it was showing', async () => {
  const { context, page, verify } = await freshPage();
  try {
    await page.goto(origin);
    await page.getByText('A place to begin', { exact: true }).first().click();
    await expect(page.locator('.conversation-heading h2')).toHaveText('A place to begin');
    await page.reload();
    await expect(page.locator('.conversation-heading h2')).toHaveText('A place to begin');
    verify();
  } finally { await context.close(); }
});
