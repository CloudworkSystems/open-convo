#!/usr/bin/env node
// Runs one make_media upload or local job.
//   node packages/capabilities/src/media/make.mjs --record <capability.json> --route upload --file <path> --made-how <answer> --media <dir>
//   node packages/capabilities/src/media/make.mjs --record <capability.json> --route local --server http://127.0.0.1:<port> --workflow <file.json> --prompt <text> --media <dir>

import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { MAX_RECORD_BYTES, formatErrors } from '../validate.mjs';
import { REASONS } from './reasons.mjs';
import { runLocal, upload } from './runner.mjs';

const WORKFLOW_BYTES = 1024 * 1024;

export async function run(argv) {
  let values;
  try {
    values = parseArgs({
      args: argv,
      options: {
        record: { type: 'string' },
        route: { type: 'string' },
        file: { type: 'string' },
        'made-how': { type: 'string' },
        media: { type: 'string' },
        server: { type: 'string' },
        workflow: { type: 'string' },
        prompt: { type: 'string' },
        kind: { type: 'string' },
        seconds: { type: 'string' },
        width: { type: 'string' },
        height: { type: 'string' },
        'reference-file': { type: 'string' },
        now: { type: 'string' },
      },
      strict: true,
    }).values;
  } catch {
    return usage();
  }
  if (!values.record || !values.route || !values.media) return usage();
  const uploadMode = values.file != null;
  const localMode = values.server != null || values.workflow != null || values.prompt != null;
  if (uploadMode === localMode) return usage();
  const record = readRecord(resolve(values.record));
  if (record.problem) return { code: 1, lines: [record.problem] };
  const now = values.now ? () => values.now : () => new Date().toISOString();
  const mediaDir = resolve(values.media);
  if (uploadMode) {
    if (!values['made-how']) return usage();
    const result = upload({
      record: record.value,
      routeId: values.route,
      filePath: resolve(values.file),
      madeHow: values['made-how'],
      mediaDir,
      now,
    });
    return finish(result);
  }
  if (!values.server || !values.workflow || values.prompt == null) return usage();
  const workflow = readWorkflow(resolve(values.workflow));
  if (workflow.problem) return { code: 1, lines: [workflow.problem] };
  const seconds = whole(values.seconds);
  const width = whole(values.width);
  const height = whole(values.height);
  if (seconds === null || width === null || height === null) return { code: 1, lines: [REASONS.badRequest] };
  const kind = values.kind ?? workflow.value.kind;
  const result = await runLocal({
    record: record.value,
    routeId: values.route,
    server: values.server,
    workflow: workflow.value,
    mediaDir,
    now,
    request: {
      kind,
      prompt: values.prompt,
      seconds,
      width,
      height,
      referenceFile: values['reference-file'] ? resolve(values['reference-file']) : undefined,
    },
  });
  return finish(result);
}

function finish(result) {
  if (!result.ok) {
    const lines = [result.reason];
    if (result.errors) lines.push(formatErrors(result.errors));
    return { code: 1, lines };
  }
  return { code: 0, lines: [result.file, result.receiptPath] };
}

function readRecord(filePath) {
  let raw;
  try {
    if (statSync(filePath).size > MAX_RECORD_BYTES) return { problem: REASONS.record };
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { problem: REASONS.record };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { problem: REASONS.record };
  }
}

function readWorkflow(filePath) {
  let raw;
  try {
    if (statSync(filePath).size > WORKFLOW_BYTES) return { problem: REASONS.workflow };
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return { problem: REASONS.workflow };
  }
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return { problem: REASONS.workflow };
  }
}

function whole(text) {
  if (text == null) return undefined;
  if (!/^(0|[1-9]\d{0,8})$/.test(text)) return null;
  return Number(text);
}

function usage() {
  return {
    code: 1,
    lines: [
      'Give --record, --route and --media, then either an upload (--file and --made-how) or a local run (--server, --workflow and --prompt).',
    ],
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { code, lines } = await run(process.argv.slice(2));
  (code ? console.error : console.log)(lines.join('\n'));
  process.exitCode = code;
}
