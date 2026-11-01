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

const STR = String.raw`"[^"\\]*"`;
const strValue = (v, what) => {
  if (!new RegExp(`^${STR}$`).test(v)) throw new Error(`${what} must be a plain string literal, not ${v}`);
  return v.slice(1, -1);
};
const arrayItems = (v, what) => {
  if (!/^\[/.test(v) || closing(v, 0) !== v.length) throw new Error(`${what} must be one array literal, not ${v}`);
  return elements(v, 0);
};
/** One labeled argument, split as label and value. */
const labeled = (arg) => {
  const m = arg.match(/^(\w+):\s*([\s\S]*)$/);
  if (!m) throw new Error(`unlabeled argument in Package.swift: ${arg}`);
  return [m[1], m[2].trim()];
};
const DEPENDENCY = [
  new RegExp(`^(${STR})$`),
  new RegExp(`^\\.(?:target|byName)\\(name:\\s*(${STR})\\)$`),
  new RegExp(`^\\.product\\(name:\\s*(${STR}),\\s*package:\\s*(${STR})\\)$`),
];
const RESOURCE = new RegExp(`^\\.(?:copy|process)\\(${STR}\\)$`);

/**
 * Each entry of the package's `targets:` array: its kind, name, path and every
 * name in its dependencies. The manifest must be one literal Package(...):
 * any argument, value or expression this can't read fully (a constant, an
 * array sum, a condition) throws, so nothing the app links can hide.
 */
export function parseTargets(text) {
  const body = text.trim();
  const head = body.match(/^(?:import PackageDescription\s+)?let package = Package\s*\(/);
  if (!head) throw new Error('Package.swift must be one `let package = Package(...)` and nothing else');
  const open = head[0].length - 1;
  if (closing(body, open) !== body.length) throw new Error('Package.swift has code after Package(...)');
  const args = Object.fromEntries(elements(body, open).map(labeled));
  for (const label of Object.keys(args)) {
    if (!['name', 'platforms', 'products', 'targets'].includes(label)) throw new Error(`unexpected Package argument ${label}:`);
  }
  if (!args.targets) throw new Error('no targets: array in Package.swift');
  return arrayItems(args.targets, 'targets').map((entry) => {
    const m = entry.match(/^\.(target|executableTarget|testTarget)\(/);
    if (!m || closing(entry, m[0].length - 1) !== entry.length) throw new Error(`unexpected target entry: ${entry.slice(0, 60)}`);
    const t = { kind: m[1], name: undefined, path: null, dependencies: [] };
    for (const [label, value] of elements(entry, m[0].length - 1).map(labeled)) {
      if (label === 'name') t.name = strValue(value, 'name');
      else if (label === 'path') t.path = strValue(value, 'path');
      else if (label === 'dependencies') {
        for (const dep of arrayItems(value, 'dependencies')) {
          const hit = DEPENDENCY.map((re) => dep.match(re)).find(Boolean);
          if (!hit) throw new Error(`dependency must be a plain name, .target(name:), .byName(name:) or .product(name:package:): ${dep}`);
          t.dependencies.push(...hit.slice(1).map((q) => q.slice(1, -1)));
        }
      } else if (label === 'resources') {
        for (const r of arrayItems(value, 'resources')) if (!RESOURCE.test(r)) throw new Error(`unexpected resource: ${r}`);
      } else throw new Error(`unexpected target argument ${label}: (only name, dependencies, path and resources)`);
    }
    if (!t.name) throw new Error('a target without a name');
    return t;
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

test('the parser reads plain literals and rejects anything it cannot read fully', () => {
  const wrap = (targets, before = '') => `${before}import PackageDescription\nlet package = Package(name: "P", targets: [${targets}])`;
  const parsed = parseTargets(wrap(`
    .target(name: "A", dependencies: ["B"]),
    .executableTarget(name: "B", dependencies: [.product(name: "C", package: "d"), .target(name: "E")], path: "Sources/X/B"),
    .testTarget(name: "ATests", dependencies: ["A"], resources: [.copy("Fixtures/x.json")])`));
  assert.deepEqual(parsed.map((t) => t.name), ['A', 'B', 'ATests']);
  assert.equal(parsed[1].path, 'Sources/X/B');
  assert.deepEqual(parsed[1].dependencies, ['C', 'd', 'E']);
  for (const bad of [
    wrap('.target(name: "A", dependencies: ["B"] + [paid])'),
    wrap('.target(name: "A", dependencies: deps)'),
    wrap('.target(name: "A", dependencies: [paid])'),
    wrap('.testTarget(name: "T", path: testPath)'),
    wrap('.target(name: "A", dependencies: [.target(name: "B", condition: .when(platforms: [.macOS]))])'),
    wrap('.target(name: "A", exclude: ["x.swift"])'),
    wrap('.target(name: "A")', 'let paid: Target.Dependency = "ParticipantDeskControls"\n'),
    `${wrap('.target(name: "A")')}\npackage.targets.append(.target(name: "B"))`,
    'import PackageDescription\nlet package = Package(name: "P", targets: allTargets)',
    wrap('.plugin(name: "P", capability: .buildTool())'),
  ]) {
    assert.throws(() => parseTargets(bad), undefined, bad);
  }
});
