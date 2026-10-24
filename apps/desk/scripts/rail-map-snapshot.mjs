#!/usr/bin/env node
// Rebuild src/content/rail-map.json, the Rail Map's snapshot of this
// repository: branches on origin, their commits and the pull requests.
//
//   node scripts/rail-map-snapshot.mjs [--pulls pulls.json] [--days 45] [--no-fetch]
//
// Pull requests come from `--pulls` (the output of
// `gh pr list --state all --limit 500 --json number,title,state,headRefName,headRefOid,labels,createdAt,mergedAt,closedAt`),
// or from running that `gh` command when it is signed in. Without either,
// only merged pull requests are listed, read from merge commit messages.
// Hashes are kept in full so two commits never share an id; the view
// shortens them for display. The snapshot keeps hashes, dates, subjects
// and branch names only: no authors, emails or file contents.
// It first runs `git fetch --prune origin`, so branches deleted on GitHub
// drop out; `--no-fetch` skips that and uses the refs already fetched.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(desk, 'src/content/rail-map.json');
const repository = 'CloudworkSystems/open-convo';
const mainBranch = 'main';
const maxCommits = 900;

const args = process.argv.slice(2);
const option = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const days = Number(option('--days') ?? 45);
if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days.');

const git = (...rest) => execFileSync('git', ['-C', desk, ...rest], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

if (!args.includes('--no-fetch')) git('fetch', '--prune', '--quiet', 'origin');

const refs = new Map();
for (const line of git('for-each-ref', 'refs/remotes/origin', '--format=%(refname:strip=3)%00%(objectname)').trim().split('\n')) {
  const [name, hash] = line.split('\0');
  if (!name || name === 'HEAD') continue;
  refs.set(hash, [...(refs.get(hash) ?? []), name]);
}
if (![...refs.values()].flat().includes(mainBranch)) throw new Error(`origin/${mainBranch} is missing. Run git fetch --prune origin first.`);

// Squash merges land on main's first-parent line as one commit named
// "Title (#123)", with no "Merge pull request" subject to read.
const mainFirstParents = new Set(git('rev-list', '--first-parent', `--max-count=${maxCommits}`, `origin/${mainBranch}`).trim().split('\n'));
const since = new Date(Date.now() - days * 86_400_000).toISOString();
const log = git('log', '--remotes=origin', '--topo-order', '--date-order', `--since=${since}`, `--max-count=${maxCommits}`, '--format=%H%x00%P%x00%cI%x00%s%x1e');
const mainTip = git('rev-parse', `origin/${mainBranch}`).trim();
const toCommit = (entry) => {
  const [hash, parents, date, subject] = entry.split('\0');
  const merged = /^Merge pull request #(\d+) /.exec(subject) ?? (mainFirstParents.has(hash) ? /\(#(\d+)\)$/.exec(subject) : null);
  return {
    hash, parents: parents ? parents.split(' ') : [], date, subject,
    refs: refs.get(hash) ?? [], ...(merged ? { mergedPull: Number(merged[1]) } : {}),
  };
};
// The main tip is always kept, even when main had no commit inside the
// window, so the view always has a main track to start from. It is older
// than every commit the window kept, so it goes last.
const commits = log.split('\x1e').map((entry) => entry.trim()).filter(Boolean).map(toCommit);
if (!commits.some((commit) => commit.hash === mainTip)) {
  commits.push(toCommit(git('log', '-1', '--format=%H%x00%P%x00%cI%x00%s', mainTip).trim()));
}

const branches = [...refs.entries()].flatMap(([hash, names]) => names.map((name) => {
  const [behind, ahead] = git('rev-list', '--left-right', '--count', `origin/${mainBranch}...${hash}`).trim().split(/\s+/).map(Number);
  const [date, subject] = git('log', '-1', '--format=%cI%x00%s', hash).trim().split('\0');
  return { name, tip: hash, date, subject, ahead, behind };
})).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));

function githubPulls() {
  const file = option('--pulls');
  if (file) return JSON.parse(readFileSync(resolve(file), 'utf8'));
  try {
    return JSON.parse(execFileSync('gh', ['pr', 'list', '--repo', repository, '--state', 'all', '--limit', '500',
      '--json', 'number,title,state,headRefName,headRefOid,labels,createdAt,mergedAt,closedAt'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } catch { return null; }
}

const listed = githubPulls();
const pulls = listed ? listed.map((pull) => {
  const state = String(pull.state).toLowerCase() === 'open' ? 'open' : pull.mergedAt ? 'merged' : 'closed';
  const agent = (pull.labels ?? []).map((label) => typeof label === 'string' ? label : label.name).find((name) => name?.startsWith('agent: '));
  return {
    number: pull.number, title: pull.title, state, branch: pull.headRefName,
    ...(pull.headRefOid ? { headHash: pull.headRefOid } : {}),
    ...(agent ? { agent: agent.slice('agent: '.length) } : {}),
    createdAt: pull.createdAt, ...(state === 'open' ? {} : { endedAt: pull.mergedAt ?? pull.closedAt }),
  };
}) : commits.filter((commit) => commit.mergedPull !== undefined).map((commit) => {
  const branch = /^Merge pull request #\d+ from [^/]+\/(\S+)/.exec(commit.subject)?.[1] ?? '';
  const title = branch || commit.subject.replace(/\s*\(#\d+\)$/, '');
  return { number: commit.mergedPull, title, state: 'merged', branch, createdAt: commit.date, endedAt: commit.date };
});
pulls.sort((a, b) => a.number - b.number);

const snapshot = { schemaVersion: 1, repository, takenAt: new Date().toISOString(), mainBranch, commits, branches, pulls };
writeFileSync(output, `${JSON.stringify(snapshot)}\n`);
console.log(`Rail Map snapshot: ${commits.length} commits, ${branches.length} branches, ${pulls.length} pull requests${listed ? '' : ' (merged only; gh was unavailable)'}.`);
