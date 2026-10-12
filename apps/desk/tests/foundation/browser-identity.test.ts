import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BRAND_IMAGE_MAX_BYTES,
  BRAND_NAME_MAX,
  BrowserIdentityStore,
  DEFAULT_IDENTITY,
  DISPLAY_NAME_MAX,
  IDENTITY_KEY,
  SESSION_NAMING_GUIDANCE_MAX,
  loadIdentity,
  saveIdentity,
  validateBrandImage,
  validateBrandName,
  validateDisplayName,
  validateEmail,
  validateSessionNamingGuidance,
  type IdentityPreferences,
  type IdentityRecord,
} from '../../src/adapters/browser-identity';

const workspaceKey = 'true-convo:desk:synthetic:v1';
const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const dataUrl = (type: string, bytes: Uint8Array) => `data:${type};base64,${Buffer.from(bytes).toString('base64')}`;
const png = dataUrl('image/png', pngBytes);

function storage(initial?: string) {
  const cache = new Map<string, string>([[workspaceKey, 'independent saved sessions and drafts']]);
  if (initial !== undefined) cache.set(IDENTITY_KEY, initial);
  const reads: string[] = [];
  const writes: string[] = [];
  const adapter = {
    getItem: (key: string) => { reads.push(key); return cache.get(key) ?? null; },
    setItem: (key: string, value: string) => { writes.push(key); cache.set(key, value); },
  };
  return { cache, reads, writes, adapter };
}

test('identity defaults and independent names round-trip without touching workspace records', () => {
  const store = storage();
  assert.deepEqual(loadIdentity(store.adapter), { preferences: DEFAULT_IDENTITY, warning: null, readOnly: false });
  assert.deepEqual(store.writes, []);
  const preferences = { brandName: '  My desk  ', displayName: '  My workspace  ', brandImage: png, sessionNamingGuidance: '  Use the topic and intended outcome.  ' };
  const normalized = { brandName: 'My desk', displayName: 'My workspace', brandImage: png, sessionNamingGuidance: 'Use the topic and intended outcome.' };
  assert.deepEqual(saveIdentity(preferences, store.adapter), { saved: true, preferences: normalized, warning: null });
  assert.deepEqual(JSON.parse(store.cache.get(IDENTITY_KEY)!), { version: 1, ...normalized });
  assert.deepEqual(loadIdentity(store.adapter), { preferences: normalized, warning: null, readOnly: false });
  assert.equal(store.cache.get(workspaceKey), 'independent saved sessions and drafts');
  assert.ok(store.reads.every((key) => key === IDENTITY_KEY));
  assert.deepEqual(store.writes, [IDENTITY_KEY]);
  assert.equal(saveIdentity({ ...normalized, displayName: 'Second workspace', brandImage: null }, store.adapter).saved, true);
  assert.deepEqual(loadIdentity(store.adapter).preferences, { ...normalized, displayName: 'Second workspace', brandImage: null });
});

test('legacy version-one identity loads empty guidance without rewriting and upgrades only on explicit save', () => {
  const legacy = { version: 1, brandName: 'Saved brand', displayName: 'Saved owner', brandImage: png };
  const raw = JSON.stringify(legacy);
  const store = storage(raw);
  const restored = loadIdentity(store.adapter);
  const preferences = { brandName: legacy.brandName, displayName: legacy.displayName, brandImage: png, sessionNamingGuidance: '' };
  assert.deepEqual(restored, { preferences, warning: null, readOnly: false });
  assert.equal(store.cache.get(IDENTITY_KEY), raw);
  assert.deepEqual(store.writes, []);
  assert.deepEqual(saveIdentity(restored.preferences, store.adapter), { saved: true, preferences, warning: null });
  assert.deepEqual(JSON.parse(store.cache.get(IDENTITY_KEY)!), { version: 1, ...preferences });
  assert.deepEqual(store.writes, [IDENTITY_KEY]);
  assert.ok(store.reads.every((key) => key === IDENTITY_KEY));
  assert.equal(store.cache.get(workspaceKey), 'independent saved sessions and drafts');
});

test('optional guidance trims and saves at its cap while invalid guidance preserves previous bytes', () => {
  const previous = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, sessionNamingGuidance: 'Keep the previous guidance.' });
  for (const value of ['', '\t\n ', ` ${'a'.repeat(SESSION_NAMING_GUIDANCE_MAX)} `, '  Keep the topic.\nMention the outcome.  ']) {
    const store = storage(previous);
    const preferences = { ...DEFAULT_IDENTITY, sessionNamingGuidance: value.trim() };
    assert.equal(validateSessionNamingGuidance(value), null);
    assert.deepEqual(saveIdentity({ ...DEFAULT_IDENTITY, sessionNamingGuidance: value }, store.adapter), { saved: true, preferences, warning: null });
    assert.deepEqual(loadIdentity(store.adapter).preferences, preferences);
    assert.deepEqual(store.writes, [IDENTITY_KEY]);
    assert.equal(store.cache.get(workspaceKey), 'independent saved sessions and drafts');
  }
  for (const value of ['a'.repeat(SESSION_NAMING_GUIDANCE_MAX + 1), null, undefined, 42, [], {}]) {
    const store = storage(previous);
    assert.ok(validateSessionNamingGuidance(value));
    assert.equal(saveIdentity({ ...DEFAULT_IDENTITY, sessionNamingGuidance: value } as IdentityPreferences, store.adapter).saved, false);
    assert.equal(store.cache.get(IDENTITY_KEY), previous);
    assert.deepEqual(store.writes, []);
  }
  const raw = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, sessionNamingGuidance: '  Loaded guidance.  ' });
  const store = storage(raw);
  assert.equal(loadIdentity(store.adapter).preferences.sessionNamingGuidance, 'Loaded guidance.');
  assert.equal(store.cache.get(IDENTITY_KEY), raw);
  assert.deepEqual(store.writes, []);
});

test('malformed and unsupported stored identity bytes remain untouched on load and save', () => {
  const invalid = [
    '{broken display settings',
    'null',
    '[]',
    JSON.stringify({ version: 2, ...DEFAULT_IDENTITY }),
    JSON.stringify({ version: 1, displayName: 'Earlier shape', brandImage: null }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, extra: 'unknown field' }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, brandName: ' ' }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, displayName: false }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, brandImage: 'https://example.com/brand.png' }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, brandImage: dataUrl('image/jpeg', pngBytes) }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, sessionNamingGuidance: null }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, sessionNamingGuidance: 42 }),
    JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, sessionNamingGuidance: 'a'.repeat(SESSION_NAMING_GUIDANCE_MAX + 1) }),
  ];
  for (const raw of invalid) {
    const store = storage(raw);
    const restored = loadIdentity(store.adapter);
    assert.equal(restored.readOnly, true);
    assert.ok(restored.warning);
    assert.deepEqual(restored.preferences, DEFAULT_IDENTITY);
    assert.equal(saveIdentity({ ...DEFAULT_IDENTITY }, store.adapter).saved, false);
    assert.equal(store.cache.get(IDENTITY_KEY), raw);
    assert.deepEqual(store.writes, []);
  }
});

test('invalid preference names and shapes cannot replace valid saved identity', () => {
  const previous = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY });
  const invalid = [
    { ...DEFAULT_IDENTITY, brandName: '' },
    { ...DEFAULT_IDENTITY, brandName: 'a'.repeat(BRAND_NAME_MAX + 1) },
    { ...DEFAULT_IDENTITY, displayName: '\t\n ' },
    { ...DEFAULT_IDENTITY, displayName: 'a'.repeat(DISPLAY_NAME_MAX + 1) },
    { ...DEFAULT_IDENTITY, brandImage: undefined },
    { ...DEFAULT_IDENTITY, extra: 'unknown field' },
  ];
  for (const preferences of invalid) {
    const store = storage(previous);
    assert.equal(saveIdentity(preferences as IdentityPreferences, store.adapter).saved, false);
    assert.equal(store.cache.get(IDENTITY_KEY), previous);
    assert.deepEqual(store.writes, []);
  }
  assert.equal(validateBrandName(` ${'a'.repeat(BRAND_NAME_MAX)} `), null);
  assert.equal(validateDisplayName(` ${'a'.repeat(DISPLAY_NAME_MAX)} `), null);
  assert.ok(validateBrandName(4));
  assert.ok(validateDisplayName(null));
});

test('images require canonical raster data URLs with matching signatures and decoded size', () => {
  const jpeg = dataUrl('image/jpeg', Buffer.from([0xff, 0xd8, 0xff]));
  const webp = dataUrl('image/webp', Buffer.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]));
  for (const valid of [null, png, jpeg, webp]) assert.equal(validateBrandImage(valid), null);
  const invalid = [
    'https://example.com/brand.png',
    'blob:https://example.com/image',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/jpg;base64,/9j/',
    'data:image/png,raw-content',
    'data:image/png;base64,',
    `${png}\n`,
    png.slice(0, -1),
    png.slice(0, -2) + 'p=', // Nonzero unused padding bits decode to the same bytes.
    dataUrl('image/jpeg', pngBytes),
    dataUrl('image/png', Buffer.from([0xff, 0xd8, 0xff])),
    dataUrl('image/webp', Buffer.from('RIFFbad data')),
    dataUrl('image/png', pngBytes.subarray(0, 7)),
    undefined,
    123,
  ];
  for (const value of invalid) assert.ok(validateBrandImage(value), String(value));
  const atLimit = Buffer.alloc(BRAND_IMAGE_MAX_BYTES);
  pngBytes.copy(atLimit);
  assert.equal(validateBrandImage(dataUrl('image/png', atLimit)), null);
  const tooLarge = Buffer.alloc(BRAND_IMAGE_MAX_BYTES + 1);
  pngBytes.copy(tooLarge);
  const oversized = dataUrl('image/png', tooLarge);
  assert.ok(validateBrandImage(oversized));
  const store = storage();
  assert.equal(saveIdentity({ ...DEFAULT_IDENTITY, brandImage: oversized }, store.adapter).saved, false);
  assert.deepEqual(store.writes, []);
});

test('damage arriving after load is preserved and blocks the next save', () => {
  const store = storage();
  assert.equal(loadIdentity(store.adapter).readOnly, false);
  const raw = JSON.stringify({ version: 3, ...DEFAULT_IDENTITY });
  store.cache.set(IDENTITY_KEY, raw);
  assert.equal(saveIdentity({ ...DEFAULT_IDENTITY, brandName: 'New brand' }, store.adapter).saved, false);
  assert.equal(store.cache.get(IDENTITY_KEY), raw);
  assert.deepEqual(store.writes, []);
});

test('read and quota failures do not claim a save or replace previous stored bytes', () => {
  const raw = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY });
  const store = storage(raw);
  const failedWrite = saveIdentity({ ...DEFAULT_IDENTITY, displayName: 'Attempted name' }, {
    getItem: store.adapter.getItem,
    setItem: () => { throw new Error('quota'); },
  });
  assert.equal(failedWrite.saved, false);
  assert.ok(failedWrite.warning);
  assert.equal(store.cache.get(IDENTITY_KEY), raw);
  assert.deepEqual(loadIdentity(store.adapter).preferences, DEFAULT_IDENTITY);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { assert.fail('must not write'); } };
  const restored = loadIdentity(blocked);
  assert.equal(restored.readOnly, true);
  assert.ok(restored.warning);
  assert.equal(saveIdentity({ ...DEFAULT_IDENTITY }, blocked).saved, false);
});

class AtomicRecord implements IdentityRecord {
  raw: string | null;
  writes = 0;
  private queue = Promise.resolve();
  constructor(raw: string | null = null) { this.raw = raw; }
  async read() { return this.raw; }
  update<T>(operation: (raw: string | null) => { result: T; raw?: string }): Promise<T> {
    const saved = this.queue.then(() => {
      const change = operation(this.raw);
      if (change.raw !== undefined) { this.raw = change.raw; this.writes += 1; }
      return change.result;
    });
    this.queue = saved.then(() => {}, () => {});
    return saved;
  }
  subscribe() { return () => {}; }
}

test('native identity reads legacy without migration and saves only the separate committed authority', async () => {
  const legacyRaw = JSON.stringify({ version: 1, brandName: 'Legacy brand', displayName: 'Legacy owner', brandImage: null });
  const legacy = storage(legacyRaw);
  const record = new AtomicRecord();
  const browser = new BrowserIdentityStore(record, legacy.adapter);
  const loaded = await browser.load();
  assert.equal(loaded.preferences.brandName, 'Legacy brand');
  assert.equal(loaded.preferences.sessionNamingGuidance, '');
  assert.deepEqual(loaded.baseline, { raw: null, legacyRaw });
  assert.equal(record.raw, null);
  assert.equal(record.writes, 0);
  assert.deepEqual(legacy.writes, []);
  const changed = { ...loaded.preferences, displayName: 'Explicitly saved owner' };
  const saved = await browser.save(changed, loaded.baseline);
  assert.equal(saved.saved, true);
  assert.deepEqual(JSON.parse(record.raw!), { version: 1, ...changed });
  assert.equal(legacy.cache.get(IDENTITY_KEY), legacyRaw);
  assert.deepEqual(legacy.writes, []);
  legacy.cache.set(IDENTITY_KEY, 'unsupported old fallback bytes');
  const committed = await browser.load();
  assert.deepEqual(committed.preferences, changed);
  assert.deepEqual(committed.baseline, { raw: record.raw, legacyRaw: null });
  assert.equal(committed.readOnly, false);
  assert.equal(legacy.cache.get(workspaceKey), 'independent saved sessions and drafts');
});

test('native identity uses the captured raw baseline so simultaneous saves cannot replace each other', async () => {
  const legacy = storage();
  const record = new AtomicRecord();
  const first = new BrowserIdentityStore(record, legacy.adapter);
  const second = new BrowserIdentityStore(record, legacy.adapter);
  const [left, right] = await Promise.all([first.load(), second.load()]);
  const firstEdit = { ...DEFAULT_IDENTITY, displayName: 'First attempted owner' };
  const secondEdit = { ...DEFAULT_IDENTITY, displayName: 'Second attempted owner' };
  const results = await Promise.all([first.save(firstEdit, left.baseline), second.save(secondEdit, right.baseline)]);
  assert.equal(results.filter((result) => result.saved).length, 1);
  const lost = results.find((result) => !result.saved)!;
  assert.equal(lost.saved, false);
  if (!lost.saved) assert.equal(lost.kind, 'conflict');
  assert.deepEqual(JSON.parse(record.raw!), { version: 1, ...firstEdit });
  assert.equal(record.writes, 1);
  assert.equal(secondEdit.displayName, 'Second attempted owner');
  assert.deepEqual(legacy.writes, []);
  const latest = await second.load();
  assert.equal(latest.preferences.displayName, firstEdit.displayName);
  assert.deepEqual(latest.baseline, { raw: record.raw, legacyRaw: null });
});

test('native read failures, transaction aborts and unsupported authority fail closed while saved bytes stay intact', async () => {
  const raw = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY });
  const legacy = storage(raw);
  const missingFactory = new BrowserIdentityStore(undefined, legacy.adapter);
  const absent = await missingFactory.load();
  assert.equal(absent.readOnly, true);
  assert.equal(absent.baseline, null);
  assert.equal((await missingFactory.save({ ...DEFAULT_IDENTITY }, absent.baseline)).saved, false);
  const blocked: IdentityRecord = {
    read: async () => { throw new Error('blocked native database'); },
    update: async () => { assert.fail('must not save after missing baseline'); },
    subscribe: () => () => {},
  };
  const closed = new BrowserIdentityStore(blocked, legacy.adapter);
  const unavailable = await closed.load();
  assert.equal(unavailable.readOnly, true);
  assert.equal(unavailable.baseline, null);
  assert.equal((await closed.save({ ...DEFAULT_IDENTITY }, unavailable.baseline)).saved, false);
  const aborted = new AtomicRecord(raw);
  aborted.update = async (operation) => { operation(aborted.raw); throw new Error('transaction aborted after staging'); };
  const failed = new BrowserIdentityStore(aborted, legacy.adapter);
  const before = await failed.load();
  const result = await failed.save({ ...DEFAULT_IDENTITY, displayName: 'Attempted owner' }, before.baseline);
  assert.equal(result.saved, false);
  assert.equal(aborted.raw, raw);
  assert.equal(aborted.writes, 0);
  const unsupported = JSON.stringify({ version: 9, ...DEFAULT_IDENTITY });
  const damaged = new AtomicRecord(unsupported);
  const damagedStore = new BrowserIdentityStore(damaged, legacy.adapter);
  const loaded = await damagedStore.load();
  assert.equal(loaded.readOnly, true);
  assert.equal((await damagedStore.save({ ...DEFAULT_IDENTITY }, loaded.baseline)).saved, false);
  assert.equal(damaged.raw, unsupported);
  assert.equal(damaged.writes, 0);
  assert.deepEqual(legacy.writes, []);
  assert.equal(legacy.cache.get(IDENTITY_KEY), raw);
});

test('optional email and avatar save with the profile while legacy records load without new fields or a rewrite', async () => {
  const legacyRaw = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY });
  const record = new AtomicRecord(legacyRaw);
  const legacy = storage(legacyRaw);
  const browser = new BrowserIdentityStore(record, legacy.adapter);
  const loaded = await browser.load();
  assert.deepEqual(loaded.preferences, DEFAULT_IDENTITY);
  assert.equal(record.raw, legacyRaw);
  assert.equal(record.writes, 0);
  const preferences = { ...loaded.preferences, displayName: 'My saved profile', email: '  owner@example.test  ', avatarImage: png };
  const normalized = { ...preferences, email: 'owner@example.test' };
  const saved = await browser.save(preferences, loaded.baseline);
  assert.equal(saved.saved, true);
  assert.deepEqual((await browser.load()).preferences, normalized);
  assert.deepEqual(JSON.parse(record.raw!), { version: 1, ...normalized });
  assert.equal(record.writes, 1);
  assert.equal(legacy.cache.get(IDENTITY_KEY), legacyRaw);
  assert.deepEqual(legacy.writes, []);
  assert.equal(legacy.cache.get(workspaceKey), 'independent saved sessions and drafts');
  assert.equal(validateEmail(''), null);
  assert.equal(validateEmail(' \t '), null);
  assert.equal(validateEmail('  person+desk@example.test  '), null);
});

test('malformed optional profile fields cannot overwrite existing identity bytes', async () => {
  const baselineRaw = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, email: 'owner@example.test', avatarImage: png });
  const invalid = [
    { email: null }, { email: undefined }, { email: 42 }, { email: 'missing-at.example.test' }, { email: 'a@ b.test' },
    { email: 'a'.repeat(255) + '@example.test' }, { avatarImage: undefined }, { avatarImage: 'https://example.test/avatar.png' },
    { avatarImage: 'data:image/svg+xml;base64,PHN2Zy8+' },
  ];
  for (const fields of invalid) {
    const record = new AtomicRecord(baselineRaw);
    const legacy = storage(baselineRaw);
    const browser = new BrowserIdentityStore(record, legacy.adapter);
    const baseline = await browser.load();
    assert.equal((await browser.save({ ...baseline.preferences, ...fields } as IdentityPreferences, baseline.baseline)).saved, false);
    assert.equal(record.raw, baselineRaw);
    assert.equal(record.writes, 0);
    const storedRaw = JSON.stringify({ version: 1, ...DEFAULT_IDENTITY, ...fields });
    // JSON omits undefined fields; those still fail explicit saves, while absent fields remain compatible on load.
    if (!Object.values(fields).includes(undefined)) {
      record.raw = storedRaw;
      assert.equal((await browser.load()).readOnly, true);
      assert.equal(record.raw, storedRaw);
    }
    assert.deepEqual(legacy.writes, []);
  }
});

test('a conflicting profile save preserves the winning name, email and avatar as one transaction', async () => {
  const record = new AtomicRecord();
  const legacy = storage();
  const browser = new BrowserIdentityStore(record, legacy.adapter);
  const baseline = await browser.load();
  const first = { ...DEFAULT_IDENTITY, displayName: 'First saved profile', email: 'first@example.test', avatarImage: png };
  const second = { ...DEFAULT_IDENTITY, displayName: 'Second draft profile', email: 'second@example.test', avatarImage: null };
  const results = await Promise.all([browser.save(first, baseline.baseline), browser.save(second, baseline.baseline)]);
  assert.equal(results[0].saved, true);
  assert.equal(results[1].saved, false);
  assert.deepEqual((await browser.load()).preferences, first);
  assert.equal(record.writes, 1);
  assert.equal(second.email, 'second@example.test');
});
