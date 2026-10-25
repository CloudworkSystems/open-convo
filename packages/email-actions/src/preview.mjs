#!/usr/bin/env node
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { previewActions } from './engine.mjs';
import { EmailActionsError, LIMITS } from './rules.mjs';
import { formatSummary } from './summary.mjs';
import { parseJsonFile } from './validate.mjs';

export const USAGE = 'Usage: node src/preview.mjs --messages <messages.json> --requests <requests.json> [--json]';

function parseArgs(argv) {
  const args = { messages: null, requests: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      if (args.json) throw new EmailActionsError('--json was given twice.');
      args.json = true;
    } else if (argument === '--messages' || argument === '--requests') {
      const name = argument.slice(2);
      if (args[name] !== null) throw new EmailActionsError(`${argument} was given twice.`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new EmailActionsError(`${argument} needs a file path.`);
      args[name] = value;
      index += 1;
    } else {
      throw new EmailActionsError(`Unknown option: ${JSON.stringify(argument)}.`);
    }
  }
  if (args.messages === null) throw new EmailActionsError('--messages is required.');
  if (args.requests === null) throw new EmailActionsError('--requests is required.');
  return args;
}

function readLimited(path, label) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
  } catch {
    throw new EmailActionsError(`Couldn't open the ${label} file.`);
  }
  try {
    let size;
    try {
      ({ size } = fstatSync(descriptor));
    } catch {
      throw new EmailActionsError(`Couldn't read the ${label} file.`);
    }
    if (size > LIMITS.fileBytes) throw new EmailActionsError(`The ${label} file is ${size} bytes; the limit is ${LIMITS.fileBytes} bytes (5 MB).`);
    try {
      return readFileSync(descriptor);
    } catch {
      throw new EmailActionsError(`Couldn't read the ${label} file.`);
    }
  } finally {
    closeSync(descriptor);
  }
}

export function main(argv, io) {
  try {
    const args = parseArgs(argv);
    const messages = parseJsonFile(readLimited(args.messages, 'messages'), 'messages');
    const requests = parseJsonFile(readLimited(args.requests, 'requests'), 'requests');
    const plan = previewActions(messages, requests);
    io.stdout.write(args.json ? `${JSON.stringify(plan, null, 2)}\n` : formatSummary(plan));
    return 0;
  } catch (error) {
    if (!(error instanceof EmailActionsError)) throw error;
    io.stderr.write(`email-actions: ${error.message}\n${USAGE}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2), process);
}
