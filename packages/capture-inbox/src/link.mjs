// Link reading and cleaning. Paths, queries and fragments are kept as written.
// This file does not use the URL class (it would re-encode them) and it never
// fetches a page or a property-list DTD.

import { LIMITS, ONLY_MEDIA } from './errors.mjs';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const TRACKING_EXACT = new Set(['fbclid', 'gclid', 'igsh', 'igshid', 'mc_eid']);

// Rewrite only these hosts. Other YouTube subdomains (music, nocookie) are
// cleaned and labelled, not rewritten. See the README.
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

const SITE_SUFFIXES = [
  ['youtube', ['youtube.com', 'youtu.be', 'youtube-nocookie.com']],
  ['instagram', ['instagram.com']],
  ['tiktok', ['tiktok.com']],
  ['x', ['x.com', 'twitter.com']],
  ['facebook', ['facebook.com', 'fb.com', 'fb.watch']],
];

function lowercaseAscii(text) {
  return text.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

function hostMatches(host, suffix) {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function isYoutubeHost(host) {
  return hostMatches(host, 'youtube.com')
    || hostMatches(host, 'youtu.be')
    || hostMatches(host, 'youtube-nocookie.com');
}

export function siteOf(host) {
  for (const [site, suffixes] of SITE_SUFFIXES) {
    for (const suffix of suffixes) {
      if (hostMatches(host, suffix)) return site;
    }
  }
  return 'web';
}

function shorten(text, room) {
  if (text.length <= room) return text;
  if (room <= 1) return '…'.slice(0, room);
  let end = room - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xD800 && code <= 0xDBFF) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function linkTitle(site, host, path, fragment) {
  let rest = `${host}${path}`;
  if (fragment) rest += `#${fragment}`;
  const prefix = `${site} `;
  return prefix + shorten(rest, LIMITS.title - prefix.length);
}

export function clipTitle(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return name;
  return name.slice(0, dot);
}

function schemeMessage(scheme) {
  return `The link uses the ${lowercaseAscii(scheme)} scheme. Only http and https are kept.`;
}

function isTracking(name, host) {
  const lower = lowercaseAscii(name);
  if (lower.startsWith('utm_')) return true;
  if (TRACKING_EXACT.has(lower)) return true;
  return lower === 'si' && isYoutubeHost(host);
}

function splitQuery(query) {
  if (!query) return [];
  const params = [];
  for (const part of query.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const name = eq === -1 ? part : part.slice(0, eq);
    params.push({ name, raw: part });
  }
  return params;
}

function parseAuthority(authority) {
  if (authority.length === 0) return { error: 'The link has no host.' };
  if (authority.includes('@')) return { error: 'The link has a user name or password, so it was not kept.' };
  if (/[\s\u0000-\u001F\u007F]/.test(authority)) return { error: 'The link has no host.' };

  let host;
  let portText = null;
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    if (end <= 1) return { error: 'The link has no host.' };
    host = authority.slice(0, end + 1);
    const rest = authority.slice(end + 1);
    if (rest.length === 0) portText = null;
    else if (rest.startsWith(':')) portText = rest.slice(1);
    else return { error: 'The link has no host.' };
  } else {
    const colon = authority.lastIndexOf(':');
    if (colon !== -1 && authority.indexOf(':') === colon) {
      host = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
      if (host.length === 0) return { error: 'The link has no host.' };
    } else if (colon !== -1) {
      return { error: 'The link has no host.' };
    } else {
      host = authority;
    }
  }

  let port = null;
  if (portText !== null) {
    if (!/^\d{1,5}$/.test(portText)) return { error: "The link's port is not valid." };
    port = Number(portText);
    if (port > 65535) return { error: "The link's port is not valid." };
  }
  return { host: lowercaseAscii(host), port };
}

function serialize(parts) {
  let url = `${parts.scheme}://${parts.host}`;
  if (parts.port !== null) url += `:${parts.port}`;
  url += parts.path;
  if (parts.params.length > 0) url += `?${parts.params.map((param) => param.raw).join('&')}`;
  if (parts.fragment) url += `#${parts.fragment}`;
  return url;
}

function firstParam(params, name) {
  for (const param of params) {
    if (param.name === name) return param;
  }
  return null;
}

function videoIdFrom(value) {
  return VIDEO_ID.test(value) ? value : null;
}

function rewriteYoutube(parts) {
  const time = firstParam(parts.params, 't');
  let id = null;
  if (SHORT_HOSTS.has(parts.host)) {
    const match = /^\/([^/]+)\/?$/.exec(parts.path);
    if (match) id = videoIdFrom(match[1]);
  } else if (WATCH_HOSTS.has(parts.host)) {
    const shorts = /^\/shorts\/([^/]+)\/?$/.exec(parts.path);
    if (shorts) id = videoIdFrom(shorts[1]);
    else if (/^\/watch\/?$/.test(parts.path)) {
      const video = firstParam(parts.params, 'v');
      if (video && video.raw.startsWith('v=')) id = videoIdFrom(video.raw.slice(2));
    }
  }
  if (!id) return null;
  const query = time ? `v=${id}&${time.raw}` : `v=${id}`;
  return {
    scheme: 'https',
    host: 'www.youtube.com',
    port: null,
    path: '/watch',
    params: splitQuery(query),
    fragment: null,
    url: `https://www.youtube.com/watch?${query}`,
  };
}

function rewriteHost(host) {
  if (host === 'twitter.com' || host === 'www.twitter.com') return 'x.com';
  if (host.endsWith('.twitter.com')) return `${host.slice(0, -'.twitter.com'.length)}.x.com`;
  if (host === 'www.instagram.com') return 'instagram.com';
  if (host === 'www.tiktok.com') return 'tiktok.com';
  return host;
}

// A raw http(s) URL, already trimmed of surrounding prose. Returns the cleaned
// link, or { error } when it must be refused. A link a rewrite does not fit
// is cleaned, never refused.
export function cleanLink(raw) {
  const match = /^(https?):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(raw);
  if (!match) {
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
    if (scheme && !/^https?$/i.test(scheme[1])) return { error: schemeMessage(scheme[1]) };
    return { error: 'The link is not an http or https address.' };
  }
  const scheme = lowercaseAscii(match[1]);
  const authority = parseAuthority(match[2]);
  if (authority.error) return authority;
  let port = authority.port;
  if ((scheme === 'http' && port === 80) || (scheme === 'https' && port === 443)) port = null;
  const path = match[3] === '' ? '/' : match[3];
  const params = splitQuery(match[4] ? match[4].slice(1) : '').filter((param) => !isTracking(param.name, authority.host));
  let fragment = match[5] ? match[5].slice(1) : null;
  if (fragment === '') fragment = null;

  const cleaned = { scheme, host: authority.host, port, path, params, fragment };
  const rewritten = rewriteYoutube(cleaned);
  if (rewritten) {
    return {
      url: rewritten.url,
      site: 'youtube',
      title: linkTitle('youtube', rewritten.host, rewritten.path, null),
    };
  }
  cleaned.host = rewriteHost(cleaned.host);
  const url = serialize(cleaned);
  const site = siteOf(cleaned.host);
  return { url, site, title: linkTitle(site, cleaned.host, cleaned.path, cleaned.fragment) };
}

function decodeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (all, body) => {
    if (body === 'amp') return '&';
    if (body === 'lt') return '<';
    if (body === 'gt') return '>';
    if (body === 'quot') return '"';
    if (body === 'apos') return "'";
    const code = body.startsWith('#x') ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
    if (!Number.isInteger(code) || code < 0 || code > 0x10FFFF) return all;
    try {
      return String.fromCodePoint(code);
    } catch {
      return all;
    }
  });
}

function readWebloc(text) {
  const body = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  if (body.startsWith('bplist') || body.includes('\u0000')) {
    return { error: 'The webloc is a binary property list. Only the XML form can be read.' };
  }
  if (!body.includes('<plist')) return { error: 'The webloc is not an XML property list.' };
  const withoutComments = body.replace(/<!--[\s\S]*?-->/g, '');
  const found = /<key>\s*URL\s*<\/key>\s*<string>([\s\S]*?)<\/string>/.exec(withoutComments);
  if (!found) return { error: 'The webloc has no URL.' };
  let value = found[1].trim();
  const cdata = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(value);
  value = (cdata ? cdata[1] : decodeXml(value)).trim();
  if (value.length === 0) return { error: 'The webloc has no URL.' };
  return { url: value };
}

function readUrlFile(text) {
  const lines = text.split(/\r\n|\n|\r/);
  let inSection = false;
  let sawSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      if (inSection) break;
      if (lowercaseAscii(trimmed) === '[internetshortcut]') {
        inSection = true;
        sawSection = true;
      }
      continue;
    }
    if (!inSection) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (lowercaseAscii(trimmed.slice(0, eq).trim()) !== 'url') continue;
    const value = trimmed.slice(eq + 1).trim();
    if (value.length === 0) return { error: 'The .url file has no URL= line.' };
    return { url: value };
  }
  if (!sawSection) return { error: 'The .url file has no [InternetShortcut] section.' };
  return { error: 'The .url file has no URL= line.' };
}

function textFormat(name) {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return 'plain';
  const ext = lowercaseAscii(name.slice(dot + 1));
  if (ext === 'webloc') return 'webloc';
  if (ext === 'url') return 'url';
  return 'plain';
}

function trimTrailing(token) {
  const base = /^https?:\/\//i.exec(token);
  const min = base ? base[0].length : 0;
  let end = token.length;
  while (end > min) {
    const ch = token[end - 1];
    if ('.,;:!?'.includes(ch) || ch === '>') {
      end -= 1;
      continue;
    }
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      let opens = 0;
      let closes = 0;
      for (let i = 0; i < end; i += 1) {
        if (token[i] === open) opens += 1;
        else if (token[i] === ch) closes += 1;
      }
      if (closes > opens) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return token.slice(0, end);
}

function findOtherScheme(text) {
  const match = /(?:^|[^\w+.-])([a-zA-Z][a-zA-Z0-9+.-]*):(\/\/|[^\s/])/.exec(text);
  return match ? match[1] : null;
}

function droppedWords(text, token) {
  const words = text.split(/\s+/).filter(Boolean);
  let seen = false;
  let dropped = 0;
  for (const word of words) {
    if (!seen && word.includes(token)) {
      seen = true;
      continue;
    }
    dropped += 1;
  }
  return dropped;
}

function fromExtracted(raw, emptyMessage) {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
    if (scheme) return { error: schemeMessage(scheme[1]) };
    return { error: emptyMessage };
  }
  const cleaned = cleanLink(trimmed);
  if (cleaned.error) return cleaned;
  return { ...cleaned, droppedWords: 0 };
}

function readPlain(text) {
  const match = /https?:\/\/[^\s]*/i.exec(text);
  if (!match) {
    const scheme = findOtherScheme(text);
    if (scheme && !/^https?$/i.test(scheme)) return { error: schemeMessage(scheme) };
    if (scheme) return { error: 'The link is not an http or https address.' };
    return { error: ONLY_MEDIA };
  }
  const token = match[0];
  const cleaned = cleanLink(trimTrailing(token));
  if (cleaned.error) return cleaned;
  return { ...cleaned, droppedWords: droppedWords(text, token) };
}

export function readTextItem(name, text) {
  const format = textFormat(name);
  if (format === 'webloc') {
    const found = readWebloc(text);
    if (found.error) return found;
    return fromExtracted(found.url, 'The webloc URL is not an http or https link.');
  }
  if (format === 'url') {
    const found = readUrlFile(text);
    if (found.error) return found;
    return fromExtracted(found.url, "The .url file's URL is not an http or https link.");
  }
  return readPlain(text);
}

const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u;

export function nameProblem(name) {
  if (name.length === 0) return 'The name is empty.';
  if (name === '.') return 'The name is ".".';
  if (name === '..') return 'The name is "..".';
  if (name.includes('/')) return 'The name contains a slash.';
  if (name.includes('\\')) return 'The name contains a backslash.';
  if (CONTROL.test(name)) return 'The name contains a control character.';
  if (Buffer.byteLength(name, 'utf8') > LIMITS.nameBytes) return 'The name is longer than 255 bytes.';
  return null;
}
