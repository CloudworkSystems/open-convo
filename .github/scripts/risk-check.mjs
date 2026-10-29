// The risk hold in `codex-approved` (docs/plans/risk-review.md): holds a pull
// request for the owner when it adds an outside host, a dependency, a Mac
// permission or the name of an API key, wherever in the repo that happens.
//
// It reads the pull request only through the API and never runs its code.
// Every changed text file is fetched whole at the merge base and at the head
// commit, and the added lines are worked out here, since GitHub's patches can
// be missing or cut short. A file that can't be read counts as a hit.
//
// The pure parts (scanning, the comment, the hold decision) need no network
// and are tested in tests/risk-check.test.mjs. readPullRequestFiles(),
// readAllowlist() and applyRiskHold() talk to GitHub.

import { createHash } from 'node:crypto';
import { OWNER_LOGIN, editedOnlyBy } from './codex-signal.mjs';

export const RISK_LABEL = 'needs-owner: risk';
export const HOLD_MARKER = '<!-- risk-hold:v1 -->';
export const HOLD_REASON = 'Risk hold: owner approval needed (see comment)';
export const ALLOWLIST_PATH = '.github/risk-allowlist.json';
// A commit status that records each head's scan, so the hourly run over every
// open pull request doesn't fetch every file again. Only the gate can post it.
export const SCAN_CONTEXT = 'risk-scan';
const SCAN_TAG = /\[risk-scan:v1 fp=([0-9a-f]{12}|none) allow=([0-9a-f]{12}|none)\]/;
const COMMENT_TAG = /<!-- risk-hits:v1 fp=([0-9a-f]{12}|none) -->/;
const ACTIONS_LOGIN = 'github-actions[bot]';
const isActionsEditor = (actor) => Boolean(actor) && actor.__typename === 'Bot' && actor.login === 'github-actions';

// ---------------------------------------------------------------- hosts

// Invented hosts never count (RFC 2606 and 6761 names, and loopback).
const RESERVED = ['example.com', 'example.org', 'example.net', 'example', 'invalid', 'test', 'localhost'];

export function isReservedHost(host) {
  if (host === '127.0.0.1' || host === '[::1]') return true;
  return RESERVED.some((name) => host === name || host.endsWith(`.${name}`));
}

// The authority: optional user, then a bracketed IPv6 address or a name, then an optional port.
const URL_PATTERN = /\b(?:https?|wss?):\/\/((?:[^\s/?#"'`<>()[\]{}\\|^,;@]*@)?(?:\[[0-9a-f:.]+\]|[^\s/?#"'`<>()[\]{}\\|^,;]+)(?::\d*)?)/gi;
const HOST_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$|^\[[0-9a-f:.]+\]$/;

/**
 * Hosts named by http(s) and ws(s) URLs in one line, as the URL parser (and
 * so fetch) reads them: lowercased, percent-decoded, in punycode, without
 * user or port. `unreadable` lists URLs whose host can't be read that way;
 * they count as hits, so an odd spelling never slips through.
 */
export function readHosts(line) {
  const hosts = [];
  const unreadable = [];
  for (const match of line.matchAll(URL_PATTERN)) {
    // A host built at run time (`https://${host}`) can't be read; the
    // checklist in the independent review covers what a pattern can't see.
    if (/^\$\{/.test(line.slice(match.index + match[0].length - match[1].length))) continue;
    // A backslash right after the host (as in a.com\@b.com) is a source
    // escape that can put a different host in the real string: fail closed.
    // Swift's "\(port)" only fills in the port, so the host still reads.
    let host = null;
    const after = line.slice(match.index + match[0].length, match.index + match[0].length + 2);
    if (after[0] === '\\' && after !== '\\(') { unreadable.push(match[0]); continue; }
    try {
      host = new URL(match[0]).hostname.replace(/\.$/, '');
    } catch { /* unreadable */ }
    if (host && HOST_SHAPE.test(host)) hosts.push(host);
    else unreadable.push(match[0]);
  }
  return { hosts, unreadable };
}

export const hostsIn = (line) => readHosts(line).hosts;

// ---------------------------------------------------------------- key names

const SECRET_NAME = /\b[A-Z][A-Z0-9_]*_(?:API_KEY|TOKEN|SECRET)\b/g;

/** Names of environment variables or secrets ending in _API_KEY, _TOKEN or _SECRET. */
export function secretNamesIn(line) {
  return [...line.matchAll(SECRET_NAME)].map((m) => m[0]);
}

// ---------------------------------------------------------------- added lines

/**
 * The head's lines that aren't in the base, with their line numbers. A line
 * counts as added when it appears more often at the head than at the base, so
 * a line moved within the file isn't new.
 */
export function addedLines(before, after) {
  const counts = new Map();
  for (const line of splitLines(before)) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added = [];
  splitLines(after).forEach((text, i) => {
    const left = counts.get(text) ?? 0;
    if (left > 0) counts.set(text, left - 1);
    else added.push({ line: i + 1, text });
  });
  return added;
}

const splitLines = (text) => (text ? text.split(/\r?\n/) : []);

// ---------------------------------------------------------------- files

const BINARY = /\.(?:png|jpe?g|gif|webp|ico|icns|bmp|tiff?|heic|avif|woff2?|ttf|otf|eot|mp3|wav|m4a|aac|flac|ogg|caf|aiff?|mp4|mov|webm|m4v|avi|mkv)$/i;
export const isBinaryPath = (path) => BINARY.test(path);

const base = (path) => path.slice(path.lastIndexOf('/') + 1);
const isMarkdown = (path) => /\.md$/i.test(path);
const isNpmManifest = (path) => base(path) === 'package.json';
const isNpmLock = (path) => ['package-lock.json', 'npm-shrinkwrap.json'].includes(base(path));
const isSwiftManifest = (path) => base(path) === 'Package.swift';
const isSwiftResolved = (path) => base(path) === 'Package.resolved';
const isEntitlements = (path) => /\.entitlements$/i.test(path);
const isInfoPlist = (path) => base(path) === 'Info.plist';
// Lockfiles this check can't parse: any change to them is a hit.
const isOtherLock = (path) => ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'].includes(base(path));

// ---------------------------------------------------------------- npm

const NPM_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const NPM_REGISTRY = 'https://registry.npmjs.org/';

/** What a dependency spec installs: the package name, or the source when it isn't the registry. */
export function npmTarget(name, spec) {
  if (typeof spec !== 'string') return `source:${JSON.stringify(spec)}`;
  const value = spec.trim();
  const alias = value.match(/^npm:((?:@[^/@\s]+\/)?[^@\s]+)(?:@.*)?$/);
  if (alias) return alias[1];
  // Version ranges and tags have no ":" or "/"; git, tarball, file, link and
  // GitHub shorthand specs do. The part after "#" is a commit or tag, like a version.
  if (/[:/]/.test(value)) return `source:${value.replace(/#.*$/, '')}`;
  return name;
}

// The package an overrides or resolutions key names: its last path part
// (with its scope), without a version range ("**/a", "b/@s/c@1" -> "a", "@s/c").
function overrideName(key) {
  const glob = key.lastIndexOf('**/');
  const parts = (glob >= 0 ? key.slice(glob + 3) : key).split('/');
  const last = parts.length > 1 && parts[parts.length - 2].startsWith('@') ? parts.slice(-2).join('/') : parts[parts.length - 1];
  const at = last.indexOf('@', 1);
  return at > 0 ? last.slice(0, at) : last;
}

function npmEntries(manifest) {
  const pairs = new Set();
  for (const section of NPM_SECTIONS) {
    const deps = manifest?.[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) pairs.add(`${name}\u0000${npmTarget(name, spec)}`);
  }
  // overrides (npm) and resolutions (yarn) can repoint a package anywhere in
  // the tree, so their entries count like dependencies.
  const walk = (entries) => {
    for (const [key, spec] of Object.entries(entries ?? {})) {
      const name = key === '.' ? null : overrideName(key);
      if (typeof spec === 'string') { if (name) pairs.add(`${name}\u0000${npmTarget(name, spec)}`); }
      else if (spec && typeof spec === 'object') {
        if (name && typeof spec['.'] === 'string') pairs.add(`${name}\u0000${npmTarget(name, spec['.'])}`);
        walk(spec);
      }
    }
  };
  for (const key of ['overrides', 'resolutions']) {
    if (manifest?.[key] && typeof manifest[key] === 'object') walk(manifest[key]);
  }
  const bundled = new Set();
  for (const key of ['bundleDependencies', 'bundledDependencies']) {
    if (Array.isArray(manifest?.[key])) for (const name of manifest[key]) bundled.add(String(name));
  }
  return { pairs, bundled };
}

function npmManifestHits(path, before, after, allow) {
  const was = npmEntries(before);
  const now = npmEntries(after);
  const hits = [];
  for (const pair of now.pairs) {
    if (was.pairs.has(pair)) continue;
    const [name, target] = pair.split('\u0000');
    if (!target.startsWith('source:') && allow.dependencies.has(`npm:${target}`)) continue;
    const detail = target === name ? `new package \`${name}\`` : target.startsWith('source:') ? `\`${name}\` installs from \`${target.slice(7)}\`` : `\`${name}\` installs the package \`${target}\``;
    hits.push({ signal: 'dependency', file: path, detail });
  }
  for (const name of now.bundled) {
    if (!was.bundled.has(name) && !allow.dependencies.has(`npm:${name}`)) hits.push({ signal: 'dependency', file: path, detail: `new bundled package \`${name}\`` });
  }
  return hits;
}

/** Every package a lockfile installs, as name and source pairs. */
export function npmLockEntries(lock) {
  const entries = [];
  if (lock?.packages && typeof lock.packages === 'object') {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (!key || !entry || typeof entry !== 'object') continue;
      const at = key.lastIndexOf('node_modules/');
      const name = typeof entry.name === 'string' ? entry.name : at >= 0 ? key.slice(at + 13) : key;
      entries.push({ name, source: lockSource(entry.link ? 'link' : entry.resolved) });
    }
  }
  // lockfileVersion 1 nests packages under "dependencies".
  const walk = (deps) => {
    if (!deps || typeof deps !== 'object') return;
    for (const [name, entry] of Object.entries(deps)) {
      if (!entry || typeof entry !== 'object') continue;
      const version = typeof entry.version === 'string' ? entry.version : '';
      const alias = version.match(/^npm:((?:@[^/@\s]+\/)?[^@\s]+)@/);
      entries.push({ name: alias ? alias[1] : name, source: lockSource(entry.resolved ?? (/[:/]/.test(version) && !alias ? version : undefined)) });
      walk(entry.dependencies);
    }
  };
  if (!lock?.packages) walk(lock?.dependencies);
  return entries;
}

function lockSource(resolved) {
  if (resolved === 'link') return 'link';
  if (typeof resolved !== 'string' || resolved.startsWith(NPM_REGISTRY)) return 'registry';
  return resolved.replace(/#.*$/, '');
}

function npmLockHits(path, before, after, allow) {
  const was = npmLockEntries(before);
  const names = new Set(was.map((e) => e.name));
  const pairs = new Set(was.map((e) => `${e.name}\u0000${e.source}`));
  const hits = new Map();
  for (const { name, source } of npmLockEntries(after)) {
    if (!names.has(name) && !allow.dependencies.has(`npm:${name}`)) hits.set(`new:${name}`, { signal: 'dependency', file: path, detail: `new package \`${name}\``, group: 'lock' });
    else if (source !== 'registry' && source !== 'link' && !pairs.has(`${name}\u0000${source}`)) hits.set(`src:${name}:${source}`, { signal: 'dependency', file: path, detail: `\`${name}\` installs from \`${source}\``, group: 'lock' });
  }
  return [...hits.values()];
}

// ---------------------------------------------------------------- Swift

// Scheme and host are case-insensitive; the path isn't (case-sensitive Git
// servers can host different repositories at paths that differ only in case).
function normalizeSwiftUrl(url) {
  const value = url.trim();
  const parts = value.match(/^([a-z][a-z0-9+.-]*:\/\/[^/]*)(.*)$/i);
  const normalized = parts ? parts[1].toLowerCase() + parts[2] : value;
  return normalized.replace(/\/+$/, '').replace(/\.git$/, '');
}

// The text inside each `<marker>(...)` call, matching parentheses.
function calls(text, marker) {
  const found = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(marker, from);
    if (start < 0) return found;
    let depth = 0;
    let i = start + marker.length - 1;
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')' && --depth === 0) break;
    }
    found.push(text.slice(start + marker.length, i));
    from = start + marker.length;
  }
}

/** Swift source with its comments blanked out (strings kept), so a commented-out declaration doesn't count. */
export function stripSwiftComments(text) {
  let out = '';
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (depth > 0) {
      if (c === '/' && next === '*') { depth++; i++; } else if (c === '*' && next === '/') { depth--; i++; }
      else if (c === '\n') out += c;
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i++; } else if (c === '"' || c === '\n') inString = false;
      continue;
    }
    if (c === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && next === '*') { depth = 1; i++; continue; }
    if (c === '"') inString = true;
    out += c;
  }
  return out;
}

/** The packages and remote binaries a Package.swift declares (read as text; no Swift runs). */
export function swiftDependencies(text, { stripComments = true } = {}) {
  const deps = new Set();
  if (stripComments) text = stripSwiftComments(text);
  for (const body of calls(text, '.package(')) {
    const url = body.match(/\burl:\s*"([^"]+)"/);
    const path = body.match(/\bpath:\s*"([^"]+)"/);
    const id = body.match(/\bid:\s*"([^"]+)"/);
    deps.add(url ? `swift:${normalizeSwiftUrl(url[1])}` : path ? `swift-path:${path[1]}` : id ? `swift-id:${id[1].toLowerCase()}` : `swift-other:${body.replace(/\s+/g, ' ').trim()}`);
  }
  for (const body of calls(text, '.binaryTarget(')) {
    const url = body.match(/\burl:\s*"([^"]+)"/);
    if (url) deps.add(`swift-binary:${url[1].trim()}`);
  }
  return deps;
}

/** The pins in a Package.resolved, any version of its format. */
export function swiftPins(resolved) {
  const pins = resolved?.pins ?? resolved?.object?.pins ?? [];
  if (!Array.isArray(pins)) throw new Error('pins is not a list');
  return new Set(pins.map((pin) => {
    const url = pin?.location ?? pin?.repositoryURL;
    if (typeof url === 'string') return `swift:${normalizeSwiftUrl(url)}`;
    return `swift-id:${String(pin?.identity ?? pin?.package ?? JSON.stringify(pin)).toLowerCase()}`;
  }));
}

function newEntries(path, before, after, allow, label) {
  return [...after].filter((dep) => !before.has(dep) && !allow.dependencies.has(dep))
    .map((dep) => ({ signal: 'dependency', file: path, detail: `${label} \`${dep.replace(/^swift[a-z-]*:/, '')}\`` }));
}

// ---------------------------------------------------------------- plists

/** Parses an XML property list. Binary plists and anything malformed throw. */
export function parsePlist(text) {
  if (!text.trim()) return {};
  if (text.startsWith('bplist')) throw new Error('binary property list');
  // Declarations, comments and the doctype match as their own tokens and are dropped.
  const tokens = [...text.matchAll(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g)]
    .filter((t) => t[2] !== undefined || t[4] !== undefined);
  let i = 0;
  const skipSpace = () => { while (i < tokens.length && tokens[i][4] !== undefined && !tokens[i][4].trim()) i++; };
  const textUntil = (name) => {
    let out = '';
    while (i < tokens.length && tokens[i][4] !== undefined) out += tokens[i++][4];
    const close = tokens[i++];
    if (!close || close[1] !== '/' || close[2] !== name) throw new Error(`unclosed <${name}>`);
    return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  };
  const value = () => {
    skipSpace();
    const open = tokens[i++];
    if (!open || open[4] !== undefined || open[1] === '/') throw new Error('expected a value');
    const [, , name, selfClosing] = open;
    if (name === 'true' || name === 'false') {
      if (!selfClosing) { skipSpace(); const close = tokens[i++]; if (close?.[2] !== name) throw new Error(`unclosed <${name}>`); }
      return name === 'true';
    }
    if (name === 'dict') {
      const dict = {};
      if (selfClosing) return dict;
      for (;;) {
        skipSpace();
        const next = tokens[i];
        if (!next) throw new Error('unclosed <dict>');
        if (next[1] === '/' && next[2] === 'dict') { i++; return dict; }
        if (next[2] !== 'key' || next[1] === '/') throw new Error('expected <key>');
        i++;
        const key = next[3] ? '' : textUntil('key');
        dict[key] = value();
      }
    }
    if (name === 'array') {
      const list = [];
      if (selfClosing) return list;
      for (;;) {
        skipSpace();
        const next = tokens[i];
        if (!next) throw new Error('unclosed <array>');
        if (next[1] === '/' && next[2] === 'array') { i++; return list; }
        list.push(value());
      }
    }
    if (['string', 'integer', 'real', 'date', 'data'].includes(name)) {
      const raw = selfClosing ? '' : textUntil(name);
      return name === 'integer' || name === 'real' ? Number(raw.trim()) : raw;
    }
    throw new Error(`unknown element <${name}>`);
  };
  skipSpace();
  const root = tokens[i];
  if (!root || root[2] !== 'plist' || root[1] === '/') throw new Error('no <plist>');
  i++;
  const parsed = value();
  skipSpace();
  if (tokens[i]?.[2] !== 'plist' || tokens[i]?.[1] !== '/') throw new Error('unclosed <plist>');
  return parsed;
}

const SANDBOX = 'com.apple.security.app-sandbox';
// The Info.plist keys that ask for something: privacy prompts, network
// exceptions and URL schemes the app answers.
const isPermissionKey = (key) => /^NS.*UsageDescription$/.test(key) || key === 'NSAppTransportSecurity' || key === 'CFBundleURLTypes';
const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x));

/** Each key path, scalar value and array entry in a property list. */
function flatten(value, path = '', out = { keys: new Map(), items: new Set() }) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      const at = path ? `${path} › ${key}` : key;
      out.keys.set(at, child);
      flatten(child, at, out);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) out.items.add(`${path}\u0000${canonical(item)}`);
  }
  return out;
}

/**
 * New Mac permissions between two parsed property lists: a new key (unless it
 * is off), a value turned from off to on, a new entry in a list, and in an
 * entitlements file any other changed value. Turning the App Sandbox off, or
 * removing it, also counts. In an Info.plist only the keys that ask for
 * something are compared.
 */
export function permissionChanges(before, after, { entitlements }) {
  const keep = (obj) => (entitlements ? obj : Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => isPermissionKey(k))));
  const was = flatten(keep(before));
  const now = flatten(keep(after));
  const found = [];
  for (const [key, value] of now.keys) {
    if (!was.keys.has(key)) {
      if (value !== false) found.push(`new key \`${key}\``);
      continue;
    }
    const old = was.keys.get(key);
    if (old === false && value === true) found.push(`\`${key}\` turned on`);
    else if (entitlements && typeof value !== 'object' && typeof old !== 'object' && value !== old && value !== false) found.push(`\`${key}\` changed`);
  }
  for (const item of now.items) {
    if (!was.items.has(item)) {
      const [key, entry] = item.split('\u0000');
      found.push(`new entry ${entry} in \`${key}\``);
    }
  }
  if (entitlements && was.keys.get(SANDBOX) === true && now.keys.get(SANDBOX) !== true) found.push('App Sandbox turned off or removed');
  return found;
}

// ---------------------------------------------------------------- the scan

/**
 * Normalizes the allowlist file's contents. Anything unreadable is treated as
 * an empty list, so more is held, never less.
 */
export function parseAllowlist(text) {
  let data = {};
  try { data = JSON.parse(text ?? '{}') ?? {}; } catch { data = {}; }
  const set = (list) => new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string').map((x) => x.trim()) : []);
  return { hosts: new Set([...set(data.hosts)].map((h) => h.toLowerCase())), dependencies: set(data.dependencies), secrets: set(data.secrets) };
}

const allowsHost = (allow, host) => allow.hosts.has(host) || [...allow.hosts].some((h) => h.startsWith('*.') && host.endsWith(h.slice(1)));

/**
 * Hits in one changed file. `before` is the file at the merge base and
 * `after` at the head ('' when the file doesn't exist there); `error` says
 * why one of them couldn't be read.
 */
export function scanFile({ path, before = '', after = '', error, allow }) {
  if (isBinaryPath(path) && !isOtherLock(path)) return [];
  if (error) return [{ signal: 'unreadable', file: path, detail: `couldn't read the diff for \`${path}\` (${error})` }];
  if (before === after) return [];
  if (isOtherLock(path)) return [{ signal: 'unreadable', file: path, detail: `\`${path}\` changed, and this check only reads npm and SwiftPM lockfiles` }];
  const hits = [];
  const parsed = (text) => (text.trim() ? JSON.parse(text) : {});
  try {
    if (isNpmManifest(path)) hits.push(...npmManifestHits(path, parsed(before), parsed(after), allow));
    if (isNpmLock(path)) hits.push(...npmLockHits(path, parsed(before), parsed(after), allow));
    if (isSwiftManifest(path)) {
      // Compared with comments stripped (so uncommenting a package counts) and
      // as raw text (so a string that fools the comment stripper can't hide a
      // newly added package): new on either reading is a hit.
      const found = [
        ...newEntries(path, swiftDependencies(before), swiftDependencies(after), allow, 'new Swift package'),
        ...newEntries(path, swiftDependencies(before, { stripComments: false }), swiftDependencies(after, { stripComments: false }), allow, 'new Swift package'),
      ];
      hits.push(...new Map(found.map((h) => [h.detail, h])).values());
    }
    if (isSwiftResolved(path)) hits.push(...newEntries(path, swiftPins(parsed(before)), swiftPins(parsed(after)), allow, 'new Swift package'));
    if (isEntitlements(path) || isInfoPlist(path)) {
      for (const detail of permissionChanges(parsePlist(before), parsePlist(after), { entitlements: isEntitlements(path) })) hits.push({ signal: 'permission', file: path, detail });
    }
  } catch (err) {
    hits.push({ signal: 'unreadable', file: path, detail: `couldn't read \`${path}\` (${err.message})` });
  }
  // Lockfiles are compared parsed above; their many registry URLs aren't new hosts.
  const lineScan = !isNpmLock(path) && !isSwiftResolved(path);
  const seen = new Set();
  for (const { line, text } of lineScan ? addedLines(before, after) : []) {
    if (!isMarkdown(path)) {
      const { hosts, unreadable } = readHosts(text);
      for (const url of unreadable) {
        if (seen.has(`u:${url}`)) continue;
        seen.add(`u:${url}`);
        hits.push({ signal: 'host', file: path, line, detail: `couldn't read the host in \`${url.replace(/`/g, "'")}\`` });
      }
      for (const host of hosts) {
        if (isReservedHost(host) || allowsHost(allow, host) || seen.has(`h:${host}`)) continue;
        seen.add(`h:${host}`);
        hits.push({ signal: 'host', file: path, line, detail: `new outside host \`${host}\`` });
      }
    }
    if (!path.startsWith('.github/')) {
      for (const name of secretNamesIn(text)) {
        if (allow.secrets.has(name) || seen.has(`s:${name}`)) continue;
        seen.add(`s:${name}`);
        hits.push({ signal: 'secret', file: path, line, detail: `names the key or secret \`${name}\`` });
      }
    }
  }
  return hits;
}

/** Hits across every changed file; an incomplete file list is a hit too. */
export function scanChanges({ files, complete = true, allow }) {
  const hits = files.flatMap((file) => scanFile({ ...file, allow }));
  if (!complete) hits.push({ signal: 'unreadable', file: '', detail: "GitHub cut the list of changed files short, so some files couldn't be checked" });
  return hits;
}

/** Identifies a set of hits, ignoring line numbers, so moved lines don't count as a change. */
export function fingerprint(hits) {
  if (hits.length === 0) return 'none';
  const keys = [...new Set(hits.map((h) => `${h.signal}|${h.file}|${h.detail}`))].sort();
  return createHash('sha256').update(keys.join('\n')).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------- the comment

const SIGNAL_TITLES = {
  host: 'New outside hosts',
  dependency: 'New dependencies',
  permission: 'New Mac permissions',
  secret: 'New key or secret names',
  unreadable: "Couldn't check",
};

export function holdCommentBody({ hits, headSha, prAuthor }) {
  const fp = fingerprint(hits);
  const lines = [HOLD_MARKER, `<!-- risk-hits:v1 fp=${fp} -->`];
  if (hits.length === 0) {
    lines.push(`**Risk hold lifted.** No risk signals on \`${headSha.slice(0, 7)}\` any more (docs/plans/risk-review.md).`);
    return lines.join('\n');
  }
  lines.push(
    `**Risk hold.** This pull request adds things the owner hasn't accepted yet, so \`codex-approved\` waits for his approval (docs/plans/risk-review.md). Found on \`${headSha.slice(0, 7)}\`:`,
    '',
  );
  for (const signal of Object.keys(SIGNAL_TITLES)) {
    const ofSignal = hits.filter((h) => h.signal === signal);
    if (ofSignal.length === 0) continue;
    lines.push(`**${SIGNAL_TITLES[signal]}**`);
    const grouped = new Map();
    for (const hit of ofSignal) {
      // Lockfile packages are listed together, one line per lockfile.
      if (hit.group === 'lock') { grouped.set(hit.file, [...(grouped.get(hit.file) ?? []), hit.detail.replace(/^new package /, '')]); continue; }
      lines.push(`- ${hit.file ? `\`${hit.file}${hit.line ? `:${hit.line}` : ''}\`: ` : ''}${hit.detail}`);
    }
    for (const [file, details] of grouped) lines.push(`- \`${file}\`: ${details.length} new or moved package(s): ${details.join(', ')}`);
    lines.push('');
  }
  lines.push(
    '**To clear it:**',
    '- Builder: add each host, dependency or key name you want accepted for good to `.github/risk-allowlist.json` in this pull request (a protected file, so the owner sees it). Leave an entry out if he should be asked again next time. Permissions and unreadable files are never allowlisted.',
    prAuthor === OWNER_LOGIN
      ? "- Owner: this pull request was opened from your own account, which GitHub won't let you approve. Reopen the work from `cloudwork-bot` and approve it there."
      : "- Owner: approve the pull request's latest commit after reading this comment. An approval given before this comment last changed doesn't count, and your note accepting Codex findings doesn't clear a risk hold.",
    "- `codex-approved` doesn't run on review events, so the hold lifts at its next run (hourly, or on the next comment). A later commit that removes every hit lifts it too.",
  );
  return lines.join('\n');
}

/** The gate's own hold comment, if there is one. */
export function findHoldComment(comments = []) {
  return comments.find((c) => c.user?.login === ACTIONS_LOGIN && (c.body ?? '').startsWith(HOLD_MARKER)) ?? null;
}

/** The fingerprint the hold comment shows, or null if it isn't trustworthy (someone else edited it). */
export function commentFingerprint(comment) {
  if (!comment || !editedOnlyBy(comment, isActionsEditor)) return null;
  return (comment.body ?? '').match(COMMENT_TAG)?.[1] ?? null;
}

/**
 * True when the owner approved the head commit after the hold comment last
 * changed. Never true on a pull request opened from his account.
 */
export function ownerReleased({ headSha, prAuthor, comment, reviews = [] }) {
  if (!comment || !headSha || prAuthor === OWNER_LOGIN) return false;
  const changed = Date.parse(comment.updated_at ?? comment.created_at ?? '');
  if (!changed) return false;
  return reviews.some((r) => r.user?.login === OWNER_LOGIN && r.state === 'APPROVED' && r.commit_id === headSha && Date.parse(r.submitted_at ?? '') > changed);
}

export function scanStatusDescription({ hits, fp, allowTag }) {
  const summary = fp === 'none' ? 'No risk signals.' : `${hits ?? 'Some'} risk signal(s); see the hold comment.`;
  return `${summary} [risk-scan:v1 fp=${fp} allow=${allowTag}]`;
}

/** The recorded scan of this head from the gate's own status, or null. */
export function cachedScan(statuses = [], allowTag) {
  const latest = statuses.find((s) => s.context === SCAN_CONTEXT);
  if (!latest || latest.creator?.login !== ACTIONS_LOGIN) return null;
  const match = (latest.description ?? '').match(SCAN_TAG);
  if (!match || match[2] !== allowTag) return null;
  return { fp: match[1] };
}

// ---------------------------------------------------------------- GitHub

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

async function readFile(gh, repoBase, path, ref) {
  let meta;
  try {
    meta = await gh.get(`${repoBase}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  } catch (error) {
    return { error: /failed: 404/.test(error.message) ? 'not found' : 'API error' };
  }
  if (Array.isArray(meta) || meta?.type !== 'file') return { error: `not a regular file (${Array.isArray(meta) ? 'folder' : meta?.type})` };
  if (meta.encoding === 'base64' && typeof meta.content === 'string' && (meta.content || meta.size === 0)) {
    return { text: Buffer.from(meta.content, 'base64').toString('utf8') };
  }
  // Over 1 MB the contents API leaves the content out; the blob has all of it.
  try {
    const blob = await gh.get(`${repoBase}/git/blobs/${meta.sha}`);
    if (blob?.encoding === 'base64' && typeof blob.content === 'string') return { text: Buffer.from(blob.content, 'base64').toString('utf8') };
  } catch { /* falls through */ }
  return { error: 'too large to read' };
}

/** Each changed file at the merge base and at the head, read whole. */
export async function readPullRequestFiles({ gh, repoBase, pr }) {
  const changed = await gh.all(`${repoBase}/pulls/${pr.number}/files`);
  const complete = changed.length >= pr.changed_files;
  const compare = await gh.get(`${repoBase}/compare/${pr.base.sha}...${pr.head.sha}`);
  const mergeBase = compare?.merge_base_commit?.sha;
  if (!mergeBase) throw new Error('no merge base');
  const files = [];
  for (const f of changed) {
    const path = f.filename;
    if (isBinaryPath(path) && !isOtherLock(path)) continue;
    const old = f.status === 'renamed' || f.status === 'copied' ? f.previous_filename ?? path : path;
    const before = f.status === 'added' ? { text: '' } : await readFile(gh, repoBase, old, mergeBase);
    const after = f.status === 'removed' ? { text: '' } : await readFile(gh, repoBase, path, pr.head.sha);
    const error = before.error ? `at the merge base: ${before.error}` : after.error ? `at the head: ${after.error}` : undefined;
    files.push({ path, before: before.text ?? '', after: after.text ?? '', error });
  }
  return { files, complete };
}

/** The allowlist from the default branch, never the pull request's copy. */
export async function readAllowlist({ gh, repoBase, ref }) {
  try {
    const file = await gh.get(`${repoBase}/contents/${ALLOWLIST_PATH}?ref=${encodeURIComponent(ref)}`);
    return { allow: parseAllowlist(Buffer.from(file.content, 'base64').toString('utf8')), allowTag: String(file.sha).slice(0, 12) };
  } catch {
    return { allow: parseAllowlist('{}'), allowTag: 'none' };
  }
}

/**
 * Runs the risk check on one pull request: scans it (or reuses this head's
 * recorded scan), keeps the hold comment and label in step, and returns the
 * hold reason, or null when there is no hold.
 */
export async function applyRiskHold({ gh, repoBase, pr, comments, reviews, allowlist }) {
  const headSha = pr.head.sha;
  const { allow, allowTag } = allowlist;
  const statuses = await gh.get(`${repoBase}/commits/${headSha}/statuses?per_page=100`);
  let comment = findHoldComment(comments);
  const shown = commentFingerprint(comment);
  let fp = cachedScan(statuses, allowTag)?.fp;
  let hits = null;
  // Scan again unless this head's scan is recorded and the comment still shows it.
  if (fp === undefined || (fp !== 'none' && shown !== fp)) {
    const { files, complete } = await readPullRequestFiles({ gh, repoBase, pr });
    hits = scanChanges({ files, complete, allow });
    fp = fingerprint(hits);
  }
  const labeled = (pr.labels ?? []).some((l) => l.name === RISK_LABEL);
  const unlabel = async () => {
    if (!labeled) return;
    try { await gh.delete(`${repoBase}/issues/${pr.number}/labels/${encodeURIComponent(RISK_LABEL)}`); } catch (error) { if (!/failed: 404/.test(error.message)) throw error; }
  };

  // Write the comment only when the hits change (or someone else edited it):
  // every edit voids earlier approvals, so the hourly run must not touch it.
  if (hits && (fp !== 'none' || comment) && shown !== fp) {
    const body = holdCommentBody({ hits, headSha, prAuthor: pr.user?.login });
    comment = comment
      ? await gh.patch(`${repoBase}/issues/comments/${comment.id}`, { body })
      : await gh.post(`${repoBase}/issues/${pr.number}/comments`, { body });
  }
  if (hits) {
    await gh.post(`${repoBase}/statuses/${headSha}`, {
      state: 'success',
      context: SCAN_CONTEXT,
      description: scanStatusDescription({ hits: hits.length, fp, allowTag }),
    });
  }

  if (fp === 'none') { await unlabel(); return null; }
  if (ownerReleased({ headSha, prAuthor: pr.user?.login, comment, reviews })) { await unlabel(); return null; }
  if (!labeled) await gh.post(`${repoBase}/issues/${pr.number}/labels`, { labels: [RISK_LABEL] });
  return HOLD_REASON;
}

/** Applies the risk hold to the gate's result: a held pull request never passes. */
export function withRiskHold({ approved, reason }, held) {
  return held ? { approved: false, reason: held } : { approved, reason };
}
