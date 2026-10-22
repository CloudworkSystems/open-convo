import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sameFile } from './paths.mjs';
import { renderReport } from './render.mjs';
import { ReportError, validateFindings } from './validate.mjs';

export { ReportError } from './validate.mjs';

const MAX_FINDINGS_BYTES = 1_000_000;

function fail(message) {
  throw new ReportError(message);
}

export function parseArgs(argv) {
  let findings;
  let json;
  let md;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== '--findings' && arg !== '--json' && arg !== '--md') {
      fail(`Unknown argument "${arg}".`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`${arg} needs a file path.`);
    index += 1;
    if (arg === '--findings') {
      if (findings !== undefined) fail('--findings was given twice.');
      findings = value;
    } else if (arg === '--json') {
      if (json !== undefined) fail('--json was given twice.');
      json = value;
    } else if (md !== undefined) {
      fail('--md was given twice.');
    } else {
      md = value;
    }
  }
  if (findings === undefined) fail('A findings file is required: --findings <file>.');
  return { findings, json, md };
}

function refuseSharedPaths(findings, json, md) {
  if (json !== undefined && sameFile(json, findings)) fail('Refusing to write --json to the findings file.');
  if (md !== undefined && sameFile(md, findings)) fail('Refusing to write --md to the findings file.');
  if (json !== undefined && md !== undefined && sameFile(json, md)) {
    fail('Refusing to write --json and --md to the same file.');
  }
}

export function buildReport(value) {
  return renderReport(validateFindings(value));
}

export function run(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  try {
    const args = parseArgs(argv);
    refuseSharedPaths(args.findings, args.json, args.md);
    let stat;
    try {
      stat = fs.statSync(args.findings);
    } catch {
      fail(`Could not read "${args.findings}".`);
    }
    if (!stat.isFile()) fail(`Could not read "${args.findings}".`);
    if (stat.size > MAX_FINDINGS_BYTES) fail('The findings file is larger than 1 MB.');
    let text;
    try {
      text = fs.readFileSync(args.findings, 'utf8');
    } catch {
      fail(`Could not read "${args.findings}".`);
    }
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      fail('The findings file is not valid JSON.');
    }
    const report = buildReport(value);
    try {
      if (args.json !== undefined) fs.writeFileSync(args.json, report.jsonText);
      if (args.md !== undefined) fs.writeFileSync(args.md, report.markdown);
    } catch {
      fail('Could not write the report.');
    }
    if (args.json === undefined && args.md === undefined) stdout.write(report.markdown);
    return 0;
  } catch (error) {
    if (error instanceof ReportError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const entry = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === entry) {
  // Let stdout finish. process.exit() would drop Markdown still queued on a pipe.
  process.exitCode = run(process.argv.slice(2));
}
