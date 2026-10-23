import { realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { hasErrors, inspectRound, outputRefusal, reportJson, RoundError } from './round.mjs';

const USAGE = 'Usage: node src/check.mjs <round.md> [--json <file>] [--md <file>]';

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    console.error(parsed.error);
    process.exitCode = 1;
    return;
  }

  let inspected;
  try {
    inspected = inspectRound(parsed.roundPath);
  } catch (err) {
    console.error(err instanceof RoundError ? err.message : 'Could not check the round file.');
    process.exitCode = 1;
    return;
  }

  const { report, markdown, mentionedNames } = inspected;
  if (parsed.jsonPath || parsed.mdPath) {
    let refusal;
    try {
      refusal = outputRefusal(parsed.roundPath, mentionedNames, parsed.jsonPath, parsed.mdPath);
    } catch (err) {
      console.error(err instanceof RoundError ? err.message : 'Could not check the output path.');
      process.exitCode = 1;
      return;
    }
    if (refusal) {
      console.error(refusal);
      process.exitCode = 1;
      return;
    }
    try {
      if (parsed.jsonPath) writeFileSync(parsed.jsonPath, reportJson(report));
      if (parsed.mdPath) writeFileSync(parsed.mdPath, markdown);
    } catch {
      console.error('Could not write the checklist.');
      process.exitCode = 1;
      return;
    }
  } else {
    process.stdout.write(markdown);
  }

  if (hasErrors(report)) process.exitCode = 1;
}

function parseArgs(args) {
  let roundPath = null;
  let jsonPath = null;
  let mdPath = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--json' || arg === '--md') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) return { error: `${arg} needs a file.` };
      if (arg === '--json' && jsonPath) return { error: '--json was given twice.' };
      if (arg === '--md' && mdPath) return { error: '--md was given twice.' };
      if (arg === '--json') jsonPath = value;
      else mdPath = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `Unknown argument: ${arg}` };
    if (roundPath) return { error: 'Give one round file.' };
    roundPath = arg;
  }
  if (!roundPath) return { error: USAGE };
  return { roundPath, jsonPath, mdPath };
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
