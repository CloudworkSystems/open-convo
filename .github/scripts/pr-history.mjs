// Writes pr-history.csv and pr-history.json: one row per pull request in this
// repository, for the owner's Google Sheet and for Canvas and Atlas.
//
//   node .github/scripts/pr-history.mjs <folder>
//
// <folder> is a checkout of the pr-history-data branch. A pull request whose
// updated_at matches the row already there is reused, so a daily run only
// reads the pull requests that changed. The first columns use the Rail Map
// snapshot's pull fields (number, title, state, branch, headHash, agent,
// createdAt, endedAt). Only agent names are kept, never authors or emails.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA_VERSION = 1;
export const CODEX = 'chatgpt-codex-connector[bot]';
const OWNER = 'CloudworkSystems';

// Unlabeled pull requests whose builder the plans name (household lists: Codex).
const KNOWN_AGENTS = { 58: 'codex', 71: 'codex' };

const OUTSIDE = /^\W*(independent (re-)?review|independent review and plan check)/i;
// "No P0 or P1" alone isn't clean: an open P2 still blocks auto-merge. A
// review counts as "findings" when it lists a P0, P1 or P2 (a count such as
// "one P2", a "[P2]" tag or a "P1." heading) in a clause that doesn't say
// it was fixed or resolved, or when it says "not clean".
const OUTSIDE_CLEAN = /clean|no (new )?findings|nothing new|no open p1 or p2/i;
const OUTSIDE_OPEN = new RegExp([
  String.raw`\b(\d+|one|two|three|four|five|six|an?)\s+(open\s+|new\s+)?p[0-2]s?\b`,
  String.raw`\[p[0-2]\]`,
  String.raw`^[#*\s]*p[0-2][.:]`,
].join('|'), 'im');
const FIXED = /\b(fixed|fixes|resolved|resolves)\b/i;
const NOT_CLEAN = /\bnot\s+(yet\s+)?clean\b/i;

export function outsideIsClean(text) {
  // Each clause on its own: "Fixed one P1" and "one P1, fixed" are both
  // fixed, while "one P1 was fixed, but one P2 remains open" is open.
  const clauses = text.split(/(?<=\.)\s+|\n+|[;,]\s*|\s+but\s+/i);
  const open = clauses.some((clause) => OUTSIDE_OPEN.test(clause) && !FIXED.test(clause));
  return OUTSIDE_CLEAN.test(text) && !NOT_CLEAN.test(text) && !open;
}

export const COLUMNS = [
  'number', 'title', 'agent', 'state', 'draft', 'branch', 'createdAt', 'endedAt', 'daysOpen',
  'commits', 'filesChanged', 'additions', 'deletions', 'areas', 'labels',
  'codexRounds', 'codexLatest', 'codexP0', 'codexP1', 'codexP2', 'codexP3',
  'outsideReviewer', 'outsideRounds', 'outsideLatest', 'outsideCommit', 'outsideOnHead', 'ownerApproved', 'headHash', 'updatedAt', 'link',
];

// apps/desk, packages/<name>, docs/plans; otherwise the top folder or file.
export function area(path) {
  const parts = path.split('/');
  if (['apps', 'packages', 'docs'].includes(parts[0]) && parts.length > 2) return parts.slice(0, 2).join('/');
  return parts[0];
}

export function agentOf(pull, commits) {
  if (KNOWN_AGENTS[pull.number]) return KNOWN_AGENTS[pull.number];
  if (pull.user?.login === 'dependabot[bot]') return 'dependabot';
  const label = pull.labels.map((l) => l.name).find((name) => name.startsWith('agent: '));
  if (label) return label.slice('agent: '.length);
  if (pull.user?.login === CODEX || pull.head.ref.startsWith('codex/')) return 'codex';
  if (commits.some((c) => c.commit.author?.name === 'Cursor Agent')) return 'grokbot';
  if (commits.some((c) => /Claude-Session|Built-by: Claude|claude\.ai\/code/.test(c.commit.message))) return 'claude';
  if (pull.head.ref.startsWith('claude/')) return 'claude';
  return 'unknown';
}

// Rounds are the distinct commits Codex reviewed: reviews with findings and
// "Didn't find any major issues" comments. The latest result comes from
// Codex's summary comment when it has one, else from the last round.
export function codexSummary({ reviews, comments, reviewComments }) {
  const commits = new Set();
  const rounds = [];
  for (const r of reviews) {
    if (r.user?.login !== CODEX) continue;
    if (r.commit_id) commits.add(r.commit_id.slice(0, 10));
    if ((r.body ?? '').includes('Codex Review')) rounds.push([r.submitted_at, 'had findings']);
  }
  let state = null;
  for (const c of comments) {
    if (c.user?.login !== CODEX) continue;
    if (c.body.startsWith("Codex Review: Didn't find any major issues")) {
      const sha = /Reviewed commit:\*\*\s*`([0-9a-f]+)`/.exec(c.body)?.[1];
      commits.add(sha ? sha.slice(0, 10) : `comment-${c.id}`);
      rounds.push([c.created_at, 'clean']);
    }
    const json = /codex-review-state:v1 (\{.*?\}) -->/s.exec(c.body)?.[1];
    // A malformed state is skipped, as the gate does, rather than stopping the run.
    if (json) { try { state = JSON.parse(json).code_review ?? state; } catch { /* unusable */ } }
  }
  rounds.sort((a, b) => a[0].localeCompare(b[0]));
  let latest = rounds.length ? rounds.at(-1)[1] : 'none';
  // Codex's flags only mean something once its review of the latest commit has finished.
  if (state?.status === 'failed') latest = 'review failed';
  else if (state && state.status !== 'completed') latest = 'review running';
  else if (state?.has_unresolved_findings === true) latest = 'open findings';
  else if (state?.has_unresolved_findings === false && state?.has_any_findings === false) latest = 'clean';
  const badges = reviewComments.filter((c) => c.user?.login === CODEX).flatMap((c) => [...(c.body ?? '').matchAll(/P([0-3]) Badge/g)].map((m) => m[1]));
  const count = (p) => badges.filter((b) => b === p).length;
  return { codexRounds: commits.size, codexLatest: latest, codexP0: count('0'), codexP1: count('1'), codexP2: count('2'), codexP3: count('3') };
}

// Independent reviews: comments or reviews that start "Independent review",
// or GrokBot's, which end "— GrokBot review". Clean or not is a text match.
// A review counts only for the commit it reviewed: the one its text names,
// else the commit a GitHub review was left on.
export function outsideSummary({ reviews, comments }, headSha = '') {
  const found = [];
  for (const item of [...comments, ...reviews]) {
    const body = (item.body ?? '').trim();
    if (!body || body.startsWith('@cursor')) continue;
    const grok = item.user?.login === 'cursor[bot]' || body.includes('GrokBot review');
    if (!OUTSIDE.test(body) && !body.includes('GrokBot review')) continue;
    const head = body.slice(0, 400);
    const clean = outsideIsClean(head);
    const commit = (/\b[0-9a-f]{7,40}\b/.exec(head)?.[0] ?? item.commit_id ?? '').slice(0, 10);
    found.push([item.submitted_at ?? item.created_at, grok ? 'GrokBot' : 'Claude', clean ? 'clean' : 'findings', commit]);
  }
  found.sort((a, b) => a[0].localeCompare(b[0]));
  return {
    outsideReviewer: [...new Set(found.map((f) => f[1]))].sort().join(' + '),
    outsideRounds: found.length,
    outsideLatest: found.length ? found.at(-1)[2] : '',
    outsideCommit: found.length ? found.at(-1)[3] : '',
    outsideOnHead: !found.length ? '' : found.at(-1)[3] && headSha.startsWith(found.at(-1)[3]) ? 'yes' : 'no',
  };
}

export function buildRow(pull, { files, reviews, comments, reviewComments, commits }) {
  const state = pull.state === 'open' ? 'open' : pull.merged_at ? 'merged' : 'closed';
  const ended = pull.merged_at ?? pull.closed_at ?? '';
  return {
    number: pull.number, title: pull.title, agent: agentOf(pull, commits), state,
    draft: pull.draft ? 'yes' : '', branch: pull.head.ref,
    createdAt: pull.created_at, endedAt: ended,
    daysOpen: ended ? Math.round((Date.parse(ended) - Date.parse(pull.created_at)) / 864e3) / 100 : '',
    commits: commits.length, filesChanged: files.length,
    additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
    areas: [...new Set(files.map((f) => area(f.filename)))].sort().join('; '),
    labels: pull.labels.map((l) => l.name).join('; '),
    ...codexSummary({ reviews, comments, reviewComments }),
    ...outsideSummary({ reviews, comments }, pull.head.sha),
    ownerApproved: reviews.some((r) => r.user?.login === OWNER && r.state === 'APPROVED') ? 'yes' : '',
    headHash: pull.head.sha, updatedAt: pull.updated_at, link: pull.html_url,
  };
}

export function toCsv(rows) {
  const cell = (v) => {
    const s = String(v ?? '');
    // A leading ' keeps a title like "=HYPERLINK(...)" from running as a
    // formula when the file is opened directly in a spreadsheet.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [COLUMNS.join(','), ...rows.map((row) => COLUMNS.map((c) => cell(row[c])).join(','))].join('\n') + '\n';
}

// Written next to the data so a reader of the branch knows what each column means.
export const README = `# PR history

One row per pull request in this repository, rebuilt every morning by
\`.github/workflows/pr-history.yml\` on \`main\`. \`pr-history.csv\` is for the
owner's Google Sheet (\`=IMPORTDATA\` of its raw link); \`pr-history.json\` holds
the same rows for the Desk, Canvas and Atlas. No authors or emails are kept.

Worked-out columns:

- \`agent\`: the \`agent: …\` label, else Codex's account or a \`codex/\` branch,
  else GrokBot (\`Cursor Agent\` commits), else Claude (\`Claude-Session\` or
  \`Built-by: Claude\` in a commit). #58 and #71 are Codex, per their plan.
- \`codexRounds\`: distinct commits Codex reviewed. \`codexP0\` to \`codexP3\`:
  Codex's inline findings by badge, across all rounds.
- \`codexLatest\`: Codex's summary comment when there is one (\`clean\`,
  \`open findings\`, \`review failed\`, \`review running\`), else the last round (\`clean\`,
  \`had findings\`), else \`none\`. On a merged pull request, \`open findings\`
  usually means findings left for the triage judge or accepted by the owner.
- \`outsideReviewer\`, \`outsideRounds\`, \`outsideLatest\`: comments that start
  "Independent review" or end "— GrokBot review". \`outsideLatest\` is a text
  match on the latest one: \`clean\` needs "clean", "no findings" or "nothing
  new" and no P0, P1 or P2 counted as still open. Check the pull request when
  it matters.
- \`outsideCommit\`, \`outsideOnHead\`: the commit that latest review names (or
  was left on), and whether it is the pull request's head. A \`clean\` review
  holds only for that commit; \`no\` also covers a later update from \`main\`
  alone, which needs no new review.
- \`areas\`: top folders touched (\`apps/desk\`, \`packages/<name>\`, \`docs/plans\`,
  or a top-level file).
`;

async function main(folder) {
  const { client, repoFromEnv } = await import('./github.mjs');
  const gh = client();
  const { owner, repo } = repoFromEnv();
  const base = `/repos/${owner}/${repo}`;
  const previousFile = join(folder, 'pr-history.json');
  const previous = existsSync(previousFile) ? JSON.parse(readFileSync(previousFile, 'utf8')) : null;
  const kept = new Map(previous?.schemaVersion === SCHEMA_VERSION ? previous.pulls.map((row) => [row.number, row]) : []);

  const rows = [];
  let fetched = 0;
  for (const pull of await gh.all(`${base}/pulls?state=all`)) {
    const old = kept.get(pull.number);
    // A row is reused only when nothing changed and it has today's columns.
    if (old && old.updatedAt === pull.updated_at && Object.keys(old).join() === COLUMNS.join()) { rows.push(old); continue; }
    const n = pull.number;
    const [files, reviews, comments, reviewComments, commits] = await Promise.all([
      gh.all(`${base}/pulls/${n}/files`), gh.all(`${base}/pulls/${n}/reviews`), gh.all(`${base}/issues/${n}/comments`),
      gh.all(`${base}/pulls/${n}/comments`), gh.all(`${base}/pulls/${n}/commits`),
    ]);
    rows.push(buildRow(pull, { files, reviews, comments, reviewComments, commits }));
    fetched += 1;
  }
  rows.sort((a, b) => a.number - b.number);
  writeFileSync(join(folder, 'pr-history.csv'), toCsv(rows));
  writeFileSync(join(folder, 'README.md'), README);
  writeFileSync(previousFile, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, repository: `${owner}/${repo}`, takenAt: new Date().toISOString(), pulls: rows }, null, 1)}\n`);
  console.log(`PR history: ${rows.length} pull requests, ${fetched} read again.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!process.argv[2]) throw new Error('Usage: node .github/scripts/pr-history.mjs <folder>');
  await main(process.argv[2]);
}
