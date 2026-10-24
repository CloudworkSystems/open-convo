#!/usr/bin/env node
// Command:
//   node src/merge.mjs --from 2026-11-01 --to 2026-11-08 --tz America/New_York a.ics b.ics [--json] [--include-cancelled]
// Reads the named files, merges them and prints an agenda (or, with --json,
// the result object). A refusal prints its message to stderr and exits with 1.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIMITS, mergeCalendars } from './engine.mjs';
import { formatAgenda } from './agenda.mjs';

const USAGE = 'Usage: node src/merge.mjs --from YYYY-MM-DD --to YYYY-MM-DD --tz Area/City <file.ics> ... [--json] [--include-cancelled]';

function parseArgs(argv) {
  const options = { files: [], json: false, includeCancelled: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--include-cancelled') options.includeCancelled = true;
    else if (arg === '--from' || arg === '--to' || arg === '--tz') {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value. ${USAGE}`);
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--')) throw new Error(`Unknown option ${arg}. ${USAGE}`);
    else options.files.push(arg);
  }
  for (const name of ['from', 'to', 'tz']) if (options[name] === undefined) throw new Error(`--${name} is missing. ${USAGE}`);
  return options;
}

export async function run(argv, { stdout = process.stdout, stderr = process.stderr, readFile = fs.readFileSync, fileSize = (file) => fs.statSync(file).size } = {}) {
  try {
    const options = parseArgs(argv);
    if (options.files.length > LIMITS.sources) throw new Error(`Too many calendars: ${options.files.length} given, at most ${LIMITS.sources}.`);
    const sources = options.files.map((file) => {
      const id = path.basename(file).replace(/\.ics$/i, '');
      let size;
      try {
        size = fileSize(file);
      } catch {
        throw new Error(`Can't read ${file}.`);
      }
      if (size > LIMITS.sourceBytes) throw new Error(`Calendar "${id}" is over 5 MB.`);
      return { id, name: id, ics: readFile(file, 'utf8') };
    });
    const result = await mergeCalendars(sources, {
      from: options.from,
      to: options.to,
      timeZone: options.tz,
      includeCancelled: options.includeCancelled,
    });
    stdout.write(options.json ? `${JSON.stringify(result, null, 2)}\n` : formatAgenda(result));
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
