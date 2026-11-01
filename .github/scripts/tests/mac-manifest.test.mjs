// Guards the Mac app's package manifest now that it no longer needs the
// owner's approval (owner decision, November 1, 2026). A new outside package
// still trips the risk hold (docs/plans/risk-review.md); these tests keep the
// two other things the manifest controls: which participant-path modules the
// app links, and that every protected test still builds and runs. Changing
// what's pinned here needs the owner, because this file is protected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const mac = normalize(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'apps', 'mac'));
const raw = readFileSync(join(mac, 'Package.swift'), 'utf8');
// Comments may say anything; only code counts.
const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** The index just past the bracket or parenthesis that closes the one at `open`, skipping strings. */
function closing(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
    } else if (c === '[' || c === '(') depth += 1;
    else if (c === ']' || c === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error('unbalanced brackets in Package.swift');
}

/** The top-level elements of the array that opens at `open`. */
function elements(text, open) {
  const end = closing(text, open) - 1;
  const out = [];
  let start = open + 1;
  for (let i = start; i < end; i += 1) {
    if (text[i] === '"' || text[i] === '[' || text[i] === '(') i = text[i] === '"' ? closingQuote(text, i) : closing(text, i) - 1;
    else if (text[i] === ',') { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start, end));
  return out.map((e) => e.trim()).filter(Boolean);
}

function closingQuote(text, open) {
  for (let i = open + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i;
  }
  throw new Error('unclosed string in Package.swift');
}

/**
 * Each entry of the package's `targets:` array: its kind, name, path and every
 * quoted name in its dependencies (any form: "X", .target(name:), .product(),
 * .byName()), so nothing a target links can hide.
 */
export function parseTargets(text) {
  // The `targets:` argument of Package( itself, not a product's targets list.
  const call = text.search(/\bPackage\s*\(/);
  const args = call < 0 ? [text] : elements(text, text.indexOf('(', call));
  const arg = args.find((a) => /^targets:\s*\[/.test(a));
  if (!arg) throw new Error('no targets: array in Package.swift');
  return elements(arg, arg.indexOf('[')).map((entry) => {
    const kind = entry.match(/^\.(\w+)\(/)?.[1] ?? entry;
    const name = entry.match(/name:\s*"([^"]+)"/)?.[1];
    const path = entry.match(/\bpath:\s*"([^"]+)"/)?.[1] ?? null;
    const depsAt = entry.search(/\bdependencies:\s*\[/);
    const deps = depsAt < 0 ? '' : entry.slice(depsAt, closing(entry, entry.indexOf('[', depsAt)));
    return { kind, name, path, dependencies: [...deps.matchAll(/"([^"]+)"/g)].map((d) => d[1]) };
  });
}

const targets = parseTargets(code);
const byName = new Map(targets.map((t) => [t.name, t]));

function linkedBy(root) {
  const seen = new Set();
  const walk = (name) => {
    if (seen.has(name) || !byName.has(name)) return;
    seen.add(name);
    byName.get(name).dependencies.forEach(walk);
  };
  walk(root);
  return seen;
}

const isParticipantPath = (name) => /^Participant/.test(name) || name === 'LocalModelRoute';

test('the manifest uses only plain targets: no plugins, flags, conditions or dropped files', () => {
  for (const kind of new Set(targets.map((t) => t.kind))) {
    assert.ok(['target', 'executableTarget', 'testTarget'].includes(kind), `unexpected .${kind}( in Package.swift`);
  }
  for (const [pattern, why] of [
    [/\bexclude:/, 'exclude: can drop a protected file from its target'],
    [/\bsources:/, 'sources: can drop a protected file from its target'],
    [/\bunsafeFlags\b/, 'unsafeFlags changes how the app is built'],
    [/#if\b/, 'a condition can build different targets on CI and on the Mac'],
    [/\bProcessInfo\b/, 'reading the environment can build different targets on CI and on the Mac'],
  ]) {
    assert.doesNotMatch(code, pattern, why);
  }
});

test('the app links exactly the participant-path modules the owner approved', () => {
  assert.ok(byName.has('VoiceCursorMac'), 'the app target is missing');
  const linked = [...linkedBy('VoiceCursorMac')].filter(isParticipantPath).sort();
  // Step 3 PR 4b: the local route in True Convo Test only, through
  // ParticipantAppWiring. ParticipantDeskControls stays unlinked.
  assert.deepEqual(linked, [
    'LocalModelRoute', 'ParticipantAppWiring', 'ParticipantCoordinator', 'ParticipantProcess', 'ParticipantSupervisorCore',
  ]);
});

test('every folder under Tests/ is built by a target, so every protected test runs', () => {
  const built = new Set(targets.map((t) => t.path ?? (t.kind === 'testTarget' ? `Tests/${t.name}` : `Sources/${t.name}`)));
  const folders = readdirSync(join(mac, 'Tests'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `Tests/${d.name}`);
  assert.ok(folders.length > 0);
  for (const folder of folders) assert.ok(built.has(folder), `${folder} is not built by any target in Package.swift`);
  // The protected tests named in .github/CODEOWNERS, by their test targets.
  for (const name of ['ArchiveProtectionTests', 'ProtectionProofTests', 'ParticipantProcessTests', 'DeskWindowKitTests', 'DeskHostTests']) {
    assert.equal(byName.get(name)?.kind, 'testTarget', `${name} must stay a test target`);
    assert.equal(byName.get(name).path, null, `${name} must build from Tests/${name}`);
  }
});

test('the parser reads names, paths and dependencies, and ignores comments', () => {
  const sample = `
    .target(name: "A", dependencies: ["B"]),
    // .target(name: "Hidden", dependencies: ["ParticipantX"]),
    .executableTarget(name: "B", dependencies: [.product(name: "C", package: "d"), .target(name: "E")], path: "Sources/X/B"),
    .testTarget(name: "ATests", dependencies: ["A"])`;
  const parsed = parseTargets(`targets: [${sample.replace(/\/\/[^\n]*/g, '')}]`);
  assert.deepEqual(parsed.map((t) => t.name), ['A', 'B', 'ATests']);
  assert.equal(parsed[1].path, 'Sources/X/B');
  assert.deepEqual(parsed[1].dependencies, ['C', 'd', 'E']);
});
