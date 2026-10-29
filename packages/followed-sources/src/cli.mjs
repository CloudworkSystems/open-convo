// The command, as a function the tests can call: reads the files, runs the
// engine with the keyword drafter and prints the summary, cards and problem
// lines, or the whole result as JSON. Returns the exit code.

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createKeywordDrafter } from './drafters.mjs';
import { run } from './engine.mjs';
import { safeText } from './text.mjs';
import { InputError, validateItems, validateKnown, validateSources, validateState } from './validate.mjs';

export const USAGE = 'Usage: node src/followed.mjs --sources <sources.json> --items <items.json> [--state <state.json>] [--known <known.json>] [--json]';
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const FILE_OPTIONS = ['sources', 'items', 'state', 'known'];
// A state file given on the command line must be a full object, not null.
const VALIDATORS = {
  sources: validateSources,
  items: validateItems,
  state: value => validateState(value ?? 'missing'),
  known: value => validateKnown(value ?? 'missing'),
};

function parseArgs(argv) {
  const args = { sources: null, items: null, state: null, known: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (arg === '--json') {
      if (args.json) throw new InputError('--json was given twice.');
      args.json = true;
    } else if (FILE_OPTIONS.includes(name)) {
      if (args[name] !== null) throw new InputError(`${arg} was given twice.`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new InputError(`${arg} needs a file path.`);
      args[name] = value;
      i += 1;
    } else {
      throw new InputError(`Unknown option: ${JSON.stringify(arg)}.`);
    }
  }
  if (args.sources === null) throw new InputError('--sources is required.');
  if (args.items === null) throw new InputError('--items is required.');
  return args;
}

class Refusal extends Error {}

function readJson(path) {
  let raw;
  let fd;
  try {
    fd = openSync(path, 'r');
    if (fstatSync(fd).size > MAX_FILE_BYTES) throw new Refusal(`larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
    raw = readFileSync(fd, 'utf8');
  } catch (error) {
    if (error instanceof Refusal) throw error;
    throw new Refusal('could not be read');
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Refusal('not valid JSON');
  }
}

/** Runs the command. `io` has write(text) and error(text); returns 0, 1 (refused input) or 2 (usage). */
export async function main(argv, io = { write: text => process.stdout.write(text), error: text => process.stderr.write(text) }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.error(`${safeText(error.message)}\n${USAGE}\n`);
    return 2;
  }
  const inputs = {};
  // Each file is read and checked on its own, so a refusal names the file.
  for (const name of FILE_OPTIONS) {
    const path = args[name];
    if (path === null) continue;
    try {
      const value = readJson(path);
      VALIDATORS[name](value);
      inputs[name] = value;
    } catch (error) {
      if (!(error instanceof Refusal) && !(error instanceof InputError)) throw error;
      io.error(`Refused ${safeText(path)}: ${safeText(error.message)}.\n`);
      return 1;
    }
  }
  const result = await run({ ...inputs, drafter: createKeywordDrafter() });
  if (args.json) {
    io.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  const names = new Map((inputs.sources.sources ?? []).map(source => [source.id, source.name]));
  const lines = [safeText(result.summary)];
  for (const card of result.cards) {
    lines.push(`[${card.kind}] ${safeText(card.title)} (${safeText(names.get(card.source) ?? card.source)})`);
  }
  for (const problem of result.problems) lines.push(`Problem: ${safeText(problem)}`);
  io.write(`${lines.join('\n')}\n`);
  return 0;
}
