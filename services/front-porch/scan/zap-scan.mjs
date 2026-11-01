// Runs the OWASP ZAP API scan against a running front porch and fails on any
// medium or high alert, or if a path was left out (docs/plans/front-porch-api.md,
// Server Security Controls).
//
//   node scan/zap-scan.mjs http://127.0.0.1:8787              (CI, Node entry point)
//   node scan/zap-scan.mjs https://front-porch.<name>.workers.dev  (staging)
//
// Needs Docker. Everything it writes goes to scan/out/ (ignored by Git).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(here, 'out');

// Pinned by digest so the scanner can't change under us.
export const ZAP_IMAGE = 'ghcr.io/zaproxy/zaproxy:stable@sha256:030d3df57735dacbb83464854758e674dd9ad01d79d12a129a8e58b1fd384238';

// Only the local Node server or the Worker's own workers.dev staging address
// may be scanned: never api.trueconvo.com or anyone else's host.
const ALLOWED_TARGET = /^(http:\/\/127\.0\.0\.1:\d{2,5}|https:\/\/front-porch\.[a-z0-9-]{1,63}\.workers\.dev)$/;

export function checkTarget(base) {
  if (typeof base !== 'string' || !ALLOWED_TARGET.test(base)) {
    throw new Error('The scan target must be the local server (http://127.0.0.1:<port>) or the Worker\'s workers.dev address.');
  }
  return base;
}

/** The OpenAPI file ZAP imports: the public one, pointed at the scan target. */
export function scanSpec(openapi, base) {
  return { ...openapi, servers: [{ url: base }] };
}

/** Every path the report must show ZAP reached. */
export function expectedPaths(openapi) {
  return [...Object.keys(openapi.paths), '/mcp'];
}

/**
 * Reads ZAP's JSON report and the list of URLs it saw. Returns the problems:
 * medium or high alerts, and any path ZAP never reached.
 */
export function judge(report, urls, paths, base) {
  const problems = [];
  const seen = new Set(urls.filter((u) => u.startsWith(base)).map((u) => new URL(u).pathname));
  for (const path of paths) {
    if (!seen.has(path)) problems.push('ZAP never reached ' + path + '.');
  }
  for (const site of report.site ?? []) {
    for (const alert of site.alerts ?? []) {
      const risk = Number(alert.riskcode);
      if (risk >= 2) problems.push((risk === 3 ? 'High' : 'Medium') + ' alert: ' + alert.name + ' (' + (alert.instances?.[0]?.uri ?? site['@name']) + ').');
    }
  }
  return problems;
}

function main() {
  const base = checkTarget(process.argv[2]);
  const openapi = JSON.parse(readFileSync(join(root, 'openapi.json'), 'utf8'));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'scan-openapi.json'), JSON.stringify(scanSpec(openapi, base), null, 2));
  copyFileSync(join(here, 'zap-hooks.py'), join(out, 'zap-hooks.py'));

  const run = spawnSync('docker', [
    'run', '--rm', '--network', 'host', '--user', 'root',
    '-e', 'FRONT_PORCH_BASE=' + base,
    '-v', out + ':/zap/wrk:rw',
    ZAP_IMAGE,
    'zap-api-scan.py', '-t', '/zap/wrk/scan-openapi.json', '-f', 'openapi',
    '-J', 'report.json', '-r', 'report.html', '--hook', '/zap/wrk/zap-hooks.py', '-I',
  ], { stdio: 'inherit' });
  if (run.status === null || run.error) throw new Error('Docker could not run ZAP.');

  const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
  const urls = readFileSync(join(out, 'urls.txt'), 'utf8').split('\n').filter(Boolean);
  const paths = expectedPaths(openapi);
  console.log('ZAP reached ' + paths.length + ' expected paths among ' + urls.length + ' URLs:');
  for (const u of urls) console.log('  ' + u);
  const problems = judge(report, urls, paths, base);
  if (problems.length) {
    console.error('ZAP scan failed:\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('ZAP scan passed: no medium or high alerts, every path reached.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
