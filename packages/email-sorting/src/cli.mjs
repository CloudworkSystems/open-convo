// The command, as a function the tests can call: reads the two files, sorts
// with the keyword classifier and prints a summary or the JSON result.
// Returns the exit code; never calls process.exit.

import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createKeywordClassifier } from './classifiers.mjs';
import { sortMessages } from './engine.mjs';
import { EmailSortError, LIMITS } from './rules.mjs';
import { formatSummary } from './summary.mjs';
import { parseJsonFile } from './validate.mjs';

export const USAGE = 'Usage: node src/sort.mjs --messages <messages.json> [--settings <settings.json>] [--json]';

function parseArgs(argv) {
  const args = { messages: null, settings: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      if (args.json) throw new EmailSortError('--json was given twice.');
      args.json = true;
    } else if (arg === '--messages' || arg === '--settings') {
      const name = arg.slice(2);
      if (args[name] !== null) throw new EmailSortError(`${arg} was given twice.`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new EmailSortError(`${arg} needs a file path.`);
      args[name] = value;
      i += 1;
    } else {
      throw new EmailSortError(`Unknown option: ${JSON.stringify(arg)}.`);
    }
  }
  if (args.messages === null) throw new EmailSortError('--messages is required.');
  return args;
}

// Refuses a file over the size limit before reading it. Open, size and
// read failures all become the plain refusal (exit code 1).
function readLimited(path, label) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new EmailSortError(`Couldn't open the ${label} file.`);
  }
  try {
    let size;
    try {
      ({ size } = fstatSync(fd));
    } catch {
      throw new EmailSortError(`Couldn't read the ${label} file.`);
    }
    if (size > LIMITS.fileBytes) {
      throw new EmailSortError(`The ${label} file is ${size} bytes; the limit is ${LIMITS.fileBytes} bytes (5 MB).`);
    }
    // A path can open but not read, for example a folder.
    try {
      return readFileSync(fd);
    } catch {
      throw new EmailSortError(`Couldn't read the ${label} file.`);
    }
  } finally {
    closeSync(fd);
  }
}

export async function main(argv, io) {
  try {
    const args = parseArgs(argv);
    const input = parseJsonFile(readLimited(args.messages, 'messages'), 'messages');
    const settings = args.settings === null ? undefined : parseJsonFile(readLimited(args.settings, 'settings'), 'settings');
    const result = await sortMessages(input, settings, createKeywordClassifier());
    io.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatSummary(result));
    return 0;
  } catch (error) {
    if (error instanceof EmailSortError) {
      io.stderr.write(`email-sorting: ${error.message}\n${USAGE}\n`);
      return 1;
    }
    throw error;
  }
}
