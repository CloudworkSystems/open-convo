import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { backup, getAccessToken, runBackupCommand } from '../scripts/backup.mjs';
import worker, { AgentWire } from '../src/worker.js';
import { createAgentWireServer } from '../src/node-server.js';
import { MemoryStore, SqlStore } from '../src/storage.js';
import { readLimited } from '../src/handler.js';
import { UNKNOWN, RESTORING, FULL, EMPTY, NO_AGENTS } from '../src/errors.js';

// Invented keys exist only in this process. No key files or remote key fetch.
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicKey = { ...await crypto.subtle.exportKey('jwk', pair.publicKey), kid: 'invented-key', alg: 'RS256', use: 'sig' };
const keySet = { keys: [publicKey] };
const TEAM = 'https://invented-team.cloudflareaccess.com';
const EPOCH = Date.parse('2026-11-16T00:00:00.000Z');
const baseEnv = { ACCESS_TEAM: TEAM, ACCESS_AUD: 'invented-audience', OWNER_EMAIL: 'owner@example.test' };
const claimsFor = (who) => who === 'cam' || who === 'other' ? { common_name: who + '-invented.access', sub: '' } : { email: who + '@example.test', sub: who + '-invented-subject' };
const encode = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function sign(claims, header = {}) {
  const head = encode({ alg: 'RS256', kid: 'invented-key', ...header });
  const body = encode({ iss: TEAM, type: 'app', aud: [baseEnv.ACCESS_AUD], iat: EPOCH / 1000, exp: EPOCH / 1000 + 30 * 86400, ...claims });
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + Buffer.from(signature).toString('base64url');
}
const tokens = Object.fromEntries(await Promise.all(['owner', 'cam', 'claude', 'other', 'unknown'].map(async (who) => [who, await sign(claimsFor(who))])));
const rpc = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const textNote = (to = 'owner') => ({ to, subject: 'Invented subject marker', body: 'Invented body marker https://never-open.example.test/' });
const errorOf = (payload) => payload.error ?? payload.result?.structuredContent?.error;
const dataOf = (payload) => payload.result?.structuredContent;
const source = (name) => readFileSync(new URL('../src/' + name, import.meta.url), 'utf8');
const fullRunLogs = [];

// Feed raw HTTP through Node's actual HTTP connection parser and runner,
// using a Duplex instead of an OS socket. Restricted builders cannot listen
// on TCP ports. No alternate application handler or direct tool calls here.
function rawHttp(server, input) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = new Duplex({
      allowHalfOpen: true,
      read() {},
      write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
    });
    socket.setTimeout = () => socket;
    socket.setNoDelay = () => socket;
    socket.setKeepAlive = () => socket;
    socket.destroySoon = () => socket.end();
    socket.on('error', reject);
    socket.on('finish', () => { resolve(Buffer.concat(chunks)); socket.destroy(); });
    server.emit('connection', socket);
    socket.push(Buffer.isBuffer(input) ? input : Buffer.from(input));
    // Keep the client read side open until the asynchronous response ends.
    // Connection: close (or the explicit protocol-error handler) ends the
    // server write side after the complete response has been captured.
  });
}

function httpResponse(raw) {
  const split = raw.indexOf('\r\n\r\n');
  assert.ok(split > 0, 'Node returned HTTP headers');
  const lines = raw.subarray(0, split).toString().split('\r\n');
  const status = Number(lines.shift().split(' ')[1]);
  const headers = new Headers(lines.map((line) => { const i = line.indexOf(':'); return [line.slice(0, i), line.slice(i + 1).trim()]; }));
  let body = raw.subarray(split + 4);
  if (headers.get('transfer-encoding') === 'chunked') {
    const chunks = [];
    while (body.length) {
      const end = body.indexOf('\r\n');
      const length = Number.parseInt(body.subarray(0, end).toString(), 16);
      assert.ok(Number.isSafeInteger(length) && length >= 0);
      if (!length) break;
      chunks.push(body.subarray(end + 2, end + 2 + length));
      body = body.subarray(end + 2 + length + 2);
    }
    body = Buffer.concat(chunks);
    headers.delete('transfer-encoding');
  }
  return new Response(status === 202 || status === 204 ? null : body, { status, headers });
}

async function fixture(t, host, overrides = {}) {
  let time = EPOCH;
  const store = new MemoryStore();
  const logs = [];
  const responses = [];
  const env = { ...baseEnv, ...overrides };
  const options = { store, keySet, now: () => time, log: (record) => { logs.push(record); fullRunLogs.push(record); } };
  let send;
  let calls = 0;
  if (host === 'worker') {
    const object = new AgentWire({}, env, options);
    const binding = {
      idFromName(name) { assert.equal(name, 'mailbox'); return 'one-object'; },
      get(id) { assert.equal(id, 'one-object'); calls++; return object; },
    };
    send = (path, init) => worker.fetch(new Request('https://mailbox.example.test' + path, init), { MAILBOX: binding });
  } else {
    const server = createAgentWireServer(env, options);
    send = async (path, init) => {
      const body = Buffer.from(init.body ?? '');
      const headers = new Headers(init.headers);
      headers.set('Host', 'invented.example.test');
      headers.set('Connection', 'close');
      if (init.body !== undefined) headers.set('Content-Length', String(body.length));
      const head = [init.method + ' ' + path + ' HTTP/1.1', ...[...headers].map(([k, v]) => k + ': ' + v), '', ''].join('\r\n');
      return httpResponse(await rawHttp(server, Buffer.concat([Buffer.from(head), body])));
    };
  }
  const ask = async (message, who = 'owner', extra = {}) => {
    const { path = '/mcp', token = tokens[who], headers = {}, method = 'POST' } = extra;
    const response = await send(path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), ...headers },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: typeof message === 'string' ? message : JSON.stringify(message) }),
    });
    responses.push(response.clone());
    const raw = await response.text();
    return { response, payload: raw ? JSON.parse(raw) : null, raw };
  };
  const call = async (name, args = {}, who = 'owner', extra = {}) => (await ask(rpc(name, args), who, extra)).payload;
  const ok = async (name, args = {}, who = 'owner') => {
    const payload = await call(name, args, who);
    assert.equal(errorOf(payload), undefined, JSON.stringify(payload));
    return dataOf(payload);
  };
  const tick = (ms = 61000) => { time += ms; };
  const add = (agent, role = 'agent', mayWriteTo = ['owner']) => ok('add_agent', {
    identity: agent === 'cam' || agent === 'other' ? 'service:' + agent + '-invented.access' : 'user:' + agent + '@example.test', agent, role, mayWriteTo,
  });
  return { store, logs, responses, send, ask, call, ok, tick, add, workerCalls: () => calls };
}

// Each numbered scenario is run through the real Worker entry and the real
// HTTP Node runner. Both instantiate AgentWire with the same storage contract.
for (const host of ['worker', 'node']) {
  test(`plan 1 [${host}]: leave, list, answer and read only the recipient's reply`, async (t) => {
    const f = await fixture(t, host);
    await f.add('cam'); await f.add('other');
    const { note } = await f.ok('leave_note', textNote(), 'cam');
    assert.equal(note.from, 'cam');
    assert.deepEqual((await f.ok('list_notes')).notes, [note]);
    const answer = (await f.ok('answer_note', { id: note.id, body: 'Invented owner reply' })).note;
    assert.deepEqual((await f.ok('read_notes', {}, 'cam')).notes, [answer]);
    assert.deepEqual((await f.ok('read_notes', {}, 'other')).notes, []);
    assert.equal(answer.inReplyTo, note.id);
  });

  test(`plan 2 [${host}]: ignore a claimed sender and save the signed-in agent name`, async (t) => {
    const f = await fixture(t, host); await f.add('cam');
    const { note } = await f.ok('leave_note', { ...textNote(), from: 'owner' }, 'cam');
    assert.equal(note.from, 'cam');
    assert.equal(f.store.get('note', note.id).from, 'cam');
  });

  test(`plan 3 [${host}]: isolate agents, enforce recipient permission and deny every owner tool`, async (t) => {
    const f = await fixture(t, host, { CALLS_PER_MINUTE: 100 });
    await f.add('cam'); await f.add('other');
    const note = (await f.ok('leave_note', textNote(), 'cam')).note;
    await f.ok('answer_note', { id: note.id, body: 'Only Cam sees this' });
    assert.deepEqual((await f.ok('read_notes', {}, 'other')).notes, []);
    assert.match(errorOf(await f.call('leave_note', textNote('other'), 'cam')).message, /cannot write/);
    const ownerTools = (await f.ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).payload.result.tools.map((tool) => tool.name);
    for (const name of ownerTools) assert.match(errorOf(await f.call(name, {}, 'cam')).message, /cannot use/);
    assert.ok(ownerTools.includes('begin_import') && ownerTools.includes('send_draft'));
  });

  test(`plan 4 [${host}]: switching off and removing take effect next call; storage has no credentials`, async (t) => {
    const f = await fixture(t, host); await f.add('cam');
    await f.ok('leave_note', textNote(), 'cam');
    await f.ok('switch_agent', { agent: 'cam', on: false });
    assert.equal(errorOf(await f.call('read_notes', {}, 'cam')).message, UNKNOWN);
    await f.ok('switch_agent', { agent: 'cam', on: true });
    await f.ok('read_notes', {}, 'cam');
    await f.ok('remove_agent', { agent: 'cam' });
    assert.equal(errorOf(await f.call('read_notes', {}, 'cam')).message, UNKNOWN);
    const snapshot = JSON.stringify([...f.store.rows]);
    for (const token of Object.values(tokens)) assert.ok(!snapshot.includes(token));
    assert.ok(!/privateKey|client_secret|CF-Access-Client-Secret|BEGIN .*KEY/.test(snapshot));
    assert.deepEqual((await f.ok('list_agents')).agents, []);
  });

  test(`plan 5 [${host}]: refuse every query string without logging its token or path`, async (t) => {
    const f = await fixture(t, host);
    for (const path of ['/mcp?token=' + tokens.cam, '/?arbitrary=INVENTED_URL_SECRET', '/INVENTED_PATH_SECRET?x=y']) {
      const { payload } = await f.ask(rpc('list_notes'), 'owner', { path });
      assert.match(errorOf(payload).message, /headers/);
    }
    const logs = JSON.stringify(f.logs);
    assert.ok(!logs.includes(tokens.cam) && !logs.includes('INVENTED_URL_SECRET') && !logs.includes('INVENTED_PATH_SECRET'));
  });

  test(`plan 6 [${host}]: reject size excess, the 61st hourly note and the 11th minute call`, async (t) => {
    const f = await fixture(t, host); await f.add('cam');
    for (const args of [{ ...textNote(), subject: 's'.repeat(121) }, { ...textNote(), body: 'b'.repeat(8193) }, { ...textNote(), body: 'é'.repeat(4097) }]) {
      assert.ok(errorOf(await f.call('leave_note', args, 'cam')));
    }
    assert.equal((await f.ask('x'.repeat(16385), 'cam')).response.status, 413);
    // A fresh minute isolates rate counts from the preceding rejected inputs.
    f.tick();
    for (let i = 0; i < 60; i++) { await f.ok('leave_note', textNote(), 'cam'); f.tick(6101); }
    assert.match(errorOf(await f.call('leave_note', textNote(), 'cam')).message, /^Too many notes for now\. Try again in \d+ minutes\.$/);
    assert.equal(f.store.count('note'), 60);
    f.tick();
    for (let i = 0; i < 10; i++) await f.ok('read_notes', {}, 'cam');
    assert.equal(errorOf(await f.call('read_notes', {}, 'cam')).message, 'Too many notes for now. Try again in 1 minutes.');
    f.tick(60000);
    await f.ok('read_notes', {}, 'cam');
    f.tick(3600000);
    await f.ok('leave_note', textNote(), 'cam');
  });

  test(`plan 7 [${host}]: a full mailbox refuses new notes and keeps all old notes`, async (t) => {
    const f = await fixture(t, host, { NOTE_CAP: 3 }); await f.add('cam');
    const notes = [];
    for (let i = 0; i < 3; i++) notes.push((await f.ok('leave_note', textNote(), 'cam')).note);
    assert.equal(errorOf(await f.call('leave_note', textNote(), 'cam')).message, FULL);
    assert.deepEqual((await f.ok('list_notes')).notes, notes.sort((a, b) => a.id.localeCompare(b.id)));
    await f.ok('clear_notes', { ids: [notes[0].id] });
    await f.ok('leave_note', textNote(), 'cam');
    assert.equal(f.store.count('note'), 3);
  });

  test(`plan 8 [${host}]: exact empty, unknown, restoring, full and rate messages never echo a token`, async (t) => {
    const f = await fixture(t, host, { NOTE_CAP: 1 });
    assert.equal((await f.ok('list_notes')).message, EMPTY);
    assert.equal((await f.ok('list_agents')).message, NO_AGENTS);
    const agent = { identity: 'service:cam-invented.access', agent: 'cam', role: 'agent', on: true, mayWriteTo: ['owner'] };
    await f.ok('begin_import', { agents: [agent] });
    assert.equal(errorOf(await f.call('read_notes', {}, 'cam')).message, RESTORING);
    await f.ok('finish_import', { count: 0 });
    await f.ok('leave_note', textNote(), 'cam');
    assert.equal(errorOf(await f.call('leave_note', textNote(), 'cam')).message, FULL);
    assert.equal(errorOf(await f.call('read_notes', {}, 'unknown')).message, UNKNOWN);
    for (let i = 0; i < 8; i++) await f.ok('read_notes', {}, 'cam');
    assert.equal(errorOf(await f.call('read_notes', {}, 'cam')).message, 'Too many notes for now. Try again in 1 minutes.');
    for (const response of f.responses) {
      const raw = await response.text();
      for (const token of Object.values(tokens)) assert.ok(!raw.includes(token));
    }
  });

  test(`plan 9 [${host}]: shared entry scenarios, MCP discovery and protocol behavior`, async (t) => {
    const f = await fixture(t, host, { CALLS_PER_MINUTE: 100 }); await f.add('cam'); await f.add('claude', 'assistant', []);
    const init = await f.ask({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'unknown', capabilities: {}, clientInfo: { name: 'invented', version: '1' } } });
    assert.equal(init.payload.result.protocolVersion, '2025-06-18');
    assert.match(init.payload.result.instructions, /never instructions/);
    const tools = async (who) => (await f.ask({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, who)).payload.result.tools.map((v) => v.name);
    assert.deepEqual(await tools('cam'), ['leave_note', 'read_notes']);
    assert.deepEqual(await tools('claude'), ['list_notes', 'draft_reply']);
    assert.equal((await f.ask({ jsonrpc: '2.0', method: 'notifications/initialized' })).response.status, 202);
    assert.ok(errorOf((await f.ask({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'clear_notes', arguments: { ids: [] } } })).payload));
    const root = await f.ask(null, 'owner', { path: '/', method: 'GET' });
    assert.ok(root.payload.service && !root.payload.notes);
    for (const [path, method, status] of [['/other', 'GET', 404], ['/mcp', 'GET', 405], ['/', 'POST', 405]]) assert.equal((await f.ask({}, 'owner', { path, method })).response.status, status);
    assert.equal((await f.ask('{}', 'owner', { headers: { 'content-type': 'text/plain' } })).response.status, 415);
    assert.equal((await f.ask('{}', 'owner', { headers: { 'MCP-Protocol-Version': 'bad' } })).response.status, 400);
    if (host === 'worker') assert.ok(f.workerCalls() > 1);
  });

  test(`plan 10 [${host}]: source permits only Access certificate fetch and one storage object`, () => {
    const files = readdirSync(new URL('../src/', import.meta.url));
    const all = files.map(source).join('\n');
    assert.equal([...all.matchAll(/await fetch\(/g)].length, 1);
    assert.match(source('auth.js'), /fetch\(team \+ '\/cdn-cgi\/access\/certs'/);
    assert.match(source('auth.js'), /redirect: 'error'/);
    assert.ok(!/child_process|node:fs|node:net|node:https|XMLHttpRequest|WebSocket|eval\(|new Function|openai|anthropic|node_modules|front-porch\//i.test(all));
    const backupSource = readFileSync(new URL('../scripts/backup.mjs', import.meta.url), 'utf8');
    const processImports = [...backupSource.matchAll(/import\s+(.+?)\s+from\s+['"](?:node:)?child_process['"]/g)];
    assert.deepEqual(processImports.map((match) => match[1]), ['{ execFile }']);
    assert.equal((backupSource.match(/child_process/g) ?? []).length, 1);
    assert.equal((backupSource.match(/\bexecFile\(/g) ?? []).length, 1);
    assert.ok(!/\bshell\s*:|\b(?:exec|execSync|execFileSync|spawn|spawnSync|fork)\s*\(/.test(backupSource));
    assert.match(backupSource, /\['access', 'token', '-app=' \+ origin\]/);
    assert.match(backupSource, /timeout: 15000/);
    for (const name of files) {
      for (const match of source(name).matchAll(/from ['"]([^'"]+)['"]/g)) assert.ok(match[1].startsWith('./') || name === 'node-server.js' && ['node:http', 'node:url'].includes(match[1]));
    }
    const config = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
    assert.equal((config.match(/\[\[durable_objects.bindings\]\]/g) ?? []).length, 1);
    assert.match(config, /new_sqlite_classes = \["AgentWire"\]/);
    assert.match(config, /workers_dev = false/);
    assert.ok(!/^\s*(account_id|routes?|secrets)\s*=/m.test(config));
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
    assert.deepEqual(pkg.devDependencies, { wrangler: '4.153.0' });
    assert.equal(pkg.scripts.test, 'node --test test/*.test.js');
    assert.ok(!pkg.dependencies && !pkg.license);
    assert.equal(pkg.private, true);
  });

  test(`plan 11 [${host}]: verify signature, issuer, expiry, audience and identity; reject forged sign-ins`, async (t) => {
    const f = await fixture(t, host, { CALLS_PER_MINUTE: 100 }); await f.add('cam');
    const brokenSignature = tokens.owner.split('.').slice(0, 2).join('.') + '.' + encode(new Uint8Array(256).fill(42).toString());
    const bad = [null, brokenSignature,
      await sign({ ...claimsFor('owner'), exp: EPOCH / 1000 }),
      await sign({ ...claimsFor('owner'), aud: ['another-audience'] }),
      await sign({ ...claimsFor('owner'), iss: 'https://other.cloudflareaccess.com' }),
      await sign({ ...claimsFor('owner'), nbf: EPOCH / 1000 + 1 }),
      await sign({ ...claimsFor('owner') }, { alg: 'none' }),
      await sign({ ...claimsFor('owner') }, { kid: 'not-this-key' }),
    ];
    for (const token of bad) {
      const { response, payload } = await f.ask(rpc('list_notes'), 'owner', { token });
      assert.equal(response.status, 401);
      assert.equal(errorOf(payload).message, 'Sign in through Cloudflare Access.');
    }
    assert.equal(errorOf(await f.call('list_notes', {}, 'unknown')).message, UNKNOWN);
    const { note } = await f.ok('leave_note', { ...textNote(), from: 'claude' }, 'cam');
    assert.equal(note.from, 'cam');
    const hybrid = await sign({ ...claimsFor('cam'), email: baseEnv.OWNER_EMAIL });
    assert.match(errorOf((await f.ask(rpc('list_notes'), 'cam', { token: hybrid })).payload).message, /cannot use/);
    assert.equal((await f.ask(null, 'owner', { path: '/', method: 'GET', token: null })).response.status, 401);
  });

  test(`plan 12 [${host}]: every answer has security headers, errors hide details, logs contain only five safe fields`, async (t) => {
    const f = await fixture(t, host); await f.add('cam');
    await f.ok('leave_note', textNote(), 'cam');
    await f.call('read_notes', {}, 'unknown');
    await f.ask('invalid-json');
    await f.ask(null, 'owner', { path: '/', method: 'GET' });
    const put = f.store.put.bind(f.store);
    f.store.put = (kind, id, value) => { put(kind, id, value); if (kind === 'note') throw new Error('PRIVATE_STACK_DETAIL with ' + tokens.cam); };
    const failed = await f.ask(rpc('leave_note', textNote()), 'cam');
    assert.equal(failed.response.status, 500);
    assert.match(errorOf(failed.payload).reference, /^AW-[a-z0-9]{8}$/);
    assert.ok(!failed.raw.includes('PRIVATE_STACK_DETAIL') && !failed.raw.includes('Error:'));
    assert.equal(f.store.count('note'), 1, 'transaction rolls back a write that threw');
    for (const response of f.responses) {
      assert.equal(response.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const logs = JSON.stringify(f.logs);
    for (const forbidden of [textNote().subject, textNote().body, 'PRIVATE_STACK_DETAIL', ...Object.values(tokens), baseEnv.OWNER_EMAIL, 'application/json']) assert.ok(!logs.includes(forbidden));
    for (const record of f.logs) assert.deepEqual(Object.keys(record), ['time', 'route', 'agent', 'outcome', 'size']);
  });

  test(`plan 13 [${host}]: export and restore 1000 notes of 8 KB in pages with owner-only, size-safe import calls`, async (t) => {
    const f = await fixture(t, host);
    const agents = [
      { identity: 'service:cam-invented.access', agent: 'cam', mayWriteTo: ['owner'], role: 'agent', on: true },
      { identity: 'user:claude@example.test', agent: 'claude', mayWriteTo: [], role: 'assistant', on: false },
    ];
    await f.ok('begin_import', { agents });
    const original = Array.from({ length: 1000 }, (_, i) => ({ id: 'invented-' + String(i).padStart(4, '0'), from: i % 2 ? 'owner' : 'cam', to: i % 2 ? 'cam' : 'owner', subject: 'Invented backup note', body: 'b'.repeat(8192), createdAt: new Date(EPOCH + i).toISOString(), ...(i ? { inReplyTo: 'invented-' + String(i - 1).padStart(4, '0') } : {}) }));
    for (const note of original) {
      assert.ok(Buffer.byteLength(JSON.stringify(rpc('import_note', { note }))) < 16384);
      await f.ok('import_note', { note });
    }
    assert.ok(errorOf(await f.call('finish_import', { count: 999 })));
    assert.equal(errorOf(await f.call('read_notes', {}, 'cam')).message, RESTORING);
    await f.ok('finish_import', { count: 1000 });
    f.tick();
    let after;
    const exported = [];
    let pages = 0;
    do {
      const page = await f.ok('export_notes', after ? { after } : {});
      assert.equal(page.notes.length, 100);
      assert.deepEqual(page.agents, agents);
      exported.push(...page.notes); after = page.after; pages++;
    } while (after);
    assert.equal(pages, 10);
    assert.deepEqual(exported, original);
    f.tick();
    assert.ok(errorOf(await f.call('begin_import', { agents })));
    const target = await fixture(t, host);
    await target.ok('begin_import', { agents });
    for (const note of exported) await target.ok('import_note', { note });
    assert.equal(errorOf(await target.call('leave_note', textNote(), 'cam')).message, RESTORING);
    await target.ok('finish_import', { count: 1000 });
    assert.deepEqual(target.store.all('note'), f.store.all('note'));
    assert.deepEqual(target.store.all('agent'), f.store.all('agent'));
    assert.equal(errorOf(await target.call('leave_note', textNote(), 'cam')).message, FULL);
    for (const name of ['begin_import', 'import_note', 'finish_import']) assert.match(errorOf(await target.call(name, {}, 'cam')).message, /cannot use/);
  });

  test(`plan 14 [${host}]: assistant drafts stay private until the owner sends; all delivery and agent tools are denied`, async (t) => {
    const f = await fixture(t, host, { CALLS_PER_MINUTE: 100 }); await f.add('cam'); await f.add('claude', 'assistant', []);
    const { note } = await f.ok('leave_note', textNote(), 'cam');
    assert.equal((await f.ok('list_notes', {}, 'claude')).notes.length, 1);
    const { draft } = await f.ok('draft_reply', { id: note.id, body: 'Invented assistant draft' }, 'claude');
    assert.deepEqual((await f.ok('read_notes', {}, 'cam')).notes, []);
    const forbidden = ['send_draft', 'answer_note', 'clear_notes', 'add_agent', 'switch_agent', 'remove_agent', 'list_agents', 'list_drafts', 'export_notes', 'begin_import', 'import_note', 'finish_import', 'leave_note', 'read_notes'];
    for (const name of forbidden) assert.match(errorOf(await f.call(name, { draftId: draft.id, id: note.id, role: 'owner', identity: baseEnv.OWNER_EMAIL }, 'claude')).message, /cannot use/);
    assert.equal((await f.ok('list_drafts')).drafts.length, 1);
    const sent = (await f.ok('send_draft', { draftId: draft.id })).note;
    assert.equal(sent.from, 'owner'); assert.equal(sent.to, 'cam');
    assert.deepEqual((await f.ok('read_notes', {}, 'cam')).notes, [sent]);
    assert.deepEqual((await f.ok('list_drafts')).drafts, []);
    assert.ok(errorOf(await f.call('send_draft', { draftId: draft.id })));
  });
}

test('edge E1: streaming and declared size rejection stop reading early', async () => {
  let read = 0;
  let cancelled = false;
  const stream = new ReadableStream({ pull(c) { read++; c.enqueue(new Uint8Array(9000)); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const request = new Request('https://mailbox.example.test/mcp', { method: 'POST', body: stream, duplex: 'half' });
  await assert.rejects(readLimited(request, 16384), /too large/);
  assert.equal(read, 2); assert.equal(cancelled, true);
  let touched = false;
  const declared = new Request('https://mailbox.example.test/mcp', { method: 'POST', headers: { 'content-length': '16385' }, body: new ReadableStream({ pull() { touched = true; } }, { highWaterMark: 0 }), duplex: 'half' });
  await assert.rejects(readLimited(declared, 16384), /too large/);
  assert.equal(touched, false);
});

for (const host of ['worker', 'node']) {
  test(`edge E2-E8 [${host}]: schemas, text, timestamps, reply references, ordering and filters`, async (t) => {
    const f = await fixture(t, host, { CALLS_PER_MINUTE: 100 }); await f.add('cam'); await f.add('other');
    for (const args of [null, [], { ...textNote(), extra: 'bad' }, { ...textNote(), body: '' }, { ...textNote(), body: '<script>bad</script>' }, { ...textNote(), subject: '\u0000bad' }, { ...textNote(), inReplyTo: 'absent' }, { ...textNote(), role: 'owner' }]) assert.ok(errorOf(await f.call('leave_note', args, 'cam')));
    assert.ok(errorOf(await f.call('list_notes', { since: '2026-02-30T00:00:00.000Z' })));
    const first = (await f.ok('leave_note', { ...textNote(), body: 'é'.repeat(4096), subject: '😀'.repeat(120) }, 'cam')).note;
    const second = (await f.ok('leave_note', textNote(), 'cam')).note;
    const expected = [first, second].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual((await f.ok('list_notes', { from: 'cam', to: 'owner' })).notes, expected);
    assert.deepEqual((await f.ok('list_notes', { since: first.createdAt })).notes, []);
    assert.ok(errorOf(await f.call('leave_note', { ...textNote(), inReplyTo: first.id }, 'cam')));
    const reply = (await f.ok('answer_note', { id: first.id, body: 'Reply' })).note;
    const followup = (await f.ok('leave_note', { ...textNote(), inReplyTo: reply.id }, 'cam')).note;
    assert.equal(followup.inReplyTo, reply.id);
    const baseSize = Buffer.byteLength(JSON.stringify(rpc('leave_note', { ...textNote(), body: '' })));
    const escapeHeavy = { ...textNote(), body: '\n'.repeat(Math.floor((16384 - baseSize) / 2)) };
    assert.ok(Buffer.byteLength(JSON.stringify(rpc('leave_note', escapeHeavy))) <= 16384);
    assert.match(errorOf(await f.call('leave_note', escapeHeavy, 'cam')).message, /back up safely/);
    for (const message of ['{', [], { jsonrpc: '2.0', id: null, method: 'ping' }, { jsonrpc: '2.0', id: 1, method: 'ping', params: null }]) assert.ok(errorOf((await f.ask(message)).payload));
    assert.ok(errorOf(await f.call('constructor')));
    assert.ok(errorOf(await f.call('list_notes', JSON.parse('{"__proto__":"bad"}'))));
  });

  test(`edge E9-E12 [${host}]: unique identities, removed agents, restore validation and draft clearing`, async (t) => {
    const f = await fixture(t, host, { CALLS_PER_MINUTE: 100 }); await f.add('cam'); await f.add('claude', 'assistant', []);
    assert.ok(errorOf(await f.call('add_agent', { identity: 'user:owner@example.test', agent: 'owner', role: 'agent', mayWriteTo: [] })));
    assert.ok(errorOf(await f.call('add_agent', { identity: 'service:cam-invented.access', agent: 'other', role: 'agent', mayWriteTo: [] })));
    assert.ok(errorOf(await f.call('add_agent', { identity: 'service:other-invented.access', agent: 'other', role: 'unknown', mayWriteTo: [] })));
    assert.ok(errorOf(await f.call('add_agent', { identity: 'service:other-invented.access', agent: 'other', role: 'agent', mayWriteTo: ['absent'] })));
    const { note } = await f.ok('leave_note', textNote(), 'cam');
    const { draft } = await f.ok('draft_reply', { id: note.id, body: 'Draft' }, 'claude');
    await f.ok('switch_agent', { agent: 'cam', on: false });
    assert.ok(errorOf(await f.call('send_draft', { draftId: draft.id })));
    assert.equal(f.store.count('draft'), 1);
    await f.ok('clear_notes', { ids: [note.id, 'absent'] });
    assert.equal(f.store.count('draft'), 0);
    await f.ok('remove_agent', { agent: 'cam' });
    assert.ok(errorOf(await f.call('add_agent', { identity: 'service:other-invented.access', agent: 'cam', role: 'agent', mayWriteTo: ['owner'] })));
    const backup = await f.ok('export_notes');
    assert.equal(backup.agents.find((a) => a.agent === 'cam').removed, true);
    const target = await fixture(t, host, { CALLS_PER_MINUTE: 100 });
    await target.ok('begin_import', { agents: backup.agents });
    const restored = { id: 'kept', from: 'cam', to: 'owner', subject: 'Restored', body: 'Public', createdAt: '2026-11-01T00:00:00.000Z' };
    assert.ok(errorOf(await target.call('import_note', { note: { ...restored, from: 'absent' } })));
    assert.ok(errorOf(await target.call('import_note', { note: { ...restored, createdAt: 'not-a-date' } })));
    await target.ok('import_note', { note: restored });
    assert.ok(errorOf(await target.call('import_note', { note: restored })));
    assert.ok(errorOf(await target.call('add_agent', { identity: 'service:other-invented.access', agent: 'other', role: 'agent', mayWriteTo: [] })));
    await target.ok('finish_import', { count: 1 });
    assert.equal(errorOf(await target.call('read_notes', {}, 'cam')).message, UNKNOWN);
    assert.ok(errorOf(await target.call('import_note', { note: restored })));
    assert.ok(errorOf(await target.call('finish_import', { count: 1 })));
  });

  test(`edge E13-E15 [${host}]: settings fail closed, concurrent cap and volatile Node storage`, async (t) => {
    const invalid = await fixture(t, host, { ACCESS_TEAM: 'https://not-allowed.example.test' });
    assert.equal((await invalid.ask(rpc('list_notes'))).response.status, 503);
    const badLimit = await fixture(t, host, { NOTE_CAP: 0 });
    assert.equal((await badLimit.ask(rpc('list_notes'))).response.status, 503);
    const f = await fixture(t, host, { NOTE_CAP: 1, CALLS_PER_MINUTE: 100 }); await f.add('cam');
    const results = await Promise.all([f.call('leave_note', textNote(), 'cam'), f.call('leave_note', textNote(), 'cam')]);
    assert.equal(results.filter((v) => !errorOf(v)).length, 1);
    assert.equal(f.store.count('note'), 1);
    const fresh = await fixture(t, host);
    assert.equal((await fresh.ok('list_notes')).message, EMPTY);
    assert.equal((await fresh.ok('list_agents')).message, NO_AGENTS);
  });

  test(`edge E20 [${host}]: keep the entire agent list small enough for one begin_import call`, async (t) => {
    const f = await fixture(t, host, { REQUEST_BYTES: 2000, CALLS_PER_MINUTE: 100 });
    let refused = false;
    for (let i = 0; i < 30; i++) {
      const result = await f.call('add_agent', { identity: 'user:invented' + i + '@example.test', agent: 'invented' + i, role: 'agent', mayWriteTo: ['owner'] });
      if (errorOf(result)) { assert.match(errorOf(result).message, /restore safely/); refused = true; break; }
    }
    assert.ok(refused);
    const { agents } = await f.ok('export_notes');
    assert.ok(agents.length > 1);
    assert.ok(Buffer.byteLength(JSON.stringify(rpc('begin_import', { agents }))) <= 2000);
    const target = await fixture(t, host, { REQUEST_BYTES: 2000 });
    await target.ok('begin_import', { agents });
    await target.ok('finish_import', { count: 0 });
  });
}

test('edge E16: SQLite adapter uses parameterized rows and delegates atomic rollback', () => {
  const memory = new MemoryStore();
  const sql = { exec(statement, ...args) {
    if (statement.startsWith('CREATE TABLE')) return [];
    if (statement.startsWith('INSERT')) { memory.put(args[0], args[1], JSON.parse(args[2])); return []; }
    if (statement.startsWith('DELETE')) { memory.delete(...args); return []; }
    if (statement.startsWith('SELECT COUNT')) return [{ n: memory.count(args[0]) }];
    if (statement.includes('AND id = ?')) { const v = memory.get(...args); return v ? [{ value: JSON.stringify(v) }] : []; }
    if (statement.startsWith('SELECT value')) return memory.all(args[0]).map((v) => ({ value: JSON.stringify(v) }));
    assert.fail('Unexpected SQL statement');
  } };
  const store = new SqlStore({ sql, transactionSync: (fn) => memory.transaction(fn) });
  store.transaction(() => store.put('note', 'invented', { body: "Invented quote ' text" }));
  assert.equal(store.count('note'), 1);
  assert.equal(store.get('note', 'invented').body, "Invented quote ' text");
  assert.throws(() => store.transaction(() => { store.delete('note', 'invented'); throw new Error('rollback'); }));
  assert.equal(store.all('note').length, 1);
  store.delete('note', 'invented'); assert.equal(store.count('note'), 0);
});

test('edge E17: Node rejects malformed HTTP with security headers and stays alive', async (t) => {
  const server = createAgentWireServer(baseEnv, { keySet, log: () => {}, now: () => EPOCH });
  for (const message of ['CONNECT /mcp HTTP/1.1\r\nHost: x\r\n\r\n', 'GET http://[:: HTTP/1.1\r\nHost: x\r\n\r\n']) {
    const answer = (await rawHttp(server, message)).toString();
    assert.match(answer, /^HTTP\/1\.1 400 /);
    assert.match(answer, /x-content-type-options: nosniff/i);
  }
  // Chunked oversized input gets the service's refusal rather than a closed socket.
  const oversized = await rawHttp(server, 'POST /mcp HTTP/1.1\r\nHost: x\r\nConnection: close\r\nContent-Type: application/json\r\nCf-Access-Jwt-Assertion: ' + tokens.owner + '\r\nTransfer-Encoding: chunked\r\n\r\n4268\r\n' + 'x'.repeat(17000) + '\r\n0\r\n\r\n');
  assert.equal(httpResponse(oversized).status, 413);
  const good = await rawHttp(server, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\nCf-Access-Jwt-Assertion: ' + tokens.owner + '\r\n\r\n');
  assert.equal(httpResponse(good).status, 200);
});

test('plan 12: audit logs captured across the entire Worker and Node scenario run', () => {
  assert.ok(fullRunLogs.length > 4000);
  const text = JSON.stringify(fullRunLogs);
  for (const forbidden of [textNote().subject, textNote().body, 'Invented assistant draft', 'Invented owner reply', '@example.test', 'PRIVATE_STACK_DETAIL', 'INVENTED_URL_SECRET', ...Object.values(tokens)]) assert.ok(!text.includes(forbidden));
  for (const record of fullRunLogs) {
    assert.deepEqual(Object.keys(record), ['time', 'route', 'agent', 'outcome', 'size']);
    assert.ok(['/', '/mcp', 'other'].includes(record.route));
    assert.match(record.agent, /^[a-z][a-z0-9_-]{0,31}$/);
  }
});

const BACKUP_ORIGIN = 'https://mailbox.example.test';
const BACKUP_TOKEN = 'invented-client-app-token-never-print';
const BACKUP_SIGN_IN = 'The Access sign-in was refused or expired. Sign in again with: cloudflared access login <mailbox-origin>';
const BACKUP_STOPPED = 'Backup command stopped. Keep the backup and check the mailbox connection, sign-in, size limits and restore state.';
const backupReply = (data) => Response.json({ jsonrpc: '2.0', id: 1, result: { structuredContent: data } });

async function backupFile(t) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-wire-backup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'invented-backup.json');
}

function backupOutput(t) {
  const output = [];
  t.mock.method(console, 'log', (...args) => output.push(args.join(' ')));
  t.mock.method(console, 'error', (...args) => output.push(args.join(' ')));
  t.after(() => assert.ok(!output.join('\n').includes(BACKUP_TOKEN)));
  return output;
}

function backupEdge(f, requests = []) {
  return async (url, init) => {
    assert.equal(String(url), BACKUP_ORIGIN + '/mcp');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.ok(headers.get('cf-access-token') === BACKUP_TOKEN);
    assert.equal(headers.has('Cf-Access-Jwt-Assertion'), false);
    requests.push(JSON.parse(init.body).params);
    // This fake Access edge supplies the signed owner assertion only after
    // checking the client token. f.send runs the real Worker and AgentWire.
    headers.delete('cf-access-token');
    headers.set('Cf-Access-Jwt-Assertion', tokens.owner);
    return f.send('/mcp', { ...init, headers });
  };
}

test('backup: client token header and export/import round-trip through the real Worker behind a fake edge', async (t) => {
  const file = await backupFile(t);
  const output = backupOutput(t);
  const original = await fixture(t, 'worker');
  const agents = [{ identity: 'service:cam-invented.access', agent: 'cam', role: 'agent', on: false, mayWriteTo: ['owner'] }];
  const notes = Array.from({ length: 101 }, (_, i) => ({ id: 'invented-' + String(i).padStart(4, '0'), from: 'cam', to: 'owner', subject: 'Invented backup subject', body: 'Invented public note', createdAt: new Date(EPOCH + i).toISOString() }));
  await original.ok('begin_import', { agents });
  for (const note of notes) await original.ok('import_note', { note });
  await original.ok('finish_import', { count: notes.length });
  original.tick();
  const waits = [];
  const exports = [];
  let tokenCalls = 0;
  const getToken = async (origin) => { assert.equal(origin, BACKUP_ORIGIN); tokenCalls++; return BACKUP_TOKEN; };
  assert.equal(await runBackupCommand(['export', file, BACKUP_ORIGIN], {
    getToken, fetch: backupEdge(original, exports), wait: async (ms) => { waits.push(ms); original.tick(ms); },
  }), 0);
  assert.deepEqual(waits, [6100]);
  assert.deepEqual(exports.map((r) => r.name), ['export_notes', 'export_notes']);
  assert.deepEqual(exports[1].arguments, { after: notes[99].id });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, agents, notes });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.ok(!(await readFile(file, 'utf8')).includes(BACKUP_TOKEN));
  const target = await fixture(t, 'worker');
  const imports = [];
  assert.equal(await runBackupCommand(['import', file, BACKUP_ORIGIN], { getToken, fetch: backupEdge(target, imports) }), 0);
  assert.equal(imports[0].name, 'begin_import');
  assert.ok(imports.slice(1, -1).every((r) => r.name === 'import_note'));
  assert.equal(imports.at(-1).name, 'finish_import');
  assert.deepEqual(imports.at(-1).arguments, { count: notes.length });
  assert.deepEqual(target.store.all('note'), original.store.all('note'));
  assert.deepEqual(target.store.all('agent'), original.store.all('agent'));
  assert.ok(!JSON.stringify([...original.logs, ...target.logs]).includes(BACKUP_TOKEN));
  assert.equal(target.store.get('meta', 'restore'), undefined);
  assert.equal(tokenCalls, 2);
  assert.deepEqual(output, ['Exported 101 notes.', 'Restored 101 notes.']);
});

test('backup: any 3xx redirect asks the owner to sign in again without following it', async (t) => {
  const output = backupOutput(t);
  for (const status of [300, 301, 302, 303, 304, 307, 308, 399]) {
    assert.equal(await runBackupCommand(['export', 'unused.json', BACKUP_ORIGIN], {
      getToken: async () => BACKUP_TOKEN,
      fetch: async (_url, init) => {
        assert.equal(init.redirect, 'manual');
        return new Response(null, { status, headers: { location: 'https://login.example.test/' + BACKUP_TOKEN } });
      },
    }), 1);
  }
  assert.deepEqual(output, Array(8).fill(BACKUP_SIGN_IN));
});

test('backup: HTML login answers ask the owner to sign in again and never echo the page', async (t) => {
  const output = backupOutput(t);
  for (const contentType of ['text/html; charset=utf-8', 'application/xhtml+xml', 'application/json']) {
    assert.equal(await runBackupCommand(['export', 'unused.json', BACKUP_ORIGIN], {
      getToken: async () => BACKUP_TOKEN,
      fetch: async () => new Response('<!doctype html><html>' + BACKUP_TOKEN + '</html>', { headers: { 'content-type': contentType } }),
    }), 1);
  }
  assert.deepEqual(output, Array(3).fill(BACKUP_SIGN_IN));
});

test('backup: missing cloudflared uses the test-only program override and gives install/sign-in instructions', async (t) => {
  const file = await backupFile(t);
  const output = backupOutput(t);
  const env = { AGENT_WIRE_CLOUDFLARED: join(file, 'program-that-does-not-exist') };
  let fetched = false;
  assert.equal(await runBackupCommand(['export', file, BACKUP_ORIGIN], {
    env, fetch: async () => { fetched = true; throw new Error(BACKUP_TOKEN); },
  }), 1);
  assert.equal(fetched, false);
  assert.deepEqual(output, ["cloudflared isn't installed. Install it, then run: cloudflared access login <mailbox-origin>"]);
  await assert.rejects(getAccessToken(BACKUP_ORIGIN, { env }), /cloudflared isn't installed/);
});

test('backup: an expired sign-in or an empty token asks the owner to sign in again', async (t) => {
  const output = backupOutput(t);
  for (const getToken of [async () => { throw new Error('expired ' + BACKUP_TOKEN); }, async () => '', async () => '   ']) {
    assert.equal(await runBackupCommand(['export', 'unused.json', BACKUP_ORIGIN], {
      getToken, fetch: async () => assert.fail('No request without a token'),
    }), 1);
  }
  assert.deepEqual(output, Array(3).fill(BACKUP_SIGN_IN));
});

test('backup: network, JSON and mailbox errors never expose the token in messages or console output', async (t) => {
  const output = backupOutput(t);
  for (const fetch of [
    async () => { throw new Error(BACKUP_TOKEN); },
    async () => new Response('invalid JSON ' + BACKUP_TOKEN),
    async () => Response.json({ error: { message: BACKUP_TOKEN, reference: BACKUP_TOKEN } }, { status: 403 }),
  ]) {
    await assert.rejects(backup('export', 'unused.json', BACKUP_ORIGIN, { getToken: async () => BACKUP_TOKEN, fetch }), { message: BACKUP_STOPPED });
    assert.equal(await runBackupCommand(['export', 'unused.json', BACKUP_ORIGIN], { getToken: async () => BACKUP_TOKEN, fetch }), 1);
  }
  assert.deepEqual(output, Array(3).fill(BACKUP_STOPPED));
});

test('backup: export refuses an existing file and a changing agent list', async (t) => {
  const file = await backupFile(t);
  await writeFile(file, 'Invented existing backup');
  const options = { getToken: async () => BACKUP_TOKEN, fetch: async () => backupReply({ agents: [], notes: [], after: null }) };
  await assert.rejects(backup('export', file, BACKUP_ORIGIN, options), { message: BACKUP_STOPPED });
  assert.equal(await readFile(file, 'utf8'), 'Invented existing backup');
  let pages = 0;
  await assert.rejects(backup('export', file, BACKUP_ORIGIN, {
    ...options, wait: async (ms) => assert.equal(ms, 6100),
    fetch: async () => backupReply({ agents: pages++ ? [{ agent: 'changed' }] : [], notes: [], after: pages === 1 ? 'invented-cursor' : null }),
  }), /The agent list changed\. Pause changes and export again\./);
  assert.equal(await readFile(file, 'utf8'), 'Invented existing backup');
});

test('backup: import checks the 16 KB size limit and duplicate ids before beginning restore', async (t) => {
  const file = await backupFile(t);
  for (const saved of [
    { version: 1, agents: [], notes: [{ id: 'invented', body: 'x'.repeat(16384) }] },
    { version: 1, agents: [{ identity: 'x'.repeat(16384) }], notes: [] },
    { version: 1, agents: [], notes: [{ id: 'duplicate' }, { id: 'duplicate' }] },
  ]) {
    await writeFile(file, JSON.stringify(saved));
    await assert.rejects(backup('import', file, BACKUP_ORIGIN, {
      getToken: async () => BACKUP_TOKEN, fetch: async () => assert.fail('No requests before the pre-check succeeds'),
    }), /exceeds the configured size limit|Check the backup format and duplicate ids/);
  }
});

test('backup: resume checks existing agents and notes and imports only the remaining notes', async (t) => {
  const file = await backupFile(t);
  const output = backupOutput(t);
  const f = await fixture(t, 'worker');
  const agents = [{ identity: 'service:cam-invented.access', agent: 'cam', role: 'agent', on: false, mayWriteTo: ['owner'] }];
  const first = { id: 'invented-1', from: 'cam', to: 'owner', subject: 'Invented subject', body: 'Invented public body', createdAt: new Date(EPOCH).toISOString() };
  const second = { ...first, id: 'invented-2' };
  await writeFile(file, JSON.stringify({ version: 1, agents, notes: [first, second] }));
  await f.ok('begin_import', { agents });
  await f.ok('import_note', { note: first });
  const options = { getToken: async () => BACKUP_TOKEN, fetch: backupEdge(f), resume: true };
  // A differing agent list and a differing stored note each stop resume.
  await writeFile(file, JSON.stringify({ version: 1, agents: [], notes: [first, second] }));
  await assert.rejects(backup('import', file, BACKUP_ORIGIN, options), /restored agent list differs/);
  await writeFile(file, JSON.stringify({ version: 1, agents, notes: [{ ...first, body: 'Different invented body' }, second] }));
  await assert.rejects(backup('import', file, BACKUP_ORIGIN, options), /stored note differs/);
  await writeFile(file, JSON.stringify({ version: 1, agents, notes: [first, second] }));
  f.tick();
  const requests = [];
  assert.equal(await runBackupCommand(['import', file, BACKUP_ORIGIN], {
    env: { RESUME: '1' }, getToken: options.getToken, fetch: backupEdge(f, requests),
  }), 0);
  assert.deepEqual(requests.map((r) => r.name), ['export_notes', 'list_notes', 'import_note', 'finish_import']);
  assert.deepEqual(requests[2].arguments, { note: second });
  assert.deepEqual(f.store.all('note'), [first, second]);
  assert.deepEqual(output, ['Restored 2 notes.']);
});
