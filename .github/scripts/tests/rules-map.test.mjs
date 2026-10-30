// Keeps the rules-file maps true (AGENTS.md "Map"): every folder AGENTS.md,
// and every SKILL.md, REVIEW.md or intent.md, is listed in the map of the
// nearest AGENTS.md above it, every map link points at a file that exists,
// and every AGENTS.md has a CLAUDE.md pointing to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'));
const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\n');
const named = (name) => (f) => f === name || f.endsWith(`/${name}`);
const rules = tracked.filter(named('AGENTS.md'));
const others = tracked.filter((f) => ['SKILL.md', 'REVIEW.md', 'intent.md'].some((n) => named(n)(f)));

function mapLinks(file) {
  const text = readFileSync(join(root, file), 'utf8');
  const start = text.search(/^## Map$/m);
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const end = rest.search(/^## /m);
  const section = end < 0 ? rest : rest.slice(0, end);
  return [...section.matchAll(/\]\(([^)#\s]+)\)/g)]
    .map((m) => m[1])
    .filter((link) => !/^[a-z]+:/.test(link))
    .map((link) => posix.normalize(posix.join(posix.dirname(file), link)));
}

// An AGENTS.md is mapped by the one above its folder; other rules files by the
// AGENTS.md in their own folder or the nearest one above it.
function parentOf(file) {
  let dir = named('AGENTS.md')(file) ? posix.dirname(posix.dirname(file)) : posix.dirname(file);
  for (;;) {
    const candidate = dir === '.' ? 'AGENTS.md' : `${dir}/AGENTS.md`;
    if (rules.includes(candidate)) return candidate;
    if (dir === '.') return null;
    dir = posix.dirname(dir);
  }
}

test('there is a root AGENTS.md with a map', () => {
  assert.ok(rules.includes('AGENTS.md'));
  assert.ok(mapLinks('AGENTS.md'), 'AGENTS.md has no "## Map" section');
});

for (const file of [...rules.filter((f) => f !== 'AGENTS.md'), ...others]) {
  test(`${file} is listed in its parent's map`, () => {
    const parent = parentOf(file);
    const links = mapLinks(parent);
    assert.ok(links, `${parent} has rules files below it but no "## Map" section`);
    assert.ok(links.includes(file), `${parent}'s map doesn't list ${file}`);
  });
}

for (const file of rules) {
  test(`${file} map links exist and it has a CLAUDE.md pointer`, () => {
    for (const link of mapLinks(file) ?? []) {
      assert.ok(existsSync(join(root, link)), `${file}'s map links to missing ${link}`);
    }
    const pointer = posix.join(posix.dirname(file), 'CLAUDE.md');
    assert.ok(existsSync(join(root, pointer)), `${pointer} is missing`);
    assert.match(readFileSync(join(root, pointer), 'utf8'), /@AGENTS\.md/);
  });
}
