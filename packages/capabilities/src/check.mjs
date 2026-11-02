#!/usr/bin/env node
// Checks capability.json files against the contract.
//   node packages/capabilities/src/check.mjs path/to/capability.json [more ...]
// Prints "ok" or each problem per file. Exit code 1 if any file fails.

import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_RECORD_BYTES, formatErrors, validateCapability } from './validate.mjs';

/** @returns {{ code: number, lines: string[] }} */
export function run(paths) {
  if (paths.length === 0) return { code: 1, lines: ['Give one or more capability.json files to check.'] };
  const lines = [];
  let code = 0;
  for (const path of paths) {
    const problem = checkFile(path);
    if (problem) {
      code = 1;
      lines.push(`${path}: not valid`, ...problem.split('\n').map((l) => `  ${l}`));
    } else {
      lines.push(`${path}: ok`);
    }
  }
  return { code, lines };
}

function checkFile(path) {
  let raw;
  try {
    if (statSync(path).size > MAX_RECORD_BYTES) return `the file is larger than ${MAX_RECORD_BYTES} bytes`;
    raw = readFileSync(path, 'utf8');
  } catch {
    return 'the file could not be read';
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    return 'the file is not valid JSON';
  }
  const { ok, errors } = validateCapability(record);
  return ok ? null : formatErrors(errors);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, lines } = run(process.argv.slice(2));
  (code ? console.error : console.log)(lines.join('\n'));
  process.exitCode = code;
}
