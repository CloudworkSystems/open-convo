import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeCharacterCodes,
  hostsIn, readHosts, isReservedHost, secretNamesIn, addedLines, npmTarget, npmLockEntries, swiftDependencies, swiftPins,
  parsePlist, permissionChanges, parseAllowlist, scanFile, scanChanges, fingerprint, holdCommentBody,
  findHoldComment, commentFingerprint, ownerReleased, cachedScan, scanStatusDescription, applyRiskHold, withRiskHold,
  RISK_LABEL, HOLD_REASON, SCAN_CONTEXT,
} from '../risk-check.mjs';
import { withOwnerOpenedHold } from '../codeowners.mjs';
import { SYSTEM } from '../codex-triage.mjs';

// Every host, package and name below is invented.
const HEAD = 'c0ffee1234'.padEnd(40, 'c');
const empty = parseAllowlist('{}');
const allow = (data) => parseAllowlist(JSON.stringify(data));
const scan = (path, before, after, list = empty) => scanFile({ path, before, after, allow: list });
const signals = (hits) => hits.map((h) => `${h.signal}:${h.detail}`);

// ------------------------------------------------------------ hosts

test('hosts: URLs of every scheme are read, without user, port or case', () => {
  assert.deepEqual(hostsIn('fetch("https://User@Data.Invented-Tracker.dev:8443/x"); ws = "wss://feed.invented-tracker.dev"'), ['data.invented-tracker.dev', 'feed.invented-tracker.dev']);
  assert.deepEqual(hostsIn('const u = `https://${host}/v1`'), []);
  assert.deepEqual(hostsIn('fetch("https://[2001:DB8::1]/x"); new WebSocket("wss://[2606:4700::1111]:8443/feed")'), ['[2001:db8::1]', '[2606:4700::1111]']);
  assert.deepEqual(signals(scan('src/a.js', '', 'fetch("http://[2001:db8::1]:80/")\n')), ['host:new outside host `[2001:db8::1]`']);
  assert.deepEqual(hostsIn('see [https://Docs.Invented-Tracker.dev] here'), ['docs.invented-tracker.dev']);
});

test('hosts: odd spellings are read the way fetch reads them', () => {
  assert.deepEqual(hostsIn('fetch("https://collector\u3002invented-tracker.dev/x")'), ['collector.invented-tracker.dev']);
  assert.deepEqual(hostsIn('fetch("https://%63ollector.invented-tracker.dev/x")'), ['collector.invented-tracker.dev']);
  assert.deepEqual(hostsIn('fetch("https://\u0435xample.com/x")'), ['xn--xample-2of.com']);
  assert.deepEqual(signals(scan('src/a.js', '', 'fetch("https://\u0435xample.com/x")\n')), ['host:new outside host `xn--xample-2of.com`']);
});

test('hosts: a URL whose host cannot be read is a hit, not skipped', () => {
  assert.deepEqual(readHosts('fetch("https://bad%host.invented-tracker.dev/")').unreadable.length, 1);
  // JSON-escaped slashes are read too, and an escape after the host still fails closed.
  assert.deepEqual(readHosts('{"url": "https:\\/\\/collector.invented-tracker.dev\\/v1"}').hosts, ['collector.invented-tracker.dev']);
  assert.equal(readHosts('"https://github.com\\/@collector.invented-tracker.dev"').unreadable.length, 1);
  // Sentence punctuation after a URL in prose isn't part of the host.
  assert.deepEqual(readHosts('// See https://github.com! Or https://github.com.'), { hosts: ['github.com', 'github.com'], unreadable: [] });
  assert.equal(readHosts('https://github.com!collector.invented-tracker.dev/').unreadable.length, 1);
  // ...but only where the URL ends: here the punctuation is still in the host.
  for (const line of ['https://github.com!/path', 'https://github.com.!?q=1', 'https://github.com,#top', 'https://github.com;x/']) {
    assert.equal(readHosts(line).hosts.length, 0, line);
    assert.equal(readHosts(line).unreadable.length, 1, line);
  }
  for (const line of ['https://github.com!]@collector.invented-tracker.dev/path', '"https://github.com"@collector.invented-tracker.dev', 'https://github.com)x@collector.invented-tracker.dev?q']) {
    assert.deepEqual(readHosts(line).hosts, [], line);
    assert.equal(readHosts(line).unreadable.length, 1, line);
  }
  assert.deepEqual(readHosts('https://github.com) or mail@invented.example'), { hosts: ['github.com'], unreadable: [] });
  // The URL parser drops tabs and carriage returns, so they don't end the host.
  assert.equal(readHosts('https://github.com!\t@collector.invented-tracker.dev/path').unreadable.length, 1);
  assert.equal(readHosts('https://github.com!\r@collector.invented-tracker.dev/path').unreadable.length, 1);
  assert.deepEqual(readHosts('https://github.com\t.collector.invented-tracker.dev/path').hosts, ['github.com.collector.invented-tracker.dev']);
  assert.deepEqual(readHosts('("https://github.com.") and https://github.com, then https://github.com;'), { hosts: ['github.com', 'github.com', 'github.com'], unreadable: [] });
  assert.deepEqual(scan('src/a.js', '', 'fetch("https://bad%host.invented-tracker.dev/")\n').map((h) => h.signal), ['host']);
  const list = allow({ hosts: ['github.com'] });
  assert.deepEqual(scan('src/a.js', '', 'fetch("https://github.com\\@collector.invented-tracker.dev/")\n', list).map((h) => h.detail), ["couldn't read the host in `https://github.com`", 'new outside host `collector.invented-tracker.dev`']);
  // Regex literals escape the dots too; the host still reads.
  assert.deepEqual(readHosts('assert.match(html, /href="https:\\/\\/collector\\.invented-tracker\\.dev\\/">/);').hosts, ['collector.invented-tracker.dev']);
  assert.deepEqual(scan('src/a.js', '', 'fetch("https://github.com\\x40collector.invented-tracker.dev/")\n', list).map((h) => h.detail), ["couldn't read the host in `https://github.com`", 'new outside host `collector.invented-tracker.dev`']);
  // Slashes and other characters written as codes still read as the URL they spell.
  for (const line of [
    'fetch("https:\\x2f\\x2fcollector.invented-tracker.dev/a")',
    'fetch("https:\\u002F\\u002Fcollector.invented-tracker.dev")',
    'let u = "https:\\u{2f}\\u{2f}collector.invented-tracker.dev"',
    '<a href="https:&#47;&#47;collector.invented-tracker.dev/">',
    '<a href="https:&#x2F;&#x2f;collector.invented-tracker.dev/">',
    '<a href="https&colon;&sol;&sol;collector&period;invented-tracker&period;dev/">',
    '<a href="https:&amp;#47;&amp;#47;collector.invented-tracker.dev/">',
    'let u = "https:\\u{0000002f}\\u{0000002F}collector.invented-tracker.dev"',
    '<a href="https:&#x000000002f;&#0000000047;collector.invented-tracker.dev/">',
  ]) {
    assert.deepEqual(scan('src/a.js', '', `${line}\n`, list).map((h) => h.detail), ['new outside host `collector.invented-tracker.dev`'], line);
  }
  assert.deepEqual(scan('src/a.js', '', 'fetch("https://github.com\\u0040collector.invented-tracker.dev/")\n', list).map((h) => h.detail), ["couldn't read the host in `https://github.com`", 'new outside host `collector.invented-tracker.dev`']);
  // A code for a non-ASCII letter the URL parser folds to ASCII still reads as that host.
  for (const line of [
    'fetch("https://\\uFF45vil.invented-tracker.dev")',
    'fetch("https://\\u24D4vil.invented-tracker.dev")',
    'fetch("https://\\uD835\\uDC1Evil.invented-tracker.dev")',
    '<a href="https://&#65349;vil.invented-tracker.dev">',
  ]) {
    assert.deepEqual(readHosts(line).hosts, ['evil.invented-tracker.dev'], line);
  }
  // A code still left as written where the host starts can't be read.
  assert.deepEqual(readHosts('fetch("https://\\u0000evil.invented-tracker.dev")').unreadable.length, 1);
  assert.deepEqual(readHosts('<a href="https://&bogus;evil.invented-tracker.dev">').unreadable.length > 0, true);
  // Deep nesting stops after a fixed number of passes and fails closed.
  const nested = `https:&${'amp;'.repeat(40)}#47;//evil.invented-tracker.dev`;
  assert.ok(readHosts(nested).unreadable.length >= 1);
  assert.doesNotThrow(() => readHosts(`https:&${'amp;'.repeat(20000)}#47;`));
  // A code for a control character or a lone surrogate is left as written.
  assert.equal(decodeCharacterCodes('a\\x00b &#127; &nbsp; \\uD800 \\u{110000}'), 'a\\x00b &#127; &nbsp; \\uD800 \\u{110000}');
  assert.deepEqual(scan('Sources/A.swift', '', 'URL(string: "http://127.0.0.1:\\(port)")\n'), []);
});

test('hosts: invented names and their subdomains never count', () => {
  for (const host of ['example.com', 'api.example.com', 'example.org', 'x.example.net', 'shop.example', 'a.invalid', 'b.test', 'localhost', 'app.localhost', '127.0.0.1']) {
    assert.equal(isReservedHost(host), true, host);
  }
  assert.equal(isReservedHost('example.com.invented-tracker.dev'), false);
  assert.equal(isReservedHost('notexample.com'), false);
});

test('hosts: a new host in code is a hit with its line, even in a comment', () => {
  const hits = scan('packages/demo/src/send.js', 'const a = 1;\n', 'const a = 1;\n// see https://collector.invented-tracker.dev/docs\n');
  assert.deepEqual(hits.map((h) => [h.signal, h.line, h.detail]), [['host', 2, 'new outside host `collector.invented-tracker.dev`']]);
});

test('hosts: docs, invented hosts and allowlisted hosts are not hits', () => {
  assert.deepEqual(scan('docs/notes.md', '', 'See https://collector.invented-tracker.dev\n'), []);
  assert.deepEqual(scan('src/a.js', '', 'fetch("https://api.example.com/x")\n'), []);
  assert.deepEqual(scan('src/a.js', '', 'fetch("https://collector.invented-tracker.dev")\n', allow({ hosts: ['collector.invented-tracker.dev'] })), []);
  assert.deepEqual(scan('src/a.js', '', 'fetch("https://eu.invented-cdn.dev")\n', allow({ hosts: ['*.invented-cdn.dev'] })), []);
});

test('hosts: a line that only moved is not added', () => {
  const before = 'a\nfetch("https://collector.invented-tracker.dev")\nb\n';
  const after = 'fetch("https://collector.invented-tracker.dev")\na\nb\n';
  assert.deepEqual(addedLines(before, after), []);
  assert.deepEqual(scan('src/a.js', before, after), []);
  assert.deepEqual(addedLines('x\n', 'x\nx\n').map((l) => l.line), [2]);
});

// ------------------------------------------------------------ key names

test('key names: a new _API_KEY, _TOKEN or _SECRET name is a hit outside .github/', () => {
  assert.deepEqual(secretNamesIn('process.env.INVENTED_API_KEY ?? env.DEMO_TOKEN; NOT_A_KEY'), ['INVENTED_API_KEY', 'DEMO_TOKEN']);
  assert.deepEqual(secretNamesIn('env.vendor_API_KEY || env.xInvented_TOKEN; const access_token = 1'), ['vendor_API_KEY', 'xInvented_TOKEN']);
  assert.deepEqual(signals(scan('packages/demo/src/model.js', '', 'const key = process.env.INVENTED_API_KEY;\n')), ['secret:names the key or secret `INVENTED_API_KEY`']);
  assert.deepEqual(scan('.github/workflows/demo.yml', '', 'INVENTED_API_KEY: ${{ secrets.INVENTED_API_KEY }}\n'), []);
  assert.deepEqual(scan('src/a.js', '', 'env.INVENTED_API_KEY\n', allow({ secrets: ['INVENTED_API_KEY'] })), []);
});

// ------------------------------------------------------------ npm

const pkg = (deps, extra = {}) => JSON.stringify({ name: 'demo', ...deps, ...extra }, null, 2);

test('npm: a new dependency in any section is a hit; a version bump is not', () => {
  const before = pkg({ dependencies: { 'left-pad-invented': '^1.0.0' } });
  assert.deepEqual(scan('packages/demo/package.json', before, pkg({ dependencies: { 'left-pad-invented': '^2.0.0' } })), []);
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const after = pkg({ dependencies: { 'left-pad-invented': '^1.0.0' }, [section]: { ...(section === 'dependencies' ? { 'left-pad-invented': '^1.0.0' } : {}), 'right-pad-invented': '1.0.0' } });
    assert.deepEqual(signals(scan('packages/demo/package.json', before, after)), ['dependency:new package `right-pad-invented`'], section);
  }
});

test('npm: moving a dependency between sections is not a hit', () => {
  const before = pkg({ dependencies: { 'left-pad-invented': '^1.0.0' } });
  assert.deepEqual(scan('package.json', before, pkg({ devDependencies: { 'left-pad-invented': '^1.0.0' } })), []);
});

test('npm: pointing an entry at another package or a git or tarball source is a hit', () => {
  const before = pkg({ dependencies: { 'left-pad-invented': '^1.0.0' } });
  for (const spec of ['npm:other-pad-invented@^1.0.0', 'git+https://git.invented-forge.dev/pad.git#v1', 'https://files.invented-forge.dev/pad-1.0.0.tgz', 'someone-invented/pad']) {
    const hits = scan('package.json', before, pkg({ dependencies: { 'left-pad-invented': spec } }));
    assert.equal(hits.filter((h) => h.signal === 'dependency').length, 1, spec);
  }
  assert.equal(npmTarget('a', 'npm:@scope-invented/b@2'), '@scope-invented/b');
  assert.equal(npmTarget('a', 'github:someone-invented/a#abc'), 'source:github:someone-invented/a');
  assert.equal(npmTarget('a', '>=1.0.0 <2'), 'a');
});

test('npm: a new git commit of the same source is like a version bump', () => {
  const at = (ref) => pkg({ dependencies: { pad: `github:someone-invented/pad#${ref}` } });
  assert.deepEqual(scan('package.json', at('aaa'), at('bbb')), []);
});

test('npm: overrides and resolutions that repoint a package are hits; a version pin is not', () => {
  const before = pkg({ dependencies: { 'left-pad-invented': '^1.0.0' } });
  const withKey = (key, value) => pkg({ dependencies: { 'left-pad-invented': '^1.0.0' } }, { [key]: value });
  assert.deepEqual(signals(scan('package.json', before, withKey('overrides', { 'left-pad-invented': 'github:someone-invented/pad' }))), ['dependency:`left-pad-invented` installs from `github:someone-invented/pad`']);
  assert.deepEqual(signals(scan('package.json', before, withKey('overrides', { 'parent-invented': { '.': '1', 'left-pad-invented': 'npm:other-pad-invented@1' } }))).sort(), ['dependency:`left-pad-invented` installs the package `other-pad-invented`', 'dependency:new package `parent-invented`']);
  assert.equal(scan('package.json', before, withKey('resolutions', { '**/left-pad-invented': 'git+ssh://git@git.invented-forge.dev/pad.git' })).filter((h) => h.signal === 'dependency').length, 1);
  assert.deepEqual(scan('package.json', before, withKey('overrides', { 'left-pad-invented': '1.0.5' })), []);
  assert.equal(scan('package.json', before, withKey('resolutions', { 'parent-invented/@scope-invented/pad@1': 'npm:other-pad-invented@1' })).length, 1);
  // Built to finish quickly on keys meant to slow a regular expression down.
  const started = Date.now();
  scan('package.json', before, withKey('overrides', { [`@./${'.../@./'.repeat(5000)}x`]: '1' }));
  assert.ok(Date.now() - started < 1000);
});

test('npm: bundleDependencies and bundledDependencies are lists of names', () => {
  const before = pkg({ dependencies: { a: '1' } }, { bundleDependencies: ['a'] });
  const after = pkg({ dependencies: { a: '1' } }, { bundleDependencies: ['a'], bundledDependencies: ['bundled-invented'] });
  assert.deepEqual(signals(scan('package.json', before, after)), ['dependency:new bundled package `bundled-invented`']);
});

test('npm: an allowlisted package is not a hit, and allows aliases to it', () => {
  const list = allow({ dependencies: ['npm:right-pad-invented'] });
  assert.deepEqual(scan('package.json', pkg({}), pkg({ dependencies: { 'right-pad-invented': '1' } }), list), []);
  assert.deepEqual(scan('package.json', pkg({}), pkg({ dependencies: { rp: 'npm:right-pad-invented@1' } }), list), []);
});

const lock = (packages) => JSON.stringify({ name: 'demo', lockfileVersion: 3, packages: { '': { name: 'demo' }, ...packages } });
const reg = (name, v) => ({ version: v, resolved: `https://registry.npmjs.org/${name}/-/${name}-${v}.tgz` });

test('npm lockfile: a new indirect package is a hit; a version bump is not', () => {
  const before = lock({ 'node_modules/a-invented': reg('a-invented', '1.0.0') });
  assert.deepEqual(scan('apps/demo/package-lock.json', before, lock({ 'node_modules/a-invented': reg('a-invented', '1.1.0') })), []);
  const after = lock({ 'node_modules/a-invented': reg('a-invented', '1.0.0'), 'node_modules/a-invented/node_modules/@deep-invented/b': reg('b', '1.0.0') });
  assert.deepEqual(signals(scan('apps/demo/package-lock.json', before, after)), ['dependency:new package `@deep-invented/b`']);
});

test('npm lockfile: an alias counts by its real name, and a new source is a hit', () => {
  assert.deepEqual(npmLockEntries(JSON.parse(lock({ 'node_modules/x': { name: 'real-invented', version: '1.0.0' } }))).map((e) => e.name), ['real-invented']);
  const before = lock({ 'node_modules/a-invented': reg('a-invented', '1.0.0') });
  const after = lock({ 'node_modules/a-invented': { version: '1.0.0', resolved: 'https://files.invented-forge.dev/a.tgz' } });
  assert.deepEqual(signals(scan('package-lock.json', before, after)), ['dependency:`a-invented` installs from `https://files.invented-forge.dev/a.tgz`']);
});

test('npm lockfile: registry URLs in it are not host hits', () => {
  const after = lock({ 'node_modules/a-invented': reg('a-invented', '1.0.0') });
  assert.deepEqual(scan('package-lock.json', lock({}), after, allow({ dependencies: ['npm:a-invented'] })), []);
});

test('npm lockfile: version 1 lockfiles are read too', () => {
  const v1 = JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { 'nested-invented': { version: '2.0.0' } } } } });
  assert.deepEqual(npmLockEntries(JSON.parse(v1)).map((e) => e.name), ['a', 'nested-invented']);
});

test('npm lockfile: hits are grouped per lockfile in the comment', () => {
  const after = lock({ 'node_modules/one-invented': reg('one', '1'), 'node_modules/two-invented': reg('two', '1') });
  const body = holdCommentBody({ hits: scan('apps/demo/package-lock.json', lock({}), after), headSha: HEAD, prAuthor: 'cloudwork-bot' });
  assert.match(body, /`apps\/demo\/package-lock.json`: 2 new or moved package\(s\): `one-invented`, `two-invented`/);
});

test('other lockfiles fail closed', () => {
  assert.deepEqual(scan('yarn.lock', 'a', 'b').map((h) => h.signal), ['unreadable']);
  assert.deepEqual(scan('pnpm-lock.yaml', 'a', 'a'), []);
});

test('an unparseable manifest is a hit', () => {
  assert.deepEqual(scan('package.json', pkg({}), '{ broken').map((h) => h.signal), ['unreadable']);
});

// ------------------------------------------------------------ Swift

const swift = (deps, targets = '') => `// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "Demo",
    dependencies: [${deps}],
    targets: [${targets}]
)`;

test('Swift: a new package is a hit; a new version of the same one is not', () => {
  const old = swift('.package(url: "https://git.invented-forge.dev/kit.git", from: "1.0.0")');
  assert.deepEqual(scan('apps/demo/Package.swift', old, swift('.package(url: "https://git.invented-forge.dev/kit", from: "2.0.0")'), allow({ hosts: ['git.invented-forge.dev'] })), []);
  const added = swift('.package(url: "https://git.invented-forge.dev/kit.git", from: "1.0.0"),\n.package(\n  url: "https://git.invented-forge.dev/other.git",\n  exact: "1.0.0"\n)');
  assert.deepEqual(signals(scan('apps/demo/Package.swift', old, added, allow({ hosts: ['git.invented-forge.dev'] }))), ['dependency:new Swift package `https://git.invented-forge.dev/other`']);
});

test('Swift: a URL that differs only in path case is a different package', () => {
  const at = (url) => swift(`.package(url: "${url}", from: "1.0.0")`);
  const list = allow({ hosts: ['git.invented-forge.dev'] });
  assert.deepEqual(scan('Package.swift', at('https://git.invented-forge.dev/Team/Kit.git'), at('https://GIT.Invented-Forge.dev/Team/Kit'), list), []);
  assert.deepEqual(signals(scan('Package.swift', at('https://git.invented-forge.dev/Team/Kit.git'), at('https://git.invented-forge.dev/team/kit.git'), list)), ['dependency:new Swift package `https://git.invented-forge.dev/team/kit`']);
});

test('Swift: uncommenting a package is a new package; URLs inside strings survive', () => {
  const list = allow({ hosts: ['git.invented-forge.dev'] });
  const pkgLine = '.package(url: "https://git.invented-forge.dev/kit.git", from: "1.0.0")';
  for (const commented of [`// ${pkgLine}`, `/* ${pkgLine} */`, `/* outer /* inner */ ${pkgLine} */`]) {
    assert.deepEqual(signals(scan('Package.swift', swift(commented), swift(pkgLine), list)), ['dependency:new Swift package `https://git.invented-forge.dev/kit`'], commented);
  }
  assert.deepEqual([...swiftDependencies(swift(`${pkgLine} // trailing note`))], ['swift:https://git.invented-forge.dev/kit']);
});

test('Swift: a string that fools the comment stripper cannot hide a new package', () => {
  const list = allow({ hosts: ['git.invented-forge.dev'] });
  const added = '.package(url: "https://git.invented-forge.dev/evil-invented", from: "1.0.0")';
  const withOpener = (opener, deps) => `${opener}\n${swift(deps)}\nlet z = "*/"`;
  for (const opener of ['let a = #" "/*" "#', 'let s = """\n/*\n"""', 'let b = #"\\"#; let c = "/*"']) {
    assert.deepEqual(signals(scan('Package.swift', withOpener(opener, ''), withOpener(opener, added), list)), ['dependency:new Swift package `https://git.invented-forge.dev/evil-invented`'], opener);
  }
  // Commenting a package out is not a hit.
  assert.deepEqual(scan('Package.swift', swift(added), swift(`// ${added}`), list), []);
});

test('Swift: a remote binary target is a dependency; a local one is not', () => {
  assert.deepEqual([...swiftDependencies(swift('', '.binaryTarget(name: "Blob", url: "https://files.invented-forge.dev/b.zip", checksum: "00")'))], ['swift-binary:https://files.invented-forge.dev/b.zip']);
  assert.deepEqual([...swiftDependencies(swift('', '.binaryTarget(name: "Blob", path: "Blob.xcframework")'))], []);
  // A raw-string URL is read; one written any other way holds the whole call.
  assert.deepEqual([...swiftDependencies(swift('', '.binaryTarget(name: "Blob", url: #"https://files.invented-forge.dev/b.zip"#, checksum: "00")'))], ['swift-binary:https://files.invented-forge.dev/b.zip']);
  assert.match([...swiftDependencies(swift('', '.binaryTarget(name: "Blob", url: blobURL, checksum: "00")'))][0], /^swift-binary:.*blobURL/);
  assert.match([...swiftDependencies(swift('.package(url: kitURL, from: "1.0.0")'))][0], /^swift-other:.*kitURL/);
  assert.deepEqual([...swiftDependencies(swift('.package(url : "https://git.invented-forge.dev/kit", from: "1.0.0")'))], ['swift:https://git.invented-forge.dev/kit']);
  // Swift allows whitespace, newlines included, around the dot and before the `(`.
  assert.deepEqual([...swiftDependencies(swift('.package (url: "https://git.invented-forge.dev/kit", from: "1.0.0")'))], ['swift:https://git.invented-forge.dev/kit']);
  assert.deepEqual([...swiftDependencies(swift('.package\n      (url: "https://git.invented-forge.dev/kit", from: "1.0.0")'))], ['swift:https://git.invented-forge.dev/kit']);
  assert.deepEqual([...swiftDependencies(swift('', '.\n  binaryTarget (name: "Blob", url: "https://files.invented-forge.dev/b.zip", checksum: "00")'))], ['swift-binary:https://files.invented-forge.dev/b.zip']);
});

test('Swift: a new pin in Package.resolved is a hit, in either format', () => {
  const v2 = (pins) => JSON.stringify({ version: 2, pins: pins.map((p) => ({ identity: p, kind: 'remoteSourceControl', location: `https://git.invented-forge.dev/${p}.git` })) });
  assert.deepEqual(signals(scan('Package.resolved', v2(['kit']), v2(['kit', 'other']))), ['dependency:new Swift package `https://git.invented-forge.dev/other`']);
  const v1 = JSON.stringify({ object: { pins: [{ package: 'Kit', repositoryURL: 'https://git.invented-forge.dev/kit.git' }] }, version: 1 });
  assert.deepEqual([...swiftPins(JSON.parse(v1))], ['swift:https://git.invented-forge.dev/kit']);
});

// ------------------------------------------------------------ permissions

const plist = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${body}
</dict>
</plist>
`;
const sandboxed = plist('<key>com.apple.security.app-sandbox</key>\n<true/>\n<key>com.apple.security.device.audio-input</key>\n<false/>');
const noDtd = allow({ hosts: ['www.apple.com'] });
const perms = (path, before, after) => scan(path, before, after, noDtd).map((h) => h.detail);

test('plists: parsed into values', () => {
  assert.deepEqual(parsePlist(plist('<key>a</key><string>x &amp; y</string><key>b</key><array><integer>2</integer><true/></array><key>c</key><dict/>')), { a: 'x & y', b: [2, true], c: {} });
  assert.deepEqual(parsePlist(plist('<!-- a <key>hidden</key> note --><key>a</key><true/>')), { a: true });
  assert.throws(() => parsePlist('bplist00...'));
  assert.throws(() => parsePlist('<plist><dict><key>a</key></dict></plist>'));
});

test('entitlements: a new key, a value turned on and a new list entry are hits', () => {
  assert.deepEqual(perms('apps/demo/Demo.entitlements', sandboxed, sandboxed.replace('</dict>', '<key>com.apple.security.network.client</key>\n<true/>\n</dict>')), ['new key `com.apple.security.network.client`']);
  assert.deepEqual(perms('Demo.entitlements', sandboxed, sandboxed.replace('<false/>', '<true/>')), ['`com.apple.security.device.audio-input` turned on']);
  const groups = (list) => plist(`<key>com.apple.security.application-groups</key>\n<array>${list.map((g) => `<string>${g}</string>`).join('')}</array>`);
  assert.deepEqual(perms('Demo.entitlements', groups(['group.invented.one']), groups(['group.invented.one', 'group.invented.two'])), ['new entry "group.invented.two" in `com.apple.security.application-groups`']);
});

test('entitlements: turning something off is not a hit, except the App Sandbox', () => {
  assert.deepEqual(perms('Demo.entitlements', sandboxed.replace('<false/>', '<true/>'), sandboxed), []);
  assert.deepEqual(perms('Demo.entitlements', sandboxed, sandboxed.replace('<true/>', '<false/>')), ['App Sandbox turned off or removed']);
  assert.deepEqual(perms('Demo.entitlements', sandboxed, plist('')), ['App Sandbox turned off or removed']);
});

test('entitlements: a deleted file reads as empty, so losing the sandbox is a hit', () => {
  assert.deepEqual(perms('Demo.entitlements', sandboxed, ''), ['App Sandbox turned off or removed']);
});

test('entitlements: a new key that is off is not a hit', () => {
  assert.deepEqual(perms('Demo.entitlements', sandboxed, sandboxed.replace('</dict>', '<key>com.apple.security.files.downloads.read-write</key><false/></dict>')), []);
});

test('Info.plist: a new privacy prompt, network exception or URL scheme is a hit; other keys are not', () => {
  const info = plist('<key>CFBundleName</key><string>Demo</string><key>NSMicrophoneUsageDescription</key><string>Records your speech.</string>');
  assert.deepEqual(perms('apps/demo/Info.plist', info, info.replace('Records your speech.', 'Records speech on this Mac.')), []);
  assert.deepEqual(perms('apps/demo/Info.plist', info, info.replace('<string>Demo</string>', '<string>Demo 2</string>')), []);
  assert.deepEqual(perms('Info.plist', info, info.replace('</dict>\n</plist>', '<key>NSCameraUsageDescription</key><string>Sees you.</string>\n</dict>\n</plist>')), ['new key `NSCameraUsageDescription`']);
  const ats = info.replace('</dict>\n</plist>', '<key>NSAppTransportSecurity</key><dict><key>NSAllowsArbitraryLoads</key><true/></dict>\n</dict>\n</plist>');
  assert.deepEqual(perms('Info.plist', info, ats), ['new key `NSAppTransportSecurity`', 'new key `NSAppTransportSecurity › NSAllowsArbitraryLoads`']);
  const scheme = info.replace('</dict>\n</plist>', '<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>demo-invented</string></array></dict></array>\n</dict>\n</plist>');
  assert.equal(perms('Info.plist', info, scheme).length, 2);
});

test('a binary or malformed plist fails closed', () => {
  assert.deepEqual(scan('Info.plist', plist(''), 'bplist00\u0000\u0001').map((h) => h.signal), ['unreadable']);
});

test('permissionChanges compares only what is passed', () => {
  assert.deepEqual(permissionChanges({}, { 'com.apple.security.network.server': true }, { entitlements: true }), ['new key `com.apple.security.network.server`']);
});

// ------------------------------------------------------------ fail closed

test('a file that could not be read is a hit; a binary file is skipped', () => {
  assert.deepEqual(scan('packages/demo/big.js', '', '', empty).length, 0);
  assert.deepEqual(scanFile({ path: 'packages/demo/big.js', error: 'at the head: too large to read', allow: empty }).map((h) => h.signal), ['unreadable']);
  assert.deepEqual(scanFile({ path: 'brand/logo.png', error: 'too large to read', allow: empty }), []);
});

test('a cut-short file list is a hit', () => {
  assert.deepEqual(scanChanges({ files: [], complete: false, allow: empty }).map((h) => h.signal), ['unreadable']);
  assert.deepEqual(scanChanges({ files: [], complete: true, allow: empty }), []);
});

// ------------------------------------------------------------ comment and release

const hostHit = { signal: 'host', file: 'src/a.js', line: 3, detail: 'new outside host `collector.invented-tracker.dev`' };

test('the fingerprint ignores line numbers and order', () => {
  const other = { signal: 'secret', file: 'src/b.js', line: 1, detail: 'names the key or secret `INVENTED_API_KEY`' };
  assert.equal(fingerprint([hostHit, other]), fingerprint([other, { ...hostHit, line: 40 }]));
  assert.notEqual(fingerprint([hostHit]), fingerprint([hostHit, other]));
  assert.equal(fingerprint([]), 'none');
});

test('the hold comment lists hits and says how to clear it', () => {
  const body = holdCommentBody({ hits: [hostHit], headSha: HEAD, prAuthor: 'cloudwork-bot' });
  assert.match(body, /`src\/a.js:3`: new outside host/);
  assert.match(body, /risk-allowlist\.json/);
  assert.match(body, /next run \(hourly, or on the next comment\)/);
  assert.match(holdCommentBody({ hits: [hostHit], headSha: HEAD, prAuthor: 'CloudworkSystems' }), /Reopen the work from `cloudwork-bot`/);
});

const actions = { login: 'github-actions[bot]', type: 'Bot' };
const holdComment = (hits, at = '2026-10-29T10:00:00Z', extra = {}) => ({
  id: 7, user: actions, body: holdCommentBody({ hits, headSha: HEAD, prAuthor: 'cloudwork-bot' }), created_at: at, updated_at: at,
  edit_history: { lastEditedAt: null, editor: null, userContentEdits: { totalCount: 0, nodes: [] } }, ...extra,
});
const approval = (at, sha = HEAD, login = 'CloudworkSystems') => ({ user: { login }, state: 'APPROVED', commit_id: sha, submitted_at: at });

test('only the owner\'s approval of the head, after the comment last changed, releases', () => {
  const comment = holdComment([hostHit]);
  assert.equal(ownerReleased({ headSha: HEAD, prAuthor: 'cloudwork-bot', comment, reviews: [approval('2026-10-29T11:00:00Z')] }), true);
  assert.equal(ownerReleased({ headSha: HEAD, prAuthor: 'cloudwork-bot', comment, reviews: [approval('2026-10-29T09:00:00Z')] }), false);
  assert.equal(ownerReleased({ headSha: HEAD, prAuthor: 'cloudwork-bot', comment, reviews: [approval('2026-10-29T11:00:00Z', 'f'.repeat(40))] }), false);
  assert.equal(ownerReleased({ headSha: HEAD, prAuthor: 'cloudwork-bot', comment, reviews: [approval('2026-10-29T11:00:00Z', HEAD, 'cloudwork-bot')] }), false);
  assert.equal(ownerReleased({ headSha: HEAD, prAuthor: 'CloudworkSystems', comment, reviews: [approval('2026-10-29T11:00:00Z')] }), false);
});

test('a hold comment edited by anyone but the gate is not trusted', () => {
  const edited = holdComment([hostHit], undefined, { edit_history: { lastEditedAt: '2026-10-29T10:05:00Z', editor: { __typename: 'User', login: 'cloudwork-bot' }, userContentEdits: { totalCount: 1, nodes: [{ editor: { __typename: 'User', login: 'cloudwork-bot' } }] } } });
  assert.equal(commentFingerprint(holdComment([hostHit])), fingerprint([hostHit]));
  assert.equal(commentFingerprint(edited), null);
  assert.equal(findHoldComment([{ user: { login: 'cloudwork-bot' }, body: holdComment([hostHit]).body }]), null);
});

test('a rename that changes how a file is read counts its text as new', () => {
  const allow = { hosts: new Set(), dependencies: new Set(), secrets: new Set() };
  const deps = '{"dependencies":{"invented-lib":"1.0.0"}}';
  assert.equal(scanFile({ path: 'apps/x/package.json', previous: 'apps/x/deps.json', before: deps, after: deps, allow })[0].detail, 'new package `invented-lib`');
  const link = 'see https://collector.invented-tracker.dev\n';
  assert.equal(scanFile({ path: 'src/notes.js', previous: 'docs/notes.md', before: link, after: link, allow })[0].signal, 'host');
  assert.deepEqual(scanFile({ path: 'src/b.js', previous: 'src/a.js', before: link, after: link, allow }), []);
});

test('a recorded scan counts only from the gate and for the same allowlist', () => {
  const status = (login, allowTag = 'abcdefabcdef') => ({ context: SCAN_CONTEXT, creator: { login }, description: scanStatusDescription({ hits: 0, fp: 'none', allowTag }) });
  assert.deepEqual(cachedScan([status('github-actions[bot]')], 'abcdefabcdef'), { fp: 'none' });
  assert.equal(cachedScan([status('cloudwork-bot')], 'abcdefabcdef'), null);
  assert.equal(cachedScan([status('github-actions[bot]', '111111111111')], 'abcdefabcdef'), null);
  assert.ok(scanStatusDescription({ hits: 12, fp: 'abcdefabcdef', allowTag: 'none' }).length <= 140);
});

// ------------------------------------------------------------ applyRiskHold, with a pretend GitHub

function fakeGitHub({ files, statuses = [] }) {
  const calls = [];
  let commentAt = 0;
  const gh = {
    calls,
    async get(path) {
      calls.push(['GET', path]);
      if (path.includes('/statuses')) return statuses;
      if (path.includes('/compare/')) return { merge_base_commit: { sha: 'b'.repeat(40) } };
      const m = path.match(/\/contents\/(.+)\?ref=(.+)$/);
      if (m) {
        const file = files.find((f) => f.path === decodeURIComponent(m[1]));
        const text = m[2] === HEAD ? file.after : file.before;
        return { type: 'file', encoding: 'base64', size: text.length, content: Buffer.from(text).toString('base64'), sha: 'd'.repeat(40) };
      }
      throw new Error(`unexpected GET ${path}`);
    },
    async all(path) { calls.push(['ALL', path]); return files.map((f) => ({ filename: f.path, status: 'modified' })); },
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (path.endsWith('/comments')) { commentAt += 1; return { ...holdComment([]), body: body.body, updated_at: `2026-10-29T10:0${commentAt}:00Z` }; }
      if (path.includes('/statuses/')) statuses.unshift({ ...body, creator: { login: 'github-actions[bot]' } });
      return {};
    },
    async patch(path, body) { calls.push(['PATCH', path, body]); return { ...holdComment([]), body: body.body, updated_at: '2026-10-29T12:00:00Z' }; },
    async delete(path) { calls.push(['DELETE', path]); return null; },
  };
  return gh;
}

const pr = (labels = []) => ({ number: 5, changed_files: 1, user: { login: 'cloudwork-bot' }, head: { sha: HEAD }, base: { sha: 'a'.repeat(40) }, labels: labels.map((name) => ({ name })) });
const list = { allow: empty, allowTag: 'abcdefabcdef' };
const risky = [{ path: 'src/a.js', before: 'x\n', after: 'x\nfetch("https://collector.invented-tracker.dev")\n' }];

test('hold: the first run posts one comment, the label and the scan record, and holds', async () => {
  const gh = fakeGitHub({ files: risky });
  const held = await applyRiskHold({ gh, repoBase: '/r', pr: pr(), comments: [], reviews: [], allowlist: list });
  assert.equal(held, HOLD_REASON);
  const posts = gh.calls.filter((c) => c[0] === 'POST').map((c) => c[1]);
  assert.deepEqual(posts, ['/r/issues/5/comments', '/r/statuses/' + HEAD, '/r/issues/5/labels']);
  assert.deepEqual(gh.calls.find((c) => c[1] === '/r/issues/5/labels')[2], { labels: [RISK_LABEL] });
});

test('hold: the same hits again leave the comment alone, so an approval after it releases', async () => {
  const gh = fakeGitHub({ files: risky });
  await applyRiskHold({ gh, repoBase: '/r', pr: pr(), comments: [], reviews: [], allowlist: list });
  const posted = gh.calls.find((c) => c[1] === '/r/issues/5/comments')[2].body;
  const comment = { ...holdComment([]), body: posted, updated_at: '2026-10-29T10:01:00Z' };
  gh.calls.length = 0;
  const held = await applyRiskHold({ gh, repoBase: '/r', pr: pr([RISK_LABEL]), comments: [comment], reviews: [approval('2026-10-29T11:00:00Z')], allowlist: list });
  assert.equal(held, null);
  // Recorded scan reused: no file is fetched, no comment edited, the label comes off.
  assert.equal(gh.calls.some((c) => c[1].includes('/contents/') || c[0] === 'PATCH'), false);
  assert.deepEqual(gh.calls.filter((c) => c[0] === 'DELETE').map((c) => c[1]), [`/r/issues/5/labels/${encodeURIComponent(RISK_LABEL)}`]);
});

test('hold: an approval from before the comment changed does not release', async () => {
  const gh = fakeGitHub({ files: risky });
  const old = holdComment([{ ...hostHit, detail: 'new outside host `older.invented-tracker.dev`' }], '2026-10-29T08:00:00Z');
  const held = await applyRiskHold({ gh, repoBase: '/r', pr: pr([RISK_LABEL]), comments: [old], reviews: [approval('2026-10-29T09:00:00Z')], allowlist: list });
  assert.equal(held, HOLD_REASON);
  assert.equal(gh.calls.filter((c) => c[0] === 'PATCH').length, 1);
});

test('hold: a commit that removes every hit lifts it and says so in the same comment', async () => {
  const gh = fakeGitHub({ files: [{ path: 'src/a.js', before: 'x\n', after: 'y\n' }] });
  const held = await applyRiskHold({ gh, repoBase: '/r', pr: pr([RISK_LABEL]), comments: [holdComment([hostHit])], reviews: [], allowlist: list });
  assert.equal(held, null);
  const patch = gh.calls.find((c) => c[0] === 'PATCH');
  assert.match(patch[2].body, /Risk hold lifted/);
  assert.equal(gh.calls.filter((c) => c[0] === 'DELETE').length, 1);
});

test('hold: a comment someone else edited is replaced, not patched, so a later approval can release', async () => {
  const gh = fakeGitHub({ files: risky });
  const foreign = { edit_history: { lastEditedAt: '2026-10-29T10:05:00Z', editor: { __typename: 'User', login: 'cloudwork-bot' }, userContentEdits: { totalCount: 1, nodes: [{ editor: { __typename: 'User', login: 'cloudwork-bot' } }] } } };
  const tampered = holdComment([], undefined, foreign);
  tampered.body = holdCommentBody({ hits: [{ path: 'src/a.js', line: 2, kind: 'host', detail: 'new outside host `collector.invented-tracker.dev`' }], headSha: HEAD, prAuthor: 'cloudwork-bot' });
  assert.equal(await applyRiskHold({ gh, repoBase: '/r', pr: pr([RISK_LABEL]), comments: [tampered], reviews: [], allowlist: list }), HOLD_REASON);
  assert.equal(gh.calls.some((c) => c[0] === 'PATCH'), false);
  assert.ok(gh.calls.some((c) => c[0] === 'DELETE' && c[1] === '/r/issues/comments/7'));
  const posted = gh.calls.find((c) => c[0] === 'POST' && c[1] === '/r/issues/5/comments')[2].body;
  // The next run trusts the fresh comment, leaves it alone, and the owner's approval releases.
  gh.calls.length = 0;
  const fresh = { ...holdComment([]), id: 8, body: posted, updated_at: '2026-10-29T10:01:00Z' };
  assert.equal(await applyRiskHold({ gh, repoBase: '/r', pr: pr([RISK_LABEL]), comments: [fresh], reviews: [approval('2026-10-29T11:00:00Z')], allowlist: list }), null);
  assert.equal(gh.calls.some((c) => c[0] === 'PATCH' || (c[0] === 'POST' && c[1].endsWith('/comments'))), false);
});

test('hold: a clean pull request gets no comment and no label', async () => {
  const gh = fakeGitHub({ files: [{ path: 'src/a.js', before: 'x\n', after: 'y\n' }] });
  assert.equal(await applyRiskHold({ gh, repoBase: '/r', pr: pr(), comments: [], reviews: [], allowlist: list }), null);
  assert.deepEqual(gh.calls.filter((c) => c[0] !== 'GET' && c[0] !== 'ALL').map((c) => c[1]), ['/r/statuses/' + HEAD]);
});

test('hold: never released on a pull request opened from the owner\'s account', async () => {
  const gh = fakeGitHub({ files: risky });
  const mine = { ...pr(), user: { login: 'CloudworkSystems' } };
  await applyRiskHold({ gh, repoBase: '/r', pr: mine, comments: [], reviews: [], allowlist: list });
  const posted = gh.calls.find((c) => c[1] === '/r/issues/5/comments')[2].body;
  const comment = { ...holdComment([]), body: posted, updated_at: '2026-10-29T10:01:00Z' };
  assert.equal(await applyRiskHold({ gh, repoBase: '/r', pr: mine, comments: [comment], reviews: [approval('2026-10-29T11:00:00Z')], allowlist: list }), HOLD_REASON);
});

// ------------------------------------------------------------ wiring

test('the risk hold replaces a passing result, and the owner-opened hold still comes first', () => {
  assert.deepEqual(withRiskHold({ approved: true, reason: 'ok' }, HOLD_REASON), { approved: false, reason: HOLD_REASON });
  assert.deepEqual(withRiskHold({ approved: true, reason: 'ok' }, null), { approved: true, reason: 'ok' });
  assert.equal(withOwnerOpenedHold(withRiskHold({ approved: true, reason: 'ok' }, HOLD_REASON), 'owner hold').reason, 'owner hold');
});

test('codex-approved runs the risk check after the owner-opened hold, and fails closed', () => {
  const script = readFileSync(new URL('../codex-approved.mjs', import.meta.url), 'utf8');
  assert.match(script, /withOwnerOpenedHold\(withRiskHold\(result, risk\), blocked\)/);
  assert.match(script, /if \(!blocked\)/);
  assert.match(script, /risk = 'Risk check could not finish/);
});

test('the triage judge always rates privacy, secret and permission findings real', () => {
  assert.match(SYSTEM, /data leaving the device, a secret, real personal data or a new permission is always "real"/);
});

test('the allowlist in the repo parses and lists hosts, dependencies and key names', () => {
  const text = readFileSync(new URL('../../risk-allowlist.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(text);
  for (const key of ['hosts', 'dependencies', 'secrets']) assert.ok(Array.isArray(parsed[key]) && parsed[key].length > 0, key);
  const list = parseAllowlist(text);
  assert.ok(list.hosts.has('registry.npmjs.org'));
  assert.ok([...list.dependencies].every((d) => /^(npm|swift[a-z-]*):/.test(d)));
});
