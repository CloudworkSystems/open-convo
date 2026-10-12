import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import {
  BrowserRoadmap,
  DESK_ROADMAP_KEY,
  ROADMAP_INVALID_WARNING,
  ROADMAP_SAVE_WARNING,
  ROADMAP_STALE_WARNING,
  ROADMAP_LOCK_WARNING,
} from '../../src/adapters/browser-roadmap';
import { DESK_STORAGE_KEY, type LockRunner } from '../../src/adapters/browser-repository';
import {
  defaultRoadmapPlacement,
  ROADMAP_EVIDENCE_REF,
  moveRoadmapCard,
  reconcileRoadmapPlacement,
  roadmapEvidenceLink,
  roadmapDropBeforeId,
  workspaceRoadmapCards,
  validateRecoveryRoadmap,
  type RecoveryCard,
} from '../../src/domain/recovery-roadmap';
import source from '../../src/content/recovery-roadmap.json';

const cards: RecoveryCard[] = ['one', 'two', 'three'].map((id) => ({
  id, title: id, track: 'Desk', column: 'next', sourceStatus: 'Checks pending',
  outcome: 'A tested recovery', checks: ['Run checks'], dependsOn: [], sources: ['PLAN.md'], notes: [],
}));

function storage(initial?: string) {
  const cache = new Map<string, string>([
    [DESK_STORAGE_KEY, 'independent sample work'],
    ...(initial === undefined ? [] : [[DESK_ROADMAP_KEY, initial]] as [string, string][]),
  ]);
  const writes: string[] = [];
  const adapter = {
    getItem: (key: string) => cache.get(key) ?? null,
    setItem: (key: string, value: string) => { writes.push(key); cache.set(key, value); },
  };
  return { cache, writes, adapter };
}

test('moving and reordering survives reload without revising work or recorded evidence', async () => {
  const original = structuredClone(cards);
  const store = storage();
  const repository = new BrowserRoadmap(store.adapter, locks());
  const initial = repository.load(cards);
  assert.equal(initial.warning, null);
  const reordered = moveRoadmapCard(initial.placement, cards, 'three', 'next', 'one');
  assert.deepEqual(reordered.columns.next, ['three', 'one', 'two']);
  assert.equal((await repository.saveMove({ id: 'three', column: 'next', beforeId: 'one' }, cards)).kind, 'saved');
  assert.equal((await repository.saveMove({ id: 'one', column: 'finished' }, cards)).kind, 'saved');
  const restored = new BrowserRoadmap(store.adapter, locks()).load(cards);
  assert.equal(restored.warning, null);
  assert.deepEqual(restored.placement.columns.finished, ['one']);
  assert.deepEqual(restored.placement.columns.next, ['three', 'two']);
  assert.equal(store.cache.get(DESK_STORAGE_KEY), 'independent sample work');
  assert.deepEqual(store.writes, [DESK_ROADMAP_KEY, DESK_ROADMAP_KEY]);
  assert.deepEqual(cards, original);
});

test('new cards get their source column and removed cards cannot return as ghosts', () => {
  const stored = { schemaVersion: 1, columns: { next: ['removed', 'two'], 'in-progress': ['one'], review: [], finished: ['three'] } };
  const current = [...cards.filter((card) => card.id !== 'three'), { ...cards[0], id: 'new', column: 'review' as const }];
  const placement = reconcileRoadmapPlacement(stored, current)!;
  assert.deepEqual(placement.columns, { suggested: [], next: ['two'], 'in-progress': ['one'], review: ['new'], finished: [] });
  assert.equal(moveRoadmapCard(placement, current, 'removed', 'finished'), placement);
  assert.equal(moveRoadmapCard(placement, current, 'one', 'next', 'removed'), placement);
});

test('legacy four-column placement remains readable without a load-time rewrite', async () => {
  const previous = { schemaVersion: 1, columns: { next: ['three'], 'in-progress': ['one'], review: [], finished: ['two'] } };
  const raw = JSON.stringify(previous);
  const store = storage(raw);
  const repository = new BrowserRoadmap(store.adapter, locks());
  const loaded = await repository.loadLatest(cards);
  assert.equal(loaded.warning, null);
  assert.deepEqual(loaded.placement.columns, { ...previous.columns, suggested: [] });
  assert.equal(store.cache.get(DESK_ROADMAP_KEY), raw);
  assert.deepEqual(store.writes, []);
  assert.equal((await repository.saveMove({ id: 'three', column: 'suggested' }, cards)).kind, 'saved');
  assert.deepEqual(new BrowserRoadmap(store.adapter, locks()).load(cards).placement.columns.suggested, ['three']);
});

test('shared work cards retain IDs and distinguish newly suggested work from legacy status', () => {
  const items = [
    { id: 'old-planned', goalId: 'folder-one', title: 'Saved planned work', status: 'planned' as const, createdAt: '2026-10-05T12:00:00Z' },
    { id: 'old-active', goalId: 'folder-two', title: 'Saved active work', status: 'active' as const, createdAt: '2026-10-05T12:00:00Z' },
    { id: 'old-returned', goalId: 'folder-two', title: 'Saved returned work', status: 'returned' as const, createdAt: '2026-10-05T12:00:00Z' },
    { id: 'new-suggestion', goalId: 'folder-one', title: 'Discuss a new idea', status: 'planned' as const, createdAt: '2026-10-06T12:00:00Z', roadmapColumn: 'suggested' as const },
  ];
  const original = structuredClone(items);
  const workCards = workspaceRoadmapCards(items);
  assert.deepEqual(workCards.map((card) => card.id), items.map((item) => item.id));
  assert.deepEqual(workCards.map((card) => card.column), ['next', 'in-progress', 'review', 'suggested']);
  const placement = moveRoadmapCard(defaultRoadmapPlacement(workCards), workCards, 'new-suggestion', 'finished');
  assert.deepEqual(placement.columns.finished, ['new-suggestion']);
  assert.equal(workCards.at(-1)?.sourceStatus, 'Suggested by you');
  assert.deepEqual(items, original);
});

test('dropping onto the next card reorders downward while explicit before-ordering stays precise', () => {
  const placement = defaultRoadmapPlacement(cards);
  const below = roadmapDropBeforeId(placement, 'one', 'next', 'two');
  assert.equal(below, 'three');
  assert.deepEqual(moveRoadmapCard(placement, cards, 'one', 'next', below).columns.next, ['two', 'one', 'three']);
  assert.deepEqual(moveRoadmapCard(placement, cards, 'one', 'next', 'two').columns.next, ['one', 'two', 'three']);
  const last = roadmapDropBeforeId(placement, 'one', 'next', 'three');
  assert.equal(last, undefined);
  assert.deepEqual(moveRoadmapCard(placement, cards, 'one', 'next', last).columns.next, ['two', 'three', 'one']);
  assert.equal(roadmapDropBeforeId(placement, 'three', 'next', 'one'), 'one');
  assert.deepEqual(moveRoadmapCard(placement, cards, 'three', 'next', 'one').columns.next, ['three', 'one', 'two']);
});

test('a tab with an older workspace view cannot erase another work card placement', async () => {
  const unseen = { ...cards[0], id: 'not-yet-received-work-item', column: 'suggested' as const };
  const stored = defaultRoadmapPlacement([...cards, unseen]);
  stored.columns.suggested = [];
  stored.columns.review = [unseen.id];
  const store = storage(JSON.stringify(stored));
  const repository = new BrowserRoadmap(store.adapter, locks());
  assert.ok(!Object.values(repository.load(cards).placement.columns).flat().includes(unseen.id));
  const result = await repository.saveMove({ id: 'one', column: 'finished' }, cards);
  assert.equal(result.kind, 'saved');
  if (result.kind === 'saved') assert.ok(!Object.values(result.placement.columns).flat().includes(unseen.id));
  const current = new BrowserRoadmap(store.adapter, locks()).load([...cards, unseen]).placement;
  assert.deepEqual(current.columns.review, [unseen.id]);
  assert.deepEqual(current.columns.finished, ['one']);
});

test('malformed local plans preserve original bytes and block replacement for the visit', async () => {
  const invalid = [
    '{broken placement',
    JSON.stringify({ schemaVersion: 2, columns: defaultRoadmapPlacement(cards).columns }),
    JSON.stringify({ schemaVersion: 1, columns: { next: ['one'], 'in-progress': [], review: ['one'], finished: [] } }),
    JSON.stringify({ schemaVersion: 1, columns: { next: ['one'], 'in-progress': [], review: [], finished: [], other: [] } }),
    JSON.stringify({ schemaVersion: 1, columns: { next: [123], 'in-progress': [], review: [], finished: [] } }),
  ];
  for (const raw of invalid) {
    const store = storage(raw);
    const repository = new BrowserRoadmap(store.adapter);
    const loaded = repository.load(cards);
    assert.equal(loaded.warning, ROADMAP_INVALID_WARNING);
    assert.deepEqual(loaded.placement, defaultRoadmapPlacement(cards));
    assert.deepEqual(await repository.saveMove({ id: 'one', column: 'finished' }, cards), { kind: 'failed', warning: ROADMAP_INVALID_WARNING });
    assert.equal(store.cache.get(DESK_ROADMAP_KEY), raw);
    assert.deepEqual(store.writes, []);
  }
});

test('a failed save retains the previous persisted placement and keeps further edits temporary', async () => {
  const previous = JSON.stringify(defaultRoadmapPlacement(cards));
  const store = storage(previous);
  let blocked = true;
  const repository = new BrowserRoadmap({
    getItem: store.adapter.getItem,
    setItem: (key, value) => { if (blocked) throw new Error('quota'); store.adapter.setItem(key, value); },
  }, locks());
  repository.load(cards);
  assert.deepEqual(await repository.saveMove({ id: 'one', column: 'finished' }, cards), { kind: 'failed', warning: ROADMAP_SAVE_WARNING });
  assert.equal(store.cache.get(DESK_ROADMAP_KEY), previous);
  assert.equal(new BrowserRoadmap(store.adapter).load(cards).placement.columns.next[0], 'one');
  blocked = false;
  assert.deepEqual(await repository.saveMove({ id: 'two', column: 'finished' }, cards), { kind: 'failed', warning: ROADMAP_SAVE_WARNING });
  assert.equal(store.cache.get(DESK_ROADMAP_KEY), previous);
  // Reload establishes a fresh visit after the storage problem is resolved.
  const reloaded = new BrowserRoadmap(store.adapter, locks());
  reloaded.load(cards);
  assert.equal((await reloaded.saveMove({ id: 'one', column: 'finished' }, cards)).kind, 'saved');
  assert.deepEqual(new BrowserRoadmap(store.adapter).load(cards).placement.columns.finished, ['one']);
});

test('damage arriving from another tab is preserved before the next attempted save', async () => {
  const store = storage();
  const repository = new BrowserRoadmap(store.adapter, locks());
  repository.load(cards);
  const damaged = 'other tab damaged placement';
  store.cache.set(DESK_ROADMAP_KEY, damaged);
  assert.deepEqual(await repository.saveMove({ id: 'one', column: 'finished' }, cards), { kind: 'failed', warning: ROADMAP_INVALID_WARNING });
  assert.equal(store.cache.get(DESK_ROADMAP_KEY), damaged);
  assert.deepEqual(store.writes, []);
});

test('storage read errors do not replace data or claim a successful save', async () => {
  const repository = new BrowserRoadmap({ getItem: () => { throw new Error('blocked'); }, setItem: () => { assert.fail('must not write'); } });
  const loaded = repository.load(cards);
  assert.equal(loaded.warning, ROADMAP_INVALID_WARNING);
  assert.deepEqual(await repository.saveMove({ id: 'one', column: 'finished' }, cards), { kind: 'failed', warning: ROADMAP_INVALID_WARNING });
});

function locks(): LockRunner {
  let queue = Promise.resolve();
  return <T>(operation: () => T | Promise<T>): Promise<T> => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
}

test('independent tab moves merge under their own lock without touching shared work', async () => {
  const store = storage();
  const withLock = locks();
  const first = new BrowserRoadmap(store.adapter, withLock);
  const second = new BrowserRoadmap(store.adapter, withLock);
  first.load(cards);
  second.load(cards);
  const results = await Promise.all([
    first.saveMove({ id: 'one', column: 'finished' }, cards),
    second.saveMove({ id: 'two', column: 'review' }, cards),
  ]);
  assert.deepEqual(results.map((result) => result.kind), ['saved', 'saved']);
  const current = new BrowserRoadmap(store.adapter).load(cards).placement;
  assert.deepEqual(current.columns.finished, ['one']);
  assert.deepEqual(current.columns.review, ['two']);
  assert.deepEqual(current.columns.next, ['three']);
  assert.equal(store.cache.get(DESK_STORAGE_KEY), 'independent sample work');
  assert.ok(store.writes.every((key) => key === DESK_ROADMAP_KEY));
});

test('missing write coordination leaves valid saved placement readable and refuses every write', async () => {
  const previous = defaultRoadmapPlacement(cards);
  previous.columns.next = ['two', 'three'];
  previous.columns.finished = ['one'];
  const raw = JSON.stringify(previous);
  const store = storage(raw);
  const repository = new BrowserRoadmap(store.adapter);
  assert.deepEqual(repository.load(cards).placement, previous);
  assert.equal(repository.load(cards).warning, ROADMAP_LOCK_WARNING);
  assert.deepEqual(await repository.saveMove({ id: 'two', column: 'review' }, cards), { kind: 'failed', warning: ROADMAP_LOCK_WARNING });
  assert.equal(store.cache.get(DESK_ROADMAP_KEY), raw);
  assert.deepEqual(store.writes, []);
});

test('an unknown card or missing reorder target cannot replace the saved board', async () => {
  const previous = JSON.stringify(defaultRoadmapPlacement(cards));
  const store = storage(previous);
  const repository = new BrowserRoadmap(store.adapter, locks());
  repository.load(cards);
  assert.deepEqual(await repository.saveMove({ id: 'unknown', column: 'finished' }, cards), { kind: 'failed', warning: ROADMAP_SAVE_WARNING });
  assert.deepEqual(await repository.saveMove({ id: 'one', column: 'review', beforeId: 'removed' }, cards), { kind: 'failed', warning: ROADMAP_STALE_WARNING });
  assert.equal(store.cache.get(DESK_ROADMAP_KEY), previous);
  assert.deepEqual(store.writes, []);
});

test('the versioned source is valid and bad source columns or duplicate IDs are refused', () => {
  assert.ok(validateRecoveryRoadmap(source));
  assert.equal(validateRecoveryRoadmap({ ...source, schemaVersion: 2 }), null);
  assert.equal(validateRecoveryRoadmap({ ...source, cards: [{ ...cards[0], column: 'approved' }] }), null);
  assert.equal(validateRecoveryRoadmap({ ...source, cards: [cards[0], cards[0]] }), null);
});

test('evidence resolves only known Open Convo files and refuses arbitrary targets', () => {
  assert.equal(roadmapEvidenceLink('PLAN.md'), `https://github.com/CloudworkSystems/open-convo/blob/${ROADMAP_EVIDENCE_REF}/PLAN.md`);
  assert.ok(roadmapEvidenceLink('apps/desk/README.md: storage')?.endsWith('/apps/desk/README.md'));
  assert.ok(roadmapEvidenceLink('packages/clarity/README.md')?.endsWith('/packages/clarity/README.md'));
  for (const invalid of ['https://example.com', 'javascript:alert(1)', '../../PLAN.md', 'XX-01', 'DK-07', 'toString', 'docs/unknown.md']) {
    assert.equal(roadmapEvidenceLink(invalid), null);
  }
});

test('each shipped card has valid dependencies and evidence files that exist in this repo', () => {
  const repositoryRoot = new URL('../../../../', import.meta.url);
  const cardIds = new Set(source.cards.map((card) => card.id));
  for (const card of source.cards) {
    for (const dependency of card.dependsOn) {
      assert.ok(dependency !== card.id && cardIds.has(dependency), `${card.id}: dependency ${dependency} does not name another shipped card.`);
    }
    for (const evidence of card.sources) {
      const link = roadmapEvidenceLink(evidence);
      assert.ok(link, `${card.id}: ${evidence} has no allowed evidence link.`);
      const path = decodeURIComponent(new URL(link).pathname.split(`/blob/${ROADMAP_EVIDENCE_REF}/`)[1]);
      assert.ok(existsSync(new URL(path, repositoryRoot)), `${card.id}: evidence ${path} is missing from the repo.`);
    }
  }
});

test('shipped roadmap text carries no private names, audit IDs or transcript references', () => {
  const text = JSON.stringify(source);
  for (const marker of [/patrick/i, /louder locally/i, /\bwong\b/i, /prospect/i, /\b[A-Z]{2}-\d{2}\b/, /\bB\d{4}:C\d{4}/, /true-convo\b/]) {
    assert.doesNotMatch(text, marker);
  }
});
