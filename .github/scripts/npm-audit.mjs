// `npm audit` in `tests` (docs/plans/security.md, section 1, "Next baseline
// steps"). High and critical advisories in runtime dependencies fail the
// check. Advisories that reach only development tools, or rate below high,
// are reported as warnings without failing it. An advisory that doesn't apply
// is listed in .github/accepted-risks.json with the owner's yes, never
// silently ignored.
//
// npm audit reads only the lockfile and asks the npm registry; it installs
// nothing and runs no package scripts.
//
//   node .github/scripts/npm-audit.mjs --folders < changed-files   JSON list of folders to audit
//   node .github/scripts/npm-audit.mjs --folders --all              every folder with a lockfile
//   node .github/scripts/npm-audit.mjs <folder> [<folder> ...]      audit them

import { spawnSync, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTED_RISKS = '.github/accepted-risks.json';
const FAILING = new Set(['high', 'critical']);
const GHSA = /GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Folders that hold a package-lock.json, from a list of tracked files. */
export function lockfileFolders(tracked) {
  return tracked
    .filter((f) => f === 'package-lock.json' || f.endsWith('/package-lock.json'))
    .map((f) => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'))
    .sort();
}

/** The lockfile folders a change touches. A change to .github/ audits them all. */
export function foldersToAudit(changed, folders) {
  if (changed.some((f) => f.startsWith('.github/'))) return [...folders];
  return folders.filter((d) => changed.some((f) => (d === '.' ? !f.includes('/') : f.startsWith(`${d}/`))));
}

/** Reads and checks the accepted-risks list. Throws on a malformed entry. */
export function parseAcceptedRisks(text) {
  const data = JSON.parse(text);
  if (!data || !Array.isArray(data.accepted)) throw new Error(`${ACCEPTED_RISKS} needs an "accepted" list`);
  return data.accepted.map((entry, i) => {
    const where = `${ACCEPTED_RISKS} entry ${i + 1}`;
    for (const key of ['advisory', 'folder', 'package', 'reason', 'ownerYes', 'date']) {
      if (typeof entry?.[key] !== 'string' || !entry[key].trim()) throw new Error(`${where} needs "${key}"`);
    }
    if (!GHSA.test(entry.advisory) || entry.advisory.match(GHSA)[0] !== entry.advisory) throw new Error(`${where}: "advisory" must be a GHSA id`);
    if (!DAY.test(entry.date)) throw new Error(`${where}: "date" must be YYYY-MM-DD`);
    return entry;
  });
}

/** One row per advisory in an `npm audit --json` report. */
export function advisoriesIn(report) {
  if (!report || typeof report !== 'object') throw new Error('npm audit gave no report');
  if (report.error) throw new Error(`npm audit failed: ${report.error.summary || report.error.code || 'unknown error'}`);
  if (typeof report.vulnerabilities !== 'object' || report.vulnerabilities === null) throw new Error('npm audit gave a report without a vulnerabilities section');
  const seen = new Map();
  for (const vuln of Object.values(report.vulnerabilities)) {
    for (const via of vuln.via || []) {
      if (typeof via !== 'object' || via === null) continue; // a path through another package; its own entry lists the advisory
      const id = String(via.url || '').match(GHSA)?.[0] || `npm-${via.source}`;
      const key = `${id}|${via.name}`;
      if (!seen.has(key)) seen.set(key, { id, package: via.name, severity: via.severity, title: via.title || '' });
    }
  }
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id) || a.package.localeCompare(b.package));
}

/**
 * Decides one folder's result from its runtime-only and full reports.
 * Returns { failures, warnings, accepted }, each a list of advisory rows.
 */
export function judge({ folder, runtime, full, accepted }) {
  const runtimeRows = advisoriesIn(runtime);
  const fullRows = advisoriesIn(full);
  const isAccepted = (row) => accepted.some((a) => a.folder === folder && a.advisory === row.id && a.package === row.package);
  const runtimeKeys = new Set(runtimeRows.map((r) => `${r.id}|${r.package}`));
  const failures = [];
  const warnings = [];
  const acceptedRows = [];
  for (const row of runtimeRows) {
    if (!FAILING.has(row.severity)) warnings.push({ ...row, scope: 'runtime' });
    else if (isAccepted(row)) acceptedRows.push(row);
    else failures.push(row);
  }
  for (const row of fullRows) {
    if (!runtimeKeys.has(`${row.id}|${row.package}`)) warnings.push({ ...row, scope: 'development only' });
  }
  return { failures, warnings, accepted: acceptedRows };
}

function audit(folder, omitDev) {
  const args = ['audit', '--json', '--package-lock-only', ...(omitDev ? ['--omit=dev'] : [])];
  const run = spawnSync('npm', args, { cwd: folder, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  try {
    return JSON.parse(run.stdout);
  } catch {
    throw new Error(`npm audit in ${folder} gave no readable report (exit ${run.status}): ${(run.stderr || '').trim().slice(0, 500)}`);
  }
}

function main(argv) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (argv[0] === '--folders') {
    const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    const folders = lockfileFolders(tracked);
    const changed = argv[1] === '--all' ? ['.github/'] : readFileSync(0, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    process.stdout.write(`${JSON.stringify(foldersToAudit(changed, folders))}\n`);
    return 0;
  }
  const accepted = parseAcceptedRisks(readFileSync(join(root, ACCEPTED_RISKS), 'utf8'));
  let failed = false;
  for (const folder of argv) {
    const { failures, warnings, accepted: acc } = judge({
      folder,
      runtime: audit(join(root, folder), true),
      full: audit(join(root, folder), false),
      accepted,
    });
    console.log(`${folder}: ${failures.length} failing, ${warnings.length} reported, ${acc.length} accepted`);
    for (const w of warnings) console.log(`::warning::${folder}: ${w.severity} ${w.id} in ${w.package} (${w.scope}): ${w.title}`);
    for (const a of acc) console.log(`${folder}: accepted ${a.severity} ${a.id} in ${a.package} (see ${ACCEPTED_RISKS})`);
    for (const f of failures) console.log(`::error::${folder}: ${f.severity} ${f.id} in ${f.package} (runtime): ${f.title}`);
    if (failures.length) failed = true;
  }
  if (failed) {
    console.log(`A runtime dependency has a high or critical advisory. Update it, or, if it doesn't apply, list it in ${ACCEPTED_RISKS} with the owner's yes.`);
    return 1;
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  }
}
