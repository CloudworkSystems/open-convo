import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

import { AgendaError, FILE_BYTES } from './errors.mjs';
import { buildAgenda } from './engine.mjs';
import { formatAgenda } from './format.mjs';

export const USAGE = 'Usage: node packages/today-agenda/src/agenda.mjs --day <day.json> [--json]';

function parseArgs(argv) {
  const args = { day: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      if (args.json) throw new AgendaError('--json was given twice.');
      args.json = true;
    } else if (arg === '--day') {
      if (args.day !== null) throw new AgendaError('--day was given twice.');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new AgendaError('--day needs a file path.');
      args.day = value;
      i += 1;
    } else {
      throw new AgendaError(`Unknown option: ${JSON.stringify(arg)}.`);
    }
  }
  if (args.day === null) throw new AgendaError('--day is required.');
  return args;
}

function readLimited(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new AgendaError("Couldn't open the day file.");
  }
  try {
    let size;
    try {
      ({ size } = fstatSync(fd));
    } catch {
      throw new AgendaError("Couldn't read the day file.");
    }
    if (size > FILE_BYTES) {
      throw new AgendaError(`day: the file is ${size} bytes; the limit is ${FILE_BYTES} bytes (2 MB).`);
    }
    try {
      return readFileSync(fd, 'utf8');
    } catch {
      throw new AgendaError("Couldn't read the day file.");
    }
  } finally {
    closeSync(fd);
  }
}

export function main(argv, io) {
  try {
    const args = parseArgs(argv);
    let parsed;
    try {
      parsed = JSON.parse(readLimited(args.day));
    } catch (error) {
      if (error instanceof AgendaError) throw error;
      throw new AgendaError('day: the file is not valid JSON.');
    }
    const agenda = buildAgenda(parsed);
    io.stdout.write(args.json ? `${JSON.stringify(agenda, null, 2)}\n` : formatAgenda(agenda));
    return 0;
  } catch (error) {
    if (error instanceof AgendaError) {
      io.stderr.write(`today-agenda: ${error.message}\n${USAGE}\n`);
      return 1;
    }
    throw error;
  }
}
