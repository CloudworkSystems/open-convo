import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { readNativeRecord } from './browser-persistence.mjs';

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
  const nexus = page.getByRole('button', { name: 'Cloudwork Nexus', exact: true });
  if (!await nexus.isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await nexus.click();
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}
const stored = (page) => readNativeRecord(page, storageKey);
const field = (page) => page.getByRole('textbox', { name: 'Your message', exact: true });
const grip = (page) => page.getByRole('separator', { name: 'Message box height', exact: true });
const height = (page) => field(page).evaluate((node) => node.getBoundingClientRect().height);
async function savedDraft(page, value) {
  await expect.poll(async () => { const state = await stored(page); return state.drafts[state.selection.sessionId]; }).toBe(value);
}

test('Enter sends, modified Enter inserts a newline at the selection, and composition never sends', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const before = await stored(page);
    await field(page).fill('Alpha old tail');
    await field(page).evaluate((node) => node.setSelectionRange(6, 9));
    await field(page).press('Control+Enter');
    await expect(field(page)).toHaveValue('Alpha \n tail');
    // The value commits before the animation-frame caret restoration. Verify
    // both ends are restored before sending the next synthetic keystroke.
    await expect.poll(() => field(page).evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([7, 7]);
    await field(page).press('Shift+Enter');
    await expect(field(page)).toHaveValue('Alpha \n\n tail');
    await expect.poll(() => field(page).evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([8, 8]);
    await field(page).press('Meta+Enter');
    await expect(field(page)).toHaveValue('Alpha \n\n\n tail');
    await expect.poll(() => field(page).evaluate((node) => [node.selectionStart, node.selectionEnd])).toEqual([9, 9]);
    await savedDraft(page, 'Alpha \n\n\n tail');
    assert.equal((await stored(page)).messages.length, before.messages.length);
    await page.reload();
    await expect(field(page)).toHaveValue('Alpha \n\n\n tail');
    await field(page).dispatchEvent('compositionstart', { data: '語' });
    await field(page).press('Enter');
    await field(page).dispatchEvent('compositionend', { data: '語' });
    await field(page).evaluate((node) => {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true }));
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true }));
    });
    assert.equal((await stored(page)).messages.length, before.messages.length);
    const body = await field(page).inputValue();
    await field(page).press('Enter');
    await expect(field(page)).toHaveValue('');
    await expect.poll(async () => (await stored(page)).messages.length).toBe(before.messages.length + 2);
    assert.equal((await stored(page)).messages.at(-2).body, body);
    await field(page).fill('   ');
    await field(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Send demo message', exact: true })).toBeDisabled();
    assert.equal((await stored(page)).messages.length, before.messages.length + 2);
    verify();
  } finally { await context.close(); }
});

test('the picker sits by Send and the top grip grows upward while the actions stay anchored', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await field(page).fill('Invented draft retained while resizing.');
    await savedDraft(page, 'Invented draft retained while resizing.');
    const before = await stored(page);
    const actions = page.locator('.composer-actions');
    const hint = page.locator('#message-shortcuts');
    const picker = page.getByRole('button', { name: 'Model and harness picker: demo only', exact: true });
    await expect(picker).toBeDisabled();
    const hintBounds = await hint.boundingBox();
    const pickerBounds = await picker.boundingBox();
    const sendBounds = await page.getByRole('button', { name: 'Send demo message', exact: true }).boundingBox();
    assert.ok(hintBounds.x < pickerBounds.x && pickerBounds.x < sendBounds.x);
    const bottom = await actions.evaluate((node) => node.getBoundingClientRect().bottom);
    const initial = await height(page);
    const bounds = await grip(page).boundingBox();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 80, { steps: 6 });
    await page.mouse.up();
    await expect.poll(() => height(page)).toBe(initial + 80);
    assert.ok(Math.abs((await actions.evaluate((node) => node.getBoundingClientRect().bottom)) - bottom) < 2);
    const larger = await grip(page).boundingBox();
    await page.mouse.move(x, larger.y + larger.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, larger.y + larger.height / 2 + 30, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => height(page)).toBe(initial + 50);
    await grip(page).press('Home');
    await expect.poll(() => height(page)).toBe(78);
    await grip(page).press('ArrowUp');
    await expect.poll(() => height(page)).toBe(98);
    await grip(page).press('ArrowDown');
    await expect.poll(() => height(page)).toBe(78);
    await grip(page).press('End');
    assert.equal(await height(page), Number(await grip(page).getAttribute('aria-valuemax')));
    const messages = await page.getByRole('log', { name: 'Messages', exact: true }).boundingBox();
    assert.ok(messages.height >= 119, `Resizing left only ${messages.height}px for messages.`);
    assert.ok(Math.abs((await actions.evaluate((node) => node.getBoundingClientRect().bottom)) - bottom) < 2);
    assert.equal(await field(page).evaluate((node) => getComputedStyle(node).resize), 'none');
    assert.deepEqual(await stored(page), before, 'Resizing must not rewrite the saved conversation.');
    verify();
  } finally { await context.close(); }
});

test('narrow and mobile composer layouts retain controls and clamp height without horizontal overflow', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 } });
  try {
    await enter(page);
    await expect(page.locator('#message-shortcuts')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Model and harness picker: demo only', exact: true })).toBeVisible();
    await field(page).fill('Invented mobile draft.');
    await grip(page).press('End');
    await page.setViewportSize({ width: 390, height: 650 });
    await expect.poll(async () => Number(await grip(page).getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(await grip(page).getAttribute('aria-valuemax')));
    await expect(field(page)).toHaveValue('Invented mobile draft.');
    await expect.poll(async () => (await page.getByRole('log', { name: 'Messages', exact: true }).boundingBox()).height).toBeGreaterThanOrEqual(119);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    const send = await page.getByRole('button', { name: 'Send demo message', exact: true }).boundingBox();
    assert.ok(send.y + send.height <= 650, 'Send should remain inside the shorter viewport.');
    await field(page).press('Enter');
    await expect(field(page)).toHaveValue('');
    verify();
  } finally { await context.close(); }
});

test('a stale read-only tab cannot submit through Enter or a form submission', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await field(page).fill('Invented saved draft before another tab edits.');
    await savedDraft(page, 'Invented saved draft before another tab edits.');
    const other = await context.newPage();
    await enter(other);
    await field(page).fill('Newer invented draft from the first tab.');
    await savedDraft(page, 'Newer invented draft from the first tab.');
    await expect(other.getByRole('alert', { name: 'Save recovery' })).toBeVisible();
    await expect(field(other)).toBeDisabled();
    await expect(other.getByRole('button', { name: 'Send demo message', exact: true })).toBeDisabled();
    const before = await stored(page);
    await field(other).evaluate((node) => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await other.locator('form.composer').evaluate((node) => node.requestSubmit());
    assert.deepEqual(await stored(page), before);
    verify();
  } finally { await context.close(); }
});
