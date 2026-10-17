// Posts the `codex-approved` commit status on pull request head commits.
// Runs only from the default branch's copy of the workflow (pull_request_target,
// issue_comment, pull_request_review, schedule), never from pull request code.

import { readFileSync } from 'node:fs';
import { client, repoFromEnv } from './github.mjs';
import { evaluateCodexSignal } from './codex-signal.mjs';

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

async function check(number) {
  const pr = await gh.get(`${base}/pulls/${number}`);
  if (pr.state !== 'open') return;
  const [comments, reviews, reactions] = await Promise.all([
    gh.all(`${base}/issues/${number}/comments`),
    gh.all(`${base}/pulls/${number}/reviews`),
    gh.all(`${base}/issues/${number}/reactions`),
  ]);
  const { approved, reason } = evaluateCodexSignal({ headSha: pr.head.sha, comments, reviews, reactions });
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
