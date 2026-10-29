// Text helpers shared by the engine, the drafters and the command. Nothing
// here acts on text; it only cleans, compares and measures it.

// C0 and C1 controls and DEL, plus zero-width and bidi format characters,
// which can hide or reorder what the owner reads.
const CONTROL = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
// ANSI escape sequences: CSI, OSC (ended by BEL or ESC \) and two-byte escapes.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g;
// Links with a scheme, links starting with www., and bare host names with a path.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S*|\b(?:mailto|javascript|data|file|tel):\S*|\bwww\.\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;

/** Removes ANSI escapes and control characters, and collapses whitespace. */
export function clean(text) {
  return text.replace(ANSI, '').replace(/\s+/g, ' ').replace(CONTROL, '').replace(/ {2,}/g, ' ').trim();
}

/** Removes every link from the text, then cleans it again. */
export function stripUrls(text) {
  return clean(text.replace(URL, ' '));
}

/** True when the text contains a link stripUrls would remove. */
export function hasUrl(text) {
  URL.lastIndex = 0;
  const found = URL.test(text);
  URL.lastIndex = 0;
  return found;
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
