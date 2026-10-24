import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let server; let browser; let origin; let output = '';
async function cleanup() {
  try { await browser?.close(); } finally {
    browser = undefined;
    if (server) {
      const running = server.exitCode === null && server.signalCode === null;
      const exited = running ? once(server, 'exit') : Promise.resolve();
      try { process.kill(-server.pid, 'SIGTERM'); } catch { if (running) server.kill('SIGTERM'); }
      if (!await Promise.race([exited.then(() => true), pause(2000).then(() => false)])) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
        await exited;
      }
      server = undefined;
    }
  }
}
before(async () => {
  try {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;
    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (part) => { output = (output + part).slice(-8000); });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null) throw Error(output);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Startup only. */ }
      await pause(100);
    }
    assert.ok(ready, output);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

async function openRailMap(t, viewport) {
  const page = await browser.newPage({ viewport });
  t.after(() => page.close());
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  // The first load after a cold dev server start waits on Vite's dependency scan.
  await expect(page.getByText('Sample preview · sample data only', { exact: true })).toBeVisible({ timeout: 30_000 });
  // A phone keeps the navigation rail in a drawer.
  if (viewport.width < 700) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('button', { name: 'CLOUDWORK NEXUS', exact: true }).first().click();
  await page.getByRole('navigation', { name: 'Nexus views', exact: true }).getByRole('button', { name: 'Cloudwork Rail Map', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Rail Map', exact: true })).toBeVisible();
  return { page, errors };
}

const pageOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

for (const [label, viewport] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
  test(`Rail Map draws its tracks and switches views without page overflow (${label})`, async (t) => {
    const { page, errors } = await openRailMap(t, viewport);
    const region = page.getByRole('region', { name: 'Rail Map', exact: true });
    await expect(region.locator('.rail-svg path').first()).toBeAttached();
    await expect(region.locator('.rail-row').first()).toBeVisible();
    assert.ok(await region.locator('.rail-main-ref').count() >= 1, 'The main branch tip is not labeled.');
    assert.equal(await pageOverflow(page), 0, 'The commit graph widened the page.');

    await region.getByRole('tab', { name: 'Pull requests', exact: true }).click();
    await expect(region.getByRole('tab', { name: 'Pull requests', exact: true })).toHaveAttribute('aria-selected', 'true');
    await region.getByLabel('Time range').selectOption('0');
    await expect(region.locator('.rail-timeline-row').first()).toBeVisible();
    assert.equal(await pageOverflow(page), 0, 'The timeline widened the page.');

    await region.getByRole('tab', { name: 'Pull requests', exact: true }).press('ArrowRight');
    await expect(region.getByRole('tab', { name: 'Branches', exact: true })).toBeFocused();
    await expect(region.locator('.rail-branches tbody tr').first()).toBeVisible();
    assert.equal(await pageOverflow(page), 0, 'The branch list widened the page.');

    await region.getByRole('tab', { name: 'Commit graph', exact: true }).click();
    await region.getByLabel('Filter commits').fill('no commit says this 6f1c');
    await expect(region.getByText(/No commits match/)).toBeVisible();
    assert.deepEqual(errors, []);
  });
}
