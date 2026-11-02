// Guards for the workflow files themselves (docs/plans/security.md, section 1,
// "Next baseline steps"). Read by .github/scripts/tests/workflow-guards.test.mjs,
// which runs in the `gate` job of `tests`.
//
// 1. Every outside action is pinned to a full commit hash, with the version
//    it stands for in a comment (`owner/repo@<40 hex> # v1.2.3`), so a moved
//    tag can't change what runs. Dependabot keeps the pins and comments
//    current.
// 2. A workflow triggered by `pull_request_target` runs with secrets and a
//    write token, so it must never check out anything but the default
//    branch: each checkout names the default branch explicitly, takes no
//    other repository, and nothing in the file reaches for pull request code.
//
// The files are read line by line instead of with a YAML library, so the gate
// needs no dependency. The checks assume the plain block style every workflow
// here uses; a file the reader can't follow fails rather than passes.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PIN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^#\s*v\d+(\.\d+)*\b/;
const DEFAULT_BRANCH_REF = '${{ github.event.repository.default_branch }}';

/** Drops a trailing YAML comment, minding quotes. */
function splitComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(text[i - 1]))) {
      return { value: text.slice(0, i).trim(), comment: text.slice(i).trim() };
    }
  }
  return { value: text.trim(), comment: '' };
}

const unquote = (s) => s.replace(/^(['"])(.*)\1$/, '$2');
const indentOf = (line) => line.length - line.trimStart().length;

/** Every `uses:` in a workflow, with its line number, value and comment. */
export function usesLines(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*(.*)$/);
    if (!m) return;
    const { value, comment } = splitComment(m[1]);
    out.push({ line: i + 1, value: unquote(value), comment });
  });
  return out;
}

/** Problems with action pins in one workflow file. */
export function pinProblems(text) {
  const problems = [];
  for (const u of usesLines(text)) {
    if (u.value.startsWith('./')) continue; // an action in this repository
    if (u.value.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/.test(u.value)) problems.push(`line ${u.line}: docker image \`${u.value}\` is not pinned to a sha256 digest`);
      continue;
    }
    if (!PIN.test(u.value)) {
      problems.push(`line ${u.line}: \`${u.value}\` is not pinned to a full commit hash`);
    } else if (!VERSION_COMMENT.test(u.comment)) {
      problems.push(`line ${u.line}: \`${u.value}\` needs the version it stands for in a comment, such as \`# v4.2.0\``);
    }
  }
  return problems;
}

/** True when the file's `on:` block (or inline `on:` value) names pull_request_target. */
export function usesPullRequestTarget(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(['"]?)on\1:\s*(.*)$/);
    if (!m) continue;
    const inline = splitComment(m[2]).value;
    if (inline) return /\bpull_request_target\b/.test(inline);
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      if (indentOf(line) === 0) break;
      if (/\bpull_request_target\b/.test(splitComment(line).value)) return true;
    }
  }
  return false;
}

/** The lines of each list item (`- ...`) whose body names actions/checkout. */
function checkoutSteps(lines) {
  const steps = [];
  for (let i = 0; i < lines.length; i += 1) {
    const start = lines[i].match(/^(\s*)-\s/);
    if (!start) continue;
    const indent = start[1].length;
    const body = [{ n: i + 1, text: lines[i] }];
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() && indentOf(line) <= indent) break;
      body.push({ n: j + 1, text: line });
    }
    const uses = body.find((l) => /^\s*(?:-\s+)?uses:/.test(l.text));
    if (uses && /actions\/checkout@/.test(uses.text)) steps.push({ line: i + 1, body });
  }
  return steps;
}

// Text that only appears when a workflow reaches for the pull request's code.
const PR_CODE = [
  /github\.event\.pull_request\.head\.(sha|ref|repo)/,
  /github\.event\.pull_request\.merge_commit_sha/,
  /github\.head_ref/,
  /refs\/pull\//,
  /\bgh\s+pr\s+checkout\b/,
  /\bgit\s+(fetch|checkout|switch|pull)\b/,
];

/** Problems with a pull_request_target workflow; none when it doesn't use that trigger. */
export function pullRequestTargetProblems(text) {
  if (!usesPullRequestTarget(text)) return [];
  const problems = [];
  const lines = text.split('\n');
  for (const step of checkoutSteps(lines)) {
    const field = (name) => step.body.find((l) => new RegExp(`^\\s*${name}:`).test(l.text));
    const ref = field('ref');
    const value = ref ? unquote(splitComment(ref.text.replace(/^\s*ref:/, '')).value) : '';
    if (value !== DEFAULT_BRANCH_REF) {
      problems.push(`line ${step.line}: a checkout in a pull_request_target workflow must set \`ref: ${DEFAULT_BRANCH_REF}\``);
    }
    const repo = field('repository');
    if (repo) problems.push(`line ${repo.n}: a checkout in a pull_request_target workflow must not take another repository`);
  }
  lines.forEach((line, i) => {
    const { value } = splitComment(line);
    for (const pattern of PR_CODE) {
      if (pattern.test(value)) {
        problems.push(`line ${i + 1}: a pull_request_target workflow must not reach for pull request code (\`${value.trim()}\`)`);
        break;
      }
    }
  });
  return problems;
}

/** Every workflow file under `dir`, as { name, text }. */
export function readWorkflows(dir) {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }));
}
