/**
 * Command: node packages/setup-check/src/check.mjs --facts <facts.json> [--json]
 * Reads one facts file and prints the setup check. It writes nothing.
 */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { checkSetup, formatPlain } from './index.mjs';

const FACTS_LIMIT = 64 * 1024;

function fail(message) {
  throw new Error(message);
}

function parseArgs(argv) {
  let factsPath;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--facts') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail('facts is missing.');
      factsPath = value;
      index += 1;
      continue;
    }
    fail(`${arg} is an unknown field.`);
  }
  if (!factsPath) fail('facts is missing.');
  return { factsPath, json };
}

function loadFacts(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  if (buffer.byteLength > FACTS_LIMIT) fail('facts is larger than 64 KB.');
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    fail('facts is not valid JSON.');
  }
}

/**
 * Runs the command. `io.readFile` defaults to reading the path from disk.
 * Returns 0 on a result and 1 on a refusal. The engine itself does not exit.
 */
export function run(argv, io = {}) {
  const readFile = io.readFile ?? (filePath => readFileSync(filePath));
  const stdout = io.stdout ?? (text => process.stdout.write(text));
  const stderr = io.stderr ?? (text => process.stderr.write(text));
  const exit = io.exit ?? (code => { process.exitCode = code; });
  try {
    const options = parseArgs(argv);
    let bytes;
    try {
      bytes = readFile(options.factsPath);
    } catch {
      fail('facts cannot be read.');
    }
    const result = checkSetup(loadFacts(bytes));
    const text = options.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatPlain(result)}\n`;
    stdout(text);
    return 0;
  } catch (error) {
    stderr(`${error.message}\n`);
    exit(1);
    return 1;
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) run(process.argv.slice(2));
