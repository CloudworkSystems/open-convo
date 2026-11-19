import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const STOPPED = 'Backup command stopped. Keep the backup and check the mailbox connection, sign-in, size limits and restore state.';
const SIGN_IN = 'The Access sign-in was refused or expired. Sign in again with: cloudflared access login <mailbox-origin>';
const MISSING = "cloudflared isn't installed. Install it, then run: cloudflared access login <mailbox-origin>";
class BackupError extends Error {}

// Capture both output streams. Never return child-process errors or output in
// a diagnostic: either may contain the app token.
export function getAccessToken(origin, { env = process.env } = {}) {
  return new Promise((resolveToken, reject) => {
    execFile(env.AGENT_WIRE_CLOUDFLARED || 'cloudflared', ['access', 'token', '-app=' + origin], {
      timeout: 15000, maxBuffer: 65536, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) return reject(new BackupError(error.code === 'ENOENT' ? MISSING : SIGN_IN));
      const token = stdout.trim();
      if (!token || /\s/.test(token)) return reject(new BackupError(SIGN_IN));
      resolveToken(token);
    });
  });
}

const envelope = (name, args) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

// All requests, including resume requests, use the same client token. Access
// verifies it at the edge and supplies the separate assertion to the Worker.
export async function backup(mode, file, mailboxOrigin, {
  fetch = globalThis.fetch, getToken = getAccessToken,
  wait = (ms) => new Promise((done) => setTimeout(done, ms)), resume = false,
} = {}) {
  try {
    const origin = new URL(mailboxOrigin);
    if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new BackupError('Use a protected HTTPS mailbox origin.');
    if (!['export', 'import'].includes(mode) || !file) throw new BackupError('Use: node scripts/backup.mjs export|import <file> <mailbox-origin>');
    let token;
    try {
      token = await getToken(origin.origin);
      if (typeof token !== 'string' || !token.trim() || /\s/.test(token)) throw new Error();
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError(SIGN_IN);
    }
    const call = async (name, args = {}) => {
      const response = await fetch(new URL('/mcp', origin), {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', 'cf-access-token': token },
        body: envelope(name, args),
      });
      if (response.status >= 300 && response.status < 400) throw new BackupError(SIGN_IN);
      if (/\b(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get('content-type') ?? '')) throw new BackupError(SIGN_IN);
      const text = await response.text();
      if (/^\s*</.test(text)) throw new BackupError(SIGN_IN);
      const reply = JSON.parse(text);
      const error = reply.error ?? reply.result?.structuredContent?.error;
      // Do not echo even a purported mailbox error: an edge response can
      // contain credentials or an HTML excerpt instead of a fixed diagnostic.
      if (!response.ok || error || reply.result?.isError || !reply.result?.structuredContent) throw new BackupError(STOPPED);
      return reply.result.structuredContent;
    };
    if (mode === 'export') {
      let after;
      let agents;
      const notes = [];
      do {
        const page = await call('export_notes', after ? { after } : {});
        if (agents && !isDeepStrictEqual(agents, page.agents)) throw new BackupError('The agent list changed. Pause changes and export again.');
        agents = page.agents;
        notes.push(...page.notes);
        after = page.after;
        if (after) await wait(6100);
      } while (after);
      await writeFile(file, JSON.stringify({ version: 1, agents, notes }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      return 'Exported ' + notes.length + ' notes.';
    }
    const saved = JSON.parse(await readFile(file, 'utf8'));
    if (saved.version !== 1 || !Array.isArray(saved.agents) || !Array.isArray(saved.notes) || new Set(saved.notes.map((n) => n.id)).size !== saved.notes.length) throw new BackupError('Check the backup format and duplicate ids.');
    // Match this to REQUEST_BYTES if the service uses a non-default setting.
    for (const text of [envelope('begin_import', { agents: saved.agents }), ...saved.notes.map((note) => envelope('import_note', { note }))]) {
      if (Buffer.byteLength(text) > 16384) throw new BackupError('A restore request exceeds the configured size limit. Keep the backup.');
    }
    let existing = [];
    if (resume) {
      const page = await call('export_notes');
      if (!isDeepStrictEqual(page.agents, saved.agents)) throw new BackupError('The restored agent list differs from the backup. Keep both copies.');
      existing = (await call('list_notes')).notes;
      for (const note of existing) {
        if (!isDeepStrictEqual(note, saved.notes.find((n) => n.id === note.id))) throw new BackupError('A stored note differs from the backup. Keep both copies.');
      }
    } else await call('begin_import', { agents: saved.agents });
    const ids = new Set(existing.map((n) => n.id));
    for (const note of saved.notes) if (!ids.has(note.id)) await call('import_note', { note });
    const done = await call('finish_import', { count: saved.notes.length });
    if (!Number.isSafeInteger(done.count) || done.count !== saved.notes.length) throw new BackupError(STOPPED);
    return 'Restored ' + done.count + ' notes.';
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError(STOPPED);
  }
}

export async function runBackupCommand(args, { env = process.env, ...options } = {}) {
  try {
    if (args.length !== 3) throw new BackupError('Use: node scripts/backup.mjs export|import <file> <mailbox-origin>');
    console.log(await backup(...args, { resume: env.RESUME === '1', getToken: (origin) => getAccessToken(origin, { env }), ...options }));
    return 0;
  } catch (error) {
    console.error(error instanceof BackupError ? error.message : STOPPED);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runBackupCommand(process.argv.slice(2));
}
