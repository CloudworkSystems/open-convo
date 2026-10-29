// Text helpers shared by the engine, the drafters and the command. Nothing
// here acts on text; it only cleans, compares and measures it.

// C0 and C1 controls and DEL, plus zero-width and bidi format characters,
// which can hide or reorder what the owner reads.
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// ANSI escape sequences: CSI, OSC (ended by BEL or ESC \) and two-byte escapes.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
// Links are found one word at a time with anchored patterns, so a long
// run of dots or letters can't make the check slow.
const BARE_SCHEME = /^(?:mailto|javascript|data|file|tel|vbscript):\S/i;
const OPENERS = /^[("'<[{]+/;

/** Removes ANSI escapes and control characters, and collapses whitespace. */
export function clean(text) {
  return text.replace(ANSI, '').replace(/\s+/g, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim();
}

// A bare host name with no path ("evil.com") counts as a link unless its
// ending is a common file or tool name, so words like "Node.js" and
// "README.md" stay.
const KEEP_ENDINGS = new Set(['js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs', 'py', 'rb', 'md', 'json', 'txt', 'yml', 'yaml', 'toml', 'html', 'css', 'sh', 'swift']);
const CLOSERS = new Set(')"\'>]}.,;:!?');

function trimClosers(token) {
  let end = token.length;
  while (end > 0 && CLOSERS.has(token[end - 1])) end -= 1;
  return token.slice(0, end);
}

function isIPv4(host) {
  const parts = host.split('.');
  return parts.length === 4 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// A host before a path, port, query or anchor may also be an IP address or
// localhost, which bare words can't be (so "and/or" stays).
function isAddress(host) {
  return isHost(host) || isIPv4(host) || host.toLowerCase() === 'localhost';
}

function isHost(host) {
  if (!/^[a-z0-9.-]+$/i.test(host)) return false;
  const labels = host.split('.');
  return labels.length > 1 && labels.every(Boolean) && /^[a-z]{2,}$/i.test(labels.at(-1));
}

// A word that is a link: it has "://" (or a backslash form), starts with a
// link scheme, www. or //, is a host name followed by a path, query,
// anchor or port, is an email address, or is a bare host name. Fullwidth
// and ideographic dots and fullwidth slashes count.
function isLinkPart(word) {
  const token = word.normalize('NFKC').replace(/\u3002/g, '.').replace(OPENERS, '');
  if (/^[/\\]{2}/.test(token) || /:[/\\]/.test(token)) return true;
  if (BARE_SCHEME.test(token) || /^www\./i.test(token)) return true;
  // An email address, or a host name with a port.
  const at = token.lastIndexOf('@');
  if (at > 0 && isHost(trimClosers(token.slice(at + 1)))) return true;
  const port = /^([^:]+):\d+/.exec(token);
  if (port && isAddress(port[1])) return true;
  const cutAt = token.search(/[/\\?#]/);
  if (cutAt > 0 && isAddress(token.slice(0, cutAt))) return true;
  const bare = trimClosers(token);
  return isIPv4(bare) || (isHost(bare) && !KEEP_ENDINGS.has(bare.split('.').at(-1).toLowerCase()));
}

// A word is a link when any part of it between brackets, parentheses or
// quotes is one, so Markdown like [label](//host/x) is caught too.
function isLink(word) {
  return word.split(/[()[\]<>{}"'`*_|]+/).some(part => part && isLinkPart(part));
}

/** Removes every link from the text, then cleans it again. */
export function stripUrls(text) {
  return clean(text.split(/\s+/).filter(word => !isLink(word)).join(' '));
}

/** True when the text contains a link stripUrls would remove. */
export function hasUrl(text) {
  return text.split(/\s+/).some(isLink);
}

/**
 * Makes source text safe to print on a terminal: ANSI escapes removed, line
 * breaks and tabs written as \n and \t, and other control characters removed.
 */
export function safeText(text) {
  return String(text)
    .replace(ANSI, '')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(CONTROL, '');
}

/** Lower case, punctuation removed, spaces collapsed. */
export function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function words(text) {
  const normalized = normalize(text);
  return normalized ? normalized.split(' ') : [];
}

/** Share of words two texts have in common, over the words either has. */
export function jaccard(a, b) {
  const left = new Set(words(a));
  const right = new Set(words(b));
  if (!left.size && !right.size) return 1;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Every run of `size` consecutive normalized words in the text. */
export function runs(text, size) {
  const list = words(text);
  const found = new Set();
  for (let i = 0; i + size <= list.length; i += 1) found.add(list.slice(i, i + size).join(' '));
  return found;
}

/** Cuts text to at most `max` characters (code points), on a word when it can. */
export function cut(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const short = chars.slice(0, max - 1).join('');
  const space = short.lastIndexOf(' ');
  return `${(space > max / 2 ? short.slice(0, space) : short).trimEnd()}…`;
}

export function length(text) {
  return Array.from(text).length;
}
