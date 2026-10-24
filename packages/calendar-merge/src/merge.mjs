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

// RFC 5545 folds lines by octets, so a fold can split a multi-byte UTF-8
// character. Before decoding, the split character's continuation bytes are
// moved in front of the fold: unfolding then gives the same text, and line
// numbers don't change. Anything else that hands the engine text (a later
// fetch layer, for example) needs the same care.
export function decodeIcs(bytes) {
  if (typeof bytes === 'string') return bytes;
  const out = [];
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    const lineBreak = b === 0x0a ? 1 : b === 0x0d && bytes[i + 1] === 0x0a ? 2 : 0;
    if (lineBreak && (bytes[i + lineBreak] === 0x20 || bytes[i + lineBreak] === 0x09)) {
      let j = i + lineBreak + 1;
      const moved = [];
      while (j < bytes.length && (bytes[j] & 0xc0) === 0x80) { moved.push(bytes[j]); j += 1; }
      if (moved.length) {
        out.push(...moved);
        for (let k = i; k <= i + lineBreak; k += 1) out.push(bytes[k]);
        i = j;
        continue;
      }
    }
    out.push(b);
    i += 1;
  }
  return new TextDecoder().decode(Uint8Array.from(out));
}

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
      return { id, name: id, ics: decodeIcs(readFile(file)) };
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
