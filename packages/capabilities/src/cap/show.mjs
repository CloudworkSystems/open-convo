#!/usr/bin/env node
// Prints the effective cap, what is reserved and spent this month, and
// whether the ledger checks out. It changes nothing.
//   node packages/capabilities/src/cap/show.mjs --ledger <dir> --state <state.json> --now <iso>

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileKind, readNoFollow } from './files.mjs';
import { describe } from './ledger.mjs';
import { REASONS } from './reasons.mjs';
import { fileStore } from './state.mjs';
import { instantText } from './time.mjs';

const CAP_FILE = 'cap.json';
const SIGNATURE_FILE = 'cap.signature';
const PUBLIC_KEY_FILE = 'public-key.pem';

export function run(argv) {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        ledger: { type: 'string' },
        state: { type: 'string' },
        now: { type: 'string' },
      },
      strict: true,
    }).values;
  } catch {
    return usage();
  }
  if (!values.ledger || !values.state || !values.now) return usage();
  if (!instantText(values.now)) return { code: 1, lines: [REASONS.badNow] };
  const ledgerDir = resolve(values.ledger);
  if (fileKind(ledgerDir) !== 'directory') return { code: 1, lines: [REASONS.ledgerFolder] };
  const loaded = loadCap(ledgerDir);
  const lines = describe({
    ledgerDir,
    store: fileStore(resolve(values.state)),
    record: loaded.record,
    signature: loaded.signature,
    publicKey: loaded.publicKey,
    now: values.now,
  });
  return { code: 0, lines };
}

function loadCap(ledgerDir) {
  const recordText = readText(resolve(ledgerDir, CAP_FILE));
  if (recordText == null) return { record: null, signature: null, publicKey: null };
  let record;
  try {
    record = JSON.parse(recordText);
  } catch {
    record = false;
  }
  const signatureText = readText(resolve(ledgerDir, SIGNATURE_FILE));
  const publicKey = readText(resolve(ledgerDir, PUBLIC_KEY_FILE));
  const signature = signatureText == null ? null : signatureText.replace(/\s+/g, '');
  return { record, signature: signature || null, publicKey };
}

function readText(path) {
  if (fileKind(path) !== 'file') return null;
  try {
    return readNoFollow(path, 64 * 1024);
  } catch {
    return null;
  }
}

function usage() {
  return { code: 1, lines: ['Give --ledger, --state and --now.'] };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, lines } = run(process.argv.slice(2));
  (code ? console.error : console.log)(lines.join('\n'));
  process.exitCode = code;
}
