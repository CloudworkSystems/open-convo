import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrowserCanvas, CANVAS_INVALID_WARNING, CANVAS_SAVE_WARNING, CANVAS_STALE_WARNING } from '../../src/adapters/browser-canvas';
import { emptyCanvasLayout, type CanvasLayoutRecord } from '../../src/domain/canvas-layout';

class RecordAuthority {
  raw: string | null = null;
  writes = 0;
  failWrite = false;
  async read() { return this.raw; }
  async update<T>(operation: (raw: string | null) => { result: T; raw?: string }): Promise<T> {
    const change = operation(this.raw);
    if (change.raw !== undefined) {
      if (this.failWrite) throw new Error('Invented quota failure');
      this.raw = change.raw;
      this.writes += 1;
    }
    return change.result;
  }
  subscribe(_changed: () => void) { return () => undefined; }
}
const candidate = (): CanvasLayoutRecord => ({
  ...emptyCanvasLayout(), nodes: {
    'domain:invented-folder': { x: 200, y: 120, width: 250, height: 96, shape: 'rectangle', positionLocked: false, shapeLocked: true },
  },
});

test('first deliberate Canvas geometry save uses an empty transactional record without changing on load', async () => {
  const authority = new RecordAuthority();
  const browser = new BrowserCanvas(authority);
  assert.deepEqual(await browser.loadLatest(), { layout: emptyCanvasLayout(), warning: null });
  assert.equal(authority.writes, 0);
  const result = await browser.save(candidate(), 0);
  assert.equal(result.kind, 'saved');
  assert.equal(JSON.parse(authority.raw!).revision, 1);
  assert.deepEqual(JSON.parse(authority.raw!).nodes, candidate().nodes);
  assert.deepEqual((await browser.loadLatest()).layout, JSON.parse(authority.raw!));
});

test('Canvas compare and save rejects another writer without altering its committed geometry', async () => {
  const authority = new RecordAuthority();
  const first = new BrowserCanvas(authority);
  const stale = new BrowserCanvas(authority);
  await first.loadLatest(); await stale.loadLatest();
  assert.equal((await first.save(candidate(), 0)).kind, 'saved');
  const bytes = authority.raw;
  const result = await stale.save(candidate(), 0);
  assert.deepEqual(result, { kind: 'failed', warning: CANVAS_STALE_WARNING });
  assert.equal(authority.raw, bytes);
  assert.equal((await stale.save(candidate(), 1)).kind, 'failed', 'A rejected writer cannot silently retry against a newer revision.');
});

test('Canvas corrupt/newer records remain byte-for-byte unchanged and block saves', async () => {
  for (const raw of ['{bad', JSON.stringify({ ...candidate(), version: 2 }), JSON.stringify({ ...candidate(), surprise: true })]) {
    const authority = new RecordAuthority(); authority.raw = raw;
    const browser = new BrowserCanvas(authority);
    assert.equal((await browser.loadLatest()).warning, CANVAS_INVALID_WARNING);
    assert.deepEqual(await browser.save(candidate(), 0), { kind: 'failed', warning: CANVAS_INVALID_WARNING });
    assert.equal(authority.raw, raw);
    assert.equal(authority.writes, 0);
  }
});

test('Canvas save abort keeps last committed bytes and later attempted layout is not written', async () => {
  const authority = new RecordAuthority(); const browser = new BrowserCanvas(authority);
  await browser.save(candidate(), 0);
  const bytes = authority.raw;
  authority.failWrite = true;
  assert.deepEqual(await browser.save(candidate(), 1), { kind: 'failed', warning: CANVAS_SAVE_WARNING });
  authority.failWrite = false;
  assert.equal((await browser.save(candidate(), 1)).kind, 'failed');
  assert.equal(authority.raw, bytes);
});

test('Canvas known canonical-record removal is not mistaken for a first save', async () => {
  const authority = new RecordAuthority(); const browser = new BrowserCanvas(authority);
  await browser.save(candidate(), 0);
  authority.raw = null;
  assert.equal((await browser.loadLatest()).warning, CANVAS_STALE_WARNING);
  assert.equal((await browser.save(candidate(), 0)).kind, 'failed');
  assert.equal(authority.raw, null);
});
