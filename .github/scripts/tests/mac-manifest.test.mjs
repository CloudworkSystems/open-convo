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

/**
 * The manifest with its comments removed exactly as Swift reads them: a line
 * comment runs to the end of its line (a "/*" inside it is just text), block
 * comments nest, and strings are kept whole. Anything this can't read the way
 * Swift does (a multi-line or raw string, an unclosed comment or string)
 * throws, so the checks below always see the text Swift compiles.
 */
export function stripComments(text) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      let depth = 0;
      do {
        if (text.startsWith('/*', i)) { depth += 1; i += 2; }
        else if (text.startsWith('*/', i)) { depth -= 1; i += 2; }
        else if (i >= text.length) throw new Error('unclosed block comment in Package.swift');
        else i += 1;
      } while (depth > 0);
      out += ' ';
    } else if (text[i] === '"') {
      if (text.startsWith('"""', i)) throw new Error('multi-line strings are not allowed in Package.swift');
      if (text[i - 1] === '#') throw new Error('raw strings are not allowed in Package.swift');
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j += 1) {
        if (text[j] === '\n') throw new Error('unclosed string in Package.swift');
        if (text[j] === '\\') j += 1;
      }
      if (j >= text.length) throw new Error('unclosed string in Package.swift');
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

const code = stripComments(raw);

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

/** The package's products as "kind name -> targets", read as strictly as the targets. */
export function parseProducts(text) {
  const body = text.trim();
  const head = body.match(/^(?:import PackageDescription\s+)?let package = Package\s*\(/);
  if (!head) throw new Error('Package.swift must be one `let package = Package(...)` and nothing else');
  const args = Object.fromEntries(elements(body, head[0].length - 1).map(labeled));
  if (!args.products) return [];
  return arrayItems(args.products, 'products').map((entry) => {
    const m = entry.match(/^\.(executable|library)\(/);
    if (!m || closing(entry, m[0].length - 1) !== entry.length) throw new Error(`unexpected product entry: ${entry.slice(0, 60)}`);
    let name;
    let list;
    for (const [label, value] of elements(entry, m[0].length - 1).map(labeled)) {
      if (label === 'name') name = strValue(value, 'product name');
      else if (label === 'targets') list = arrayItems(value, 'product targets').map((v) => strValue(v, 'product target'));
      else throw new Error(`unexpected product argument ${label}:`);
    }
    return `${m[1]} ${name} -> ${(list ?? []).join(', ')}`;
  });
}

const targets = parseTargets(code);
const products = parseProducts(code);
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

test('the products are the approved ones, each built from its own target', () => {
  // The packaging script copies the VoiceCursorMac product's binary into the
  // app, so which target a product builds is pinned too. A new product needs
  // the owner (this file is protected).
  assert.deepEqual(products, [
    'executable VoiceCursorMac -> VoiceCursorMac',
    'executable VoiceCursorPolicyCheck -> VoiceCursorPolicyCheck',
    'executable ParticipantSupervisor -> ParticipantSupervisor',
    'executable DeskBundleManifest -> DeskBundleManifest',
  ]);
});

test('every target builds from its own folder, and the moved ones are pinned', () => {
  // A target without a path builds from Sources/<name> (Tests/<name> for a
  // suite), so the app can't be swapped for another program by name alone.
  // The few targets that live elsewhere are pinned here; a new one, or a
  // changed path, needs the owner (this file is protected).
  const moved = {
    ProtectionProofHost: 'Sources/ParticipantTestFakes/ProtectionProofHost',
    ParticipantSupervisorCore: 'Sources/ParticipantSupervisor/Core',
    ParticipantSupervisor: 'Sources/ParticipantSupervisor/Main',
    ParticipantFakeCLI: 'Sources/ParticipantTestFakes/FakeCLI',
    ParticipantTestHost: 'Sources/ParticipantTestFakes/TestHost',
    ParticipantPausingSupervisor: 'Sources/ParticipantTestFakes/PausingSupervisor',
    LocalConversationProofHost: 'Tests/LocalConversationProofHost',
    ClaudeConversationProofHost: 'Tests/ClaudeConversationProofHost',
    ParticipantAvailabilityProbe: 'Sources/ParticipantTestFakes/AvailabilityProbe',
  };
  const explicit = Object.fromEntries(targets.filter((t) => t.path !== null).map((t) => [t.name, t.path]));
  assert.deepEqual(explicit, moved);
  const names = targets.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'two targets share a name');
});

test('every program links exactly the participant-path modules the owner approved', () => {
  // Step 3 PR 4b: the app reaches the local route in True Convo Test only,
  // through ParticipantAppWiring, and ParticipantDeskControls stays unlinked.
  // The supervisor ships inside the app too, so every product is walked.
  const approved = {
    VoiceCursorMac: ['LocalModelRoute', 'ParticipantAppWiring', 'ParticipantCoordinator', 'ParticipantProcess', 'ParticipantSupervisorCore'],
    VoiceCursorPolicyCheck: [],
    ParticipantSupervisor: ['ParticipantSupervisor', 'ParticipantSupervisorCore'],
    DeskBundleManifest: [],
  };
  for (const [product, expected] of Object.entries(approved)) {
    assert.ok(byName.has(product), `the ${product} target is missing`);
    assert.deepEqual([...linkedBy(product)].filter(isParticipantPath).sort(), expected, product);
  }
});

test('every folder under Tests/ is a test target, so every test runs', () => {
  const folderOf = (t) => t.path ?? (t.kind === 'testTarget' ? `Tests/${t.name}` : `Sources/${t.name}`);
  const tested = new Set(targets.filter((t) => t.kind === 'testTarget').map(folderOf));
  // The kill-mid-reply proofs' apps live under Tests/ but are programs a test
  // runs, not suites (step 3 PR 5, and the Claude Code adapter's 4-proof).
  // Any other exception needs the owner.
  const programs = new Map([
    ['Tests/LocalConversationProofHost', 'LocalConversationProofHost'],
    ['Tests/ClaudeConversationProofHost', 'ClaudeConversationProofHost'],
  ]);
  const folders = readdirSync(join(mac, 'Tests'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `Tests/${d.name}`);
  assert.ok(folders.length > 0);
  for (const folder of folders) {
    if (programs.has(folder)) {
      const owner = byName.get(programs.get(folder));
      assert.ok(owner?.kind === 'executableTarget' && owner.path === folder, `${folder} must stay the ${programs.get(folder)} program`);
    } else {
      assert.ok(tested.has(folder), `${folder} is not built by a test target in Package.swift, so swift test won't run it`);
    }
  }
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
  // Comments are removed the way Swift reads them, never hiding code.
  assert.equal(stripComments('a // x /* y\nb */ c'), 'a \nb */ c');
  assert.equal(stripComments('a /* x /* y */ z */ b'), 'a   b');
  assert.equal(stripComments('"//not a comment" x'), '"//not a comment" x');
  for (const bad of ['a /* never closed', '"""\nx\n"""', '#"raw"#', '"unclosed\n"']) {
    assert.throws(() => stripComments(bad), undefined, bad);
  }
  const hidden = wrap('.target(name: "A", dependencies: ["B", // /*\n "ParticipantDeskControls"])');
  assert.deepEqual(parseTargets(stripComments(hidden))[0].dependencies, ['B', 'ParticipantDeskControls']);
  const withProducts = (p) => `import PackageDescription\nlet package = Package(name: "P", products: [${p}], targets: [])`;
  assert.deepEqual(parseProducts(withProducts('.executable(name: "App", targets: ["Other"])')), ['executable App -> Other']);
  for (const bad of ['.executable(name: "App", targets: appTargets)', '.executable(name: appName, targets: ["App"])', '.plugin(name: "P", targets: ["P"])']) {
    assert.throws(() => parseProducts(withProducts(bad)), undefined, bad);
  }
});
