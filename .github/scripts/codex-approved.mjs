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
import { parseCodeowners, ownerOpenedBlock } from './codeowners.mjs';

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
  }
}`;

// Attaches `edit_history` to Codex's and the owner's comments. A comment whose record can't be
// read gets null, which makes the signal check ignore it (fails closed).
async function withEditHistory(comments) {
  const ids = comments.filter((c) => [CODEX_LOGIN, OWNER_LOGIN].includes(c.user?.login) && c.node_id).map((c) => c.node_id);
  const history = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const data = await gh.graphql(EDIT_HISTORY, { ids: ids.slice(i, i + 50) });
    for (const node of data?.nodes ?? []) {
      if (node?.id) history.set(node.id, { lastEditedAt: node.lastEditedAt, editor: node.editor, userContentEdits: node.userContentEdits });
    }
  }
  return comments.map((c) => ({ ...c, edit_history: history.get(c.node_id) ?? null }));
}

// CODEOWNERS from the default branch, never the pull request's copy.
let ownerRules;
async function codeownersRules() {
  if (!ownerRules) {
    const { default_branch: ref } = await gh.get(base);
    const file = await gh.get(`${base}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(ref)}`);
    ownerRules = parseCodeowners(Buffer.from(file.content, 'base64').toString('utf8'));
  }
  return ownerRules;
}

async function check(number) {
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
  const signal = evaluateCodexSignal({ headSha: pr.head.sha, prAuthor: pr.user?.login, comments, reviews, reactions, dismissals });
  // A pull request the owner opened skips GitHub's code-owner review, so it
  // waits here instead whenever it changes a protected file.
  const files = (await gh.all(`${base}/pulls/${number}/files`)).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const blocked = ownerOpenedBlock({ prAuthor: pr.user?.login, files, rules: await codeownersRules() });
  const approved = signal.approved && !blocked;
  const reason = blocked ?? signal.reason;
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

const numbers = pullNumbersFromEvent()
  ?? (await gh.all(`${base}/pulls?state=open`)).map((p) => p.number);
let failed = false;
for (const number of numbers) {
  try { await check(number); } catch (error) { failed = true; console.error(`#${number}: ${error.message}`); }
}
if (failed) process.exit(1);
