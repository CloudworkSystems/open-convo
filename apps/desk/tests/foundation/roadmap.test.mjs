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
import { readRecordRaw } from './browser-persistence.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const workspaceKey = 'true-convo:desk:synthetic:v1';
const placementKey = 'true-convo:desk:roadmap:v1';
const placementDatabase = placementKey;
const placementStore = 'records';
const placementRecordKey = 'current';
const columnIds = ['suggested', 'next', 'in-progress', 'review', 'finished'];
const readWarning = 'Saved roadmap placement could not be read. Its original contents were kept. Changes here will last only for this visit.';
const saveWarning = 'Roadmap placement could not be saved. The previous saved placement was kept; changes here will last only for this visit.';
const coordinationWarning = 'This browser cannot coordinate roadmap saves between tabs. Changes here will last only for this visit.';
const databaseWarning = 'The roadmap database is unavailable. Changes here will last only for this visit; saved placement was kept.';
const recoveryWarning = 'The current saved roadmap placement is unavailable. This view uses the retained older copy; changes here will last only for this visit.';
let roadmap;
let server;
let browser;
let origin;
let screenshots;
let serverOutput = '';
let databaseOpenTimeoutMs;

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

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
  assert.ok(existsSync(join(root, 'dist/index.html')), 'Run npm run build before roadmap browser checks.');
  roadmap = JSON.parse(await readFile(join(root, 'src/content/recovery-roadmap.json'), 'utf8'));
  assert.equal(roadmap.schemaVersion, 1, 'Browser checks need a versioned roadmap source.');
  assert.ok(roadmap.cards.length > 0, 'The recovery source must contain cards.');
  assert.equal(new Set(roadmap.cards.map((card) => card.id)).size, roadmap.cards.length, 'Source card identities must be unique.');
  const persistenceSource = await readFile(join(root, 'src/adapters/indexeddb-record.ts'), 'utf8');
  const openDeadline = /export const INDEXEDDB_OPEN_TIMEOUT_MS\s*=\s*([\d_]+)\s*;/.exec(persistenceSource);
  assert.ok(openDeadline, 'The queued-open regression needs the exported native database deadline.');
  databaseOpenTimeoutMs = Number(openDeadline[1].replaceAll('_', ''));
  assert.ok(Number.isSafeInteger(databaseOpenTimeoutMs) && databaseOpenTimeoutMs > 0, 'The native database deadline must be a positive integer.');
  try {
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    screenshots = process.env.DESK_SCREENSHOT_DIR || await mkdtemp(join(tmpdir(), 'true-convo-roadmap-browser-'));
    await mkdir(screenshots, { recursive: true });
    // Serve the compiled app, so these checks catch bundled-content and CSP regressions.
    server = spawn('npm', ['run', 'start', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) {
      stream.on('data', (part) => { serverOutput = (serverOutput + part).slice(-12_000); });
    }
    let available = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (server.exitCode !== null) throw new Error(`Roadmap preview exited: ${serverOutput}`);
      try { if ((await fetch(origin)).ok) { available = true; break; } } catch { /* startup */ }
      await pause(100);
    }
    assert.ok(available, `Roadmap preview did not become ready: ${serverOutput}`);
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
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  const outside = [];
  const api = [];
  const errors = [];
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.href); return route.abort(); }
    if (url.pathname.startsWith('/api/')) api.push(url.pathname);
    return route.continue();
  });
  context.on('page', (page) => {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text().replace(/data:[^'"\s)]+/g, 'data:[embedded asset omitted]'));
    });
  });
  const page = await context.newPage();
  return {
    context, page,
    verify: () => {
      assert.deepEqual(outside, [], 'Roadmap attempted an outside-origin request.');
      assert.deepEqual(api, [], 'Roadmap attempted a legacy/private API request.');
      assert.deepEqual(errors, [], 'Roadmap reported an application or CSP error.');
    },
  };
}

async function navigate(page, name) {
  const views = page.getByRole('navigation', { name: 'Nexus views', exact: true });
  if (name === 'ROADMAP') {
    if (!await views.isVisible()) await navigate(page, 'NEXUS');
    await views.getByRole('button', { name: 'Roadmap', exact: true }).click();
    return;
  }
  if (name === 'NEXUS' && await views.isVisible()) {
    const navigator = views.getByRole('button', { name: 'Nexus Navigator', exact: true });
    if (await navigator.getAttribute('aria-current') !== 'page') await navigator.click();
    return;
  }
  const label = name === 'NEXUS' ? 'Cloudwork Nexus' : name;
  const mobileMenu = page.getByRole('button', { name: 'Open navigation', exact: true });
  if (await mobileMenu.isVisible()) {
    await mobileMenu.click();
    const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true });
    await drawer.getByRole('button', { name: label, exact: true }).click();
    await expect(drawer).not.toBeVisible();
  } else {
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  if (name === 'NEXUS') {
    const navigator = views.getByRole('button', { name: 'Nexus Navigator', exact: true });
    if (await navigator.getAttribute('aria-current') !== 'page') await navigator.click();
  }
}

async function enterDesk(page) {
  await page.goto(origin);
  await expect(page.getByText('Sample preview · sample data only', { exact: true })).toBeVisible();
  await navigate(page, 'NEXUS');
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Sample workspace saved in this browser' })).toBeVisible();
}

async function enterWork(page) {
  await enterDesk(page);
  await navigate(page, 'ROADMAP');
  await expect(page.getByRole('heading', { name: 'Recovery roadmap', exact: true })).toHaveCount(0);
  await expect(board(page)).toBeVisible();
  await expect(board(page).locator('.roadmap-move select').first()).toBeEnabled();
}

function board(page) {
  return page.getByRole('region', { name: 'Roadmap columns', exact: true });
}

function column(page, id) {
  return board(page).locator(`.roadmap-column[data-column="${id}"]`);
}

function cardNode(page, card) {
  return board(page).locator(`.roadmap-card[data-card-id="${card.id}"]`);
}

function mover(container, card) {
  return container.getByRole('combobox', { name: `Move ${card.title} to`, exact: true });
}

function differentColumn(id) {
  return columnIds[(columnIds.indexOf(id) + 1) % columnIds.length];
}

function defaultColumns() {
  return Object.fromEntries(columnIds.map((id) => [id, roadmap.cards.filter((card) => card.column === id).map((card) => card.id)]));
}

async function displayedColumns(page) {
  return board(page).evaluate((node) => Object.fromEntries([...node.querySelectorAll('.roadmap-column')].map((column) => [
    column.dataset.column,
    [...column.querySelectorAll('.roadmap-card')].map((card) => card.dataset.cardId),
  ])));
}

async function savedBytes(page, key = workspaceKey) {
  return readRecordRaw(page, key);
}

async function legacyBytes(page) {
  return page.evaluate((key) => localStorage.getItem(key), placementKey);
}

async function unloadBlocked(page) {
  return page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

// Read the native authority independently of the application adapter. Resolve
// after transaction completion, so a successful request in an aborted save
// can never be mistaken for a durable record.
async function savedRecord(page) {
  return page.evaluate(async ({ name, store, key }) => {
    if (!(await indexedDB.databases()).some((database) => database.name === name)) return undefined;
    return new Promise((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => reject(new Error('The native roadmap inspection was blocked.'));
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction(store, 'readonly');
        const reading = transaction.objectStore(store).get(key);
        let record;
        reading.onsuccess = () => { record = reading.result; };
        transaction.oncomplete = () => { database.close(); resolve(record); };
        transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Native roadmap inspection aborted.')); };
      };
    });
  }, { name: placementDatabase, store: placementStore, key: placementRecordKey });
}

async function savedPlacement(page) {
  const record = await savedRecord(page);
  return record === undefined ? null : record;
}

async function expectPlacementSaved(page) {
  const displayed = await displayedColumns(page);
  await expect.poll(async () => {
    const bytes = await savedPlacement(page);
    return bytes ? JSON.parse(bytes) : null;
  }).toEqual({ schemaVersion: 1, columns: displayed });
  await expect(page.locator('.roadmap-save-status')).toHaveText('Roadmap placement saves in this browser.');
  await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(0);
}

async function expectInColumn(page, card, id) {
  await expect(column(page, id).locator(`.roadmap-card[data-card-id="${card.id}"]`)).toHaveCount(1);
  await expect(cardNode(page, card)).toHaveCount(1);
  await expect(mover(cardNode(page, card), card)).toHaveValue(id);
}

async function openManual(page) {
  const create = page.getByRole('form', { name: 'Create a suggested card', exact: true });
  await expect(create).toHaveCount(1);
  await expect(create.getByRole('textbox', { name: 'Card title', exact: true })).toBeVisible();
  return create;
}

async function defaultDisplayedColumns(page) {
  const columns = defaultColumns();
  const state = JSON.parse(await savedBytes(page));
  for (const item of state.workItems) {
    const column = item.roadmapColumn === 'suggested' ? 'suggested'
      : item.status === 'active' ? 'in-progress' : item.status === 'returned' ? 'review' : 'next';
    columns[column].push(item.id);
  }
  return columns;
}

async function seedPlacement(context, bytes) {
  await context.addInitScript(({ key, bytes, origin }) => {
    // Seed once; reloading must expose any accidental overwrite or removal.
    if (location.origin === origin && localStorage.getItem(key) === null) localStorage.setItem(key, bytes);
  }, { key: placementKey, bytes, origin });
}

async function enterStorageFixture(page) {
  await page.route('**/__roadmap-storage-fixture.html', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<!doctype html><title>Invented roadmap storage fixture</title>',
  }));
  await page.goto(`${origin}/__roadmap-storage-fixture.html`);
}

async function seedSavedPlacement(page, record) {
  await enterStorageFixture(page);
  await page.evaluate(({ name, store, key, record }) => new Promise((resolve, reject) => {
    const opening = indexedDB.open(name, 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore(store);
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => reject(new Error('The native roadmap fixture was blocked.'));
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction(store, 'readwrite');
      transaction.objectStore(store).put(record, key);
      transaction.oncomplete = () => { database.close(); resolve(); };
      transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Native roadmap fixture aborted.')); };
    };
  }), { name: placementDatabase, store: placementStore, key: placementRecordKey, record });
}

test('every compiled recovery card keeps its source details, dependency context and accessible controls', { timeout: 60_000 }, async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterWork(page);
    await expect(board(page)).toHaveClass(/roadmap-board/);
    await expect(board(page).locator('.roadmap-column')).toHaveCount(columnIds.length);
    await expect(board(page).locator('.roadmap-card')).toHaveCount(roadmap.cards.length + JSON.parse(await savedBytes(page)).workItems.length);
    assert.deepEqual(await displayedColumns(page), await defaultDisplayedColumns(page));
    const workspace = await savedBytes(page);
    for (const card of roadmap.cards) {
      const node = cardNode(page, card);
      const open = node.getByRole('button', { name: `Open ${card.title}`, exact: true });
      await expect(open).toBeVisible();
      await expect(node).toContainText(card.track);
      await expect(mover(node, card)).toHaveValue(card.column);
      assert.deepEqual(await mover(node, card).locator('option').evaluateAll((options) => options.map((option) => option.value)), columnIds);
      await open.click();
      const dialog = page.getByRole('dialog', { name: card.title, exact: true });
      await expect(dialog).toBeVisible();
      for (const label of ['Recorded progress', 'Outcome', 'Checks', 'Dependencies', 'Evidence']) {
        await expect(dialog.getByText(label, { exact: true })).toBeVisible();
      }
      await expect(dialog).toContainText(card.sourceStatus);
      await expect(dialog).toContainText(card.outcome);
      for (const check of card.checks) await expect(dialog).toContainText(check);
      for (const id of card.dependsOn) {
        const dependency = roadmap.cards.find((candidate) => candidate.id === id);
        assert.ok(dependency, `Source dependency ${id} has no card.`);
        await expect(dialog).toContainText(dependency.title);
      }
      for (const evidence of card.sources) await expect(dialog).toContainText(evidence);
      for (const note of card.notes) await expect(dialog).toContainText(note);
      await expect(mover(dialog, card)).toHaveValue(card.column);
      await page.keyboard.press('Escape');
      await expect(dialog).not.toBeVisible();
    }
    assert.equal(await savedBytes(page), workspace, 'Opening roadmap details changed sample workspace records.');
    verify();
  } finally { await context.close(); }
});

test('keyboard card entry traps modal focus, moves through its labeled selector and returns focus', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterWork(page);
    const card = roadmap.cards[0];
    const open = cardNode(page, card).getByRole('button', { name: `Open ${card.title}`, exact: true });
    await open.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: card.title, exact: true });
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    const focusables = await dialog.locator('button:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]').count();
    for (let i = 0; i < focusables + 2; i += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, 'Focus escaped the roadmap modal.');
    }
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true);
    const target = card.column === 'finished' ? 'next' : 'finished';
    await mover(dialog, card).focus();
    // Native select popup keyboard behavior differs between macOS and Linux.
    // Select the value portably; the modal entry/trap/return remain keyboard checks.
    await mover(dialog, card).selectOption(target);
    await expect(mover(dialog, card)).toHaveValue(target);
    await expect(dialog).toContainText(card.sourceStatus);
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(open).toBeFocused();
    await expectInColumn(page, card, target);
    await expectPlacementSaved(page);
    verify();
  } finally { await context.close(); }
});

test('board moves restore the current selector after saving without taking focus from another control or modal', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await context.addInitScript((key) => {
      const request = navigator.locks.request.bind(navigator.locks);
      navigator.locks.request = (name, ...args) => {
        if (name !== `${key}:writer`) return request(name, ...args);
        const operation = args.at(-1);
        return request(name, ...args.slice(0, -1), async (...values) => {
          await new Promise((resolve) => { window.__releaseRoadmapSave = resolve; });
          window.__releaseRoadmapSave = null;
          return operation(...values);
        });
      };
    }, placementKey);
    await enterWork(page);
    const card = roadmap.cards[0];
    const other = roadmap.cards.find((item) => item.id !== card.id);
    const target = differentColumn(card.column);
    const moving = mover(cardNode(page, card), card);
    const otherButton = cardNode(page, other).getByRole('button', { name: `Open ${other.title}`, exact: true });
    const release = async () => {
      await expect.poll(() => page.evaluate(() => typeof window.__releaseRoadmapSave)).toBe('function');
      await page.evaluate(() => window.__releaseRoadmapSave());
      await expect(page.getByText('Saving roadmap placement…', { exact: true })).not.toBeVisible();
      await expectPlacementSaved(page);
    };

    await moving.focus();
    await moving.selectOption(target);
    await expect(page.getByText('Saving roadmap placement…', { exact: true })).toBeVisible();
    await release();
    await expectInColumn(page, card, target);
    await expect(moving).toBeFocused();

    await moving.selectOption(card.column);
    await expect(page.getByText('Saving roadmap placement…', { exact: true })).toBeVisible();
    await otherButton.focus();
    await release();
    await expect(otherButton).toBeFocused();
    await expectInColumn(page, card, card.column);

    await moving.focus();
    await moving.selectOption(target);
    await expect(page.getByText('Saving roadmap placement…', { exact: true })).toBeVisible();
    await otherButton.click();
    const dialog = page.getByRole('dialog', { name: other.title, exact: true });
    await expect(dialog).toBeVisible();
    await release();
    assert.equal(await dialog.evaluate((node) => node.contains(document.activeElement)), true, 'Completed save took focus from the open modal.');
    await expect(moving).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(otherButton).toBeFocused();
    verify();
  } finally { await context.close(); }
});

test('card moves persist separately from saved workspace bytes and keep recorded progress unchanged', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const draft = 'Invented conversation draft held while roadmap placement changes.';
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(draft);
    await expect.poll(async () => {
      const state = JSON.parse(await savedBytes(page));
      return state.drafts[state.selection.sessionId];
    }).toBe(draft);
    const workspace = await savedBytes(page);
    const revision = JSON.parse(workspace).revision;
    await navigate(page, 'ROADMAP');
    const card = roadmap.cards[0];
    const target = differentColumn(card.column);
    await mover(cardNode(page, card), card).selectOption(target);
    await expectInColumn(page, card, target);
    await expectPlacementSaved(page);
    assert.equal(await savedBytes(page), workspace);
    assert.equal(JSON.parse(await savedBytes(page)).revision, revision, 'A roadmap move advanced the sample workspace revision.');
    await cardNode(page, card).getByRole('button', { name: `Open ${card.title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: card.title, exact: true });
    await expect(dialog).toContainText(card.sourceStatus);
    await expect(dialog).toContainText(card.outcome);
    await expect(mover(dialog, card)).toHaveValue(target);
    await page.keyboard.press('Escape');
    await page.reload();
    await expectInColumn(page, card, target);
    assert.equal(await savedBytes(page), workspace);
    await navigate(page, 'NEXUS');
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(draft);
    await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('native desktop drag and drop changes placement once and survives reload without changing sample work', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterWork(page);
    const card = roadmap.cards.find((item) => item.column === 'next') ?? roadmap.cards[0];
    const target = differentColumn(card.column);
    const workspace = await savedBytes(page);
    await expect(cardNode(page, card)).toHaveAttribute('draggable', 'true');
    await page.evaluate(() => {
      window.__roadmapNativeDragEvents = [];
      for (const type of ['dragstart', 'drop']) document.addEventListener(type, (event) => {
        window.__roadmapNativeDragEvents.push({ type: event.type, trusted: event.isTrusted });
      }, true);
    });
    await cardNode(page, card).dragTo(column(page, target), {
      sourcePosition: { x: 12, y: 12 }, targetPosition: { x: 40, y: 30 },
    });
    await expectInColumn(page, card, target);
    assert.deepEqual(await page.evaluate(() => window.__roadmapNativeDragEvents), [
      { type: 'dragstart', trusted: true }, { type: 'drop', trusted: true },
    ], 'The browser check must exercise native drag events.');
    await expectPlacementSaved(page);
    assert.equal(await savedBytes(page), workspace);
    await page.reload();
    await expectInColumn(page, card, target);
    await expect(board(page).locator('.roadmap-card')).toHaveCount(roadmap.cards.length + JSON.parse(await savedBytes(page)).workItems.length);
    assert.equal(await savedBytes(page), workspace);
    verify();
  } finally { await context.close(); }
});

test('native downward drop onto the adjacent card changes ordering and retains shared work and source evidence', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterWork(page);
    const [first, second] = roadmap.cards.filter((card) => card.column === 'next');
    assert.ok(first && second, 'Adjacent ordering requires two Planned source cards.');
    const original = (await displayedColumns(page)).next;
    assert.equal(original.indexOf(second.id), original.indexOf(first.id) + 1);
    const workspace = await savedBytes(page);
    await cardNode(page, first).dragTo(cardNode(page, second), {
      sourcePosition: { x: 12, y: 12 }, targetPosition: { x: 20, y: 20 },
    });
    const expected = [...original];
    const firstIndex = expected.indexOf(first.id);
    expected.splice(firstIndex, 2, second.id, first.id);
    await expect.poll(async () => (await displayedColumns(page)).next).toEqual(expected);
    await expectPlacementSaved(page);
    assert.equal(await savedBytes(page), workspace, 'Ordering changed the shared work or conversation records.');
    for (const card of [first, second]) await expect(cardNode(page, card)).toContainText(card.sourceStatus);
    await page.reload();
    assert.deepEqual((await displayedColumns(page)).next, expected);
    assert.equal(await savedBytes(page), workspace);
    verify();
  } finally { await context.close(); }
});

test('legacy placement stays byte-for-byte intact while the first successful move creates the canonical record', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    assert.ok(roadmap.cards.length >= 2, 'Migration checks need two source cards.');
    const [first, second] = roadmap.cards;
    const firstTarget = differentColumn(first.column);
    const secondTarget = differentColumn(second.column);
    const columns = defaultColumns();
    columns[first.column] = columns[first.column].filter((id) => id !== first.id);
    columns[firstTarget].push(first.id);
    delete columns.suggested;
    const legacy = JSON.stringify({ schemaVersion: 1, columns }, null, 2);
    await seedPlacement(context, legacy);
    await enterWork(page);
    await expectInColumn(page, first, firstTarget);
    assert.equal(await legacyBytes(page), legacy);
    assert.equal(await savedPlacement(page), null, 'Reading a legacy plan eagerly migrated it.');
    const workspace = await savedBytes(page);
    await mover(cardNode(page, second), second).selectOption(secondTarget);
    await expectInColumn(page, first, firstTarget);
    await expectInColumn(page, second, secondTarget);
    await expectPlacementSaved(page);
    const canonical = await savedPlacement(page);
    assert.equal(typeof canonical, 'string', 'Canonical placement must be a native serialized record.');
    const expected = { ...columns, suggested: [] };
    expected.next = [...expected.next, ...JSON.parse(workspace).workItems.map((item) => item.id)];
    expected[second.column] = expected[second.column].filter((id) => id !== second.id);
    expected[secondTarget] = [...expected[secondTarget], second.id];
    assert.deepEqual(JSON.parse(canonical), { schemaVersion: 1, columns: expected });
    assert.equal(await legacyBytes(page), legacy, 'Migration rewrote the legacy saved bytes.');
    assert.equal(await savedBytes(page), workspace);
    await page.reload();
    await expectInColumn(page, first, firstTarget);
    await expectInColumn(page, second, secondTarget);
    assert.equal(await savedPlacement(page), canonical);
    assert.equal(await legacyBytes(page), legacy);
    const changedLegacy = JSON.stringify({ schemaVersion: 1, columns: defaultColumns() }, null, 4);
    await page.evaluate(({ key, bytes }) => localStorage.setItem(key, bytes), { key: placementKey, bytes: changedLegacy });
    await page.reload();
    await expectInColumn(page, first, firstTarget);
    await expectInColumn(page, second, secondTarget);
    assert.equal(await savedPlacement(page), canonical, 'A subsequent legacy change displaced canonical placement.');
    assert.equal(await legacyBytes(page), changedLegacy, 'The app mirrored canonical placement over the legacy baseline.');
    assert.equal(await savedBytes(page), workspace);
    verify();
  } finally { await context.close(); }
});

for (const [name, fixture] of [
  ['malformed JSON', () => '{"invented-placement-do-not-render":'],
  ['an unsupported version', () => JSON.stringify({ schemaVersion: 99, columns: defaultColumns(), note: 'invented-placement-do-not-render' })],
  ['a malformed column', () => JSON.stringify({ schemaVersion: 1, columns: { ...defaultColumns(), next: 'invented-placement-do-not-render' } })],
]) {
  test(`roadmap storage with ${name} preserves original bytes and allows temporary moves`, async () => {
    const { context, page, verify } = await isolatedPage();
    try {
      const damaged = fixture();
      await seedPlacement(context, damaged);
      await enterWork(page);
      await expect(page.getByText(readWarning, { exact: true })).toBeVisible();
      assert.equal(await legacyBytes(page), damaged);
      assert.equal(await savedPlacement(page), null, 'Unreadable legacy storage became canonical.');
      assert.deepEqual(await displayedColumns(page), await defaultDisplayedColumns(page));
      await expect(page.locator('body')).not.toContainText('invented-placement-do-not-render');
      const workspace = await savedBytes(page);
      const card = roadmap.cards[0];
      const target = differentColumn(card.column);
      await mover(cardNode(page, card), card).selectOption(target);
      await expectInColumn(page, card, target);
      assert.equal(await legacyBytes(page), damaged, 'A temporary move replaced damaged storage.');
      assert.equal(await savedPlacement(page), null, 'A temporary move migrated unreadable legacy storage.');
      assert.equal(await savedBytes(page), workspace);
      await expect(page.getByText(readWarning, { exact: true })).toBeVisible();
      await page.reload();
      await expectInColumn(page, card, card.column);
      assert.equal(await legacyBytes(page), damaged);
      assert.equal(await savedPlacement(page), null);
      assert.equal(await savedBytes(page), workspace);
      await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
      verify();
    } finally { await context.close(); }
  });
}

for (const [name, fixture] of [
  ['malformed JSON', () => '{"invented-canonical-do-not-render":'],
  ['an unsupported version', () => JSON.stringify({ schemaVersion: 99, columns: defaultColumns(), note: 'invented-canonical-do-not-render' })],
  ['a malformed column', () => JSON.stringify({ schemaVersion: 1, columns: { ...defaultColumns(), next: 'invented-canonical-do-not-render' } })],
  ['an unknown null record', () => null],
]) {
  test(`canonical roadmap storage with ${name} stays intact and never falls back over its authority`, async () => {
    const { context, page, verify } = await isolatedPage();
    try {
      const card = roadmap.cards[0];
      const legacyColumn = differentColumn(card.column);
      const columns = defaultColumns();
      columns[card.column] = columns[card.column].filter((id) => id !== card.id);
      columns[legacyColumn].push(card.id);
      const legacy = JSON.stringify({ schemaVersion: 1, columns }, null, 2);
      const damaged = fixture();
      await seedPlacement(context, legacy);
      await seedSavedPlacement(page, damaged);
      await enterWork(page);
      await expect(page.getByText(readWarning, { exact: true })).toBeVisible();
      assert.deepEqual(await savedRecord(page), damaged);
      assert.equal(await legacyBytes(page), legacy);
      assert.deepEqual(await displayedColumns(page), await defaultDisplayedColumns(page), 'Unreadable canonical placement silently fell back to a different legacy plan.');
      await expect(page.locator('body')).not.toContainText('invented-canonical-do-not-render');
      const workspace = await savedBytes(page);
      const target = differentColumn(card.column);
      await mover(cardNode(page, card), card).selectOption(target);
      await expectInColumn(page, card, target);
      await expect(page.getByText(readWarning, { exact: true })).toBeVisible();
      await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(1);
      assert.deepEqual(await savedRecord(page), damaged, 'A temporary move replaced an unreadable canonical record.');
      assert.equal(await legacyBytes(page), legacy);
      assert.equal(await savedBytes(page), workspace);
      await page.reload();
      await expectInColumn(page, card, card.column);
      await expect(page.getByText(readWarning, { exact: true })).toBeVisible();
      assert.deepEqual(await savedRecord(page), damaged);
      assert.equal(await legacyBytes(page), legacy);
      assert.equal(await savedBytes(page), workspace);
      await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
      verify();
    } finally { await context.close(); }
  });
}

for (const [name, hasLegacy] of [
  ['unavailable roadmap database', true],
  ['denied roadmap database access', true],
  ['denied roadmap database access', false],
]) {
  test(`${name} keeps roadmap moves temporary ${hasLegacy ? 'and preserves legacy bytes' : 'without a retained copy'}`, async () => {
    const { context, page, verify } = await isolatedPage();
    try {
      const card = roadmap.cards[0];
      const savedColumn = differentColumn(card.column);
      const columns = defaultColumns();
      columns[card.column] = columns[card.column].filter((id) => id !== card.id);
      columns[savedColumn].push(card.id);
      const legacy = hasLegacy ? JSON.stringify({ schemaVersion: 1, columns }, null, 2) : null;
      if (hasLegacy) await seedPlacement(context, legacy);
      // Roadmap is mounted even while the Nexus module is visible. Deny its
      // database before bootstrap, while keeping workspace storage available.
      await context.addInitScript(({ name, database, store }) => {
        window.__roadmapUnavailableWrites = 0;
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function (...args) {
          if (this.transaction.db.name === database && this.name === store) window.__roadmapUnavailableWrites += 1;
          return put.apply(this, args);
        };
        const open = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (databaseName, ...args) {
          if (databaseName === database && sessionStorage.getItem('invented-roadmap-fixture:access-restored') !== 'yes') {
            throw new DOMException('Invented roadmap-only storage unavailability', name === 'unavailable roadmap database' ? 'NotSupportedError' : 'SecurityError');
          }
          return open.call(this, databaseName, ...args);
        };
      }, { name, database: placementDatabase, store: placementStore });
      await enterDesk(page);
      const workspace = await savedBytes(page);
      const probe = await context.newPage();
      await enterStorageFixture(probe);
      await navigate(page, 'ROADMAP');
      await expect(board(page).locator('.roadmap-move select').first()).toBeEnabled();
      const expectedWarning = hasLegacy ? recoveryWarning : databaseWarning;
      await expect(page.getByText(expectedWarning, { exact: true })).toBeVisible();
      await expectInColumn(page, card, hasLegacy ? savedColumn : card.column);
      const temporaryColumn = differentColumn(savedColumn);
      await mover(cardNode(page, card), card).selectOption(temporaryColumn);
      await expectInColumn(page, card, temporaryColumn);
      await expect(page.getByText(expectedWarning, { exact: true })).toBeVisible();
      await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(1);
      assert.equal(await page.evaluate(() => window.__roadmapUnavailableWrites), 0, 'Unavailable roadmap storage still attempted a write.');
      assert.equal(await legacyBytes(page), legacy);
      assert.equal(await savedBytes(probe), workspace);
      assert.equal(await savedPlacement(probe), null, 'A temporary move initialized canonical placement.');
      const manual = await openManual(page);
      const title = `Invented manual sample saved with ${name}`;
      await manual.getByRole('textbox', { name: 'Card title', exact: true }).fill(title);
      await manual.getByRole('button', { name: 'Create card', exact: true }).click();
      await expect.poll(async () => JSON.parse(await savedBytes(probe)).workItems.some((item) => item.title === title)).toBe(true);
      assert.equal(await legacyBytes(page), legacy);
      await probe.close();
      await page.evaluate(() => sessionStorage.setItem('invented-roadmap-fixture:access-restored', 'yes'));
      await page.reload();
      await expectInColumn(page, card, hasLegacy ? savedColumn : card.column);
      await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(0);
      await expect(board(page).getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
      assert.equal(await savedPlacement(page), null);
      assert.equal(await legacyBytes(page), legacy);
      await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
      verify();
    } finally { await context.close(); }
  });
}

test('an open queued behind blocked native deletion reaches its deadline and closes its late connection', { timeout: 20_000 }, async () => {
  const { context, page, verify } = await isolatedPage();
  let blocker;
  try {
    const card = roadmap.cards[0];
    const backupColumn = differentColumn(card.column);
    const canonicalColumn = differentColumn(backupColumn);
    const temporaryColumn = differentColumn(canonicalColumn);
    const backupColumns = defaultColumns();
    backupColumns[card.column] = backupColumns[card.column].filter((id) => id !== card.id);
    backupColumns[backupColumn].push(card.id);
    const legacy = JSON.stringify({ schemaVersion: 1, columns: backupColumns }, null, 2);
    const canonicalColumns = defaultColumns();
    canonicalColumns[card.column] = canonicalColumns[card.column].filter((id) => id !== card.id);
    canonicalColumns[canonicalColumn].push(card.id);
    const canonical = JSON.stringify({ schemaVersion: 1, columns: canonicalColumns });
    await seedPlacement(context, legacy);
    await seedSavedPlacement(page, canonical);
    blocker = await context.newPage();
    await enterStorageFixture(blocker);
    await blocker.evaluate(({ name, store, key, canonical }) => new Promise((resolve, reject) => {
      window.__roadmapDeleteQueue = { blocked: false, deleted: false, restored: false, deleteError: null, restoreError: null };
      const opening = indexedDB.open(name, 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        window.__heldRoadmapDatabase = database;
        // Keep this invented connection open through versionchange so that
        // deletion really blocks. A same-version open alone would not block.
        database.onversionchange = () => {};
        const deleting = indexedDB.deleteDatabase(name);
        deleting.onblocked = () => { window.__roadmapDeleteQueue.blocked = true; resolve(); };
        deleting.onsuccess = () => { window.__roadmapDeleteQueue.deleted = true; };
        deleting.onerror = () => { window.__roadmapDeleteQueue.deleteError = deleting.error?.name; reject(deleting.error); };
        // Queue restoration before the app's open. After release this puts
        // back the same invented bytes, allowing the late app request to
        // succeed at v1 and exercise its close guard instead of upgrade abort.
        const restoring = indexedDB.open(name, 1);
        restoring.onupgradeneeded = () => {
          restoring.result.createObjectStore(store);
          restoring.transaction.objectStore(store).put(canonical, key);
        };
        restoring.onsuccess = () => { restoring.result.close(); window.__roadmapDeleteQueue.restored = true; };
        restoring.onerror = () => { window.__roadmapDeleteQueue.restoreError = restoring.error?.name; };
      };
    }), { name: placementDatabase, store: placementStore, key: placementRecordKey, canonical });
    await page.addInitScript(({ name, store, channel, warning }) => {
      window.__roadmapQueuedOpen = { calls: 0, blocked: 0, success: 0, closed: 0, puts: 0, notifications: 0, startedAt: null };
      window.__roadmapQueuedOpenObservation = { pendingControls: null, enabledBeforeRecovery: false, recoveryAt: null };
      // Work stays mounted while another view is visible, so its database open
      // can reach the deadline before the test driver finishes navigation.
      // Record the loading guard and actual recovery time in the browser, from
      // before the app starts, without delaying its native open or deadline.
      const observe = () => {
        const startedAt = window.__roadmapQueuedOpen.startedAt;
        if (startedAt === null) return;
        const observation = window.__roadmapQueuedOpenObservation;
        const elapsed = performance.now() - startedAt;
        if (document.querySelector('.roadmap-warning')?.textContent === warning) {
          observation.recoveryAt = elapsed;
          observer.disconnect();
          return;
        }
        const controls = [...document.querySelectorAll('.roadmap-board .roadmap-move select')];
        if (!controls.length) return;
        observation.pendingControls ??= { at: elapsed, count: controls.length, allDisabled: controls.every((control) => control.disabled) };
        if (controls.some((control) => !control.disabled)) observation.enabledBeforeRecovery = true;
      };
      const observer = new MutationObserver(observe);
      observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
      const open = IDBFactory.prototype.open;
      IDBFactory.prototype.open = function (databaseName, ...args) {
        const request = open.call(this, databaseName, ...args);
        if (databaseName === name) {
          window.__roadmapQueuedOpen.calls += 1;
          window.__roadmapQueuedOpen.startedAt ??= performance.now();
          observe();
          request.addEventListener('blocked', () => { window.__roadmapQueuedOpen.blocked += 1; });
          request.addEventListener('success', () => { window.__roadmapQueuedOpen.success += 1; });
        }
        return request;
      };
      const close = IDBDatabase.prototype.close;
      IDBDatabase.prototype.close = function (...args) {
        if (this.name === name) window.__roadmapQueuedOpen.closed += 1;
        return close.apply(this, args);
      };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === name && this.name === store) window.__roadmapQueuedOpen.puts += 1;
        return put.apply(this, args);
      };
      const notify = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (...args) {
        if (this.name === channel) window.__roadmapQueuedOpen.notifications += 1;
        return notify.apply(this, args);
      };
    }, { name: placementDatabase, store: placementStore, channel: `${placementDatabase}:commits`, warning: recoveryWarning });
    await enterDesk(page);
    // Deliberately inspect from the driver after the native deadline, so the
    // loading assertions prove the recorded browser state even with a late
    // actor. This wait neither holds the open nor changes the production timer.
    await page.waitForFunction((deadline) => {
      const startedAt = window.__roadmapQueuedOpen.startedAt;
      return startedAt !== null && performance.now() - startedAt >= deadline;
    }, databaseOpenTimeoutMs + 100, { timeout: databaseOpenTimeoutMs + 2_000 });
    const workspace = await savedBytes(page);
    await navigate(page, 'ROADMAP');
    await expect(board(page)).toBeVisible();
    // The bound follows the production deadline; two seconds cover browser
    // task delivery and React rendering after rejection, not a longer retry.
    const recoveryBound = databaseOpenTimeoutMs + 2_000;
    await expect(page.getByText(recoveryWarning, { exact: true })).toBeVisible({ timeout: recoveryBound });
    const observation = await page.evaluate(() => window.__roadmapQueuedOpenObservation);
    assert.ok(observation.pendingControls?.count > 0, 'The queued open must expose its loading controls.');
    assert.equal(observation.pendingControls.allDisabled, true, 'Every selector must start disabled while the native read is pending.');
    assert.ok(observation.pendingControls.at < databaseOpenTimeoutMs, 'The loading guard must be observed before the native deadline.');
    assert.equal(observation.enabledBeforeRecovery, false, 'No selector may become enabled before the recovery view is recorded.');
    const elapsed = observation.recoveryAt;
    assert.notEqual(elapsed, null, 'The browser must record when recovery first appears.');
    assert.ok(elapsed >= databaseOpenTimeoutMs - 100 && elapsed <= recoveryBound, `Queued roadmap open recovered outside its deadline margin: ${elapsed}ms.`);
    await expect(board(page).locator('.roadmap-move select').first()).toBeEnabled();
    await expectInColumn(page, card, backupColumn);
    assert.deepEqual(await page.evaluate(() => {
      const { startedAt, ...state } = window.__roadmapQueuedOpen;
      return state;
    }), { calls: 1, blocked: 0, success: 0, closed: 0, puts: 0, notifications: 0 }, 'The deadline must handle an open whose own blocked event never fires.');
    await mover(cardNode(page, card), card).selectOption(temporaryColumn);
    await expectInColumn(page, card, temporaryColumn);
    await expect(page.getByText(recoveryWarning, { exact: true })).toBeVisible();
    await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(1);
    const heldRaw = await blocker.evaluate(({ store, key }) => new Promise((resolve, reject) => {
      const transaction = window.__heldRoadmapDatabase.transaction(store, 'readonly');
      const reading = transaction.objectStore(store).get(key);
      let raw;
      reading.onsuccess = () => { raw = reading.result; };
      transaction.oncomplete = () => resolve(raw);
      transaction.onabort = () => reject(transaction.error);
    }), { store: placementStore, key: placementRecordKey });
    assert.equal(heldRaw, canonical, 'A timed-out roadmap move changed primary bytes before the blocker was released.');
    assert.deepEqual(await blocker.evaluate(() => window.__roadmapDeleteQueue), {
      blocked: true, deleted: false, restored: false, deleteError: null, restoreError: null,
    });
    assert.equal(await legacyBytes(page), legacy);
    assert.equal(await savedBytes(page), workspace);
    await blocker.evaluate(() => { window.__heldRoadmapDatabase.close(); window.__heldRoadmapDatabase = null; });
    await expect.poll(() => blocker.evaluate(() => window.__roadmapDeleteQueue.restored)).toBe(true);
    await expect.poll(() => page.evaluate(() => window.__roadmapQueuedOpen.success)).toBe(1);
    assert.deepEqual(await blocker.evaluate(() => window.__roadmapDeleteQueue), {
      blocked: true, deleted: true, restored: true, deleteError: null, restoreError: null,
    });
    assert.deepEqual(await page.evaluate(() => {
      const { startedAt, ...state } = window.__roadmapQueuedOpen;
      return state;
    }), { calls: 1, blocked: 0, success: 1, closed: 1, puts: 0, notifications: 0 }, 'The late open must close without writing or announcing a saved placement.');
    assert.equal(await savedPlacement(blocker), canonical);
    await expectInColumn(page, card, temporaryColumn);
    await expect(page.getByText(recoveryWarning, { exact: true })).toBeVisible();
    await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(1);
    assert.equal(await legacyBytes(page), legacy);
    assert.equal(await savedBytes(page), workspace);
    await blocker.evaluate((name) => new Promise((resolve, reject) => {
      const deleting = indexedDB.deleteDatabase(name);
      deleting.onblocked = () => reject(new Error('The timed-out roadmap open leaked its late native connection.'));
      deleting.onerror = () => reject(deleting.error);
      deleting.onsuccess = () => resolve();
    }), placementDatabase);
    verify();
  } finally {
    if (blocker && !blocker.isClosed()) {
      await blocker.evaluate(() => { window.__heldRoadmapDatabase?.close(); window.__heldRoadmapDatabase = null; }).catch(() => {});
    }
    await context.close();
  }
});

test('a roadmap-only save failure preserves the previous placement and keeps sample record saving available', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    const legacy = JSON.stringify({ schemaVersion: 1, columns: defaultColumns() }, null, 2);
    await seedPlacement(context, legacy);
    await enterWork(page);
    const card = roadmap.cards[0];
    const savedColumn = differentColumn(card.column);
    await mover(cardNode(page, card), card).selectOption(savedColumn);
    await expectPlacementSaved(page);
    const placement = await savedPlacement(page);
    const workspace = await savedBytes(page);
    const other = await context.newPage();
    await enterWork(other);
    await expectInColumn(other, card, savedColumn);
    await page.evaluate(({ name, store, channel }) => {
      window.__roadmapAbortedSave = { put: 0, success: 0, abort: 0, complete: 0, notifications: 0 };
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        if (this.transaction.db.name === name && this.name === store) {
          window.__roadmapAbortedSave.put += 1;
          const transaction = this.transaction;
          request.addEventListener('success', () => {
            window.__roadmapAbortedSave.success += 1;
            transaction.abort();
          }, { once: true });
          transaction.addEventListener('abort', () => { window.__roadmapAbortedSave.abort += 1; }, { once: true });
          transaction.addEventListener('complete', () => { window.__roadmapAbortedSave.complete += 1; }, { once: true });
        }
        return request;
      };
      const notify = BroadcastChannel.prototype.postMessage;
      BroadcastChannel.prototype.postMessage = function (...args) {
        if (this.name === channel) window.__roadmapAbortedSave.notifications += 1;
        return notify.apply(this, args);
      };
    }, { name: placementDatabase, store: placementStore, channel: `${placementDatabase}:commits` });
    const temporaryColumn = differentColumn(savedColumn);
    await mover(cardNode(page, card), card).selectOption(temporaryColumn);
    await expectInColumn(page, card, temporaryColumn);
    await expect(page.getByText(saveWarning, { exact: true })).toBeVisible();
    await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(1);
    assert.equal(await savedPlacement(page), placement, 'A put that later aborted replaced durable placement.');
    assert.equal(await legacyBytes(page), legacy);
    assert.deepEqual(await page.evaluate(() => window.__roadmapAbortedSave), {
      put: 1, success: 1, abort: 1, complete: 0, notifications: 0,
    }, 'The fixture must abort a real successful put and emit no saved-placement notification.');
    await expectInColumn(other, card, savedColumn);
    assert.equal(await savedBytes(page), workspace);
    await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    await navigate(page, 'CONTINUITY');
    await navigate(page, 'ROADMAP');
    await expectInColumn(page, card, temporaryColumn);
    await expect(page.getByText(saveWarning, { exact: true })).toBeVisible();
    await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(1);
    assert.equal(await savedPlacement(page), placement);
    assert.equal(await legacyBytes(page), legacy);
    assert.equal(await unloadBlocked(page), true, 'A failed placement must warn before browser navigation.');
    await navigate(page, 'CONTINUITY');
    await expect(board(page)).toHaveCount(0);
    assert.equal(await unloadBlocked(page), true, 'Leaving Roadmap must keep the retained failed placement protected.');
    await navigate(page, 'ROADMAP');
    await expectInColumn(page, card, temporaryColumn);
    const manual = await openManual(page);
    const title = 'Invented manual record saved despite an aborted roadmap transaction';
    await manual.getByRole('textbox', { name: 'Card title', exact: true }).fill(title);
    await manual.getByRole('button', { name: 'Create card', exact: true }).click();
    await expect.poll(async () => JSON.parse(await savedBytes(page)).workItems.some((item) => item.title === title)).toBe(true);
    assert.equal(await savedPlacement(page), placement);
    assert.equal(await legacyBytes(page), legacy);
    await page.reload();
    await expectInColumn(page, card, savedColumn);
    await expect(page.locator('[data-preview-refresh-hold="roadmap-placement"]')).toHaveCount(0);
    assert.equal(await unloadBlocked(page), false, 'Explicit reload starts from saved placement without a retained failed attempt.');
    await expect(board(page).getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
    assert.equal(await savedPlacement(page), placement);
    assert.equal(await legacyBytes(page), legacy);
    verify();
  } finally { await context.close(); }
});

test('without Web Locks saved placement can be read but all roadmap moves stay temporary', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    const card = roadmap.cards[0];
    const savedColumn = differentColumn(card.column);
    const columns = defaultColumns();
    columns[card.column] = columns[card.column].filter((id) => id !== card.id);
    columns[savedColumn].push(card.id);
    const originalBytes = JSON.stringify({ schemaVersion: 1, columns }, null, 2);
    await context.addInitScript(({ key, store, bytes, origin }) => {
      if (location.origin !== origin) return;
      if (localStorage.getItem(key) === null) localStorage.setItem(key, bytes);
      Object.defineProperty(navigator, 'locks', { value: undefined });
      const original = IDBObjectStore.prototype.put;
      window.__roadmapWriteAttempts = 0;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.transaction.db.name === key && this.name === store) window.__roadmapWriteAttempts += 1;
        return original.apply(this, args);
      };
    }, { key: placementKey, store: placementStore, bytes: originalBytes, origin });
    // Without its coordination primitive, the workspace retains attempted
    // edits with its own failed-save notice. Independent board moves stay
    // temporary and must never overwrite a saved placement.
    await page.goto(origin);
    await expect(page.getByText('Sample preview · sample data only', { exact: true })).toBeVisible();
    await navigate(page, 'ROADMAP');
    await expect(board(page)).toBeVisible();
    await expect(page.getByText(coordinationWarning, { exact: true })).toBeVisible();
    await expectInColumn(page, card, savedColumn);
    const workspace = await savedBytes(page);
    const temporaryColumn = differentColumn(savedColumn);
    await mover(cardNode(page, card), card).selectOption(temporaryColumn);
    await expectInColumn(page, card, temporaryColumn);
    assert.equal(await legacyBytes(page), originalBytes, 'An uncoordinated move replaced the previous saved plan.');
    assert.equal(await page.evaluate(() => window.__roadmapWriteAttempts), 0, 'Roadmap attempted an uncoordinated save.');
    assert.equal(await savedPlacement(page), null, 'An uncoordinated move initialized canonical placement.');
    assert.equal(await savedBytes(page), workspace);
    await expect(page.getByText(coordinationWarning, { exact: true })).toBeVisible();
    await page.reload();
    // No workspace was saved without its write lock. A fresh invented
    // workspace has new IDs, so its previous tab selection cannot be restored.
    // Reopen Roadmap to inspect the independently saved roadmap placement.
    await navigate(page, 'ROADMAP');
    await expect(board(page)).toBeVisible();
    await expectInColumn(page, card, savedColumn);
    assert.equal(await legacyBytes(page), originalBytes);
    assert.equal(await page.evaluate(() => window.__roadmapWriteAttempts), 0);
    assert.equal(await savedPlacement(page), null);
    verify();
  } finally { await context.close(); }
});

test('roadmap moves do not interrupt another tab or trigger synthetic workspace conflicts', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const draft = 'Invented shared draft retained when another tab moves roadmap cards.';
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.fill(draft);
    await expect.poll(async () => {
      const state = JSON.parse(await savedBytes(page));
      return state.drafts[state.selection.sessionId];
    }).toBe(draft);
    const other = await context.newPage();
    await enterDesk(other);
    const otherComposer = other.getByRole('textbox', { name: 'Your message', exact: true });
    await expect(otherComposer).toHaveValue(draft);
    const workspace = await savedBytes(page);
    await navigate(page, 'ROADMAP');
    const card = roadmap.cards[0];
    await mover(cardNode(page, card), card).selectOption(differentColumn(card.column));
    await expectPlacementSaved(page);
    assert.equal(await savedBytes(page), workspace);
    assert.equal(await savedBytes(other), workspace);
    await expect(otherComposer).toHaveValue(draft);
    await expect(otherComposer).toBeEditable();
    await expect(other.getByRole('button', { name: 'Send demo message', exact: true })).toBeEnabled();
    await expect(other.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    await expect(page.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    await other.reload();
    await expect(otherComposer).toHaveValue(draft);
    await expect(other.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('two tabs moving independent cards retain both placements and keep an open detail dialog', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterWork(page);
    const other = await context.newPage();
    await enterWork(other);
    assert.ok(roadmap.cards.length >= 2, 'Concurrent placement checks need two source cards.');
    const [first, second] = roadmap.cards;
    const firstTarget = differentColumn(first.column);
    const secondTarget = differentColumn(second.column);
    const workspace = await savedBytes(page);
    await cardNode(page, first).getByRole('button', { name: `Open ${first.title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: first.title, exact: true });
    await Promise.all([
      mover(dialog, first).selectOption(firstTarget),
      mover(cardNode(other, second), second).selectOption(secondTarget),
    ]);
    for (const tab of [page, other]) {
      await expectInColumn(tab, first, firstTarget);
      await expectInColumn(tab, second, secondTarget);
      await expectPlacementSaved(tab);
      assert.equal(await savedBytes(tab), workspace, 'Concurrent planning changes wrote shared workspace records.');
      await expect(tab.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    }
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(first.sourceStatus);
    await expect(mover(dialog, first)).toHaveValue(firstTarget);
    await page.keyboard.press('Escape');
    await Promise.all([page.reload(), other.reload()]);
    for (const tab of [page, other]) {
      await expectInColumn(tab, first, firstTarget);
      await expectInColumn(tab, second, secondTarget);
      assert.equal(await savedBytes(tab), workspace);
    }
    verify();
  } finally { await context.close(); }
});

test('two tabs moving independent cards preserve newer saved placement when the earlier result arrives late', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    // Delay result delivery after the first native Web Lock has been released.
    // The other tab can finish a real coordinated write during that delay.
    await page.addInitScript(() => {
      if (!navigator.locks) return;
      const request = navigator.locks.request.bind(navigator.locks);
      navigator.locks.request = async (...args) => {
        const result = await request(...args);
        if (args[0] === 'true-convo:desk:roadmap:v1:writer' && window.__holdRoadmapResult) {
          window.__roadmapResultWaiting = true;
          await new Promise((resolve) => { window.__releaseRoadmapResult = resolve; });
        }
        return result;
      };
    });
    await enterWork(page);
    const other = await context.newPage();
    await enterWork(other);
    assert.ok(roadmap.cards.length >= 2, 'Concurrent placement checks need two source cards.');
    const [first, second] = roadmap.cards;
    const firstTarget = differentColumn(first.column);
    const secondTarget = differentColumn(second.column);
    const workspace = await savedBytes(page);
    await cardNode(page, first).getByRole('button', { name: `Open ${first.title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: first.title, exact: true });
    await page.evaluate(() => { window.__holdRoadmapResult = true; });
    await mover(dialog, first).selectOption(firstTarget);
    await expect.poll(() => page.evaluate(() => window.__roadmapResultWaiting)).toBe(true);
    await mover(cardNode(other, second), second).selectOption(secondTarget);
    await expectInColumn(other, first, firstTarget);
    await expectInColumn(other, second, secondTarget);
    await expectPlacementSaved(other);
    await expectInColumn(page, second, secondTarget);
    await expect(dialog).toBeVisible();
    await page.evaluate(() => {
      window.__holdRoadmapResult = false;
      window.__releaseRoadmapResult();
    });
    await expect(page.locator('.roadmap-save-status')).toHaveText('Roadmap placement saves in this browser.');
    for (const tab of [page, other]) {
      await expectInColumn(tab, first, firstTarget);
      await expectInColumn(tab, second, secondTarget);
      await expectPlacementSaved(tab);
      assert.equal(await savedBytes(tab), workspace, 'Concurrent planning changes wrote shared workspace records.');
      await expect(tab.getByRole('alert', { name: 'Save recovery' })).not.toBeVisible();
    }
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(first.sourceStatus);
    await expect(mover(dialog, first)).toHaveValue(firstTarget);
    await page.keyboard.press('Escape');
    await Promise.all([page.reload(), other.reload()]);
    for (const tab of [page, other]) {
      await expectInColumn(tab, first, firstTarget);
      await expectInColumn(tab, second, secondTarget);
      assert.equal(await savedBytes(tab), workspace);
    }
    verify();
  } finally { await context.close(); }
});

test('a pending placement stays visible and protected through route exit until its transaction settles', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await page.addInitScript(() => {
      const request = navigator.locks.request.bind(navigator.locks);
      navigator.locks.request = async (...args) => {
        if (args[0] === 'true-convo:desk:roadmap:v1:writer' && window.__holdPendingRoadmap) {
          window.__pendingRoadmapWaiting = true;
          await new Promise((resolve) => { window.__releasePendingRoadmap = resolve; });
        }
        return request(...args);
      };
    });
    await enterWork(page);
    assert.equal(await unloadBlocked(page), false);
    const card = roadmap.cards[0];
    const target = differentColumn(card.column);
    await page.evaluate(() => { window.__holdPendingRoadmap = true; });
    await mover(cardNode(page, card), card).selectOption(target);
    await expect.poll(() => page.evaluate(() => window.__pendingRoadmapWaiting)).toBe(true);
    await expectInColumn(page, card, target);
    assert.equal(await savedPlacement(page), null, 'The held transaction must not be committed yet.');
    await navigate(page, 'CONTINUITY');
    await expect(board(page)).toHaveCount(0);
    assert.equal(await unloadBlocked(page), true, 'A pending attempt remains protected outside Roadmap.');
    await navigate(page, 'ROADMAP');
    await expectInColumn(page, card, target);
    await expect(mover(cardNode(page, card), card)).toBeDisabled();
    await page.evaluate(() => {
      window.__holdPendingRoadmap = false;
      window.__releasePendingRoadmap();
    });
    await expectInColumn(page, card, target);
    await expectPlacementSaved(page);
    await expect(mover(cardNode(page, card), card)).toBeEnabled();
    assert.equal(await unloadBlocked(page), false, 'A confirmed durable placement clears unload protection.');
    verify();
  } finally { await context.close(); }
});

test('suggested card entry focuses its title and creates a saved card with keyboard typing and Enter', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterWork(page);
    const create = await openManual(page);
    const input = create.getByRole('textbox', { name: 'Card title', exact: true });
    await expect(input).toBeFocused();
    const title = 'Invented keyboard suggestion from the current folder';
    await page.keyboard.type(title);
    await expect(input).toHaveValue(title);
    await page.keyboard.press('Enter');
    await expect(column(page, 'suggested').getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
    await expect.poll(async () => JSON.parse(await savedBytes(page)).workItems.find((item) => item.title === title)?.roadmapColumn).toBe('suggested');
    await expect(input).toHaveValue('');
    await page.reload();
    await expect(column(page, 'suggested').getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('suggested card folder type-ahead keeps focus and never writes picker keys into another folder draft', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const initial = JSON.parse(await savedBytes(page));
    for (const name of ['Planning', 'Product']) {
      await page.getByRole('button', { name: 'Create folder', exact: true }).click();
      const creation = page.getByRole('dialog', { name: 'Create folder', exact: true });
      await creation.getByRole('textbox', { name: 'Folder name', exact: true }).fill(name);
      await creation.getByRole('button', { name: 'Create folder', exact: true }).click();
      await expect(creation).not.toBeVisible();
      await expect.poll(async () => JSON.parse(await savedBytes(page)).goals.some((goal) => goal.title === name)).toBe(true);
    }
    const before = JSON.parse(await savedBytes(page));
    const planning = before.goals.find((goal) => goal.title === 'Planning');
    const product = before.goals.find((goal) => goal.title === 'Product');
    await navigate(page, 'ROADMAP');
    const create = await openManual(page);
    const folder = create.getByRole('combobox', { name: 'Session folder', exact: true });
    const input = create.getByRole('textbox', { name: 'Card title', exact: true });
    await folder.selectOption(initial.goals[0].id);
    await folder.focus();
    await page.keyboard.press('p');
    await expect(folder).toHaveValue(planning.id);
    await expect(folder).toBeFocused();
    await page.keyboard.press('r');
    await expect(folder).toHaveValue(product.id);
    await expect(folder).toBeFocused();
    assert.deepEqual(JSON.parse(await savedBytes(page)).goalDrafts, before.goalDrafts,
      'Typing a folder name must not save the remaining letters as a card draft.');
    await page.keyboard.press('Tab');
    await expect(input).toBeFocused();
    await page.keyboard.type('Invented Product suggestion after keyboard folder choice');
    await page.keyboard.press('Enter');
    await expect.poll(async () => JSON.parse(await savedBytes(page)).workItems.find((item) => item.title === 'Invented Product suggestion after keyboard folder choice')?.goalId).toBe(product.id);
    assert.deepEqual(JSON.parse(await savedBytes(page)).goalDrafts[planning.id], before.goalDrafts[planning.id]);
    verify();
  } finally { await context.close(); }
});

test('Roadmap rail folder Enter keeps keyboard-opened hover and hidden rails focused and expanded', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const original = JSON.parse(await savedBytes(page)).goals[0];
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await creation.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented Roadmap keyboard folder');
    await creation.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(creation).not.toBeVisible();
    await expect.poll(async () => JSON.parse(await savedBytes(page)).goals.length).toBe(2);
    const alternate = JSON.parse(await savedBytes(page)).goals.find((goal) => goal.id !== original.id);
    await navigate(page, 'ROADMAP');
    const input = page.getByRole('textbox', { name: 'Card title', exact: true });
    await input.fill('Invented retained card draft before rail folder selection');
    await expect.poll(async () => JSON.parse(await savedBytes(page)).goalDrafts[alternate.id].workTitle).toBe('Invented retained card draft before rail folder selection');
    const retained = await savedBytes(page);
    for (const mode of ['hover', 'hidden']) {
      await page.evaluate((mode) => localStorage.setItem('true-convo:desk:layout:v1', JSON.stringify({ mode, railWidth: 260, inspectorWidth: 294 })), mode);
      await page.reload();
      await expect(input).toBeVisible();
      await page.mouse.move(1300, 150);
      await page.getByRole('main').focus();
      await page.keyboard.press('Control+Backslash');
      const layout = page.locator('.desk-layout');
      await expect(layout).toHaveClass(/rail-revealed/);
      // The shortcut focuses the rail toggle in the next animation frame.
      // Let that focus land before choosing a folder with the keyboard.
      await expect(page.locator('.desktop-navigation').getByRole('button', { name: 'Collapse navigation', exact: true })).toBeFocused();
      for (const target of [original, alternate]) {
        const folder = page.locator('.desktop-navigation').getByRole('button', { name: target.title, exact: true });
        await folder.focus();
        await page.keyboard.press('Enter');
        await expect(folder).toHaveAttribute('aria-current', 'true');
        await expect(folder).toBeFocused();
        await expect(layout).toHaveClass(/rail-revealed/);
        await expect(page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Roadmap', exact: true })).toHaveAttribute('aria-current', 'page');
        await expect(input).toHaveValue(JSON.parse(retained).goalDrafts[target.id].workTitle);
        assert.equal(await savedBytes(page), retained, 'Rail folder selection must preserve every saved card draft and record.');
      }
    }
    verify();
  } finally { await context.close(); }
});

test('suggested cards use an explicit existing folder when Ungrouped is selected and preserve its draft', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const before = JSON.parse(await savedBytes(page));
    const folder = before.goals[0];
    await page.getByRole('button', { name: 'Ungrouped sessions', exact: true }).click();
    await navigate(page, 'ROADMAP');
    const create = await openManual(page);
    const input = create.getByRole('textbox', { name: 'Card title', exact: true });
    await expect(input).toBeEnabled();
    await expect(input).toBeFocused();
    await expect(create.getByRole('combobox', { name: 'Session folder', exact: true })).toHaveValue(folder.id);
    const title = 'Invented suggestion with an explicit existing folder';
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await expect(column(page, 'suggested').getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
    await expect.poll(async () => JSON.parse(await savedBytes(page)).workItems.find((item) => item.title === title)?.goalId).toBe(folder.id);
    const draft = 'Invented unfinished card while Ungrouped stays selected';
    await input.fill(draft);
    await expect.poll(async () => JSON.parse(await savedBytes(page)).goalDrafts[folder.id].workTitle).toBe(draft);
    const after = JSON.parse(await savedBytes(page));
    assert.deepEqual(after.goals, before.goals, 'Creating a suggestion must not invent a new folder.');
    const selected = await page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);
    assert.equal(selected.goalId, null, 'Choosing a card folder must preserve the current Ungrouped selection.');
    assert.equal(selected.sessionId, null);
    await navigate(page, 'CONTINUITY');
    await navigate(page, 'ROADMAP');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(draft);
    await page.reload();
    const restored = await openManual(page);
    await expect(restored.getByRole('textbox', { name: 'Card title', exact: true })).toHaveValue(draft);
    await expect(column(page, 'suggested').getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
    verify();
  } finally { await context.close(); }
});

test('suggested card folder choices keep each saved draft and do not change the active session', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterDesk(page);
    const initial = JSON.parse(await savedBytes(page));
    const firstFolder = initial.goals[0];
    const firstSession = initial.sessions.find((session) => session.goalId === firstFolder.id);
    await page.getByRole('button', { name: 'Create folder', exact: true }).click();
    const creation = page.getByRole('dialog', { name: 'Create folder', exact: true });
    await creation.getByRole('textbox', { name: 'Folder name', exact: true }).fill('Invented alternate suggestion folder');
    await creation.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(creation).not.toBeVisible();
    await expect.poll(async () => JSON.parse(await savedBytes(page)).goals.length).toBe(2);
    const secondFolder = JSON.parse(await savedBytes(page)).goals.find((goal) => goal.id !== firstFolder.id);
    await page.getByRole('button', { name: firstFolder.title, exact: true }).click();
    await page.locator(`.session-link[data-session-id="${firstSession.id}"]`).click();
    await navigate(page, 'ROADMAP');
    const create = await openManual(page);
    const input = create.getByRole('textbox', { name: 'Card title', exact: true });
    const folder = create.getByRole('combobox', { name: 'Session folder', exact: true });
    const firstDraft = 'Invented draft in the first folder';
    const secondDraft = 'Invented draft in the second folder';
    await input.fill(firstDraft);
    await expect.poll(async () => JSON.parse(await savedBytes(page)).goalDrafts[firstFolder.id].workTitle).toBe(firstDraft);
    const selection = await page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection);
    assert.equal(selection.sessionId, firstSession.id);
    await folder.focus();
    await folder.selectOption(secondFolder.id);
    await expect(folder).toBeFocused();
    await expect(input).toHaveValue('');
    await input.focus();
    await page.keyboard.type(secondDraft);
    await expect.poll(async () => JSON.parse(await savedBytes(page)).goalDrafts[secondFolder.id].workTitle).toBe(secondDraft);
    assert.deepEqual(await page.evaluate(() => JSON.parse(sessionStorage.getItem('true-convo:desk:synthetic:tab-view:v1')).selection), selection);
    await folder.focus();
    await folder.selectOption(firstFolder.id);
    await expect(folder).toBeFocused();
    await expect(input).toHaveValue(firstDraft);
    await input.focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => JSON.parse(await savedBytes(page)).workItems.find((item) => item.title === firstDraft)?.goalId).toBe(firstFolder.id);
    await page.reload();
    const restored = await openManual(page);
    await expect(restored.getByRole('textbox', { name: 'Card title', exact: true })).toHaveValue('');
    await restored.getByRole('combobox', { name: 'Session folder', exact: true }).selectOption(secondFolder.id);
    await expect(restored.getByRole('textbox', { name: 'Card title', exact: true })).toHaveValue(secondDraft);
    verify();
  } finally { await context.close(); }
});

test('compact suggested card creation keeps shared records and drafts across moves and reloads', async () => {
  const { context, page, verify } = await isolatedPage();
  try {
    await enterWork(page);
    await expect(page.locator('details.manual-work')).toHaveCount(0);
    await expect(column(page, 'suggested').getByRole('form', { name: 'Create a suggested card', exact: true })).toBeVisible();
    const manual = await openManual(page);
    const input = manual.getByRole('textbox', { name: 'Card title', exact: true });
    const title = 'Invented manual sample distinct from recovered roadmap evidence';
    await input.fill(title);
    await manual.getByRole('button', { name: 'Create card', exact: true }).click();
    await expect(column(page, 'suggested').getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
    const draft = 'Invented unfinished manual work draft retained across visits';
    await input.fill(draft);
    await expect.poll(async () => {
      const state = JSON.parse(await savedBytes(page));
      return state.goalDrafts[state.selection.goalId]?.workTitle;
    }).toBe(draft);
    const workspace = await savedBytes(page);
    const created = JSON.parse(workspace).workItems.find((item) => item.title === title);
    assert.equal(created.status, 'planned');
    assert.equal(created.roadmapColumn, 'suggested');
    await expectInColumn(page, created, 'suggested');
    await mover(cardNode(page, created), created).selectOption('next');
    await expectPlacementSaved(page);
    await expectInColumn(page, created, 'next');
    await expect(cardNode(page, created)).toContainText('Suggested by you');
    assert.equal(await savedBytes(page), workspace, 'Moving a suggestion rewrote its shared work record or draft.');
    const card = roadmap.cards[0];
    const target = differentColumn(card.column);
    await mover(cardNode(page, card), card).selectOption(target);
    await expectPlacementSaved(page);
    assert.equal(await savedBytes(page), workspace);
    await expect(board(page).locator('.roadmap-card')).toHaveCount(roadmap.cards.length + JSON.parse(await savedBytes(page)).workItems.length);
    await expect(board(page)).toContainText(title);
    await navigate(page, 'CONTINUITY');
    await navigate(page, 'ROADMAP');
    await expect((await openManual(page)).getByRole('textbox', { name: 'Card title', exact: true })).toHaveValue(draft);
    await page.reload();
    await expectInColumn(page, card, target);
    await expectInColumn(page, created, 'next');
    const restored = await openManual(page);
    await expect(board(page).getByRole('button', { name: `Open ${title}`, exact: true })).toBeVisible();
    await expect(restored.getByRole('textbox', { name: 'Card title', exact: true })).toHaveValue(draft);
    assert.equal(await savedBytes(page), workspace);
    verify();
  } finally { await context.close(); }
});

test('390px dark roadmap keeps horizontal scrolling inside the board and card details usable', async (t) => {
  const { context, page, verify } = await isolatedPage({ viewport: { width: 390, height: 844 }, colorScheme: 'dark', reducedMotion: 'reduce' });
  try {
    await enterWork(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    assert.ok(sizes.scroll <= sizes.width + 1, `Roadmap overflowed the mobile page: ${sizes.scroll} > ${sizes.width}.`);
    const boardSizes = await board(page).evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth, overflow: getComputedStyle(node).overflowX }));
    assert.ok(boardSizes.scroll > boardSizes.width, 'All five mobile columns need an internal scroll area.');
    assert.ok(['auto', 'scroll'].includes(boardSizes.overflow), 'Mobile board scrolling must be available.');
    const card = [...roadmap.cards].reverse().find((item) => item.column === 'finished') ?? roadmap.cards.at(-1);
    const node = cardNode(page, card);
    await node.scrollIntoViewIfNeeded();
    const target = differentColumn(card.column);
    await mover(node, card).selectOption(target);
    await expectInColumn(page, card, target);
    await expectPlacementSaved(page);
    await cardNode(page, card).getByRole('button', { name: `Open ${card.title}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: card.title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(mover(dialog, card)).toHaveValue(target);
    await expect(dialog).toContainText(card.sourceStatus);
    const box = await dialog.boundingBox();
    assert.ok(box.x >= -1 && box.x + box.width <= 391, 'The roadmap modal extends beyond the phone viewport.');
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: join(screenshots, 'roadmap-mobile-dark-details.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await page.reload();
    await expectInColumn(page, card, target);
    await page.screenshot({ path: join(screenshots, 'roadmap-mobile-dark.png'), fullPage: true });
    verify();
    t.diagnostic(`Roadmap mobile screenshots: ${screenshots}`);
  } finally { await context.close(); }
});
