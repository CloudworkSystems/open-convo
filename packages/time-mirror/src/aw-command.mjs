#!/usr/bin/env node
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { awDays, activityWatchSource, fromSource } from './sources.mjs';

const BASE = 'http://127.0.0.1:5600';
const MAX_BYTES = 2 * 1024 * 1024;
const fail = message => { throw new Error(message); };

function argumentsFrom(values) {
  const options = { force: false, listApps: false };
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    if (argument === '--force') options.force = true;
    else if (argument === '--list-apps') options.listApps = true;
    else if (['--from', '--to', '--tz', '--host', '--tags', '--out', '--base'].includes(argument)) {
      const value = values[++index];
      if (!value || value.startsWith('--')) fail(`Missing value for ${argument}.`);
      options[argument.slice(2)] = value;
    } else fail(`Unknown option: ${argument}.`);
  }
  for (const name of ['from', 'to', 'tz', 'host', 'tags']) if (!options[name]) fail(`Missing --${name}.`);
  if (!options.listApps && !options.out) fail('Missing --out.');
  if ((options.base ?? BASE) !== BASE) fail('ActivityWatch can only be read at 127.0.0.1:5600.');
  return options;
}

export function makeFetchJson(fetchImpl = fetch, timeoutMs = 10_000) {
  return async path => {
    if (!/^\/api\/0\/buckets\/(?:$|[^/]+\/events\?start=[^&]+&end=.+$)/.test(path)) fail('Refused an unexpected ActivityWatch path.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(`${BASE}${path}`, { redirect: 'manual', signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') fail('ActivityWatch took longer than 10 seconds to answer. Open ActivityWatch, then run this again.');
      fail("ActivityWatch isn't answering at 127.0.0.1:5600. Open ActivityWatch, then run this again.");
    } finally { clearTimeout(timeout); }
    if (response.status >= 300 && response.status < 400) fail('ActivityWatch tried to redirect the request. Check the local ActivityWatch setup.');
    if (!response.ok) fail(`ActivityWatch answered with HTTP ${response.status}. Open ActivityWatch and try again.`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) return { truncated: true };
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); return { truncated: true }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { fail('ActivityWatch returned malformed JSON. Open ActivityWatch and try again.'); }
  };
}

async function tagsFrom(path) {
  let value;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { fail(`Could not read the tags file at ${path}. Check the path and JSON, then run this again.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('The tags file must contain one JSON object.');
  return value;
}

async function writePrivate(path, contents, force) {
  const target = resolve(path);
  if (!force) {
    try { await readFile(target); fail(`Refused to overwrite ${target}. Use --force if you want to replace it.`); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = `${dirname(target)}/.${randomBytes(12).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

export async function run(values, { fetchImpl = fetch, stdout = console.log } = {}) {
  const options = argumentsFrom(values);
  const appTags = await tagsFrom(options.tags);
  const common = { from: options.from, to: options.to, timeZone: options.tz, host: options.host, appTags, fetchJson: makeFetchJson(fetchImpl) };
  if (options.listApps) {
    const result = await awDays({ ...common, collectApps: true });
    for (const [app, minutes] of Object.entries(result.apps).sort(([left], [right]) => left.localeCompare(right))) stdout(`${app}\t${minutes.toFixed(2)} minutes`);
    if (Object.keys(result.apps).length === 0) stdout('No activity was found.');
    stdout(`Missing days: ${result.missing.length ? result.missing.join(', ') : 'none'}`);
    stdout(`Skipped malformed events: ${result.skipped}`);
    return result;
  }
  const result = await fromSource(activityWatchSource(common), common);
  let html = result.html;
  if (result.trackers.length === 0) html = html.replace('</main>', '<p>No activity was found.</p></main>');
  if (Object.keys(appTags).length === 0) html = html.replace('</main>', '<p>All activity is untagged. Run again with --list-apps to choose app tags.</p></main>');
  await writePrivate(options.out, html, options.force);
  stdout(`Wrote ${resolve(options.out)}`);
  stdout(`Missing days: ${result.missingDays.length ? result.missingDays.join(', ') : 'none'}`);
  stdout(`Skipped malformed events: ${result.skipped}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  run(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
