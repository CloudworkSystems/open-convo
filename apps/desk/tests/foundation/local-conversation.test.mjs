import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect as browserExpect } from '@playwright/test';

// Step 3 PR 4a: the Desk talking to a local model through the real native
// participant connection, codec and runtime, with the Mac host played inside
// the page. Invented models, digests and messages only; nothing leaves it.
const expect = browserExpect.configure({ timeout: 12_000 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let server; let browser; let origin; let output = '';
async function cleanup() {
  try { await browser?.close(); } finally {
    browser = undefined;
    if (server) {
      const running = server.exitCode === null && server.signalCode === null;
      const exited = running ? once(server, 'exit') : Promise.resolve();
      try { process.kill(-server.pid, 'SIGTERM'); } catch { if (running) server.kill('SIGTERM'); }
      if (!await Promise.race([exited.then(() => true), pause(2000).then(() => false)])) {
        try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); }
        await exited;
      }
      server = undefined;
    }
  }
}
before(async () => {
  try {
    const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
    origin = `http://127.0.0.1:${port}`;
    server = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: root, env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [server.stdout, server.stderr]) stream.on('data', (part) => { output = (output + part).slice(-8000); });
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (server.exitCode !== null) throw Error(output);
      try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Startup only. */ }
      await pause(100);
    }
    assert.ok(ready, output);
    const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
    browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
  } catch (error) { await cleanup(); throw error; }
}, { timeout: 25_000 });
after(cleanup);

// This entry and its in-page host exist only in the intercepted test request.
const harness = `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import '/brand/fonts/fonts.css';
import '/brand/tokens.css';
import '/src/shell/foundation.css';
import '/src/shell/nexus.css';
import '/src/app/recovery.css';
import { App } from '/src/app/App.tsx';
import { createNativeProofRuntime } from '/src/app/runtime.tsx';
import { createDemoState } from '/src/domain/demo.ts';
import { NativeHostClient } from '/src/adapters/native-host-client.ts';
import { NativeProofCodec, NATIVE_PROOF_LIMITS } from '/src/adapters/native-host-codec.ts';
import { NativeParticipantConnection } from '/src/adapters/native-participant-port.ts';
const options = window.__localOptions;
let fixtureId = 0;
const createId = () => '00000000-0000-4000-8000-' + String(++fixtureId).padStart(12, '0');
let stored = createDemoState({ id: createId });
stored.selection = { ...stored.selection, route: 'sessions', sessionId: stored.sessions[0].id };
if (options.choice) stored.sessions[0].participantChoice = options.choice;
const host = window.__localHost = {
  availability: options.availability, starts: [], stops: [], requests: [], saves: [], runs: new Map(), stopReply: 'stopped',
};
let active = true;
const invalidations = new Set();
const lifecycle = { isActive: () => active,
  subscribeInvalidation: (listener) => { invalidations.add(listener); return () => invalidations.delete(listener); },
  revoke: () => { if (!active) return; active = false; for (const listener of invalidations) listener(); } };
const repository = {
  loadLatest: async () => ({ kind: 'ready', state: structuredClone(stored) }),
  save: async (state, revision) => {
    host.saves.push(structuredClone(state));
    if (revision !== stored.revision) return { kind: 'conflict', error: 'Invented conflict.', attemptedState: state, currentState: stored };
    stored = structuredClone(state);
    return { kind: 'saved', state: structuredClone(stored) };
  },
  subscribe: () => () => {},
};
const context = { connectionId: 'invented-local-desk', documentGeneration: 1 };
const events = new EventTarget();
let deliver = () => {};
const push = (event) => events.dispatchEvent(new CustomEvent('trueconvo-host', { detail: { type: 'participant.event',
  connectionId: context.connectionId, generation: context.documentGeneration, event } }));
host.emit = (type, extra = {}) => {
  const run = [...host.runs.values()].at(-1);
  const event = { runId: run.runId, sessionId: run.sessionId, sequence: ++run.sequence, at: new Date().toISOString(), type, ...extra };
  if (['completed', 'stopped', 'failed'].includes(type)) run.terminal = event;
  run.events.push(event);
  push(event);
  return event;
};
function answer(request) {
  const { operation, payload } = request;
  host.requests.push(operation);
  const run = payload.runId && host.runs.get(payload.runId);
  switch (operation) {
    case 'participant.availability': return host.availability;
    case 'participant.start':
      if (options.refuseStart) { host.requests.push('refused-start'); return { outcome: 'refused', reason: options.refuseStart }; }
      host.starts.push({ payload: structuredClone(payload), saved: structuredClone(stored.conversationRuns.find((item) => item.runId === payload.runId)) });
      host.runs.set(payload.runId, { runId: payload.runId, sessionId: payload.sessionId, sequence: 0, events: [], terminal: null });
      setTimeout(() => host.emit('started'), 0);
      return { outcome: 'ok', runId: payload.runId };
    case 'participant.stop': {
      host.stops.push(payload.runId);
      if (!run.terminal) host.emit('stopped', { reason: 'local-stop' });
      return { outcome: 'ok', runId: payload.runId, state: 'exited', terminal: run.terminal, groupCleared: true, providerCancelConfirmed: false };
    }
    case 'participant.status':
      if (!run) return { outcome: 'refused', reason: 'unknown-run' };
      return run.terminal
        ? { outcome: 'ok', runId: run.runId, state: 'exited', lastSequence: run.terminal.sequence, terminal: run.terminal, groupCleared: true, unknownReason: null }
        : { outcome: 'ok', runId: run.runId, state: 'running', lastSequence: run.sequence, terminal: null, groupCleared: null, unknownReason: null };
    case 'participant.events': {
      const after = payload.afterSequence;
      const list = run.events.filter((event) => event.sequence > after).slice(0, payload.maxEvents);
      const last = list.length ? list.at(-1).sequence : after;
      return { outcome: 'ok', runId: run.runId, events: list, more: last < run.sequence, lastSequence: run.sequence, lost: null, terminal: null };
    }
    default: return { outcome: 'refused', reason: 'unknown-operation' };
  }
}
const transport = {
  listen(reply) { deliver = reply; return () => {}; },
  async send(wire) {
    const request = JSON.parse(wire);
    const response = answer(request);
    const { payload: _payload, ...base } = request;
    setTimeout(() => deliver(JSON.stringify({ ...base, ...response })), 0);
  },
};
let seq = 0;
const requestId = () => '30000000-0000-4000-8000-' + String(++seq).padStart(12, '0');
const codec = new NativeProofCodec(context, 256);
const client = new NativeHostClient(transport, codec, { ...context, maxWireBytes: NATIVE_PROOF_LIMITS.envelopeBytes, maxRetainedRequests: 256, timeoutMs: 5000 });
const connection = new NativeParticipantConnection({ client, context, workspaceHandle: 'invented-workspace', events, requestId });
const runtime = createNativeProofRuntime(repository, lifecycle, { createId, nativeParticipants: connection });
void connection.refreshAvailability();
window.__stored = () => structuredClone(stored);
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App, { runtime }));
`;

const digest = '0123456789abcdef'.repeat(4);
const cloudDigest = 'fedcba9876543210'.repeat(4);
const claude = { id: 'claude-code', label: 'Invented Claude', model: 'invented-claude-model', executionHost: 'this-mac', available: false, reason: 'overflow-unverified' };
const local = { id: 'ollama-local', label: 'invented-model:7b', model: `invented-model:7b@${digest}`, executionHost: 'this-mac' };
const ready = { outcome: 'ok', participants: [claude,
  { id: 'ollama-local', label: 'invented-cloud:cloud', model: `invented-cloud:cloud@${cloudDigest}`, executionHost: 'this-mac', available: false, reason: 'model-not-local' },
  { ...local, available: true, reason: null }],
routes: [{ route: 'ollama-local', state: 'ready', reason: null }] };
const down = (reason) => ({ outcome: 'ok', participants: [claude], routes: [{ route: 'ollama-local', state: 'unavailable', reason }] });

async function fixture({ availability = ready, choice, refuseStart } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; const outside = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((value) => { window.__localOptions = value; }, { availability, choice, refuseStart });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
    if (url.pathname === '/src/main.tsx') return route.fulfill({ contentType: 'application/javascript', body: harness });
    return route.continue();
  });
  await page.goto(origin);
  await expect.poll(() => errors.length ? errors.join('\n') : page.evaluate(() => Boolean(window.__localHost))).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  return {
    page,
    host: () => page.evaluate(() => ({ starts: window.__localHost.starts, stops: window.__localHost.stops, requests: window.__localHost.requests })),
    stored: () => page.evaluate(() => window.__stored()),
    emit: (type, extra) => page.evaluate(([kind, more]) => window.__localHost.emit(kind, more), [type, extra]),
    async send(text) {
      await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    },
    check() { assert.deepEqual(errors, []); assert.deepEqual(outside, []); },
    close: () => context.close(),
  };
}

test('choosing a local model shows who receives the message, and earlier turns go as context by run id', async () => {
  const f = await fixture();
  try {
    const { page } = f;
    await page.getByRole('button', { name: /^Model and participant/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Local · invented-model:7b · stays on this Mac' })).toBeVisible();
    await expect(dialog.getByText('This model runs on Ollama’s servers, not on this Mac.', { exact: false }).first()).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Cloud · invented-cloud:cloud · not on this Mac (can’t be used)' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /invented-cloud.*stays on this Mac/ })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Choose participant: Local · invented-model:7b · stays on this Mac' }).click();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.provider-label')).toContainText('Local · invented-model:7b · stays on this Mac');

    await f.send('Invented first question.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    const [first] = (await f.host()).starts;
    assert.deepEqual(first.payload.participant, local);
    assert.deepEqual(first.saved.contextRunIds, [], 'the prepared run was saved, with no earlier turns, before Start');
    await expect(page.locator('[data-run-id]').first()).toContainText('Response in progress');
    await f.emit('text', { text: 'Invented first ' });
    await f.emit('text', { text: 'reply.' });
    await expect(page.locator('[data-run-id]').first()).toContainText('Invented first reply.');
    await f.emit('completed');
    await expect(page.locator('[data-run-id]').first()).toContainText('Reply complete · stayed on this Mac');
    await expect(page.locator('[data-run-id]').first()).toContainText('This Mac · stays on this Mac');
    await expect.poll(async () => (await f.stored()).conversationRuns?.[0]?.phase).toBe('completed');

    await f.send('Invented follow-up.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(2);
    const second = (await f.host()).starts[1];
    assert.deepEqual(second.saved.contextRunIds, [first.payload.runId]);
    assert.equal(JSON.stringify(second.payload).includes('Invented first reply.'), false, 'context goes by run id, never as text from the page');
    f.check();
  } finally { await f.close(); }
});

test('Stop ends a local reply, keeps its text and offers Retry, which only refills the message box', async () => {
  const f = await fixture({ choice: local });
  try {
    const { page } = f;
    await f.send('Invented question to stop.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    await f.emit('text', { text: 'Invented partial' });
    await expect(page.locator('[data-run-id]')).toContainText('Invented partial');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.locator('[data-run-id]')).toContainText('Stopped. The reply so far is kept.');
    assert.equal((await f.host()).stops.length, 1);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented question to stop.');
    assert.equal((await f.host()).starts.length, 1, 'Retry never sends on its own');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await f.host()).starts.length).toBe(2);
    const [old, fresh] = (await f.host()).starts;
    assert.notEqual(old.payload.runId, fresh.payload.runId, 'a retried message is a new run with new ids');
    assert.deepEqual(fresh.saved.contextRunIds, [], 'a stopped reply is not sent as context');
    f.check();
  } finally { await f.close(); }
});

test('a reply cut off at the length limit says so plainly and offers Retry', async () => {
  const f = await fixture({ choice: local });
  try {
    await f.send('Invented long question.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    await f.emit('text', { text: 'Invented long' });
    await f.emit('failed', { reason: 'reply-too-long' });
    await expect(f.page.locator('[data-run-id]')).toContainText('Reply cut off: it reached the length limit for one conversation.');
    await expect(f.page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    f.check();
  } finally { await f.close(); }
});

test('with Ollama not running, the picker and composer say why and nothing is sent', async () => {
  const f = await fixture({ availability: down('ollama-not-running'), choice: local });
  try {
    const { page } = f;
    await expect(page.locator('#send-blocked-reason')).toContainText('Ollama is not running on this Mac.');
    // The saved pin can't be classified while the route is down: neutral, never "stays on this Mac".
    await expect(page.locator('.provider-label')).toContainText('Ollama · invented-model:7b · not available right now');
    await expect(page.locator('.provider-label')).not.toContainText('stays on this Mac');
    await expect(page.getByRole('button', { name: /^Model and participant/ })).toContainText('Ollama · invented-model:7b');
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented question.');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: /^Model and participant/ }).click();
    await expect(page.getByRole('dialog').locator('[data-local-route-notice]')).toContainText('Ollama is not running on this Mac.');
    assert.deepEqual((await f.host()).starts, []);
    f.check();
  } finally { await f.close(); }
});

test('a saved local model whose tag now names another model is reported as changed', async () => {
  const moved = structuredClone(ready);
  moved.participants[2].model = `invented-model:7b@${cloudDigest}`;
  const f = await fixture({ availability: moved, choice: local });
  try {
    await expect(f.page.locator('#send-blocked-reason')).toContainText('invented-model:7b changed in Ollama since you chose it');
    assert.deepEqual((await f.host()).starts, []);
    f.check();
  } finally { await f.close(); }
});

test('a start refused because the earlier turns changed says nothing was sent and how to continue', async () => {
  const f = await fixture({ choice: local, refuseStart: 'run-mismatch' });
  try {
    await f.send('Invented question.');
    await expect(f.page.locator('[data-run-id]')).toContainText('The earlier part of this conversation changed before sending, so nothing was sent.');
    assert.deepEqual((await f.host()).starts, []);
    await f.page.getByRole('button', { name: 'Close as unknown', exact: true }).click();
    await expect(f.page.locator('[data-run-id]')).toContainText('Closed before any reply arrived.');
    await f.page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented question.');
    f.check();
  } finally { await f.close(); }
});

test('a saved cloud choice is never called local, in the picker or above the conversation', async () => {
  const cloudChoice = { id: 'ollama-local', label: 'invented-cloud:cloud', model: `invented-cloud:cloud@${cloudDigest}`, executionHost: 'this-mac' };
  const f = await fixture({ choice: cloudChoice });
  try {
    const { page } = f;
    await expect(page.locator('.provider-label')).toContainText('Cloud · invented-cloud:cloud · not on this Mac (can’t be used)');
    await expect(page.locator('.provider-label')).not.toContainText('stays on this Mac');
    await expect(page.locator('#send-blocked-reason')).toContainText('runs on Ollama’s servers, not on this Mac');
    await expect(page.getByRole('button', { name: /^Model and participant/ })).toContainText('Cloud · invented-cloud:cloud');
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented question.');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    assert.deepEqual((await f.host()).starts, []);
    f.check();
  } finally { await f.close(); }
});

test('a saved remote pin without a ":cloud" name that later disappears is never called local', async () => {
  const remotePin = { id: 'ollama-local', label: 'invented-remote:20b', model: `invented-remote:20b@${cloudDigest}`, executionHost: 'this-mac' };
  const f = await fixture({ choice: remotePin });
  try {
    const { page } = f;
    await expect(page.locator('.provider-label')).toContainText('Ollama · invented-remote:20b · no longer installed');
    await expect(page.locator('.provider-label')).not.toContainText('stays on this Mac');
    await page.getByRole('button', { name: /^Model and participant/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Ollama · invented-remote:20b · no longer installed' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Local · invented-model:7b · stays on this Mac' })).toBeVisible();
    const saved = dialog.getByRole('region', { name: 'Saved participant selection' });
    await expect(saved).toContainText('Process location' + 'Unknown right now');
    await expect(saved).not.toContainText('this-mac');
    await expect(saved).not.toContainText('stays on this Mac');
    assert.deepEqual((await f.host()).starts, []);
    f.check();
  } finally { await f.close(); }
});
