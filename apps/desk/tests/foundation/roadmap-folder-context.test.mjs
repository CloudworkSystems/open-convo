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
let server;
let browser;
let origin;
let output = '';
const pause = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

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
    }
    server = undefined;
  }
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
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

async function isolatedPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
    assert.deepEqual(outside, [], 'Folder context requested another origin.');
    assert.deepEqual(privateApi, [], 'Folder context requested a private API.');
    assert.deepEqual(errors, [], 'Folder context reported browser errors.');
  } };
}

const stored = (page) => readNativeRecord(page);
const selection = (page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);
const railFolder = (page, name) => page.locator('.desktop-navigation .domain-link').filter({ hasText: name });
const createForm = (page) => page.getByRole('form', { name: 'Create a suggested card', exact: true });

async function enter(page) {
  await page.goto(origin);
  await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Nexus Navigator', exact: true })).toBeVisible();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}

async function createFolder(page, name, parentId = null) {
  await page.getByRole('button', { name: 'Create folder', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create folder', exact: true });
  await dialog.getByRole('textbox', { name: 'Folder name', exact: true }).fill(name);
  await dialog.getByRole('combobox', { name: 'Inside', exact: true }).selectOption(parentId ?? '');
  await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await stored(page)).goals.some((goal) => goal.title === name && (goal.parentId ?? null) === parentId)).toBe(true);
  return (await stored(page)).goals.find((goal) => goal.title === name && (goal.parentId ?? null) === parentId);
}

async function openRoadmap(page) {
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Roadmap', exact: true }).click();
  await expect(createForm(page).getByRole('textbox', { name: 'Card title', exact: true })).toBeFocused();
}

test('a rail folder round trip resets an explicit card folder choice and keeps every folder draft', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const first = (await stored(page)).goals[0];
    const second = await createFolder(page, 'Invented folder B');
    const third = await createFolder(page, 'Invented folder C');
    await railFolder(page, first.title).click();
    await openRoadmap(page);
    const form = createForm(page);
    const picker = form.getByRole('combobox', { name: 'Session folder', exact: true });
    const title = form.getByRole('textbox', { name: 'Card title', exact: true });
    const firstDraft = 'Invented suggestion saved in folder A';
    const secondDraft = 'Invented unfinished suggestion in folder B';
    const thirdDraft = 'Invented unfinished suggestion in folder C';
    await title.fill(firstDraft);
    await expect.poll(async () => (await stored(page)).goalDrafts[first.id].workTitle).toBe(firstDraft);
    const selected = await selection(page);
    await picker.focus();
    await picker.selectOption(second.id);
    await expect(picker).toBeFocused();
    assert.deepEqual(await selection(page), selected, 'Choosing card context must not change the active folder/session.');
    await title.fill(secondDraft);
    await expect.poll(async () => (await stored(page)).goalDrafts[second.id].workTitle).toBe(secondDraft);
    await railFolder(page, third.title).click();
    await expect(picker).toHaveValue(third.id);
    await expect(railFolder(page, third.title)).toBeFocused();
    await title.fill(thirdDraft);
    await expect.poll(async () => (await stored(page)).goalDrafts[third.id].workTitle).toBe(thirdDraft);
    await railFolder(page, first.title).click();
    await expect(picker).toHaveValue(first.id);
    await expect(railFolder(page, first.title)).toBeFocused();
    await expect(title).toHaveValue(firstDraft);
    await form.getByRole('button', { name: 'Create card', exact: true }).click();
    await expect.poll(async () => (await stored(page)).workItems.find((item) => item.title === firstDraft)?.goalId).toBe(first.id);
    const after = await stored(page);
    assert.equal(after.goalDrafts[first.id].workTitle, '');
    assert.equal(after.goalDrafts[second.id].workTitle, secondDraft);
    assert.equal(after.goalDrafts[third.id].workTitle, thirdDraft);
    await page.reload();
    await expect(createForm(page).getByRole('textbox', { name: 'Card title', exact: true })).toBeVisible();
    await createForm(page).getByRole('combobox', { name: 'Session folder', exact: true }).selectOption(second.id);
    await expect(createForm(page).getByRole('textbox', { name: 'Card title', exact: true })).toHaveValue(secondDraft);
    verify();
  } finally { await context.close(); }
});

test('the card folder picker distinguishes matching nested names by full path and keeps top-level type-ahead', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const initial = (await stored(page)).goals[0];
    const planning = await createFolder(page, 'Planning');
    const product = await createFolder(page, 'Product');
    const planningReview = await createFolder(page, 'Review', planning.id);
    const productReview = await createFolder(page, 'Review', product.id);
    await railFolder(page, initial.title).click();
    await openRoadmap(page);
    const form = createForm(page);
    const picker = form.getByRole('combobox', { name: 'Session folder', exact: true });
    await expect(picker.getByRole('option', { name: 'Planning / Review', exact: true })).toHaveAttribute('value', planningReview.id);
    await expect(picker.getByRole('option', { name: 'Product / Review', exact: true })).toHaveAttribute('value', productReview.id);
    await expect(picker.getByRole('option', { name: 'Review', exact: true })).toHaveCount(0);
    await picker.focus();
    await page.keyboard.type('P');
    await expect(picker).toHaveValue(planning.id);
    await expect(picker).toBeFocused();
    await page.keyboard.type('r');
    await expect(picker).toHaveValue(product.id);
    await expect(picker).toBeFocused();
    await picker.selectOption({ label: 'Product / Review' });
    const title = 'Invented suggestion belonging to Product review';
    await form.getByRole('textbox', { name: 'Card title', exact: true }).fill(title);
    await form.getByRole('button', { name: 'Create card', exact: true }).click();
    await expect.poll(async () => (await stored(page)).workItems.find((item) => item.title === title)?.goalId).toBe(productReview.id);
    assert.equal((await stored(page)).workItems.some((item) => item.title === title && item.goalId === planningReview.id), false);
    verify();
  } finally { await context.close(); }
});
