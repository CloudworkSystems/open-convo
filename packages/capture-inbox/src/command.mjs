import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

import { CaptureError, FILE_BYTES } from './errors.mjs';
import { sortDrop } from './engine.mjs';
import { formatDrop } from './format.mjs';

export const USAGE = 'Usage: node packages/capture-inbox/src/sort.mjs --drop <drop.json> [--json]';

function parseArgs(argv) {
  const args = { drop: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      if (args.json) throw new CaptureError('--json was given twice.');
      args.json = true;
    } else if (arg === '--drop') {
      if (args.drop !== null) throw new CaptureError('--drop was given twice.');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new CaptureError('--drop needs a file path.');
      args.drop = value;
      i += 1;
    } else {
      throw new CaptureError(`Unknown option: ${JSON.stringify(arg)}.`);
    }
  }
  if (args.drop === null) throw new CaptureError('--drop is required.');
  return args;
}

function readLimited(path) {
  let fd;
  try {
    fd = openSync(path, 'r');
  } catch {
    throw new CaptureError("Couldn't open the drop file.");
  }
  try {
    let size;
    try {
      ({ size } = fstatSync(fd));
    } catch {
      throw new CaptureError("Couldn't read the drop file.");
    }
    if (size > FILE_BYTES) {
      throw new CaptureError(`drop: the file is ${size} bytes; the limit is ${FILE_BYTES} bytes (8 MB).`);
    }
    try {
      return readFileSync(fd, 'utf8');
    } catch {
      throw new CaptureError("Couldn't read the drop file.");
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
      parsed = JSON.parse(readLimited(args.drop));
    } catch (error) {
      if (error instanceof CaptureError) throw error;
      throw new CaptureError('drop: the file is not valid JSON.');
    }
    const result = sortDrop(parsed);
    io.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatDrop(result));
    return 0;
  } catch (error) {
    if (error instanceof CaptureError) {
      io.stderr.write(`capture-inbox: ${error.message}\n${USAGE}\n`);
      return 1;
    }
    throw error;
  }
}
