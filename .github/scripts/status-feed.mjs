// Writes the status feed (docs/plans/status-feed.md, part 1): one row for each
// open pull request with its one state, the rule that put it there and the
// next move, plus totals. Runs only from the default branch's copy of the
// workflow and never checks out pull request code.
//
// It reads GitHub and writes one thing: `status-feed.json` on its own branch,
// `status-feed-data`, as one commit of one file through the git data API.
// It never writes to `main`, to a pull request or to an issue. When GitHub
// can't be read, or too few API calls are left, it writes nothing and the
// last feed stays.
//
// The state rules are in status-feed-rules.mjs and tested on invented pull
// requests in tests/status-feed.test.mjs.

import { readFileSync } from 'node:fs';
import { client, repoFromEnv } from './github.mjs';
import { evaluateCodexSignal, CODEX_LOGIN, OWNER_LOGIN } from './codex-signal.mjs';
import { triageEligibility, latestVerdict, ACTIONS_LOGIN } from './codex-triage.mjs';
import { parseCodeowners, protectedFiles } from './codeowners.mjs';
import { RISK_ESCALATE_LABEL } from './risk-check.mjs';
import {
  DEPENDABOT_LOGIN, KEEPER_ISSUE, JUDGE_WINDOW_MS,
  keeperComment, parseKeeper, silenceStands, waitingStands, codexFindingReviews, loopRounds,
  reviewedCommit, sameChanges, countedReview, escalationAt, planCheck,
  ownerApprovalStands, ownerApprovedAfter, stateOf, buildFeed, unchangedSince,
} from './status-feed-rules.mjs';

export const DATA_BRANCH = 'status-feed-data';
export const FEED_PATH = 'status-feed.json';
// Below this many REST calls left, the run writes nothing, so the merge
// gate's own workflows keep their share of the hour's calls.
const MIN_CALLS_LEFT = 300;
const AGENT_LABELS = ['agent: claude', 'agent: codex', 'agent: grokbot'];

const gh = client();
const { owner, repo } = repoFromEnv();
const base = `/repos/${owner}/${repo}`;
const now = Date.now();

const notFound = (error) => /failed: 404/.test(error?.message ?? '');

function pullNumberFromEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  const event = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return event.pull_request?.number ?? null;
}

// Who edited each comment (the REST API only says that a comment changed).
// The same query codex-approved.mjs uses; that file runs on import, so the
// query is repeated here rather than shared.
const EDIT_HISTORY = `query($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on IssueComment {
      id
      lastEditedAt
      editor { __typename login }
      userContentEdits(first: 100) { totalCount nodes { deletedAt editor { __typename login } } }
    }
    ... on PullRequestReviewComment {
      id
      lastEditedAt
      editor { __typename login }
      userContentEdits(first: 100) { totalCount nodes { deletedAt editor { __typename login } } }
    }
  }
}`;

async function withEditHistory(comments) {
  const ids = comments.filter((c) => [CODEX_LOGIN, OWNER_LOGIN, ACTIONS_LOGIN].includes(c.user?.login) && c.node_id).map((c) => c.node_id);
  const history = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gh.graphql(EDIT_HISTORY, { ids: ids.slice(i, i + 50) });
    for (const node of data?.nodes ?? []) {
      if (node?.id) history.set(node.id, { lastEditedAt: node.lastEditedAt, editor: node.editor, userContentEdits: node.userContentEdits });
    }
  }
  return comments.map((c) => ({ ...c, edit_history: history.get(c.node_id) ?? null }));
}

// Every check run on a commit (the list is wrapped in an object, so the
// client's paging helper doesn't fit).
async function checkRuns(sha) {
  const runs = [];
  for (let page = 1; ; page += 1) {
    const data = await gh.get(`${base}/commits/${sha}/check-runs?per_page=100&page=${page}`);
    runs.push(...(data.check_runs ?? []));
    if ((data.check_runs ?? []).length < 100) return runs;
  }
}

function testsState(runs) {
  const tests = runs.filter((r) => r.name === 'tests' && r.app?.slug === 'github-actions')
    .sort((a, b) => Date.parse(b.started_at ?? 0) - Date.parse(a.started_at ?? 0))[0];
  if (!tests) return null;
  if (tests.status !== 'completed') return 'pending';
  return tests.conclusion === 'success' ? 'success' : 'failure';
}

const failingJobs = (runs) => [...new Set(runs
  .filter((r) => r.app?.slug === 'github-actions' && r.status === 'completed' && ['failure', 'timed_out'].includes(r.conclusion))
  .map((r) => r.name))].sort();

let rules;
async function codeownersRules(defaultBranch) {
  if (!rules) {
    const file = await gh.get(`${base}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(defaultBranch)}`);
    rules = parseCodeowners(Buffer.from(file.content, 'base64').toString('utf8'));
  }
  return rules;
}

const compareFiles = (defaultBranch, sha) => gh.get(`${base}/compare/${encodeURIComponent(defaultBranch)}...${sha}`).then((c) => c.files ?? []);

async function rowFor(number, { defaultBranch, keeper }) {
  const pr = await gh.get(`${base}/pulls/${number}`);
  if (pr.state !== 'open') return null;
  const headSha = pr.head.sha;
  const [comments, reviews, reactions, changed, commits] = await Promise.all([
    gh.all(`${base}/issues/${number}/comments`).then(withEditHistory),
    gh.all(`${base}/pulls/${number}/reviews`),
    gh.all(`${base}/issues/${number}/reactions`),
    gh.all(`${base}/pulls/${number}/files`),
    gh.all(`${base}/pulls/${number}/commits`),
  ]);
  const dismissed = reviews.some((r) => r.user?.login === CODEX_LOGIN && r.state === 'DISMISSED');
  const dismissals = dismissed
    ? (await gh.all(`${base}/issues/${number}/events`)).filter((e) => e.event === 'review_dismissed')
    : [];
  const codexFindings = codexFindingReviews(reviews, dismissals);
  const reviewComments = codexFindings.length ? await gh.all(`${base}/pulls/${number}/comments`).then(withEditHistory) : [];
  const [status, runs] = await Promise.all([gh.get(`${base}/commits/${headSha}/status`), checkRuns(headSha)]);

  const prAuthor = pr.user?.login;
  const labels = (pr.labels ?? []).map((l) => l.name);
  const builder = prAuthor === DEPENDABOT_LOGIN ? 'Dependabot' : (AGENT_LABELS.find((l) => labels.includes(l)) ?? 'none');
  const files = changed.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  // A file list cut short counts as touching protected paths (fails closed).
  const protectedNeeded = changed.length < pr.changed_files || protectedFiles(await codeownersRules(defaultBranch), files).length > 0;

  const codex = evaluateCodexSignal({ headSha, prAuthor, comments, reviews, reactions, dismissals, now });
  const codexFindingsOnHead = codexFindings.some((r) => r.commit_id === headSha);
  const eligibility = triageEligibility({ headSha, prAuthor, fromFork: pr.head?.repo?.full_name !== pr.base?.repo?.full_name, reviews, reviewComments, dismissals });
  const verdict = eligibility.eligible ? latestVerdict({ headSha, findings: eligibility.findings, comments }) : null;
  // A later clean Codex round on the head ends the judge's wait.
  const judgeDue = !codex.approved && eligibility.eligible && !verdict && now - eligibility.lastFinding < JUDGE_WINDOW_MS;
  const judgeSaidReal = Boolean(verdict?.verdict?.verdicts?.some((v) => v.verdict === 'real'));

  // The independent review: of the head, or of an earlier commit whose
  // changes against main are the head's (the keeper's SAME).
  let review = countedReview({ comments, reviews, headSha });
  let reviewed = review ? headSha : null;
  if (!review) {
    const earlier = reviewedCommit({ comments, reviews, commits });
    if (earlier && earlier !== headSha) {
      const [a, b] = await Promise.all([compareFiles(defaultBranch, earlier), compareFiles(defaultBranch, headSha)]);
      if (sameChanges(a, b)) {
        review = countedReview({ comments, reviews, headSha, sameAs: earlier });
        reviewed = review ? earlier : null;
      }
    }
  }
  const escalatedAt = Math.max(escalationAt({ comments, reviews, headSha }), review?.escalation ? review.at : 0);
  const escalated = labels.includes(RISK_ESCALATE_LABEL) || escalatedAt > 0 || Boolean(review?.escalation);
  const headCommittedAt = commits.at(-1)?.commit?.committer?.date ?? null;
  // When auto-merge was last switched on: read only when it is on and the
  // review has open findings, the one case where it matters.
  let autoMergeAfterReview = false;
  if (pr.auto_merge && review?.severities.some((s) => s <= 2)) {
    const events = await gh.all(`${base}/issues/${number}/timeline`);
    const enabled = events.filter((e) => e.event === 'auto_merge_enabled').map((e) => Date.parse(e.created_at) || 0);
    const at = enabled.length ? Math.max(...enabled) : 0;
    autoMergeAfterReview = at > review.at && at > (Date.parse(headCommittedAt ?? '') || 0);
  }
  const silent = keeper.silent.filter((line) => line.number === number
    && silenceStands(line, { headCommittedAt, keeperCheckedAt: keeper.checkedAt, codexReviewedHead: codexFindingsOnHead || codex.approved, review }));

  const result = stateOf({
    draft: pr.draft,
    conflict: pr.mergeable_state === 'dirty',
    // GitHub answers "unknown" (and mergeable null) while it is still working it out.
    mergeUnknown: pr.mergeable === null || pr.mergeable_state === 'unknown',
    builder,
    tests: testsState(runs),
    codexApproved: status.statuses?.find((s) => s.context === 'codex-approved')?.state ?? null,
    codexReviewedHead: codexFindingsOnHead || codex.approved,
    codexCleanOnHead: codex.approved,
    codexFindingsOnHead,
    judgeDue,
    judgeSaidReal,
    loopRounds: loopRounds({ headSha, reviews, reviewComments, dismissals, codexCleanOnHead: codex.approved }),
    reviewNeeded: builder !== 'agent: grokbot' && builder !== 'Dependabot',
    review,
    planCheckNeeded: ['agent: grokbot', 'agent: codex'].includes(builder) && files.some((f) => f.startsWith('packages/')),
    planCheck: planCheck({ comments, reviews, headSha }),
    protectedNeeded,
    ownerApproval: ownerApprovalStands(reviews),
    openedByOwner: prAuthor === OWNER_LOGIN,
    labels,
    escalated,
    escalationApproved: escalated && ownerApprovedAfter(reviews, escalatedAt, headSha),
    autoMerge: Boolean(pr.auto_merge),
    autoMergeAfterReview,
    silent,
    waiting: keeper.waiting.filter((line) => line.number === number && waitingStands(line, { headCommittedAt, keeperCheckedAt: keeper.checkedAt })),
  });
  return {
    number,
    title: pr.title,
    url: pr.html_url,
    branch: pr.head.ref,
    builder,
    headSha: headSha.slice(0, 7),
    reviewedSha: reviewed ? reviewed.slice(0, 7) : null,
    reviewedHead: reviewed === headSha,
    failingJobs: failingJobs(runs),
    ...result,
  };
}

// Pull requests merged in the last 7 days. Closed pull requests come newest
// update first, so paging stops once a page has nothing updated in the window.
async function recentMerges() {
  const since = now - 8 * 24 * 60 * 60 * 1000;
  const merged = [];
  for (let page = 1; page <= 10; page += 1) {
    const list = await gh.get(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`);
    merged.push(...list.filter((p) => p.merged_at).map((p) => p.merged_at));
    if (list.length < 100 || list.every((p) => Date.parse(p.updated_at) < since)) break;
  }
  return merged;
}

async function previousFeed() {
  let ref;
  try { ref = await gh.get(`${base}/git/ref/heads/${DATA_BRANCH}`); } catch (error) {
    if (notFound(error)) return { parent: null, feed: null };
    throw error;
  }
  const parent = ref.object.sha;
  try {
    const file = await gh.get(`${base}/contents/${FEED_PATH}?ref=${parent}`);
    return { parent, feed: JSON.parse(Buffer.from(file.content, 'base64').toString('utf8')) };
  } catch (error) {
    // A damaged or missing file is replaced by this run's feed.
    console.error(`The previous feed couldn't be read: ${error.message}`);
    return { parent, feed: null };
  }
}

// One commit holding one file, on top of the last feed commit. Never a force
// update: if another run moved the branch first, this one fails and writes nothing.
async function writeFeed(feed, parent) {
  const tree = await gh.post(`${base}/git/trees`, { tree: [{ path: FEED_PATH, mode: '100644', type: 'blob', content: `${JSON.stringify(feed, null, 2)}\n` }] });
  const commit = await gh.post(`${base}/git/commits`, {
    message: `Status feed: ${feed.totals.open} open pull requests`,
    tree: tree.sha,
    parents: parent ? [parent] : [],
  });
  if (parent) await gh.patch(`${base}/git/refs/heads/${DATA_BRANCH}`, { sha: commit.sha, force: false });
  else await gh.post(`${base}/git/refs`, { ref: `refs/heads/${DATA_BRANCH}`, sha: commit.sha });
  return commit.sha;
}

const limit = await gh.get('/rate_limit');
const left = limit.resources?.core?.remaining ?? 0;
if (left < MIN_CALLS_LEFT) {
  console.log(`Only ${left} GitHub calls left this hour; writing nothing so the merge gate keeps its share.`);
  process.exit(0);
}

const repoInfo = await gh.get(base);
const defaultBranch = repoInfo.default_branch;
const keeper = parseKeeper(keeperComment(await gh.all(`${base}/issues/${KEEPER_ISSUE}/comments`)));
const { parent, feed: previous } = await previousFeed();

// A pull request event refreshes that one pull request and keeps the other
// rows from the last feed; every other run (hourly, by hand, or with no
// earlier feed) refreshes them all.
const single = pullNumberFromEvent();
let rows;
if (single && previous) {
  const row = await rowFor(single, { defaultBranch, keeper });
  rows = [...(previous.rows ?? []).filter((r) => r.number !== single), ...(row ? [row] : [])];
} else {
  rows = [];
  for (const pr of await gh.all(`${base}/pulls?state=open`)) {
    const row = await rowFor(pr.number, { defaultBranch, keeper });
    if (row) rows.push(row);
  }
}

const feed = buildFeed({ rows, previous, merged: await recentMerges(), keeperCheckedAt: keeper.checkedAt, now });
if (unchangedSince(previous, feed, now)) {
  console.log('Nothing changed since the last feed; writing nothing.');
} else {
  const sha = await writeFeed(feed, parent);
  console.log(`Wrote the status feed (${feed.totals.open} open) as ${sha.slice(0, 7)} on ${DATA_BRANCH}.`);
}
