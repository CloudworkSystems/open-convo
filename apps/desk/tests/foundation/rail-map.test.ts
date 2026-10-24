import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  indexPulls, layoutRails, mainLine, pullSpan, pullsForCommit, summarizeRails, validateRailMapSnapshot,
  type RailMapSnapshot,
} from '../../src/domain/rail-map';

// Invented history: main m3 <- m2 <- m1; feature f2 <- f1 branches from m1,
// merged into main by m3; "open" branches from m2 and is still unmerged.
function invented(): RailMapSnapshot {
  return {
    schemaVersion: 1, repository: 'invented/repo', takenAt: '2026-10-10T12:00:00Z', mainBranch: 'main',
    commits: [
      { hash: 'o1', parents: ['m2'], date: '2026-10-10T11:00:00Z', subject: 'Invented open work', refs: ['open'] },
      { hash: 'm3', parents: ['m2', 'f2'], date: '2026-10-10T10:00:00Z', subject: 'Merge pull request #2 from invented/feature', refs: ['main'], mergedPull: 2 },
      { hash: 'f2', parents: ['f1'], date: '2026-10-10T09:00:00Z', subject: 'Invented feature, part 2', refs: ['feature'] },
      { hash: 'm2', parents: ['m1'], date: '2026-10-10T08:00:00Z', subject: 'Invented main change', refs: [] },
      { hash: 'f1', parents: ['m1'], date: '2026-10-09T09:00:00Z', subject: 'Invented feature, part 1', refs: [] },
      { hash: 'm1', parents: ['outside'], date: '2026-10-09T08:00:00Z', subject: 'Invented start', refs: [] },
    ],
    branches: [
      { name: 'open', tip: 'o1', date: '2026-10-10T11:00:00Z', subject: 'Invented open work', ahead: 1, behind: 1 },
      { name: 'main', tip: 'm3', date: '2026-10-10T10:00:00Z', subject: 'Merge', ahead: 0, behind: 0 },
      { name: 'feature', tip: 'f2', date: '2026-10-10T09:00:00Z', subject: 'Invented feature, part 2', ahead: 0, behind: 2 },
    ],
    pulls: [
      { number: 2, title: 'Invented feature', state: 'merged', branch: 'feature', headHash: 'f2', agent: 'claude', createdAt: '2026-10-09T09:30:00Z', endedAt: '2026-10-10T10:00:00Z' },
      { number: 3, title: 'Invented open work', state: 'open', branch: 'open', headHash: 'o1', createdAt: '2026-10-10T11:10:00Z' },
      { number: 1, title: 'Invented old try', state: 'closed', branch: 'feature', createdAt: '2026-10-01T09:00:00Z', endedAt: '2026-10-02T09:00:00Z' },
    ],
  };
}

test('the main line follows first parents from the main branch tip', () => {
  assert.deepEqual([...mainLine(invented())], ['m3', 'm2', 'm1']);
});

test('lanes keep main in lane 0 and give each branch its own track', () => {
  const rows = layoutRails(invented());
  const lane = Object.fromEntries(rows.map((row) => [row.commit.hash, row.lane]));
  assert.equal(lane.m3, 0); assert.equal(lane.m2, 0); assert.equal(lane.m1, 0);
  assert.notEqual(lane.o1, 0); assert.notEqual(lane.f2, 0);
  assert.equal(lane.f1, lane.f2, 'A branch stays on one track.');
  assert.ok(rows.find((row) => row.commit.hash === 'm3')!.merge);
  // Every row's tracks reach the next row: from this commit's lane or a lane passing through.
  rows.forEach((row, index) => {
    for (const segment of row.segments) {
      assert.ok(segment.from === row.lane || segment.from === segment.lane);
      const next = rows[index + 1];
      if (next) assert.ok(segment.to === segment.lane || segment.to === next.lane);
    }
  });
  // The open branch's track runs down into main at m2.
  const openRow = rows.findIndex((row) => row.commit.hash === 'o1');
  const intoMain = rows.slice(openRow, rows.findIndex((row) => row.commit.hash === 'm2'))
    .flatMap((row) => row.segments).some((segment) => segment.to === 0 && segment.from === lane.o1);
  assert.ok(intoMain, 'The open branch never joins its parent on main.');
  // It does not join lane 0 until the row just above m2, so it never looks connected to m3.
  const aboveM2 = rows.findIndex((row) => row.commit.hash === 'm2') - 1;
  rows.slice(openRow, aboveM2).forEach((row) => assert.ok(
    !row.segments.some((segment) => segment.from === lane.o1 && segment.to === 0),
    `The open branch joins main early, at ${row.commit.hash}.`,
  ));
  // A parent outside the snapshot ends the track instead of opening a lane.
  assert.deepEqual(rows.at(-1)!.segments, []);
});

test('a branch whose parent is the main tip keeps its own track past newer commits on other branches', () => {
  const base = invented();
  // git log --topo-order --date-order can list o1 (parent m3), then x1 (another branch), then m3.
  const snapshot: RailMapSnapshot = {
    ...base,
    commits: [
      { hash: 'o1', parents: ['m3'], date: '2026-10-10T12:00:00Z', subject: 'Invented open work', refs: ['open'] },
      { hash: 'x1', parents: ['m2'], date: '2026-10-10T11:00:00Z', subject: 'Invented other work', refs: ['other'] },
      { hash: 'm3', parents: ['m2'], date: '2026-10-10T10:00:00Z', subject: 'Invented main tip', refs: ['main'] },
      { hash: 'm2', parents: ['outside'], date: '2026-10-10T08:00:00Z', subject: 'Invented main change', refs: [] },
    ],
  };
  const rows = layoutRails(snapshot);
  const openLane = rows[0].lane;
  assert.notEqual(openLane, 0);
  assert.ok(!rows[0].segments.some((segment) => segment.to === 0 && segment.lane !== 0), 'The open branch bends into main before x1.');
  assert.ok(rows[1].segments.some((segment) => segment.from === openLane && segment.to === 0), 'The open branch never reaches m3.');
  assert.ok(rows[1].segments.some((segment) => segment.from === 0 && segment.to === 0), 'The main line breaks at x1.');
});

test('pull requests attach to branch tips and merge commits; the latest pull wins a branch', () => {
  const snapshot = invented();
  const index = indexPulls(snapshot.pulls);
  assert.equal(index.byBranch.get('feature')!.number, 2);
  const byHash = Object.fromEntries(snapshot.commits.map((commit) => [commit.hash, pullsForCommit(commit, index, 'main').map((pull) => pull.number)]));
  assert.deepEqual(byHash.f2, [2]);
  assert.deepEqual(byHash.m3, [2], 'The main tip names the pull it merged, not a pull for main.');
  assert.deepEqual(byHash.o1, [3]);
  assert.deepEqual(byHash.m2, []);
});

test('summary counts and timeline spans', () => {
  const snapshot = invented();
  assert.deepEqual(summarizeRails(snapshot), { openPulls: 1, mergedLastWeek: 1, branchesWithWork: 1, commits: 6 });
  const start = Date.parse('2026-10-09T00:00:00Z'), end = Date.parse('2026-10-11T00:00:00Z');
  assert.equal(pullSpan(snapshot.pulls[2], start, end, snapshot.takenAt), null, 'A pull closed before the range is left out.');
  const open = pullSpan(snapshot.pulls[1], start, end, snapshot.takenAt)!;
  assert.ok(open.left > .5 && open.width > 0, 'An open pull runs to the snapshot time.');
  const merged = pullSpan(snapshot.pulls[0], start, end, snapshot.takenAt)!;
  assert.ok(Math.abs(merged.left + merged.width - (Date.parse('2026-10-10T10:00:00Z') - start) / (end - start)) < 1e-9);
});

test('validation rejects malformed snapshots', () => {
  assert.throws(() => validateRailMapSnapshot({ ...invented(), schemaVersion: 2 }), /header/);
  assert.throws(() => validateRailMapSnapshot({ ...invented(), commits: [invented().commits[0], invented().commits[0]] }), /repeats/);
  assert.throws(() => validateRailMapSnapshot({ ...invented(), pulls: [{ ...invented().pulls[0], state: 'draft' }] }), /pull request/);
  assert.throws(() => validateRailMapSnapshot({ ...invented(), branches: [{ ...invented().branches[0], ahead: -1 }] }), /branch/);
});

test('the bundled snapshot is valid and carries no author or email fields', () => {
  const raw = readFileSync(new URL('../../src/content/rail-map.json', import.meta.url), 'utf8');
  const snapshot = validateRailMapSnapshot(JSON.parse(raw));
  assert.ok(snapshot.commits.length > 0);
  assert.ok(snapshot.commits.every((commit) => /^[0-9a-f]{40}$/.test(commit.hash) && commit.parents.every((parent) => /^[0-9a-f]{40}$/.test(parent))), 'Snapshot hashes must be full, so short prefixes can never collide.');
  assert.ok(snapshot.commits.some((commit) => commit.refs.includes(snapshot.mainBranch)), 'The main branch tip is missing.');
  assert.doesNotMatch(raw, /"(author|email|committer)"/);
  assert.doesNotMatch(raw, /@[a-z0-9-]+\.[a-z]{2,}/i, 'An email address is in the snapshot.');
  layoutRails(snapshot);
});
