import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

import { FILE_BYTES, RevisitError, fail } from './errors.mjs';
import { formatView } from './text.mjs';
import { parseSaved } from './saved.mjs';
import { listView } from './view.mjs';

export const USAGE = 'Usage: node packages/revisit-reminders/src/revisit.mjs --file <reminders.json> --today YYYY-MM-DD [--days N] [--json]';

function parseArgs(argv) {
  const args = { file: null, today: null, days: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      if (args.json) fail('json', '--json was given twice');
      args.json = true;
    } else if (arg === '--file' || arg === '--today' || arg === '--days') {
      const name = arg.slice(2);
      if (args[name] !== null) fail(name, `--${name} was given twice`);
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) fail(name, `--${name} needs a value`);
      args[name] = value;
      index += 1;
    } else {
      fail('arguments', `unknown option ${JSON.stringify(arg)}`);
    }
  }
  if (args.file === null) fail('file', '--file is required');
  if (args.today === null) fail('today', '--today is required');
  return args;
}

function readDays(text) {
  if (text === null) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(text)) fail('days', 'days must be a whole number from 0 to 3650');
  const days = Number(text);
  if (!Number.isSafeInteger(days)) fail('days', 'days must be a whole number from 0 to 3650');
  return days;
}

function readLimited(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    fail('file', "Couldn't open the reminders file");
  }
  try {
    let info;
    try {
      info = fstatSync(fd);
    } catch {
      fail('file', "Couldn't read the reminders file");
    }
    if (!info.isFile()) fail('file', 'the reminders path is not a file');
    if (info.size > FILE_BYTES) fail('file', `the file is ${info.size} bytes; the limit is ${FILE_BYTES} bytes`);
    let bytes;
    try {
      bytes = readFileSync(fd);
    } catch {
      fail('file', "Couldn't read the reminders file");
    }
    if (bytes.length > FILE_BYTES) fail('file', `the file is ${bytes.length} bytes; the limit is ${FILE_BYTES} bytes`);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('file', 'file is not UTF-8');
    }
  } finally {
    closeSync(fd);
  }
}

export function main(argv, io) {
  try {
    const args = parseArgs(argv);
    const reminders = parseSaved(readLimited(args.file));
    const options = { today: args.today };
    const days = readDays(args.days);
    if (days !== undefined) options.days = days;
    const view = listView(reminders, options);
    io.stdout.write(args.json ? `${JSON.stringify(view, null, 2)}\n` : formatView(view));
    return 0;
  } catch (error) {
    if (error instanceof RevisitError) {
      io.stderr.write(`revisit-reminders: ${error.message}\n${USAGE}\n`);
      return 1;
    }
    throw error;
  }
}
