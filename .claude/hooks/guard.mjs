#!/usr/bin/env node
// Claude Code PreToolUse guard: blocks the repo's hard "never" rules before a
// tool runs, so they don't rely on an agent remembering AGENTS.md. It is a
// backstop for honest mistakes, not a sandbox; branch protection on GitHub is
// still the real lock on main. Exit 2 blocks the call and shows the reason.
//
// Rules (AGENTS.md "Limits", "Moving Code From True Convo", "Keeping
// Finished Work Moving"):
//   1. No push to main or master, and no deleting them.
//   2. No force-push and no history rewriting (filter-branch, filter-repo).
//   3. No admin-bypass merges.
//   4. No writes into the True Convo folder, which is a read-only reference.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PROTECTED = new Set(['main', 'master']);
const TRUE_CONVO = /True-Convo-AI/i;

// Split a shell command into simple commands, then into words. Quotes are
// honoured well enough for the realistic cases; this is not a full shell parser.
function splitCommands(command) {
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === ';' || ch === '\n' || ch === '|' || ch === '&' || ch === '(' || ch === ')') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.map(words).filter((w) => w.length > 0);
}

function words(text) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// Returns the git subcommand and its arguments, skipping env assignments and
// git's own options such as -C <dir> or -c key=value.
function gitCall(argv) {
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i += 1;
  if (argv[i] === 'command' || argv[i] === 'exec') i += 1;
  if (!/(^|\/)git$/.test(argv[i] ?? '')) return null;
  i += 1;
  let dir = null;
  while (i < argv.length && argv[i].startsWith('-')) {
    if (argv[i] === '-C') { dir = argv[i + 1]; i += 2; } else if (argv[i] === '-c') { i += 2; } else { i += 1; }
  }
  return { sub: argv[i], args: argv.slice(i + 1), dir };
}

function branchTarget(ref) {
  // HEAD:main, src:refs/heads/main, :main (delete), +main, main
  const dst = ref.includes(':') ? ref.slice(ref.lastIndexOf(':') + 1) : ref;
  return dst.replace(/^\+/, '').replace(/^refs\/heads\//, '');
}

function currentBranch(cwd) {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function checkPush(args, cwd) {
  const opts = args.filter((a) => a.startsWith('-'));
  const positional = args.filter((a) => !a.startsWith('-'));
  if (opts.some((o) => /^--force(-with-lease|-if-includes)?(=|$)/.test(o) || /^-[a-zA-Z]*f/.test(o))) {
    return 'Force-push is not allowed (AGENTS.md "Limits"). Push a new commit instead.';
  }
  if (opts.includes('--mirror') || opts.includes('--all')) {
    return 'Pushing every branch at once could push main; push your own branch by name.';
  }
  const refs = positional.slice(1);
  if (refs.some((r) => r.startsWith('+'))) {
    return 'A "+" refspec is a force-push, which is not allowed (AGENTS.md "Limits").';
  }
  // A bare HEAD or @ (as in "git push -u origin HEAD") means the current branch.
  const resolve = (r) => {
    const dst = branchTarget(r);
    return dst === 'HEAD' || dst === '@' ? currentBranch(cwd) : dst;
  };
  if (refs.some((r) => PROTECTED.has(resolve(r)))) {
    return 'Pushing to or deleting main is not allowed. Work on your own branch and open a pull request.';
  }
  if (refs.length === 0 && PROTECTED.has(currentBranch(cwd))) {
    return 'You are on main, so this push would go to main. Create a branch first.';
  }
  return null;
}

export function checkBash(command, cwd = process.cwd()) {
  let here = cwd;
  for (const argv of splitCommands(command)) {
    if (argv[0] === 'cd' && argv[1]) here = argv[1];
    const git = gitCall(argv);
    if (git) {
      const where = git.dir ?? here;
      if (git.sub === 'push') {
        const reason = checkPush(git.args, where);
        if (reason) return reason;
      }
      if (git.sub === 'filter-branch' || git.sub === 'filter-repo') {
        return 'History rewriting is not allowed (AGENTS.md "Limits").';
      }
      if (git.sub === 'branch' && git.args.some((a) => /^-[a-zA-Z]*D/.test(a) || a === '--delete' || /^-[a-zA-Z]*d/.test(a)) && git.args.some((a) => PROTECTED.has(a))) {
        return 'Deleting main is not allowed.';
      }
      // In the True Convo folder only read-only git subcommands are allowed;
      // anything else (pull, restore, commit, checkout ...) is blocked.
      const reads = ['status', 'log', 'show', 'diff', 'grep', 'blame', 'ls-files', 'ls-tree', 'cat-file', 'rev-parse', 'rev-list', 'describe', 'show-ref', 'shortlog', 'help', 'version', '--version'];
      if (TRUE_CONVO.test(where) && !reads.includes(git.sub ?? '')) {
        return 'The True Convo folder is read-only (AGENTS.md "Moving Code From True Convo"). Copy the piece into this repo instead.';
      }
    }
    const isGh = /(^|\/)gh$/.test(argv[0] ?? '');
    // gh accepts global flags such as -R owner/repo before the subcommand, so
    // look for "pr merge" anywhere rather than at fixed positions.
    const prAt = argv.indexOf('pr');
    const isMerge = prAt > 0 && argv[prAt + 1] === 'merge';
    if (isGh && isMerge && argv.some((a) => a === '--admin' || a.startsWith('--admin='))) {
      return 'Admin-bypass merges are not allowed (AGENTS.md "Keeping Finished Work Moving").';
    }
  }
  // Shell writes into the True Convo folder: redirects, tee, sed -i, cp/rsync/ln
  // into it, and mv/rm and friends anywhere on it (a move deletes the source).
  if (TRUE_CONVO.test(command)) {
    const writesInto = /(>>?|\btee\b(\s+-a)?)\s*["']?[^\s"']*True-Convo-AI/i.test(command)
      || /\b(cp|rsync|ln|install)\b[^;&|\n]*\s["']?[^\s"']*True-Convo-AI[^\s"']*["']?\s*($|[;&|\n])/i.test(command)
      || /\b(mv|rm|rmdir|unlink|touch|mkdir|chmod|chown|truncate)\b[^;&|\n]*True-Convo-AI/i.test(command)
      || /\bsed\b[^;&|\n]*\s-i\b[^;&|\n]*True-Convo-AI/i.test(command);
    if (writesInto) {
      return 'The True Convo folder is read-only (AGENTS.md "Moving Code From True Convo"). Copy the piece into this repo instead.';
    }
  }
  return null;
}

export function checkTool(input) {
  const tool = input?.tool_name ?? '';
  const ti = input?.tool_input ?? {};
  if (tool === 'Bash') return checkBash(String(ti.command ?? ''), input?.cwd || process.cwd());
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const path = String(ti.file_path ?? ti.notebook_path ?? '');
    if (TRUE_CONVO.test(path)) {
      return 'The True Convo folder is read-only (AGENTS.md "Moving Code From True Convo").';
    }
  }
  return null;
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.stderr.write('guard: could not read the tool call, so it was not checked.\n');
    process.exit(0);
  }
  const reason = checkTool(input);
  if (reason) {
    process.stderr.write(`Blocked by the repo guard (.claude/hooks/guard.mjs): ${reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
