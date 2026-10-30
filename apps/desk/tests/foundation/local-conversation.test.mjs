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
// A conversation reopened after the app was killed mid-reply (step 3 PR 5):
// an earlier completed turn, and a turn whose saved reply stops at sequence
// 2 with no ending. The host answers for it as the Mac does after a crash:
// status unknown / exit-unrecorded, events lost (restarted) with no ending.
if (options.restored) {
  const sessionId = stored.sessions[0].id;
  const at = stored.updatedAt;
  const run = (ids, input, extra) => ({ version: 1, runId: ids[0], sessionId, userMessageId: ids[1], assistantMessageId: ids[2],
    participant: options.choice, inputChunks: [input], outputChunks: [], lastSequence: 0, phase: 'prepared', createdAt: at,
    updatedAt: at, contextRunIds: [], ...extra });
  const earlier = run(options.restored.earlier, 'Invented earlier question.',
    { phase: 'completed', outputChunks: ['Invented earlier answer.'], lastSequence: 3 });
  const cut = run(options.restored.cut, 'Invented question cut off by a crash.',
    { phase: 'running', outputChunks: ['Invented partial reply '], lastSequence: 2, contextRunIds: [earlier.runId] });
  // A workspace that holds runs is schema 2, as the page saves it.
  stored.schemaVersion = 2;
  stored.capabilities = { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' };
  stored.conversationRuns = [earlier, cut];
  host.runs.set(cut.runId, { runId: cut.runId, sessionId, sequence: 2, events: [], terminal: null, crashed: true });
}
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
      if (!options.holdStarted) setTimeout(() => host.emit('started'), 0);
      return { outcome: 'ok', runId: payload.runId };
    case 'participant.stop': {
      host.stops.push(payload.runId);
      if (!run.terminal) host.emit('stopped', { reason: 'local-stop' });
      return { outcome: 'ok', runId: payload.runId, state: 'exited', terminal: run.terminal, groupCleared: true, providerCancelConfirmed: false };
    }
    case 'participant.status':
      if (!run) return { outcome: 'refused', reason: 'unknown-run' };
      if (run.crashed) return { outcome: 'ok', runId: run.runId, state: 'unknown', lastSequence: null, terminal: null, groupCleared: null, unknownReason: 'exit-unrecorded' };
      return run.terminal
        ? { outcome: 'ok', runId: run.runId, state: 'exited', lastSequence: run.terminal.sequence, terminal: run.terminal, groupCleared: true, unknownReason: null }
        : { outcome: 'ok', runId: run.runId, state: 'running', lastSequence: run.sequence, terminal: null, groupCleared: null, unknownReason: null };
    case 'participant.events': {
      const after = payload.afterSequence;
      if (run.crashed) return { outcome: 'ok', runId: run.runId, events: [], more: false, lastSequence: null,
        lost: { fromSequence: after + 1, throughSequence: null, reason: 'restarted' }, terminal: null };
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
const runtime = createNativeProofRuntime(repository, lifecycle, { createId, nativeParticipants: connection, offerClaude: !!options.offerClaude });
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

async function fixture({ availability = ready, choice, refuseStart, holdStarted, restored, offerClaude } = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; const outside = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((value) => { window.__localOptions = value; }, { availability, choice, refuseStart, holdStarted, restored, offerClaude });
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
    await expect(page.locator('[data-run-id]')).toContainText('Stopped on this Mac. The reply so far is kept.');
    await expect(page.locator('[data-run-id]')).toContainText('This Mac · stays on this Mac');
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

test('step 3 trial: while a reply is being written, Send becomes a visible Stop that ends it from the keyboard', async () => {
  const f = await fixture({ choice: local });
  try {
    const { page } = f;
    await f.send('Invented question with a long reply.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    // A long reply scrolls the transcript's own Stop out of view: this is
    // what the owner hit in the trial.
    await f.emit('text', { text: Array.from({ length: 80 }, (_, line) => `Invented reply line ${line + 1}.`).join('\n') });
    await expect(page.locator('[data-run-id]')).toContainText('Invented reply line 80.');
    await expect(page.locator('.run-stop')).not.toBeInViewport();
    const composerStop = page.getByRole('button', { name: 'Stop reply', exact: true });
    await expect(composerStop).toBeVisible();
    await expect(composerStop).toBeInViewport();
    await expect(composerStop).toHaveText('Stop');
    await expect(composerStop).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toHaveCount(0);
    assert.ok(await composerStop.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) >= 13, 'Stop is normal-size text');
    await composerStop.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-run-id]')).toContainText('Stopped on this Mac. The reply so far is kept.');
    assert.equal((await f.host()).stops.length, 1, 'the composer Stop uses the same single stop request');
    // Once the stop is saved, the same button is Send again.
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop reply', exact: true })).toHaveCount(0);
    await expect(page.locator('[data-run-id]')).toContainText('Invented reply line 80.');
    // The reply's status is inside the reply, under its heading and above its
    // text, in larger text; the details row below it uses the past tense.
    const reply = page.getByRole('article', { name: 'Local invented-model:7b response' });
    const status = reply.locator('.run-phase');
    await expect(status).toHaveText('Stopped on this Mac. The reply so far is kept.');
    await expect(status).not.toContainText(/provider/i);
    assert.ok(await status.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) >= 15, 'the status is the most prominent line of the reply');
    assert.ok((await status.boundingBox()).y < (await reply.locator('.run-output').boundingBox()).y, 'the status comes before the reply text');
    assert.ok((await reply.locator('.run-participant').boundingBox()).y > (await reply.locator('.run-output').boundingBox()).y, 'the details come after the reply text');
    await expect(reply.locator('.run-participant')).toContainText('Where it ran');
    await expect(reply.locator('.run-participant')).not.toContainText('Running on');
    f.check();
  } finally { await f.close(); }
});

test('a reply cut off by a crash: the reopened Desk holds Send and Retry until Close as unknown is saved, then Retry sends exactly one new run', async () => {
  const restored = {
    earlier: ['24000000-0000-4000-8000-000000000001', '24000000-0000-4000-8000-000000000002', '24000000-0000-4000-8000-000000000003'],
    cut: ['24000000-0000-4000-8000-000000000011', '24000000-0000-4000-8000-000000000012', '24000000-0000-4000-8000-000000000013'],
  };
  const f = await fixture({ choice: local, restored });
  try {
    const { page } = f;
    const cut = page.locator(`[data-run-id="${restored.cut[0]}"]`);
    const box = page.getByRole('textbox', { name: 'Your message', exact: true });
    const sendButton = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(cut).toContainText('Invented partial reply');
    // The restored page reads status, then events, and is offered only
    // Close as unknown: no Retry yet, and Send waits on the unfinished run.
    await expect(page.getByRole('button', { name: 'Close as unknown', exact: true })).toBeVisible();
    await expect.poll(async () => (await f.host()).requests.filter((r) => r === 'participant.events').length).toBeGreaterThan(0);
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await box.fill('Invented other message.');
    await expect(sendButton).toBeDisabled();
    await box.fill('');
    const before = (await f.stored()).conversationRuns.find((run) => run.runId === restored.cut[0]);
    assert.equal(before.closure, undefined);

    await page.getByRole('button', { name: 'Close as unknown', exact: true }).click();
    await expect(cut).toContainText('Reply cut off. The text so far is kept; the Mac never recorded how it ended.');
    await expect.poll(async () => (await f.stored()).conversationRuns.find((run) => run.runId === restored.cut[0])?.closure?.kind).toBe('unknown');
    const closed = (await f.stored()).conversationRuns.find((run) => run.runId === restored.cut[0]);
    assert.equal(closed.closure.reason, 'user-closed');
    const { closure: _closure, ...rest } = closed;
    assert.deepEqual(rest, before, 'the closure changes nothing else: text, sequence and phase are kept');
    await box.fill('Invented other message.');
    await expect(sendButton).toBeEnabled();
    await box.fill('');

    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(box).toHaveValue('Invented question cut off by a crash.');
    assert.equal((await f.host()).starts.length, 0, 'Retry never sends on its own');
    await sendButton.click();
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    const [fresh] = (await f.host()).starts;
    assert.notEqual(fresh.payload.runId, restored.cut[0], 'a retried message is a new run with new ids');
    assert.deepEqual(fresh.payload.inputChunks.join(''), 'Invented question cut off by a crash.');
    assert.deepEqual(fresh.saved.contextRunIds, [restored.earlier[0]], 'the earlier completed turn is context; the cut-off one is not');
    await f.emit('text', { text: 'Invented retried reply.' });
    await f.emit('completed');
    await expect.poll(async () => (await f.stored()).conversationRuns.find((run) => run.runId === fresh.payload.runId)?.phase).toBe('completed');
    assert.deepEqual((await f.stored()).conversationRuns.find((run) => run.runId === restored.cut[0]), closed, 'the old run stays as it was');
    assert.equal((await f.host()).starts.length, 1, 'exactly one new start');
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
    // Step 3 trial: the reason is a visible notice at the top of the message
    // box, in normal-size text, announced as a status, and tied to Send.
    const notice = page.locator('.composer-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toBeInViewport();
    await expect(notice).toHaveText('Ollama is not running on this Mac. Open Ollama, then check again. Your draft is kept.');
    await expect(page.locator('.composer').getByRole('status')).toContainText('Ollama is not running on this Mac.');
    assert.ok(await notice.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)) >= 13, 'the notice is normal-size text');
    const noticeBox = await notice.boundingBox();
    const boxBounds = await page.getByRole('textbox', { name: 'Your message', exact: true }).boundingBox();
    assert.ok(noticeBox.y + noticeBox.height <= boxBounds.y + 1, 'the notice sits right above the message box');
    await expect(page.getByRole('button', { name: 'Send message', exact: true }))
      .toHaveAccessibleDescription('Ollama is not running on this Mac. Open Ollama, then check again. Your draft is kept.');
    await expect(page.locator('.conversation-footnote')).not.toContainText('Ollama');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented question.');
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

test('Stop before the Mac reported started says no reply started, never "stays on this Mac"', async () => {
  const f = await fixture({ choice: local, holdStarted: true });
  try {
    const { page } = f;
    await f.send('Invented question stopped early.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    const transcript = page.locator('[data-run-id]');
    await expect(transcript).toContainText('Stopped before any reply started.');
    await expect(transcript).toContainText('No reply started');
    await expect(transcript).not.toContainText('stays on this Mac');
    await expect(transcript.getByRole('heading', { name: 'Ollama · invented-model:7b' })).toBeVisible();
    f.check();
  } finally { await f.close(); }
});

// Claude Code adapter PR 4a: the off-Mac Claude entry (contract section 21),
// listed only where the integration asks (PR 4b does). Invented text only.
const offMac = { id: 'claude-code', label: 'Claude', model: 'invented-pinned-model', executionHost: 'anthropic' };
const withClaude = { outcome: 'ok', participants: [
  { ...offMac, available: true, reason: null, confirmation: { state: 'active', confirmedAt: '2026-10-29T03:30:00.000Z', runsLeft: 5 } },
  { ...local, available: true, reason: null }],
routes: [{ route: 'ollama-local', state: 'ready', reason: null }] };
const claudeTitle = 'Claude · invented-pinned-model · Anthropic (not on this Mac)';
const destination = (page) => page.locator('[data-send-destination]');

test('Claude stays out of the picker unless the integration lists it (owner decision, October 16)', async () => {
  const f = await fixture({ availability: withClaude });
  try {
    const { page } = f;
    await page.getByRole('button', { name: /^Model and participant/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Local · invented-model:7b · stays on this Mac' })).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /Claude/ })).toHaveCount(0);
    f.check();
  } finally { await f.close(); }
});

test('Claude stays out of the picker from a host with no local route too (independent review on #205)', async () => {
  const f = await fixture({ availability: { outcome: 'ok', participants: [withClaude.participants[0]] } });
  try {
    const { page } = f;
    await page.getByRole('button', { name: /^Model and participant/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('No approved participants are listed.').first()).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /Claude/ })).toHaveCount(0);
    f.check();
  } finally { await f.close(); }
});

test('Claude is named "Anthropic (not on this Mac)"; the line above the box counts the earlier turns, a local one included, and they go by run id', async () => {
  const f = await fixture({ availability: withClaude, choice: local, offerClaude: true });
  try {
    const { page } = f;
    await expect(destination(page)).toHaveCount(0, { message: 'a local model has no off-Mac line' });
    await f.send('Invented local question.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    await f.emit('text', { text: 'Invented local answer.' });
    await f.emit('completed');
    await expect.poll(async () => (await f.stored()).conversationRuns?.[0]?.phase).toBe('completed');

    await page.getByRole('button', { name: /^Model and participant/ }).click();
    const dialog = page.getByRole('dialog');
    const entry = dialog.locator('li', { has: page.getByRole('heading', { name: claudeTitle }) });
    await expect(entry).toContainText('Claude Code, on your Claude plan');
    await expect(entry).toContainText('Anthropic (not on this Mac)');
    await expect(entry).not.toContainText('stays on this Mac');
    await dialog.getByRole('button', { name: `Choose participant: ${claudeTitle}` }).click();
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(destination(page)).toHaveText('Sends this message and 1 earlier turn to Anthropic.');

    await f.send('Invented question for Claude.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(2);
    const [first, second] = (await f.host()).starts;
    assert.deepEqual(second.payload.participant, offMac);
    assert.deepEqual(second.saved.contextRunIds, [first.payload.runId], 'the local turn is sent as context');
    assert.equal(JSON.stringify(second.payload).includes('Invented local answer.'), false, 'context goes by run id, never as text from the page');
    await expect(page.locator('[data-run-id]').nth(1)).toContainText('Anthropic (not on this Mac)');
    f.check();
  } finally { await f.close(); }
});

test('the earlier turns and the new message share the 4,096-byte trial limit: the oldest turns stay out, and a message past it alone is held', async () => {
  const f = await fixture({ availability: withClaude, choice: offMac, offerClaude: true });
  try {
    const { page } = f;
    await expect(destination(page)).toHaveText('Sends this message to Anthropic, with no earlier turns.');
    await f.send('a'.repeat(2500));
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    await f.emit('text', { text: 'Invented reply.' });
    await f.emit('completed');
    await expect.poll(async () => (await f.stored()).conversationRuns?.[0]?.phase).toBe('completed');
    const box = page.getByRole('textbox', { name: 'Your message', exact: true });
    await box.fill('b'.repeat(100));
    await expect(destination(page)).toHaveText('Sends this message and 1 earlier turn to Anthropic.');
    await box.fill('b'.repeat(2000));
    await expect(destination(page)).toHaveText('Sends this message to Anthropic, with no earlier turns. The oldest turn stays on this Mac to fit the current trial’s limit.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await f.host()).starts.length).toBe(2);
    assert.deepEqual((await f.host()).starts[1].saved.contextRunIds, []);
    await f.emit('completed');
    await expect.poll(async () => (await f.stored()).conversationRuns?.[1]?.phase).toBe('completed');
    await box.fill('c'.repeat(4097));
    await expect(page.locator('#send-blocked-reason')).toContainText('too long for the current trial');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    assert.equal((await f.host()).starts.length, 2);
    f.check();
  } finally { await f.close(); }
});

test('Stop ends a Claude reply and offers Retry, which only refills the message box', async () => {
  const f = await fixture({ availability: withClaude, choice: offMac, offerClaude: true });
  try {
    const { page } = f;
    await f.send('Invented Claude question to stop.');
    await expect.poll(async () => (await f.host()).starts.length).toBe(1);
    await f.emit('text', { text: 'Invented partial' });
    await expect(page.locator('[data-run-id]')).toContainText('Invented partial');
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented Claude question to stop.');
    assert.equal((await f.host()).starts.length, 1, 'Retry never sends on its own');
    f.check();
  } finally { await f.close(); }
});
