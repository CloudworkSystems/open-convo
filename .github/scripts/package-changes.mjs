// Decides which packages under packages/ the `tests` check must run.
// Any folder in packages/ with a package.json counts, so a new package is
// covered without editing the workflow. Packages that already have their own
// job in tests.yml are left out here so they don't run twice.
//
// Usage (prints a JSON list of package folder names):
//   git diff --name-only ... | node .github/scripts/package-changes.mjs
//   node .github/scripts/package-changes.mjs --all

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Packages with a dedicated job in tests.yml.
export const OWN_JOB = new Set(['clarity']);
// Folder names that are safe to use in workflow paths.
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Folder names in `packagesDir` that contain a package.json. */
export function listPackages(packagesDir) {
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * @param {string[]} changedFiles repo-relative paths the pull request changes
 * @param {string[]} packages package folder names (from listPackages)
 * @param {{all?: boolean}} options all: test every package (manual run)
 * @returns {string[]} package folder names to test
 */
export function packagesToTest(changedFiles, packages, { all = false } = {}) {
  const unsafe = packages.filter((name) => !SAFE_NAME.test(name));
  if (unsafe.length) throw new Error(`Package folder names must match ${SAFE_NAME}: ${unsafe.join(', ')}`);
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);
  // A change to the checks themselves runs every package.
  const everything = all || files.some((f) => f.startsWith('.github/'));
  return packages
    .filter((name) => !OWN_JOB.has(name))
    .filter((name) => everything || files.some((f) => f.startsWith(`packages/${name}/`)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const all = process.argv.includes('--all');
  const input = all ? '' : readFileSync(0, 'utf8');
  const packages = listPackages(join(process.cwd(), 'packages'));
  console.log(JSON.stringify(packagesToTest(input.split('\n'), packages, { all })));
}
