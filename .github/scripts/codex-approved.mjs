// Posts the `codex-approved` commit status on pull request head commits.
// Runs only from the default branch's copy of the workflow (pull_request_target,
// issue_comment, schedule, workflow_dispatch), never from pull request code.
//
// No event fires when a review is dismissed (pull_request_review would run the
// pull request's own copy of the workflow, so the gate doesn't use it). After
// the owner dismisses a Codex review, run the codex-approved workflow by hand
// (workflow_dispatch, optionally with the pull request number); otherwise the
// hourly run picks it up within an hour. The delay can only hold a pull request
// back, never let one through.

import { readFileSync } from 'node:fs';
import { client, repoFromEnv } from './github.mjs';
import { evaluateCodexSignal, CODEX_LOGIN, OWNER_LOGIN } from './codex-signal.mjs';
import { triageEligibility, triagePasses, latestVerdict, judgeFindings, verdictComment, ACTIONS_LOGIN } from './codex-triage.mjs';

const CONTEXT = 'codex-approved';
const gh = client();
const { owner, repo } = repoFromEnv();
const base = `/repos/${owner}/${repo}`;

function pullNumbersFromEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  const event = path ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (event.pull_request?.number) return [event.pull_request.number];
  if (event.issue?.pull_request && event.issue.number) return [event.issue.number];
  const input = event.inputs?.pull_request;
  if (input) return [Number(input)];
  return null; // schedule or manual run without a number: check every open PR
}

// Who edited each comment. The REST API only says *that* a comment changed,
// not who changed it, and anyone with write access can edit Codex's comments.
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

// Attaches `edit_history` to Codex's, the owner's and the triage judge's comments (issue or
// review comments). A comment whose record can't be read gets null, which makes the checks
// ignore it (fails closed).
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

// A pull request stuck on minor Codex findings: ask the judge once per head
// and set of findings, and pass if it rates every finding a nit
// (docs/plans/codex-triage.md). Without the API key secret this never asks,
// and the result stays whatever the Codex signal said.
//
// Only runs for one pull request may ask the judge: those share the
// pull request's concurrency group, so two runs never ask at once. A run
// over every open pull request (hourly, or manual without a number) only
// reads verdicts already posted.
async function triage({ number, pr, comments, reviews, dismissals, reason, mayJudge }) {
  const headSha = pr.head.sha;
  const onHead = reviews.some((r) => r.user?.login === CODEX_LOGIN && r.commit_id === headSha && r.state !== 'APPROVED');
  if (!onHead) return { approved: false, reason };
  const reviewComments = await withEditHistory(await gh.all(`${base}/pulls/${number}/comments`));
  const eligibility = triageEligibility({ headSha, prAuthor: pr.user?.login, reviews, reviewComments, dismissals });
  if (!eligibility.eligible) {
    console.log(`#${number}: no triage (${eligibility.reason})`);
    return { approved: false, reason };
  }
  let current = comments;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (mayJudge && apiKey && !latestVerdict({ headSha, findings: eligibility.findings, comments })) {
    try {
      const verdicts = await judgeFindings({ findings: eligibility.findings, prTitle: pr.title, apiKey });
      await gh.post(`${base}/issues/${number}/comments`, { body: verdictComment({ headSha, findings: eligibility.findings, verdicts }) });
      current = await gh.all(`${base}/issues/${number}/comments`).then(withEditHistory);
    } catch (error) {
      console.error(`#${number}: triage judge unavailable: ${error.message}`);
    }
  }
  if (triagePasses({ headSha, eligibility, comments: current })) {
    return { approved: true, reason: `Judge rated all ${eligibility.findings.length} remaining Codex finding(s) on ${headSha.slice(0, 7)} as nits.` };
  }
  return { approved: false, reason };
}

async function check(number, mayJudge) {
  const pr = await gh.get(`${base}/pulls/${number}`);
  if (pr.state !== 'open') return;
  const [comments, reviews, reactions] = await Promise.all([
    gh.all(`${base}/issues/${number}/comments`).then(withEditHistory),
    gh.all(`${base}/pulls/${number}/reviews`),
    gh.all(`${base}/issues/${number}/reactions`),
  ]);
  // Who dismissed a Codex review. Fetched only when one is dismissed; if the
  // timeline can't be read, the dismissed review keeps blocking.
  const dismissed = reviews.some((r) => r.user?.login === CODEX_LOGIN && r.state === 'DISMISSED');
  const dismissals = dismissed
    ? (await gh.all(`${base}/issues/${number}/events`)).filter((e) => e.event === 'review_dismissed')
    : [];
  let { approved, reason } = evaluateCodexSignal({ headSha: pr.head.sha, prAuthor: pr.user?.login, comments, reviews, reactions, dismissals });
  if (!approved) ({ approved, reason } = await triage({ number, pr, comments, reviews, dismissals, reason, mayJudge }));
  const state = approved ? 'success' : 'pending';

  const current = await gh.get(`${base}/commits/${pr.head.sha}/status`);
  const existing = current.statuses.find((s) => s.context === CONTEXT);
  const description = [...reason].filter((ch) => ch.codePointAt(0) <= 0xffff).join('').slice(0, 140);
  if (existing && existing.state === state && existing.description === description) return;

  await gh.post(`${base}/statuses/${pr.head.sha}`, {
    state,
    context: CONTEXT,
    // GitHub refuses 4-byte characters (most emoji) in status descriptions.
    description,
  });
  console.log(`#${number} ${pr.head.sha.slice(0, 7)}: ${state} (${reason})`);
}

const fromEvent = pullNumbersFromEvent();
const numbers = fromEvent ?? (await gh.all(`${base}/pulls?state=open`)).map((p) => p.number);
let failed = false;
for (const number of numbers) {
  try { await check(number, fromEvent !== null); } catch (error) { failed = true; console.error(`#${number}: ${error.message}`); }
}
if (failed) process.exit(1);
