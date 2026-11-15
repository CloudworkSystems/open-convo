// The checks every request passes before anything is sent
// (docs/plans/push-gate.md, "Checks On Every Request"). Each returns null
// when the request passes, or one plain clause saying what is wrong and
// what to change. The gate turns that into the refusal sentence.

import { AGENTS, LIMITS, REPORT_ISSUE } from './constants.mjs';
import { secretLookalike } from './errors.mjs';

const SHA = /^[0-9a-f]{40}$/;
const BUNDLE_NAME = /^[A-Za-z0-9._-]+\.bundle$/;
export const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REVIEW_RESULTS = ['clean', 'findings answered'];
const ALLOWED_MENTIONS = ['codex', 'cursor'];

/** Branch: never `main`; no spaces, no `..`, no leading `-`. */
export function checkBranch(branch) {
  if (typeof branch !== 'string' || !branch) return 'it names no branch, so add the branch to push to';
  if (branch === 'main' || branch === 'refs/heads/main') return 'the gate never pushes to main, so name a branch of your own';
  if (/\s/.test(branch)) return 'the branch name has a space in it, so use a name without spaces';
  if (branch.includes('..')) return 'the branch name has ".." in it, so use a name without it';
  if (branch.startsWith('-')) return 'the branch name starts with "-", so use a name that starts with a letter or number';
  if (branch.startsWith('refs/') || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.endsWith('/') || branch.endsWith('.lock') || branch.includes('//')) {
    return 'the branch name has characters git or GitHub would misread, so use letters, numbers, ".", "_", "-" and "/" only';
  }
  return null;
}

/**
 * Text that goes to GitHub: descriptions, comments, replies and titles.
 * `signOff: false` skips the sign-off line (titles have none).
 */
export function checkText(text, { agent, thread, what, signOff = true }) {
  if (typeof text !== 'string' || !text.trim()) return `its ${what} is empty, so write one`;
  if (text.length >= LIMITS.textChars) return `its ${what} is ${text.length} characters long, so shorten it to under ${LIMITS.textChars}`;
  if (/owner-accepts-findings/i.test(text)) return `its ${what} contains the owner's accept line, which only the owner posts, so take that line out`;
  for (const match of text.matchAll(/(^|[^A-Za-z0-9_])@([A-Za-z0-9][A-Za-z0-9-]*)/g)) {
    if (!ALLOWED_MENTIONS.includes(match[2].toLowerCase())) {
      return `its ${what} mentions "@${match[2]}", and the gate only lets through mentions of Codex and Cursor, so write the name without the at sign`;
    }
  }
  const secret = secretLookalike(text);
  if (secret) return `its ${what} contains what looks like ${secret}, so take that out`;
  if (signOff) {
    const lines = text.trimEnd().split('\n');
    const last = lines[lines.length - 1].toLowerCase();
    if (!last.includes(AGENTS[agent].toLowerCase()) || !last.includes(thread.toLowerCase())) {
      return `its ${what} doesn't end with a line naming the agent and its thread or task, so end it with a line such as "${AGENTS[agent]}, ${thread}"`;
    }
  }
  return null;
}

/** Local review: by a different agent than the builder, for the same commit, clean or answered. */
export function checkReview(review, { agent, commit }) {
  if (!review || typeof review !== 'object') return 'it has no local review record, so have a different agent review the commit and add the record';
  if (!Object.hasOwn(AGENTS, review.reviewer)) return 'its local review names no known reviewer, so name claude, codex or grokbot';
  if (review.reviewer === agent) return 'its local review is by the same agent that built it, so have a different agent review the commit';
  if (review.commit !== commit) return 'its local review is for a different commit, so have the reviewer review the commit being pushed';
  if (!REVIEW_RESULTS.includes(review.result)) return 'its local review still has open findings, so send it once the result is "clean" or "findings answered"';
  return null;
}

/**
 * Checks a request's own contents: everything that needs no git and no
 * network. Returns `{ why }` when it fails, or `{ request }` with only the
 * fields the gate uses.
 */
export function checkRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { why: "it isn't a request the gate can read, so write it as the README shows" };
  const { kind, agent, thread } = raw;
  if (!Object.hasOwn(AGENTS, agent)) return { why: 'it names no known agent, so set "agent" to claude, codex or grokbot' };
  if (typeof thread !== 'string' || !thread.trim() || thread.length > 200 || thread.includes('\n')) {
    return { why: 'it names no thread or task, so set "thread" to one line naming yours' };
  }
  const who = { agent, thread: thread.trim() };

  if (kind === 'push') {
    const branchWhy = checkBranch(raw.branch);
    if (branchWhy) return { why: branchWhy };
    if (typeof raw.commit !== 'string' || !SHA.test(raw.commit)) return { why: 'it names no exact commit, so set "commit" to the full 40-character commit id' };
    if (typeof raw.bundle !== 'string' || !BUNDLE_NAME.test(raw.bundle)) {
      return { why: 'it names no bundle file, so put the git bundle beside the request and set "bundle" to its file name' };
    }
    const reviewWhy = checkReview(raw.review, { agent, commit: raw.commit });
    if (reviewWhy) return { why: reviewWhy };
    const request = {
      kind,
      ...who,
      branch: raw.branch,
      commit: raw.commit,
      bundle: raw.bundle,
      review: { reviewer: raw.review.reviewer, commit: raw.review.commit, result: raw.review.result },
    };
    if (raw.pullRequest !== undefined) {
      const pr = raw.pullRequest;
      if (!pr || typeof pr !== 'object') return { why: 'its pull request part can\'t be read, so give it a "title" and a "body"' };
      const titleWhy = checkText(pr.title, { ...who, what: 'pull request title', signOff: false });
      if (titleWhy) return { why: titleWhy };
      if (pr.title.includes('\n') || pr.title.length > 250) return { why: 'its pull request title is more than one short line, so shorten it' };
      const bodyWhy = checkText(pr.body, { ...who, what: 'pull request description' });
      if (bodyWhy) return { why: bodyWhy };
      request.pullRequest = { title: pr.title.trim(), body: pr.body };
    }
    return { request };
  }

  if (kind === 'comment') {
    const target = raw.target;
    const pull = target?.pull;
    const issue = target?.issue;
    const onPull = Number.isInteger(pull) && pull > 0 && issue === undefined;
    const onIssue = issue === REPORT_ISSUE && pull === undefined;
    if (!onPull && !onIssue) {
      return { why: `it doesn't say where the comment goes, so set "target" to an open pull request ({"pull": number}) or to issue #${REPORT_ISSUE} ({"issue": ${REPORT_ISSUE}})` };
    }
    const bodyWhy = checkText(raw.body, { ...who, what: 'comment' });
    if (bodyWhy) return { why: bodyWhy };
    return { request: { kind, ...who, target: onPull ? { pull } : { issue }, body: raw.body } };
  }

  if (kind === 'reply') {
    if (!Number.isInteger(raw.pull) || raw.pull <= 0) return { why: 'it names no pull request, so set "pull" to the pull request\'s number' };
    if (!Number.isInteger(raw.inReplyTo) || raw.inReplyTo <= 0) return { why: 'it names no review thread, so set "inReplyTo" to the id of the review comment it answers' };
    const bodyWhy = checkText(raw.body, { ...who, what: 'reply' });
    if (bodyWhy) return { why: bodyWhy };
    return { request: { kind, ...who, pull: raw.pull, inReplyTo: raw.inReplyTo, body: raw.body } };
  }

  return { why: 'its kind isn\'t one the gate handles, so set "kind" to push, comment or reply' };
}
