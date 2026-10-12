import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { WORKSPACE_DATABASE_NAME, installNativeWriteFailure, readNativeRecord, readNativeRecordRaw, writeNativeRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let server; let browser; let origin; let output = '';
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
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;
    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (part) => { output = (output + part).slice(-8_000); });
    let available = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Preview exited: ${output}`);
      try { if ((await fetch(origin)).ok) { available = true; break; } } catch { /* startup */ }
      await pause(100);
    }
    assert.ok(available, `Preview did not become ready: ${output}`);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

async function isolatedPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  const outside = []; const privateApi = []; const errors = [];
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
    assert.deepEqual(outside, [], 'CONTINUITY requested another origin.');
    assert.deepEqual(privateApi, [], 'CONTINUITY requested a private or legacy API.');
    assert.deepEqual(errors, [], 'CONTINUITY reported browser errors.');
  } };
}
async function saved(page) {
  await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
}
async function enter(page, mobile = false) {
  await page.goto(origin); await saved(page);
  if (mobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chosen memories', exact: true })).toBeVisible();
}
const teaching = (page) => page.getByRole('form', { name: 'Remember a detail', exact: true });
const detail = (page) => teaching(page).getByRole('textbox', { name: 'Detail to remember', exact: true });
const currentCards = (page) => page.locator('.memory-current .memory-card');
async function remember(page, text) {
  await detail(page).fill(text);
  await teaching(page).getByRole('button', { name: 'Save memory', exact: true }).click();
  await saved(page);
}
async function keyboardActivate(button) {
  await button.focus();
  await expect(button).toBeFocused();
  await button.press('Enter');
}

test('CONTINUITY opens old invented saves without creating memory records or changing committed bytes', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await page.goto(origin); await saved(page);
    const before = await readNativeRecordRaw(page);
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Chosen memories', exact: true })).toBeVisible();
    await expect(page.getByText('Invented-data preview · unencrypted browser storage. No AI memory or learning is connected.', { exact: true })).toBeVisible();
    await expect(page.getByText('No chosen memories in this folder.', { exact: true })).toBeVisible();
    assert.equal(await readNativeRecordRaw(page), before);
    const state = await readNativeRecord(page);
    assert.equal(Object.hasOwn(state, 'memories'), false); assert.equal(Object.hasOwn(state, 'memoryDrafts'), false);
    verify();
  } finally { await context.close(); }
});

test('direct teaching, keyboard correction, Undo, Trash and both restore choices persist and keep context truthful', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await remember(page, 'OLD-BROWSER-MEMORY-CANARY');
    const card = currentCards(page).first();
    await card.getByRole('button', { name: 'Correct', exact: true }).click();
    const correction = card.getByRole('textbox', { name: 'Corrected detail', exact: true });
    await expect(correction).toBeFocused(); await correction.fill('CURRENT-BROWSER-MEMORY-CANARY');
    await card.getByRole('button', { name: 'Save correction', exact: true }).click(); await saved(page);
    await page.locator('.memory-context > summary').click();
    await expect(page.locator('.memory-context')).toContainText('CURRENT-BROWSER-MEMORY-CANARY');
    await expect(page.locator('.memory-context')).not.toContainText('OLD-BROWSER-MEMORY-CANARY');
    await card.getByRole('button', { name: 'Undo correct', exact: true }).click(); await saved(page);
    await expect(card.locator(':scope > .memory-body')).toHaveText('OLD-BROWSER-MEMORY-CANARY');
    await expect(page.locator('.memory-context')).not.toContainText('CURRENT-BROWSER-MEMORY-CANARY');
    await card.getByRole('button', { name: 'Forget', exact: true }).click(); await saved(page);
    await expect(currentCards(page)).toHaveCount(0);
    const trash = page.locator('.memory-trash .memory-card');
    await expect(trash).toContainText('In Trash');
    await expect(page.locator('.memory-context')).not.toContainText('OLD-BROWSER-MEMORY-CANARY');
    await trash.getByRole('button', { name: 'Restore for viewing only', exact: true }).click(); await saved(page);
    await expect(currentCards(page)).toContainText('Viewing only');
    await expect(page.locator('.memory-context')).not.toContainText('OLD-BROWSER-MEMORY-CANARY');
    await currentCards(page).getByRole('button', { name: 'Restore for this folder', exact: true }).click(); await saved(page);
    await expect(page.locator('.memory-context')).toContainText('OLD-BROWSER-MEMORY-CANARY');
    await page.reload();
    await expect(currentCards(page)).toContainText('Available in this folder');
    const state = await readNativeRecord(page);
    assert.equal(state.memories[0].history.length, 6); assert.equal(state.memories[0].use, 'active');
    assert.deepEqual(state.capabilities, { mode: 'synthetic', provider: 'demo-only', native: 'unavailable' });
    verify();
  } finally { await context.close(); }
});

test('keyboard memory actions keep focus on the affected card and Tab continues from its new position', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await remember(page, 'Keyboard focus sample');
    const id = await currentCards(page).first().getAttribute('data-memory-id');
    await remember(page, 'Another memory remains in the current list');
    const card = page.locator(`.memory-card[data-memory-id="${id}"]`);
    const correct = card.getByRole('button', { name: 'Correct', exact: true });

    await keyboardActivate(correct);
    const correction = card.getByRole('textbox', { name: 'Corrected detail', exact: true });
    await expect(correction).toBeFocused();
    await correction.fill('Corrected keyboard sample');
    await keyboardActivate(card.getByRole('button', { name: 'Save correction', exact: true }));
    await expect(card).toBeFocused();
    await page.keyboard.press('Tab'); await expect(correct).toBeFocused();

    await correct.press('Enter'); await expect(correction).toBeFocused();
    await correction.fill('Discard this correction');
    await keyboardActivate(card.getByRole('button', { name: 'Cancel correction', exact: true }));
    await expect(card).toBeFocused();
    await expect(card.locator(':scope > .memory-body')).toHaveText('Corrected keyboard sample');
    await page.keyboard.press('Tab'); await expect(correct).toBeFocused();

    await keyboardActivate(card.getByRole('button', { name: 'Forget', exact: true }));
    await expect(page.locator('.memory-trash').locator(`[data-memory-id="${id}"]`)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('button', { name: 'Restore for this folder', exact: true })).toBeFocused();

    await keyboardActivate(card.getByRole('button', { name: 'Restore for viewing only', exact: true }));
    await expect(page.locator('.memory-current').locator(`[data-memory-id="${id}"]`)).toBeFocused();
    await expect(card).toContainText('Viewing only');
    await page.keyboard.press('Tab'); await expect(correct).toBeFocused();

    await keyboardActivate(card.getByRole('button', { name: 'Restore for this folder', exact: true }));
    await expect(card).toBeFocused(); await expect(card).toContainText('Available in this folder');
    await keyboardActivate(card.getByRole('button', { name: 'Undo restore', exact: true }));
    await expect(card).toBeFocused(); await expect(card).toContainText('Viewing only');
    await page.keyboard.press('Tab'); await expect(correct).toBeFocused();

    await keyboardActivate(card.getByRole('button', { name: 'Forget', exact: true }));
    await expect(card).toBeFocused();
    await keyboardActivate(card.getByRole('button', { name: 'Undo forget', exact: true }));
    await expect(page.locator('.memory-current').locator(`[data-memory-id="${id}"]`)).toBeFocused();
    await page.keyboard.press('Tab'); await expect(correct).toBeFocused();
    await saved(page); verify();
  } finally { await context.close(); }
});

test('keyboard actions reveal manually collapsed Trash before focusing a moved memory', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await remember(page, 'Previously forgotten sample');
    await keyboardActivate(currentCards(page).getByRole('button', { name: 'Forget', exact: true }));
    await remember(page, 'Move into collapsed Trash');
    const id = await currentCards(page).getAttribute('data-memory-id');
    const card = page.locator(`.memory-card[data-memory-id="${id}"]`);
    const trash = page.locator('.memory-trash');
    const summary = trash.locator(':scope > summary');

    await keyboardActivate(summary);
    await expect(trash).not.toHaveAttribute('open');
    await keyboardActivate(card.getByRole('button', { name: 'Forget', exact: true }));
    await expect(trash).toHaveAttribute('open');
    await expect(trash.locator(`[data-memory-id="${id}"]`)).toBeFocused();
    await expect(card).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('button', { name: 'Restore for this folder', exact: true })).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.locator('.memory-current').locator(`[data-memory-id="${id}"]`)).toBeFocused();
    await keyboardActivate(summary);
    await expect(trash).not.toHaveAttribute('open');
    await keyboardActivate(card.getByRole('button', { name: 'Undo restore', exact: true }));
    await expect(trash).toHaveAttribute('open');
    await expect(trash.locator(`[data-memory-id="${id}"]`)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(card.getByRole('button', { name: 'Restore for this folder', exact: true })).toBeFocused();
    await saved(page); verify();
  } finally { await context.close(); }
});

test('choosing a source then editing the selected detail retains source review and excludes raw source from context', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    const original = await readNativeRecord(page);
    await teaching(page).getByRole('combobox', { name: 'Memory source', exact: true }).selectOption({ label: 'Scratch note 1' });
    await expect(detail(page)).toHaveValue(original.notes[0].body);
    await detail(page).fill('ONLY-CHOSEN-SOURCE-DETAIL');
    await saved(page);
    const drafted = await readNativeRecord(page);
    const goalId = original.goals[0].id;
    assert.equal(drafted.memoryDrafts[goalId].sourceBody, original.notes[0].body);
    await teaching(page).getByRole('button', { name: 'Save memory', exact: true }).click(); await saved(page);
    await expect(currentCards(page)).toContainText('ONLY-CHOSEN-SOURCE-DETAIL');
    await page.locator('.memory-context > summary').click();
    await expect(page.locator('.memory-context')).toContainText('ONLY-CHOSEN-SOURCE-DETAIL');
    await expect(page.locator('.memory-context')).not.toContainText(original.notes[0].body);
    await currentCards(page).getByRole('button', { name: 'Forget', exact: true }).click(); await saved(page);
    await expect(page.locator('.memory-context')).not.toContainText('ONLY-CHOSEN-SOURCE-DETAIL');
    const after = await readNativeRecord(page);
    assert.deepEqual(after.notes, original.notes); assert.deepEqual(after.messages, original.messages);
    const trash = page.locator('.memory-trash .memory-card');
    await trash.locator('.memory-history > summary').click();
    await trash.getByText('Read original source', { exact: true }).click();
    await expect(trash.locator('.memory-history')).toContainText(original.notes[0].body);
    verify();
  } finally { await context.close(); }
});

test('unfinished teaching and correction survive leaving the module and reload without entering context', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page);
    await detail(page).fill('UNSENT-TEACHING-CANARY'); await saved(page);
    await page.getByRole('button', { name: 'DATA', exact: true }).click();
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    await expect(detail(page)).toHaveValue('UNSENT-TEACHING-CANARY');
    await page.reload(); await expect(detail(page)).toHaveValue('UNSENT-TEACHING-CANARY');
    await page.locator('.memory-context > summary').click();
    await expect(page.locator('.memory-context')).not.toContainText('UNSENT-TEACHING-CANARY');
    await teaching(page).getByRole('button', { name: 'Save memory', exact: true }).click(); await saved(page);
    await currentCards(page).getByRole('button', { name: 'Correct', exact: true }).click();
    await currentCards(page).getByRole('textbox', { name: 'Corrected detail', exact: true }).fill('UNSENT-CORRECTION-CANARY'); await saved(page);
    await page.getByRole('button', { name: 'DATA', exact: true }).click();
    await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    const restoredCorrection = currentCards(page).getByRole('textbox', { name: 'Corrected detail', exact: true });
    await expect(restoredCorrection).toHaveValue('UNSENT-CORRECTION-CANARY');
    await expect(restoredCorrection).not.toBeFocused();
    await page.reload();
    await expect(restoredCorrection).toHaveValue('UNSENT-CORRECTION-CANARY');
    await expect(restoredCorrection).not.toBeFocused();
    await page.locator('.memory-context > summary').click();
    await expect(page.locator('.memory-context')).not.toContainText('UNSENT-CORRECTION-CANARY');
    verify();
  } finally { await context.close(); }
});

test('full browser storage retains attempted memory work, reports failure and retries the latest state', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await installNativeWriteFailure(context);
    await enter(page);
    const before = await readNativeRecordRaw(page);
    await page.evaluate(() => { window.__deskFailWrites = true; });
    await detail(page).fill('RETAINED-FAILED-MEMORY-CANARY');
    await expect(page.getByRole('alert', { name: 'Save recovery', exact: true })).toBeVisible();
    await teaching(page).getByRole('button', { name: 'Save memory', exact: true }).click();
    await expect(currentCards(page)).toContainText('RETAINED-FAILED-MEMORY-CANARY');
    assert.equal(await readNativeRecordRaw(page), before);
    await page.evaluate(() => { window.__deskFailWrites = false; });
    await page.getByRole('button', { name: 'Retry save', exact: true }).click(); await saved(page);
    await expect(page.getByRole('alert', { name: 'Save recovery', exact: true })).toHaveCount(0);
    await page.reload(); await expect(currentCards(page)).toContainText('RETAINED-FAILED-MEMORY-CANARY');
    verify();
  } finally { await context.close(); }
});

test('corrupt memory records refuse replacement and keep exact established bytes available for recovery', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enter(page); await remember(page, 'Preserve original memory work');
    const state = await readNativeRecord(page);
    state.memories[0].undo.previous = { body: 'Forged earlier value', use: 'active' };
    const raw = JSON.stringify(state);
    await writeNativeRecordRaw(page, WORKSPACE_DATABASE_NAME, raw, { notify: false });
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Workspace needs recovery', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download retained browser copy', exact: true })).toBeVisible();
    assert.equal(await readNativeRecordRaw(page), raw);
    verify();
  } finally { await context.close(); }
});

test('folder choice preserves picker focus and resets across rail choices without reviving a previous local scope', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await page.goto(origin); await saved(page);
    const state = await readNativeRecord(page); const first = state.goals[0];
    const second = { ...first, id: '00000000-0000-4000-8000-900000000001', title: 'Second sample scope', nextStep: '' };
    const third = { ...first, id: '00000000-0000-4000-8000-900000000002', title: 'Third sample scope', nextStep: '' };
    state.goals.push(second, third); state.goalDrafts[second.id] = { nextStep: null, workTitle: '' }; state.goalDrafts[third.id] = { nextStep: null, workTitle: '' };
    await writeNativeRecordRaw(page, WORKSPACE_DATABASE_NAME, JSON.stringify(state), { notify: false });
    await page.reload(); await page.getByRole('button', { name: 'CONTINUITY', exact: true }).click();
    const picker = teaching(page).getByRole('combobox', { name: 'Session folder', exact: true });
    await picker.focus(); await picker.selectOption(third.id); await expect(picker).toBeFocused();
    await detail(page).fill('Third-folder-only draft'); await saved(page);
    await page.locator(`.desktop-navigation .domain-link[data-domain-id="${second.id}"]`).click(); await expect(picker).toHaveValue(second.id);
    await page.locator(`.desktop-navigation .domain-link[data-domain-id="${first.id}"]`).click(); await expect(picker).toHaveValue(first.id);
    await expect(detail(page)).toHaveValue('');
    await picker.selectOption(third.id); await expect(detail(page)).toHaveValue('Third-folder-only draft');
    await remember(page, 'Third-folder correction sample');
    await currentCards(page).getByRole('button', { name: 'Correct', exact: true }).click();
    const correction = currentCards(page).getByRole('textbox', { name: 'Corrected detail', exact: true });
    await expect(correction).toBeFocused();
    await correction.fill('Keep this unfinished correction'); await saved(page);
    await picker.focus(); await picker.selectOption(second.id); await expect(picker).toBeFocused();
    await picker.selectOption(third.id); await expect(picker).toBeFocused();
    await expect(correction).toHaveValue('Keep this unfinished correction');
    await expect(correction).not.toBeFocused();
    await picker.selectOption(second.id); await expect(picker).toBeFocused();
    await expect(currentCards(page)).toHaveCount(0);
    verify();
  } finally { await context.close(); }
});

test('small touch viewport keeps memory controls visible, supports saving, and retains native privacy gates', async () => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await enter(page, true); await remember(page, 'Mobile invented preference');
    await expect(currentCards(page)).toContainText('Mobile invented preference');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Navigation', exact: true }).getByRole('button', { name: 'DATA', exact: true }).click();
    await expect(page.getByRole('button', { name: /Manage Trash/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Lock workspace/ })).toBeDisabled();
    verify();
  } finally { await context.close(); }
});
