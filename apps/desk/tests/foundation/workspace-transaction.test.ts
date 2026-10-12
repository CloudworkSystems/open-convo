import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserRepository, DESK_STORAGE_KEY, type StorageLike, type WorkspaceRecord } from '../../src/adapters/browser-repository';
import { applyCommand } from '../../src/domain/commands';
import { createDemoState } from '../../src/domain/demo';

class LegacyCopy implements StorageLike {
  raw: string | null = null;
  writes = 0;
  getItem(key: string) { assert.equal(key, DESK_STORAGE_KEY); return this.raw; }
  setItem() { this.writes += 1; throw new Error('The transactional adapter must never overwrite legacy bytes.'); }
}

/** Exercises the adapter's transaction contract; native IDB isolation is checked in Chromium. */
class RecordFixture implements WorkspaceRecord {
  raw: string | null = null;
  failReads = false;
  abortWrites = false;
  commits = 0;
  tail = Promise.resolve();
  async read() {
    if (this.failReads) throw new Error('Record unavailable');
    return this.raw;
  }
  async update<T>(operation: (raw: string | null) => { result: T; raw?: string }): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      if (this.failReads) throw new Error('Record unavailable');
      const change = operation(this.raw);
      if (change.raw !== undefined) {
        if (this.abortWrites) throw new Error('Transaction aborted before commit');
        this.raw = change.raw;
        this.commits += 1;
      }
      return change.result;
    } finally { release(); }
  }
}

test('a valid earlier copy is read without migration; the first content save seeds the primary while preserving exact legacy bytes', async () => {
  const legacy = new LegacyCopy();
  const primary = new RecordFixture();
  const original = createDemoState();
  legacy.raw = JSON.stringify(original);
  const before = legacy.raw;
  const repository = new BrowserRepository(legacy, undefined, primary);
  const loaded = await repository.loadLatest();
  assert.deepEqual(loaded, { kind: 'ready', state: original, source: 'legacy' });
  assert.equal(primary.raw, null);
  assert.equal(primary.commits, 0);
  assert.equal(repository.load().kind, 'unavailable', 'A sync read must not bypass the primary authority.');
  const attempted = applyCommand(original, { type: 'set-draft', sessionId: original.sessions[0].id, text: 'Saved through the transaction' });
  assert.equal((await repository.save(attempted, original.revision)).kind, 'saved');
  assert.deepEqual(JSON.parse(primary.raw!), attempted);
  assert.equal(legacy.raw, before);
  assert.equal(legacy.writes, 0);
});

test('an existing primary record is the only authority even when a newer-looking legacy copy is incompatible', async () => {
  const legacy = new LegacyCopy();
  legacy.raw = '{incompatible preserved backup';
  const primary = new RecordFixture();
  const current = createDemoState();
  primary.raw = JSON.stringify(current);
  const repository = new BrowserRepository(legacy, undefined, primary);
  assert.deepEqual(await repository.loadLatest(), { kind: 'ready', state: current, source: 'transactional' });
  const attempted = applyCommand(current, { type: 'set-session-intent-draft', sessionId: current.sessions[0].id, text: 'Intent draft in primary' });
  assert.equal((await repository.save(attempted, current.revision)).kind, 'saved');
  assert.equal(legacy.raw, '{incompatible preserved backup');
  assert.equal(legacy.writes, 0);
});

test('two same-revision field edits commit one complete state and retain the losing attempt as a conflict', async () => {
  const legacy = new LegacyCopy();
  const primary = new RecordFixture();
  const original = createDemoState();
  primary.raw = JSON.stringify(original);
  const first = new BrowserRepository(legacy, undefined, primary);
  const second = new BrowserRepository(legacy, undefined, primary);
  const sessionId = original.sessions[0].id;
  const composer = applyCommand(original, { type: 'set-draft', sessionId, text: 'Keep the simultaneous composer draft' });
  const intent = applyCommand(original, { type: 'set-session-intent-draft', sessionId, text: 'Keep the simultaneous intent draft' });
  const results = await Promise.all([first.save(composer, original.revision), second.save(intent, original.revision)]);
  assert.deepEqual(results.map((result) => result.kind), ['saved', 'conflict']);
  assert.deepEqual(JSON.parse(primary.raw!), composer);
  if (results[1].kind === 'conflict') {
    assert.deepEqual(results[1].attemptedState, intent);
    assert.deepEqual(results[1].currentState, composer);
  }
  assert.equal(primary.commits, 1);
  assert.equal(legacy.writes, 0);
});

test('malformed or unsupported primary bytes remain authoritative and cannot be replaced by a valid legacy copy', async () => {
  for (const raw of ['{not JSON', JSON.stringify({ schemaVersion: 90 })]) {
    const legacy = new LegacyCopy();
    const original = createDemoState();
    legacy.raw = JSON.stringify(original);
    const primary = new RecordFixture();
    primary.raw = raw;
    const repository = new BrowserRepository(legacy, undefined, primary);
    const result = await repository.loadLatest();
    assert.equal(result.kind, 'invalid');
    if (result.kind === 'invalid') assert.equal(result.raw, raw);
    assert.equal((await repository.save(original, null)).kind, 'failed');
    assert.equal(primary.raw, raw);
    assert.equal(primary.commits, 0);
    assert.equal(legacy.writes, 0);
  }
});

test('unavailable primary storage exposes only a clearly older recovery copy and never falls back to a saved claim', async () => {
  const legacy = new LegacyCopy();
  const original = createDemoState();
  legacy.raw = JSON.stringify(original);
  const primary = new RecordFixture();
  primary.failReads = true;
  const repository = new BrowserRepository(legacy, undefined, primary);
  const loaded = await repository.loadLatest();
  assert.equal(loaded.kind, 'unavailable');
  if (loaded.kind === 'unavailable') {
    assert.equal(loaded.legacyRaw, legacy.raw);
    assert.match(loaded.error, /may be older/);
  }
  const result = await repository.save(original, null);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.deepEqual(result.attemptedState, original);
  assert.equal(primary.raw, null);
  assert.equal(legacy.writes, 0);
});

test('a transaction abort leaves the committed state untouched and the captured attempt retryable', async () => {
  const legacy = new LegacyCopy();
  const primary = new RecordFixture();
  const original = createDemoState();
  primary.raw = JSON.stringify(original);
  const repository = new BrowserRepository(legacy, undefined, primary);
  const attempted = applyCommand(original, { type: 'set-draft', sessionId: original.sessions[0].id, text: 'Retain this aborted attempt' });
  primary.abortWrites = true;
  const result = await repository.save(attempted, original.revision);
  assert.equal(result.kind, 'failed');
  if (result.kind === 'failed') assert.deepEqual(result.attemptedState, attempted);
  assert.deepEqual(JSON.parse(primary.raw!), original);
  primary.abortWrites = false;
  assert.equal((await repository.save(attempted, original.revision)).kind, 'saved');
  assert.deepEqual(JSON.parse(primary.raw!), attempted);
});

test('removing an observed primary record is a conflict rather than permission to seed from its retained legacy backup', async () => {
  const legacy = new LegacyCopy();
  const primary = new RecordFixture();
  const original = createDemoState();
  legacy.raw = JSON.stringify(original);
  primary.raw = legacy.raw;
  const repository = new BrowserRepository(legacy, undefined, primary);
  assert.equal((await repository.loadLatest()).kind, 'ready');
  primary.raw = null;
  assert.equal((await repository.loadLatest()).kind, 'empty');
  const attempted = applyCommand(original, { type: 'set-draft', sessionId: original.sessions[0].id, text: 'Do not bootstrap over removed work' });
  assert.equal((await repository.save(attempted, original.revision)).kind, 'conflict');
  assert.equal(primary.raw, null);
  assert.equal(legacy.raw, JSON.stringify(original));
});
