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
import { readNativeRecord, readNativeRecordRaw } from './foundation/browser-persistence.mjs';

// Run explicitly after DESK_CLOUD_PREVIEW=1 npm run build. These checks use
// browser-generated CSP violations from invented fixtures, not Codex's native
// annotation implementation. No Sites or owner browser profile is contacted.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceKey = 'true-convo:desk:synthetic:v1';
const viewKey = 'true-convo:desk:synthetic:tab-view:v1';
const reloadKey = 'true-convo:desk:preview-reload:v1';
const fixtureOrigin = 'https://annotation-style.invalid';
const legacyHistoryState = { fixture: 'invented annotation style test', tab: { panel: 'desk', sequence: 7 } };
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
    assert.equal(loadedBuild.application, 'true-convo-desk-preview', 'Run a cloud-preview build first.');
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
  const outsideRequests = [], apiRequests = [], errors = [];
  let announced = loadedBuild;
  let manifestRequests = 0, documentRequests = 0;
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      outsideRequests.push(url.href);
      // Every outside-origin request is aborted, including the invented
      // annotation-style.invalid stylesheet if Chromium reaches it.
      return route.abort();
    }
    if (url.pathname.startsWith('/api/')) { apiRequests.push(url.href); return route.abort(); }
    if (route.request().resourceType() === 'document') documentRequests += 1;
    if (url.pathname === '/desk-build.json') {
      manifestRequests += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(announced) });
    }
    return route.continue();
  });
  await context.addInitScript((legacyHistoryState) => {
    window.__annotationStyleTest = { applicationListeners: { added: 0, removed: 0 }, violations: [] };
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    // Install the test's observer through the original method, then count only
    // application registrations to detect an accidentally retained collector.
    add.call(document, 'securitypolicyviolation', (event) => {
      window.__annotationStyleTest.violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
    });
    EventTarget.prototype.addEventListener = function (type, ...args) {
      if (type === 'securitypolicyviolation') window.__annotationStyleTest.applicationListeners.added += 1;
      return add.call(this, type, ...args);
    };
    EventTarget.prototype.removeEventListener = function (type, ...args) {
      if (type === 'securitypolicyviolation') window.__annotationStyleTest.applicationListeners.removed += 1;
      return remove.call(this, type, ...args);
    };
    if (new URL(location.href).searchParams.has('annotation-diagnostics')) history.replaceState(legacyHistoryState, '');
  }, legacyHistoryState);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  return {
    context, page,
    announce: () => { announced = { ...loadedBuild, source_commit: (loadedBuild.source_commit === 'e'.repeat(40) ? 'f' : 'e').repeat(40), working_copy: false }; },
    manifestRequests: () => manifestRequests,
    documentRequests: () => documentRequests,
    verify: () => {
      assert.deepEqual(apiRequests, []);
      assert.deepEqual(errors, [], 'The annotation fixtures must not produce an application exception.');
      assert.ok(outsideRequests.every((url) => new URL(url).origin === fixtureOrigin), 'An unexpected outside-origin request was attempted.');
      assert.equal(context.pages().length, 1);
    },
  };
}

async function enterDesk(page, query = '') {
  await page.goto(`${origin}/${query}`);
  await page.bringToFront();
  await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).click();
  await expect(page.getByText('Sample workspace saved in this browser', { exact: true })).toBeVisible();
}

async function savedBrowserWork(page) {
  const workspace = await readNativeRecordRaw(page, workspaceKey);
  const caches = await page.evaluate(({ workspaceKey, viewKey, reloadKey }) => ({
    legacy: localStorage.getItem(workspaceKey),
    view: sessionStorage.getItem(viewKey),
    reload: sessionStorage.getItem(reloadKey),
  }), { workspaceKey, viewKey, reloadKey });
  return { workspace, ...caches };
}

async function expectNoDiagnosticCollector(page) {
  await expect(page.getByRole('region', { name: 'Annotation diagnostics', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Annotation diagnostic report', exact: true })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.__annotationStyleTest.applicationListeners), { added: 0, removed: 0 });
}

test('ordinary preview has no diagnostic collector or UI', { timeout: 15_000 }, async () => {
  const { context, page, manifestRequests, verify } = await samplePage();
  try {
    await enterDesk(page);
    await expectNoDiagnosticCollector(page);
    await expect.poll(manifestRequests, { message: 'The ordinary preview update watcher must still run.' }).toBeGreaterThan(0);
    verify();
  } finally { await context.close(); }
});

test('legacy diagnostic URLs clear only the retired flag, preserve browser work and resume guarded preview updates', { timeout: 30_000 }, async () => {
  const { context, page, announce, manifestRequests, documentRequests, verify } = await samplePage();
  try {
    await enterDesk(page);
    const draft = 'Invented draft retained when an old annotation link is opened.';
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(draft);
    await expect.poll(async () => Object.values((await readNativeRecord(page, workspaceKey)).drafts).includes(draft)).toBe(true);
    const before = await savedBrowserWork(page);
    const documentsBefore = documentRequests();
    const pollsBeforeNavigation = manifestRequests();

    await page.goto(`${origin}/?annotation-diagnostics=1&keep=sample#anchor`);
    await expect.poll(() => page.url()).toBe(`${origin}/?keep=sample#anchor`);
    assert.deepEqual(await page.evaluate(() => history.state), legacyHistoryState);
    await expectNoDiagnosticCollector(page);
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(draft);
    assert.deepEqual(await savedBrowserWork(page), before, 'Retiring the old flag must keep the exact saved workspace, draft and tab view.');
    assert.equal(documentRequests(), documentsBefore + 1, 'Cleaning the URL must not reload or navigate the document.');
    await expect.poll(manifestRequests, { message: 'An old diagnostic URL must still start the ordinary update watcher.' }).toBeGreaterThan(pollsBeforeNavigation);

    const pollsBeforeUpdate = manifestRequests();
    const documentsBeforeUpdate = documentRequests();
    announce();
    const composer = page.getByRole('textbox', { name: 'Your message', exact: true });
    await composer.focus();
    await page.clock.fastForward(31_000);
    await expect.poll(manifestRequests, { message: 'The retired flag must not pause later manifest polling.' }).toBeGreaterThan(pollsBeforeUpdate);
    await expect(page.getByRole('status', { name: 'Preview update', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh preview', exact: true })).toBeDisabled();
    await page.clock.fastForward(65_000);
    assert.equal(documentRequests(), documentsBeforeUpdate, 'A focused draft must retain the normal automatic refresh guard.');
    assert.deepEqual(await savedBrowserWork(page), before);
    await expect(composer).toHaveValue(draft);
    assert.deepEqual(await page.evaluate(() => history.state), legacyHistoryState);

    await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).focus();
    await page.clock.fastForward(10_000);
    await expect.poll(documentRequests, { message: 'A saved idle tab must resume the ordinary automatic update behavior.' }).toBe(documentsBeforeUpdate + 1);
    await expect(composer).toHaveValue(draft);
    const afterUpdate = await savedBrowserWork(page);
    assert.equal(afterUpdate.workspace, before.workspace);
    assert.equal(afterUpdate.legacy, before.legacy);
    assert.equal(afterUpdate.view, before.view);
    assert.equal(afterUpdate.reload, (loadedBuild.source_commit === 'e'.repeat(40) ? 'f' : 'e').repeat(40));
    assert.equal(page.url(), `${origin}/?keep=sample#anchor`);
    assert.deepEqual(await page.evaluate(() => history.state), legacyHistoryState);
    await expectNoDiagnosticCollector(page);
    verify();
  } finally { await context.close(); }
});

test('hosted styles allow inline stylesheet elements while blocking style attributes, inline scripts and outside CSS', { timeout: 20_000 }, async () => {
  const { context, page, verify } = await samplePage();
  try {
    await enterDesk(page);
    const before = await savedBrowserWork(page);
    const policy = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    assert.match(policy, /style-src 'self'(?:;|$)/);
    assert.match(policy, /script-src 'self'(?:;|$)/);

    await page.evaluate(() => {
      const marker = document.createElement('span');
      marker.id = 'annotation-style-fixture';
      marker.textContent = 'Invented CSP fixture';
      document.body.append(marker);
      const stylesheet = document.createElement('style');
      stylesheet.textContent = '#annotation-style-fixture { color: rgb(1, 2, 3); }';
      document.head.append(stylesheet);
    });
    const marker = page.locator('#annotation-style-fixture');
    await expect(marker).toHaveCSS('color', 'rgb(1, 2, 3)');
    assert.match(policy, /style-src-elem 'self' 'unsafe-inline'(?:;|$)/);
    assert.match(policy, /style-src-attr 'none'(?:;|$)/);

    await marker.evaluate((element) => element.setAttribute('style', 'color: rgb(9, 8, 7)'));
    await expect.poll(() => page.evaluate(() => window.__annotationStyleTest.violations.some((event) => event.directive === 'style-src-attr' && event.blockedURI === 'inline'))).toBe(true);
    await expect(marker).toHaveCSS('color', 'rgb(1, 2, 3)');

    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__annotationStyleBlockedScriptRan = true;';
      document.head.append(script);
    });
    await expect.poll(() => page.evaluate(() => window.__annotationStyleTest.violations.some((event) => event.directive === 'script-src-elem' && event.blockedURI === 'inline'))).toBe(true);
    assert.equal(await page.evaluate(() => window.__annotationStyleBlockedScriptRan), undefined, 'The hosted style allowance must not enable inline scripts.');

    await page.evaluate((fixtureOrigin) => {
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = `${fixtureOrigin}/invented-annotator.css`;
      document.head.append(stylesheet);
    }, fixtureOrigin);
    await expect.poll(() => page.evaluate((fixtureOrigin) => window.__annotationStyleTest.violations.some((event) => event.directive === 'style-src-elem' && event.blockedURI.startsWith(fixtureOrigin)), fixtureOrigin)).toBe(true);
    assert.equal(await page.evaluate(() => window.__annotationStyleTest.violations.some((event) => event.directive === 'style-src-elem' && event.blockedURI === 'inline')), false, 'The injected inline stylesheet must remain allowed.');
    assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), policy);
    assert.deepEqual(await savedBrowserWork(page), before);
    await expectNoDiagnosticCollector(page);
    verify();
  } finally { await context.close(); }
});

test('hosted inline stylesheet renders a fixed overlay with its intended position, appearance and cursor', { timeout: 15_000 }, async () => {
  const { context, page, verify } = await samplePage();
  try {
    await enterDesk(page);
    const before = await savedBrowserWork(page);
    await page.evaluate(() => {
      const overlay = document.createElement('div');
      overlay.id = 'annotation-overlay-fixture';
      overlay.textContent = 'Invented overlay';
      const stylesheet = document.createElement('style');
      stylesheet.id = 'annotation-overlay-fixture-style';
      stylesheet.textContent = `#annotation-overlay-fixture {
        position: fixed; left: 460px; top: 180px; width: 120px; height: 48px;
        background: rgb(24, 126, 246); color: rgb(255, 255, 255);
        border-radius: 16px; cursor: crosshair; z-index: 2147483647;
      }`;
      document.head.append(stylesheet);
      document.body.append(overlay);
    });
    const overlay = page.locator('#annotation-overlay-fixture');
    await expect(overlay).toHaveCSS('position', 'fixed');
    await expect(overlay).toHaveCSS('background-color', 'rgb(24, 126, 246)');
    await expect(overlay).toHaveCSS('border-radius', '16px');
    await expect(overlay).toHaveCSS('cursor', 'crosshair');
    assert.deepEqual(await overlay.boundingBox(), { x: 460, y: 180, width: 120, height: 48 });
    await page.mouse.move(480, 200);
    assert.deepEqual(await page.evaluate(() => {
      const target = document.elementFromPoint(480, 200);
      return { id: target?.id, cursor: target ? getComputedStyle(target).cursor : null };
    }), { id: 'annotation-overlay-fixture', cursor: 'crosshair' });

    await page.evaluate(() => {
      document.getElementById('annotation-overlay-fixture').remove();
      document.getElementById('annotation-overlay-fixture-style').remove();
    });
    const navigation = page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true });
    await navigation.hover();
    await expect(navigation).toHaveCSS('cursor', 'pointer');
    assert.deepEqual(await savedBrowserWork(page), before, 'An injected visual overlay must not change the saved workspace.');
    await expectNoDiagnosticCollector(page);
    verify();
  } finally { await context.close(); }
});
