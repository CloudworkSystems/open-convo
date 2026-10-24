// Rail Map: the repository's branches, commits and pull requests as tracks.
// The snapshot is plain repository history (no authors, no file contents);
// this module turns it into lanes and states the view can draw.

export interface RailCommit {
  hash: string;
  parents: string[];
  date: string;
  subject: string;
  /** Branch names whose tip is this commit. */
  refs: string[];
  /** The pull request a "Merge pull request #N" commit merged. */
  mergedPull?: number;
}

export type RailPullState = 'open' | 'merged' | 'closed';

export interface RailPull {
  number: number;
  title: string;
  state: RailPullState;
  branch: string;
  headHash?: string;
  agent?: string;
  createdAt: string;
  endedAt?: string;
}

export interface RailBranch {
  name: string;
  tip: string;
  date: string;
  subject: string;
  ahead: number;
  behind: number;
}

export interface RailMapSnapshot {
  schemaVersion: 1;
  repository: string;
  takenAt: string;
  mainBranch: string;
  /** Newest first, children before parents. */
  commits: RailCommit[];
  branches: RailBranch[];
  pulls: RailPull[];
}

/** One drawn track piece between a commit row and the next row. */
export interface RailSegment { from: number; to: number; lane: number }

export interface RailRow {
  commit: RailCommit;
  lane: number;
  onMain: boolean;
  merge: boolean;
  segments: RailSegment[];
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const date = (value: unknown): value is string => text(value) && !Number.isNaN(Date.parse(value));

/** Reject a snapshot that does not match the shape the view reads. */
export function validateRailMapSnapshot(input: unknown): RailMapSnapshot {
  if (!record(input) || input.schemaVersion !== 1 || !text(input.repository) || !date(input.takenAt) || !text(input.mainBranch)) throw new Error('The Rail Map snapshot header is invalid.');
  if (!Array.isArray(input.commits) || !Array.isArray(input.branches) || !Array.isArray(input.pulls)) throw new Error('The Rail Map snapshot lists are missing.');
  const hashes = new Set<string>();
  for (const commit of input.commits) {
    if (!record(commit) || !text(commit.hash) || !Array.isArray(commit.parents) || !commit.parents.every(text) || !date(commit.date) || !text(commit.subject)
      || !Array.isArray(commit.refs) || !commit.refs.every(text) || !(commit.mergedPull === undefined || count(commit.mergedPull))) throw new Error('A Rail Map commit is invalid.');
    if (hashes.has(commit.hash)) throw new Error(`A Rail Map commit repeats: ${commit.hash}`);
    hashes.add(commit.hash);
  }
  for (const branch of input.branches) {
    if (!record(branch) || !text(branch.name) || !text(branch.tip) || !date(branch.date) || !text(branch.subject) || !count(branch.ahead) || !count(branch.behind)) throw new Error('A Rail Map branch is invalid.');
  }
  for (const pull of input.pulls) {
    if (!record(pull) || !count(pull.number) || !text(pull.title) || !['open', 'merged', 'closed'].includes(pull.state as string) || !text(pull.branch)
      || !date(pull.createdAt) || !(pull.endedAt === undefined || date(pull.endedAt)) || !(pull.agent === undefined || text(pull.agent))
      || !(pull.headHash === undefined || text(pull.headHash))) throw new Error('A Rail Map pull request is invalid.');
  }
  return input as unknown as RailMapSnapshot;
}

/** The main branch's first-parent line, which always runs in lane 0. */
export function mainLine(snapshot: RailMapSnapshot): Set<string> {
  const byHash = new Map(snapshot.commits.map((commit) => [commit.hash, commit]));
  const line = new Set<string>();
  let hash = snapshot.commits.find((commit) => commit.refs.includes(snapshot.mainBranch))?.hash;
  while (hash && byHash.has(hash) && !line.has(hash)) {
    line.add(hash);
    hash = byHash.get(hash)!.parents[0];
  }
  return line;
}

/**
 * Assign each commit a lane, newest first, the way `git log --graph` does:
 * a lane holds the commit it expects next; a commit takes the first lane that
 * expects it, its first parent continues there, and other parents open lanes.
 * Lane 0 is kept for the main line. Parents outside the snapshot end their lane.
 */
export function layoutRails(snapshot: RailMapSnapshot): RailRow[] {
  const main = mainLine(snapshot);
  const known = new Set(snapshot.commits.map((commit) => commit.hash));
  // Lane 0 waits for the main tip from the start, so a newer branch whose
  // parent is an older main commit keeps its own lane down to that parent
  // instead of appearing to join the main commits above it.
  const mainTip = snapshot.commits.find((commit) => main.has(commit.hash))?.hash ?? null;
  const lanes: (string | null)[] = [mainTip];
  const free = () => {
    const index = lanes.findIndex((value, lane) => lane > 0 && value === null);
    if (index >= 0) return index;
    lanes.push(null);
    return lanes.length - 1;
  };
  const rows: { commit: RailCommit; lane: number; before: (string | null)[]; after: (string | null)[] }[] = [];
  for (const commit of snapshot.commits) {
    const before = [...lanes];
    const waiting = lanes.flatMap((value, lane) => value === commit.hash ? [lane] : []);
    const lane = main.has(commit.hash) ? 0 : waiting[0] ?? free();
    for (const index of waiting) lanes[index] = null;
    commit.parents.forEach((parent, index) => {
      if (!known.has(parent)) return;
      // The main line always continues in lane 0, even when a branch lane
      // already waits for the same parent; both lanes meet at its row.
      if (lane === 0 && index === 0 && main.has(parent)) { lanes[0] = parent; return; }
      if (lanes.includes(parent)) return;
      if (index === 0 && lane > 0 && lanes[lane] === null) lanes[lane] = parent;
      else lanes[free()] = parent;
    });
    while (lanes.length > 1 && lanes[lanes.length - 1] === null) lanes.pop();
    rows.push({ commit, lane, before, after: [...lanes] });
  }
  return rows.map((row, index) => {
    const next = rows[index + 1];
    const segments: RailSegment[] = [];
    row.after.forEach((hash, lane) => {
      if (hash === null) return;
      const to = next && next.commit.hash === hash ? next.lane : lane;
      if (row.commit.parents.includes(hash)) segments.push({ from: row.lane, to, lane });
      if (row.before[lane] === hash) segments.push({ from: lane, to, lane });
    });
    return { commit: row.commit, lane: row.lane, onMain: main.has(row.commit.hash), merge: row.commit.parents.length > 1, segments };
  });
}

export interface RailPullIndex { byNumber: Map<number, RailPull>; byBranch: Map<string, RailPull>; byHead: Map<string, RailPull> }

/** Look up pull requests by number, branch (latest wins) and head commit. */
export function indexPulls(pulls: readonly RailPull[]): RailPullIndex {
  const byNumber = new Map<number, RailPull>(); const byBranch = new Map<string, RailPull>(); const byHead = new Map<string, RailPull>();
  for (const pull of pulls) {
    byNumber.set(pull.number, pull);
    const current = byBranch.get(pull.branch);
    if (!current || current.number < pull.number) byBranch.set(pull.branch, pull);
    if (pull.headHash) byHead.set(pull.headHash, pull);
  }
  return { byNumber, byBranch, byHead };
}

/** The pull requests a commit row should name: its branch tips' and the one it merged. */
export function pullsForCommit(commit: RailCommit, index: RailPullIndex, mainBranch: string): RailPull[] {
  const found: RailPull[] = [];
  const add = (pull: RailPull | undefined) => { if (pull && !found.includes(pull)) found.push(pull); };
  for (const ref of commit.refs) if (ref !== mainBranch) add(index.byBranch.get(ref));
  add(commit.mergedPull === undefined ? undefined : index.byNumber.get(commit.mergedPull));
  if (!found.length && !commit.refs.length) add(index.byHead.get(commit.hash));
  return found;
}

export interface RailSummary { openPulls: number; mergedLastWeek: number; branchesWithWork: number; commits: number }

export function summarizeRails(snapshot: RailMapSnapshot): RailSummary {
  const weekAgo = Date.parse(snapshot.takenAt) - 7 * 86_400_000;
  return {
    openPulls: snapshot.pulls.filter((pull) => pull.state === 'open').length,
    mergedLastWeek: snapshot.pulls.filter((pull) => pull.state === 'merged' && pull.endedAt && Date.parse(pull.endedAt) >= weekAgo).length,
    branchesWithWork: snapshot.branches.filter((branch) => branch.name !== snapshot.mainBranch && branch.ahead > 0).length,
    commits: snapshot.commits.length,
  };
}

/** Where a pull request's bar starts and ends on a timeline from `start` to `end`, as fractions. */
export function pullSpan(pull: RailPull, start: number, end: number, takenAt: string): { left: number; width: number } | null {
  const opened = Date.parse(pull.createdAt);
  const closed = Date.parse(pull.state === 'open' ? takenAt : pull.endedAt ?? takenAt);
  if (closed < start || opened > end || end <= start) return null;
  const left = (Math.max(opened, start) - start) / (end - start);
  const right = (Math.min(closed, end) - start) / (end - start);
  return { left, width: Math.max(0, right - left) };
}
