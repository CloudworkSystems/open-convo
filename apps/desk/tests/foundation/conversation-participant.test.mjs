import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect as browserExpect } from '@playwright/test';

// Stream checkpoints use the real five-second cadence. Prepared and final
// records still save immediately; no production timers or globals are replaced.
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

// This entry, invented participant and memory repository exist only in the
// intercepted test request. Production reads none of these globals/bindings.
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
import { applyCommand } from '/src/domain/commands.ts';
import { appendParticipantEvent } from '/src/domain/conversation-runs.ts';
import { canSaveConversationWorkspaceWithRuns, WORKSPACE_TEXT_LIMIT_BYTES } from '/src/domain/conversation-workspace.ts';
const fixtureOptions = await window.__participantFixtureOptions();
let fixtureId = fixtureOptions.idOffset;
const createId = () => '00000000-0000-4000-8000-' + String(++fixtureId).padStart(12, '0');
let seed = createDemoState({ id: createId });
const firstSessionId = seed.sessions[0].id;
seed = applyCommand(seed, { type: 'create-session', goalId: seed.goals[0].id }, { id: createId });
seed.sessions[1].title = 'Other invented session';
if (fixtureOptions.capacityDraftSession) {
  seed = applyCommand(seed, { type: 'create-session', goalId: seed.goals[0].id }, { id: createId });
  seed.sessions[2].title = 'Budget draft session';
}
seed.selection = { ...seed.selection, route: 'sessions', sessionId: firstSessionId };
let active = true;
const invalidations = new Set();
const lifecycle = {
  isActive: () => active,
  subscribeInvalidation: (listener) => { invalidations.add(listener); return () => invalidations.delete(listener); },
  revoke: () => { if (!active) return; active = false; for (const listener of invalidations) listener(); },
};
const repositoryListeners = new Set();
const repository = {
  loadLatest: async () => {
    const state = await window.__participantFixtureLoad(seed);
    if (fixtureOptions.legacyRunning || fixtureOptions.legacyIncomplete) {
      const run = state.conversationRuns[0];
      target = { runId: run.runId, sessionId: run.sessionId };
      sequences.set(run.runId, run.lastSequence);
    }
    return { kind: 'ready', state };
  },
  save: (state, revision) => window.__participantFixtureSave(state, revision),
  subscribe: (listener) => { repositoryListeners.add(listener); return () => repositoryListeners.delete(listener); },
};
const identity = Object.freeze({ id: 'invented-participant', label: 'Invented participant', model: fixtureOptions.model, executionHost: 'Invented worker' });
const listeners = new Set();
const everSubscribed = new Set();
const sequences = new Map();
let subscribeThrows = fixtureOptions.subscribeThrows;
let target;
let terminalEvidence;
function makeEvent(type, text, selected = target) {
  if (!selected) throw Error('No invented target selected');
  const sequence = (sequences.get(selected.runId) ?? 0) + 1;
  sequences.set(selected.runId, sequence);
  return { runId: selected.runId, sessionId: selected.sessionId, sequence, at: new Date().toISOString(), type,
    ...(type === 'text' ? { text } : {}) };
}
const port = {
  identity,
  subscribe: (listener) => {
    if (subscribeThrows) throw Error('Invented subscription refusal');
    listeners.add(listener); everSubscribed.add(listener); return () => listeners.delete(listener);
  },
  start: async (input) => {
    target = { runId: input.runId, sessionId: input.sessionId };
    const result = await window.__participantFixtureCall('start', input);
    if (result.kind !== 'accepted') return result;
    const started = makeEvent('started');
    for (const listener of listeners) listener(started);
    return { kind: 'accepted' };
  },
  stop: async (selected) => {
    const result = await window.__participantFixtureCall('stop', selected);
    if (result.kind === 'cleanup-uncertain') {
      terminalEvidence ??= { ...makeEvent('stopped', undefined, selected), reason: 'stop-incomplete' };
      return { ...result, event: terminalEvidence };
    }
    if (result.kind !== 'confirmed') return result;
    return { kind: 'confirmed', event: makeEvent('stopped', undefined, selected) };
  },
  reconcile: async (selected) => { await window.__participantFixtureCall('reconcile', selected); return { kind: 'unknown' }; },
  ...(fixtureOptions.cleanupStatus ? { status: async (selected) => {
    const result = await window.__participantFixtureCall('status', selected);
    if (result.kind !== 'status') return result;
    terminalEvidence ??= result.terminal;
    return { ...result, terminal: terminalEvidence ?? result.terminal ?? null, lastSequence: terminalEvidence?.sequence ?? result.lastSequence };
  } } : {}),
};
const runtime = createNativeProofRuntime(repository, lifecycle, {
  createId, ...(fixtureOptions.withoutParticipant ? {} : { participant: port }),
  ...(fixtureOptions.participantChoices === undefined ? {} : { participantChoices: fixtureOptions.participantChoices }),
});
window.__participantTest = {
  draftAtCapacity: (state, textEvent, sessionId) => {
    const previous = state.conversationRuns.find((run) => run.runId === textEvent.runId);
    const appended = previous.lastSequence === textEvent.sequence ? { kind: 'ok', run: previous } : appendParticipantEvent(previous, textEvent);
    if (appended.kind !== 'ok') throw Error('Invented fixture event must remain applicable');
    const viewed = applyCommand(state, { type: 'select-session', sessionId });
    let low = 0; let high = WORKSPACE_TEXT_LIMIT_BYTES;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      const edited = applyCommand(viewed, { type: 'set-draft', sessionId, text: 'p'.repeat(length) });
      if (canSaveConversationWorkspaceWithRuns(edited, [appended.run])) low = length;
      else high = length - 1;
    }
    if (!low || low === WORKSPACE_TEXT_LIMIT_BYTES) throw Error('Invented fixture must reach the aggregate boundary below the text limit');
    return 'p'.repeat(low);
  },

  notifyWorkspaceChange: () => { for (const listener of repositoryListeners) listener(); },
  revoke: () => lifecycle.revoke(),
  activeListeners: () => listeners.size,
  setSubscribeThrows: (value) => { subscribeThrows = value; },
  hold: (type, text) => makeEvent(type, text),
  deliver: (event) => { for (const listener of listeners) listener(event); },
  emit: (type, text) => { const event = makeEvent(type, text); for (const listener of listeners) listener(event); return event; },
  emitLate: (type, text) => { const event = makeEvent(type, text); for (const listener of everSubscribed) listener(event); return event; },
};
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App, { runtime }));
`;

async function fixture(config = {}) {
  const context = await browser.newContext({ viewport: config.viewport ?? { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = []; const outside = []; const protocolErrors = [];
  const calls = { loads: 0, saves: [], starts: [], stops: [], reconciles: [], statuses: [] };
  let stored; let block; let fail; let conflict; let startResult = 'accepted'; let stopResult = 'confirmed';
  let withoutParticipant = Boolean(config.withoutParticipant); let generation = 0; let model = 'Invented model'; const pending = [];
  let stopBlocked = false; const pendingStops = [];
  let statusResult = { kind: 'status', state: 'cleanup-pending', groupCleared: false, unknownReason: null };
  let externalRevision = false;
  let participantChoices = config.participantChoices === undefined ? undefined : structuredClone(config.participantChoices);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('__participantFixtureOptions', () => ({
    idOffset: generation++ * 100_000, withoutParticipant, model, participantChoices, subscribeThrows: Boolean(config.subscribeThrows),
    capacityDraftSession: Boolean(config.capacityDraftSession), legacyRunning: Boolean(config.legacyRunning),
    legacyIncomplete: Boolean(config.legacyIncomplete), cleanupStatus: Boolean(config.cleanupStatus),
  }));
  await page.exposeFunction('__participantFixtureLoad', (seed) => {
    calls.loads++;
    if (!stored) {
      stored = structuredClone(seed);
      if (config.futureSession) {
        const session = stored.sessions.find((entry) => entry.id === stored.selection.sessionId);
        const future = new Date(Date.now() + 86_400_000).toISOString();
        session.createdAt = future;
        session.updatedAt = future;
        stored.updatedAt = future;
      }
      if (config.input !== undefined) stored.drafts[stored.selection.sessionId] = config.input;
      if (config.participantChoice) {
        stored.sessions.find((session) => session.id === stored.selection.sessionId).participantChoice = structuredClone(config.participantChoice);
      }
      if (config.theme) stored.preferences.theme = config.theme;
      if (config.workspaceBytes) {
        const otherSession = stored.sessions.find((session) => session.id !== stored.selection.sessionId);
        const chunks = (text) => Array.from({ length: Math.ceil(text.length / 16_384) }, (_, index) => text.slice(index * 16_384, (index + 1) * 16_384));
        stored.schemaVersion = 2;
        stored.capabilities = { mode: 'synthetic', provider: 'runtime-selected', native: 'unavailable' };
        stored.conversationRuns = Array.from({ length: 4 }, (_, index) => ({
          version: 1,
          runId: `10000000-0000-4000-8000-${String(index * 3 + 1).padStart(12, '0')}`,
          sessionId: otherSession.id,
          userMessageId: `10000000-0000-4000-8000-${String(index * 3 + 2).padStart(12, '0')}`,
          assistantMessageId: `10000000-0000-4000-8000-${String(index * 3 + 3).padStart(12, '0')}`,
          participant: { id: 'invented-history', label: 'Invented saved participant', model: 'Invented model', executionHost: 'Invented worker' },
          inputChunks: ['Earlier invented message'], outputChunks: chunks(('x'.repeat(79) + ' ').repeat(Math.ceil(255 * 1024 / 80)).slice(0, 255 * 1024)),
          lastSequence: 3, phase: 'completed', createdAt: otherSession.createdAt, updatedAt: otherSession.updatedAt,
        }));
        if (config.legacyRunning) {
          stored.conversationRuns[0].phase = 'running';
          stored.conversationRuns[0].participant = { id: 'invented-participant', label: 'Invented participant', model, executionHost: 'Invented worker' };
        }
        if (config.legacyIncomplete) {
          stored.conversationRuns[0].phase = 'stopped';
          stored.conversationRuns[0].reason = 'stop-incomplete';
          stored.conversationRuns[0].participant = { id: 'invented-participant', label: 'Invented participant', model, executionHost: 'Invented worker' };
        }
        const last = stored.conversationRuns.at(-1);
        const excess = Buffer.byteLength(JSON.stringify(stored)) - config.workspaceBytes;
        assert.ok(excess > 0 && excess < last.outputChunks.join('').length);
        last.outputChunks = chunks(last.outputChunks.join('').slice(0, -excess));
        assert.ok(Math.abs(Buffer.byteLength(JSON.stringify(stored)) - config.workspaceBytes) < 100,
          'The near-limit fixture accounts for chunk-array framing.');
      }
    }
    const loaded = structuredClone(stored);
    if (externalRevision) loaded.revision += 1;
    return loaded;
  });
  await page.exposeFunction('__participantFixtureSave', async (snapshot, expectedRevision) => {
    const entry = { snapshot: structuredClone(snapshot), expectedRevision, completed: false };
    calls.saves.push(entry);
    if (Buffer.byteLength(JSON.stringify(snapshot)) > 1024 * 1024) {
      protocolErrors.push('Attempted a workspace save larger than the native 1 MiB record limit.');
      return { kind: 'failed', error: 'Invented native payload-too-large refusal.', attemptedState: snapshot };
    }
    if (conflict?.(snapshot)) {
      conflict = undefined; entry.conflicted = true;
      return { kind: 'conflict', error: 'Invented definite revision conflict.', attemptedState: snapshot, currentState: stored };
    }
    if (fail?.(snapshot)) {
      fail = undefined;
      entry.failed = true;
      return { kind: 'failed', error: 'Invented definite save failure.', attemptedState: snapshot };
    }
    if (block?.(snapshot)) {
      block = undefined;
      await new Promise((done) => pending.push(done));
    }
    if (expectedRevision !== stored.revision) {
      protocolErrors.push({ expectedRevision, actualRevision: stored.revision });
      return { kind: 'conflict', error: 'Invented compare-and-save conflict.', attemptedState: snapshot, currentState: stored };
    }
    stored = structuredClone(snapshot);
    entry.completed = true;
    return { kind: 'saved', state: structuredClone(stored) };
  });
  await page.exposeFunction('__participantFixtureCall', async (operation, input) => {
    if (operation === 'start') {
      calls.starts.push({ input: structuredClone(input), savedAtStart: structuredClone(stored) });
      const kind = startResult;
      startResult = 'accepted';
      return { kind };
    }
    else if (operation === 'stop') {
      calls.stops.push(structuredClone(input));
      if (stopBlocked) { stopBlocked = false; await new Promise((done) => pendingStops.push(done)); }
      const kind = stopResult;
      stopResult = 'confirmed';
      return typeof kind === 'string' ? { kind } : kind;
    }
    else if (operation === 'status') { calls.statuses.push(structuredClone(input)); return structuredClone(statusResult); }
    else if (operation === 'reconcile') calls.reconciles.push(structuredClone(input));
  });
  await page.addInitScript(() => {
    window.__forbidden = [];
    for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) {
      Object.defineProperty(window, key, { configurable: true, get() { window.__forbidden.push(key); throw Error('Unexpected browser persistence'); } });
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
    if (url.pathname === '/src/main.tsx') return route.fulfill({ contentType: 'application/javascript', body: harness });
    return route.continue();
  });
  await page.goto(origin);
  await expect.poll(() => errors.length ? errors.join('\n') : page.evaluate(() => Boolean(window.__participantTest))).toBe(true);
  await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
  return {
    page, calls,
    get stored() { return structuredClone(stored); },
    get blocked() { return pending.length; },
    blockNext(predicate) { block = predicate; },
    failNext(predicate) { fail = predicate; },
    conflictNext(predicate) { conflict = predicate; },
    nextStart(kind) { startResult = kind; },
    nextStop(kind) { stopResult = kind; },
    nextStatus(result) { statusResult = result; },
    async externalChange() { externalRevision = true; await page.evaluate(() => window.__participantTest.notifyWorkspaceChange()); },
    blockStop() { stopBlocked = true; },
    releaseStop() { assert.ok(pendingStops.length); pendingStops.shift()(); },
    changeModelOnReload(value) { model = value; },
    changeChoicesOnReload(choices) { participantChoices = structuredClone(choices); },
    omitParticipantOnReload() { withoutParticipant = true; },
    restoreParticipantOnReload() { withoutParticipant = false; },
    release() { assert.ok(pending.length, 'An actual repository save must be blocked.'); pending.shift()(); },
    async send(input = 'Invented participant request') {
      await page.getByRole('textbox', { name: 'Your message', exact: true }).fill(input);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    },
    emit: (type, text) => page.evaluate(([kind, literal]) => window.__participantTest.emit(kind, literal), [type, text]),
    async emitText(text) {
      let chunk = ''; let bytes = 0; let event;
      for (const scalar of text) {
        const width = Buffer.byteLength(scalar);
        if (bytes + width > 16_384) {
          event = await this.emit('text', chunk); chunk = ''; bytes = 0;
        }
        chunk += scalar; bytes += width;
      }
      if (chunk) event = await this.emit('text', chunk);
      return event;
    },
    async check() {
      assert.deepEqual(errors, []); assert.deepEqual(outside, []); assert.deepEqual(protocolErrors, []);
      assert.deepEqual(await page.evaluate(() => window.__forbidden), []);
    },
    async close() { for (const done of pending.splice(0)) done(); for (const done of pendingStops.splice(0)) done(); await context.close(); },
  };
}

const transcript = (page) => page.locator('[data-run-id]');
const savedRun = (f) => f.stored.conversationRuns?.[0];
async function expectSavedSequence(f, sequence) {
  try { await expect.poll(() => savedRun(f)?.lastSequence).toBe(sequence); }
  catch (error) {
    const diagnostic = JSON.stringify({
      starts: f.calls.starts.length, stops: f.calls.stops.length,
      saves: f.calls.saves.map(({ snapshot, completed, failed }) => ({ completed, failed,
        runs: snapshot.conversationRuns?.map(({ phase, lastSequence, closure }) => ({ phase, lastSequence, closure })) })),
      visible: (await transcript(f.page).allTextContents()).map((text) => text.slice(-1200)),
    });
    throw new Error(`Expected saved sequence ${sequence}. Invented fixture state: ${diagnostic}`, { cause: error });
  }
}

test('participant dispatch waits for the exact prepared run to be durably saved', async () => {
  const f = await fixture();
  try {
    f.blockNext((state) => state.conversationRuns?.some((run) => run.phase === 'prepared'));
    const input = '  Invented exact input café 🙂\n ';
    await f.send(input);
    await expect.poll(() => f.blocked).toBe(1);
    assert.equal(f.calls.starts.length, 0);
    assert.equal(savedRun(f), undefined);
    await expect(transcript(f.page)).toBeVisible();
    f.release();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    const { input: dispatched, savedAtStart } = f.calls.starts[0];
    const prepared = savedAtStart.conversationRuns.find((run) => run.runId === dispatched.runId);
    assert.equal(prepared.phase, 'prepared');
    assert.equal(prepared.lastSequence, 0);
    assert.equal(prepared.sessionId, dispatched.sessionId);
    assert.equal(prepared.inputChunks.join(''), input);
    assert.equal(dispatched.inputChunks.join(''), input);
    assert.equal(savedAtStart.drafts[dispatched.sessionId], '');
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    await f.check();
  } finally { await f.close(); }
});

test('literal participant output renders and saves across chunks without creating a simulated reply', async () => {
  const f = await fixture();
  try {
    const originalMessages = f.stored.messages;
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    const first = '<b>Literal, not markup</b>\n\t cafe\u0301 🙂 '.repeat(650);
    const second = '\n  ending exactly  ';
    const firstEvent = await f.emitText(first);
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(firstEvent.sequence);
    await f.emit('text', second);
    await f.emit('completed');
    await expect.poll(() => savedRun(f)?.phase).toBe('completed');
    await expect.poll(() => transcript(f.page).locator('.run-output').textContent()).toBe(first + second);
    assert.equal(savedRun(f).outputChunks.join(''), first + second);
    assert.ok(savedRun(f).outputChunks.length > 1);
    assert.deepEqual(f.stored.messages, originalMessages);
    assert.equal(await transcript(f.page).locator('.run-output b').count(), 0);
    await expect(transcript(f.page).locator('[data-save-state="saved"]')).toBeVisible();
    await expect(transcript(f.page).getByText('Invented model', { exact: true })).toBeVisible();
    await expect(transcript(f.page).getByText('Invented worker', { exact: true })).toBeVisible();
    await f.check();
  } finally { await f.close(); }
});

test('Stop reaches the participant while a reply save is blocked and preserves the saved prefix and unsaved tail', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    await f.emit('text', 'Saved prefix');
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(2);
    f.blockNext((state) => state.conversationRuns?.some((run) => run.lastSequence === 3));
    await f.emit('text', ' and unsaved tail');
    await expect.poll(() => f.blocked).toBe(1);
    await expect(transcript(f.page).locator('[data-saved-output]')).toHaveText('Saved prefix');
    assert.equal(await transcript(f.page).locator('[data-pending-output]').textContent(), ' and unsaved tail');
    const presentation = await transcript(f.page).evaluate((section) => {
      const saved = section.querySelector('[data-saved-output]');
      const pending = section.querySelector('[data-pending-output]');
      const style = (element) => {
        const css = getComputedStyle(element);
        return { background: css.backgroundColor, line: css.textDecorationLine, decoration: css.textDecorationStyle };
      };
      return { saved: style(saved), pending: style(pending),
        explanation: document.getElementById(pending.getAttribute('aria-describedby'))?.textContent };
    });
    assert.notDeepEqual(presentation.pending, presentation.saved, 'The visible unsaved tail must differ from the saved prefix.');
    assert.match(presentation.pending.line, /underline/);
    assert.equal(presentation.pending.decoration, 'dotted');
    assert.match(presentation.explanation, /not yet saved/);
    await expect(transcript(f.page).getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).focus();
    await f.page.keyboard.press('Enter');
    await expect.poll(() => f.calls.stops.length).toBe(1);
    assert.equal(f.blocked, 1, 'Stop must not await the unrelated durable-save promise.');
    assert.deepEqual(f.calls.stops[0], { runId: savedRun(f).runId, sessionId: savedRun(f).sessionId });
    assert.equal(savedRun(f).outputChunks.join(''), 'Saved prefix');
    await expect(transcript(f.page).getByText('Response stopped · provider cancellation unconfirmed', { exact: true })).toBeVisible();
    await expect(transcript(f.page).locator('.run-phase')).toBeFocused();
    f.release();
    await expect.poll(() => savedRun(f)?.phase).toBe('stopped');
    assert.equal(savedRun(f).outputChunks.join(''), 'Saved prefix and unsaved tail');
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('a real page reload reopens its saved run without dispatching that identity again', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    await f.emit('text', 'Saved reply before reload');
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(2);
    const run = savedRun(f);
    await f.page.reload();
    await expect(transcript(f.page)).toHaveAttribute('data-run-id', run.runId);
    await expect.poll(() => transcript(f.page).locator('.run-output').textContent()).toBe('Saved reply before reload');
    await f.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    assert.equal(f.calls.loads, 2);
    assert.equal(f.calls.starts.length, 1, 'Loading a persisted prepared/running identity never grants a new dispatch.');
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toHaveCount(0);
    assert.equal(savedRun(f).runId, run.runId);
    assert.equal(savedRun(f).lastSequence, run.lastSequence);
    await f.check();
  } finally { await f.close(); }
});

test('switching sessions keeps the participant stream attached to its originating session', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    const original = savedRun(f);
    const other = f.stored.sessions.find((session) => session.id !== original.sessionId);
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    await expect(f.page.locator('.session-link.selected')).toHaveAttribute('data-session-id', other.id);
    await expect(transcript(f.page)).toHaveCount(0);
    await f.emit('text', 'Only the originating conversation receives this.');
    await f.emit('completed');
    await expect.poll(() => savedRun(f)?.phase).toBe('completed');
    assert.equal(savedRun(f).sessionId, original.sessionId);
    assert.equal(f.stored.drafts[other.id], '');
    assert.equal(f.stored.conversationRuns.filter((run) => run.sessionId === other.id).length, 0);
    await expect(transcript(f.page)).toHaveCount(0);
    const originalTitle = f.stored.sessions.find((session) => session.id === original.sessionId).title;
    await f.page.getByRole('button', { name: originalTitle, exact: true }).click();
    await expect.poll(() => transcript(f.page).locator('.run-output').textContent()).toBe('Only the originating conversation receives this.');
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('runtime invalidation clears the transcript and ignores late callbacks and save completions', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    f.blockNext((state) => state.conversationRuns?.some((run) => run.lastSequence === 2));
    await f.emit('text', 'Invented pending output before invalidation');
    await expect.poll(() => f.blocked).toBe(1);
    const savesBefore = f.calls.saves.length;
    await f.page.evaluate(() => window.__participantTest.revoke());
    await expect(f.page.getByRole('heading', { name: 'Workspace connection closed', exact: true })).toBeVisible();
    await f.page.evaluate(() => window.__participantTest.emitLate('text', 'Late text must stay invisible'));
    await f.page.evaluate(() => window.__participantTest.emitLate('completed'));
    f.release();
    await expect.poll(() => f.calls.saves.at(-1).completed).toBe(true);
    await expect(transcript(f.page)).toHaveCount(0);
    await expect(f.page.getByText('Late text must stay invisible', { exact: true })).toHaveCount(0);
    await expect(f.page.getByText('Invented pending output before invalidation', { exact: true })).toHaveCount(0);
    assert.equal(f.calls.saves.length, savesBefore);
    assert.equal(savedRun(f).lastSequence, 2, 'Only the already-dispatched save can finish, never the late stream.');
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('streamed output survives an unrelated save failure and global Retry saves the exact retained checkpoint', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    await f.emit('text', 'Already saved reply prefix');
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(2);
    const sessionId = savedRun(f).sessionId;
    const draft = 'Unrelated next-message draft retained through failure';
    f.failNext((state) => state.drafts[sessionId] === draft);
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill(draft);
    await expect(f.page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
    const writesAtFailure = f.calls.saves.length;
    await f.emit('text', ' and text received after the warning');
    await expect.poll(() => transcript(f.page).locator('.run-output').textContent())
      .toBe('Already saved reply prefix and text received after the warning');
    assert.equal(f.calls.saves.length, writesAtFailure, 'An unresolved save problem blocks further repository writes.');
    assert.equal(savedRun(f).lastSequence, 2);
    assert.equal(savedRun(f).outputChunks.join(''), 'Already saved reply prefix');
    await expect(transcript(f.page).locator('[data-save-state="pending"]')).toBeVisible();
    await f.page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(3);
    assert.equal(savedRun(f).outputChunks.join(''), 'Already saved reply prefix and text received after the warning');
    assert.equal(f.stored.drafts[sessionId], draft);
    await expect(transcript(f.page).locator('[data-save-state="saved"]')).toBeVisible();
    await expect(transcript(f.page).getByText('Saved through update 3.', { exact: true })).toBeVisible();
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('a failed prepared save requires successful Retry and an explicit Start prepared message action', async () => {
  const f = await fixture();
  try {
    f.failNext((state) => state.conversationRuns?.some((run) => run.phase === 'prepared'));
    await f.send('Invented prepared request retained after save failure');
    await expect(f.page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
    assert.equal(f.calls.starts.length, 0);
    assert.equal(savedRun(f), undefined);
    await f.page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect.poll(() => savedRun(f)?.phase).toBe('prepared');
    const start = f.page.getByRole('button', { name: 'Start prepared message', exact: true });
    await expect(start).toBeEnabled();
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Prepared · not started');
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toHaveCount(0);
    await expect(transcript(f.page).getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    assert.equal(f.calls.starts.length, 0, 'Saving the retained preparation never implicitly dispatches it.');
    await start.focus();
    await expect(start).toBeFocused();
    await f.page.keyboard.press('Enter');
    await expectSavedSequence(f, 1);
    assert.equal(f.calls.starts.length, 1);
    assert.equal(f.calls.starts[0].input.runId, savedRun(f).runId);
    assert.equal(f.calls.starts[0].savedAtStart.conversationRuns[0].phase, 'prepared');
    await expect(start).toHaveCount(0);
    await expect(transcript(f.page).locator('.run-phase')).toBeFocused();
    await f.check();
  } finally { await f.close(); }
});

test('an explicit not-started result permits a manual start of the same prepared identity once', async () => {
  const f = await fixture();
  try {
    f.nextStart('not-started');
    await f.send();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    const start = f.page.getByRole('button', { name: 'Start prepared message', exact: true });
    await expect(start).toBeEnabled();
    assert.equal(savedRun(f).phase, 'prepared');
    await start.click();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    assert.equal(f.calls.starts.length, 2);
    assert.deepEqual(f.calls.starts[1].input, f.calls.starts[0].input);
    await expect(start).toHaveCount(0);
    await f.check();
  } finally { await f.close(); }
});

test('unknown dispatch and a reopened prepared identity never offer Start prepared message', async () => {
  const f = await fixture();
  try {
    f.nextStart('unknown');
    await f.send();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    await expect(transcript(f.page).locator('.run-error')).toBeVisible();
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toHaveCount(0);
    const runId = savedRun(f).runId;
    assert.equal(savedRun(f).phase, 'prepared');
    await f.page.reload();
    await expect(transcript(f.page)).toHaveAttribute('data-run-id', runId);
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toHaveCount(0);
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('a backward wall clock uses workspace chronology and accepts participant events without stranding the session', async () => {
  const input = 'Invented draft whose session was created under a future clock';
  const f = await fixture({ futureSession: true, input });
  try {
    const session = f.stored.sessions.find((entry) => entry.id === f.stored.selection.sessionId);
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    await send.click();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    await expectSavedSequence(f, 1);
    assert.ok(savedRun(f).createdAt >= session.createdAt);
    assert.equal(savedRun(f).inputChunks.join(''), input);
    await f.emit('text', 'Literal reply under an earlier participant clock');
    await f.emit('completed');
    await expect.poll(() => savedRun(f)?.phase).toBe('completed');
    assert.ok(savedRun(f).updatedAt >= savedRun(f).createdAt);
    assert.equal(savedRun(f).outputChunks.join(''), 'Literal reply under an earlier participant clock');
    await f.send('Next invented message after the clock change');
    await expect.poll(() => f.calls.starts.length).toBe(2);
    await f.check();
  } finally { await f.close(); }
});

test('a synchronous subscribe refusal keeps the draft and Send usable without retaining a stranded controller', async () => {
  const input = 'Invented draft retained after a connection refusal';
  const f = await fixture({ subscribeThrows: true, input });
  try {
    const before = f.stored;
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    await send.click();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(input);
    await expect(send).toBeEnabled();
    await expect(transcript(f.page)).toHaveCount(0);
    assert.equal(await f.page.evaluate(() => window.__participantTest.activeListeners()), 0);
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.calls.starts.length, 0);
    assert.deepEqual(f.stored, before);
    await f.page.evaluate(() => window.__participantTest.setSubscribeThrows(false));
    await send.click();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    assert.equal(f.calls.starts[0].input.inputChunks.join(''), input);
    await f.check();
  } finally { await f.close(); }
});

test('unknown Stop can be retried and checked, then explicitly closed without losing its prefix or claiming cancellation', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    await f.emit('text', 'Saved prefix before an unconfirmed stop');
    await expectSavedSequence(f, 2);
    const original = savedRun(f);
    f.nextStop('unknown');
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => f.calls.stops.length).toBe(1);
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Run status unknown');
    const retryStop = transcript(f.page).getByRole('button', { name: 'Retry Stop', exact: true });
    await expect(retryStop).toBeEnabled();
    f.nextStop('unknown');
    await retryStop.click();
    await expect.poll(() => f.calls.stops.length).toBe(2);
    assert.deepEqual(f.calls.stops[1], f.calls.stops[0]);
    await f.page.getByRole('button', { name: 'Check run status', exact: true }).click();
    await expect.poll(() => f.calls.reconciles.length).toBe(1);
    assert.deepEqual(f.calls.reconciles[0], { runId: original.runId, sessionId: original.sessionId, afterSequence: original.lastSequence });
    f.blockNext((state) => state.conversationRuns?.some((run) => run.closure?.kind === 'unknown'));
    await f.page.getByRole('button', { name: 'Close as unknown', exact: true }).click();
    await expect.poll(() => f.blocked).toBe(1);
    await expect(transcript(f.page).locator('[data-save-state="pending"]')).toBeVisible();
    const nextInput = 'A new invented message after an explicit unknown closure';
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill(nextInput);
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    assert.equal(savedRun(f).closure, undefined);
    assert.equal(f.calls.starts.length, 1);
    f.release();
    await expect.poll(() => savedRun(f)?.closure?.kind).toBe('unknown');
    assert.equal(savedRun(f).closure.reason, 'user-closed');
    assert.equal(savedRun(f).phase, original.phase);
    assert.equal(savedRun(f).lastSequence, original.lastSequence);
    assert.equal(savedRun(f).outputChunks.join(''), original.outputChunks.join(''));
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Closed with outcome unknown');
    await expect(transcript(f.page)).not.toContainText('Retry Stop or check this run');
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Retry Stop', exact: true })).toHaveCount(0);
    assert.equal(f.calls.stops.length, 2, 'Local closure is not another Stop or a cancellation acknowledgment.');
    await f.page.reload();
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Closed with outcome unknown');
    await expect(transcript(f.page).locator('.run-output')).toHaveText(original.outputChunks.join(''));
    assert.equal(f.calls.starts.length, 1);
    await f.send(nextInput);
    await expect.poll(() => f.calls.starts.length).toBe(2);
    assert.notEqual(f.calls.starts[1].input.runId, original.runId);
    assert.equal(f.stored.conversationRuns.find((run) => run.runId === original.runId).closure.kind, 'unknown');
    await f.check();
  } finally { await f.close(); }
});

test('a saved run reopened without a participant offers truthful local closure and never a fake status check', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(1);
    await f.emit('text', 'Saved output remains readable without its participant');
    await expect.poll(() => savedRun(f)?.lastSequence).toBe(2);
    const original = savedRun(f);
    f.omitParticipantOnReload();
    await f.page.reload();
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Participant connection unavailable');
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toHaveCount(0);
    await expect(f.page.getByText('Stop outcome unknown', { exact: true })).toHaveCount(0);
    const stop = transcript(f.page).getByRole('button', { name: /^(Stop|Retry Stop|Stop unconfirmed)$/ });
    if (await stop.count()) await expect(stop).toBeDisabled();
    await f.page.getByRole('button', { name: 'Close as unknown', exact: true }).click();
    await expect.poll(() => savedRun(f)?.closure?.kind).toBe('unknown');
    assert.equal(savedRun(f).phase, original.phase);
    assert.equal(savedRun(f).lastSequence, original.lastSequence);
    assert.equal(savedRun(f).outputChunks.join(''), original.outputChunks.join(''));
    assert.equal(f.calls.stops.length, 0);
    assert.equal(f.calls.reconciles.length, 0);
    assert.equal(f.calls.starts.length, 1);
    f.restoreParticipantOnReload();
    await f.page.reload();
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Closed with outcome unknown');
    await f.send('Fresh invented request after reconnection');
    await expect.poll(() => f.calls.starts.length).toBe(2);
    assert.notEqual(f.calls.starts[1].input.runId, original.runId);
    await f.check();
  } finally { await f.close(); }
});

test('a nearly full aggregate workspace refuses a new run before subscribing or dispatching and keeps the draft', async () => {
  const input = 'Invented message kept because this workspace is nearly full';
  const f = await fixture({ workspaceBytes: 1024 * 1024 - 16 * 1024, input });
  try {
    const before = f.stored;
    assert.ok(Buffer.byteLength(JSON.stringify(before)) < 1024 * 1024);
    await f.page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(f.page.getByText(/workspace.*limit/i)).toBeVisible();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(input);
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(transcript(f.page)).toHaveCount(0);
    assert.equal(await f.page.evaluate(() => window.__participantTest.activeListeners()), 0);
    assert.equal(f.calls.starts.length, 0);
    assert.equal(f.calls.saves.length, 0);
    assert.deepEqual(f.stored, before);
    await f.check();
  } finally { await f.close(); }
});

test('aggregate workspace admission stops a stream before an oversized checkpoint and preserves unrelated editing', async () => {
  const f = await fixture({ workspaceBytes: 1024 * 1024 - 96 * 1024 });
  try {
    const historicalRuns = f.stored.conversationRuns;
    await f.send();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    const target = f.calls.starts[0].input;
    const currentRun = () => f.stored.conversationRuns.find((run) => run.runId === target.runId);
    await expect.poll(() => currentRun()?.lastSequence).toBe(1);
    const chunk = 'z'.repeat(16 * 1024);
    let emitted = '';
    for (let index = 0; index < 10 && f.calls.stops.length === 0; index++) {
      emitted += chunk;
      await f.emit('text', chunk);
    }
    await expect.poll(() => f.calls.stops.length).toBe(1);
    await expect.poll(() => currentRun()?.closure?.kind).toBe('interrupted');
    const retained = currentRun();
    assert.equal(retained.closure.reason, 'workspace-limit');
    await expect(transcript(f.page).locator('[data-interruption-reason]')).toHaveText('This workspace reached its storage limit. The retained response is incomplete.');
    assert.equal(retained.closure.terminalEvent.type, 'stopped');
    assert.ok(retained.outputChunks.join('').length > 0);
    assert.ok(retained.outputChunks.join('').length < emitted.length);
    assert.ok(emitted.startsWith(retained.outputChunks.join('')));
    assert.deepEqual(f.stored.conversationRuns.slice(0, historicalRuns.length), historicalRuns);
    assert.ok(f.calls.saves.every(({ snapshot }) => Buffer.byteLength(JSON.stringify(snapshot)) <= 1024 * 1024));
    const draft = 'An unrelated draft still saves after the guarded stop';
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill(draft);
    await expect.poll(() => f.stored.drafts[target.sessionId]).toBe(draft);
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

async function expectInsideMessageViewport(locator) {
  await expect.poll(() => locator.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const viewport = element.closest('.message-scroll').getBoundingClientRect();
    return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1
      && bounds.top >= 0 && bounds.bottom <= window.innerHeight;
  })).toBe(true);
}

test('a healthy first Send keeps status and Stop visible at 1280x800 and does not offer abandonment', async () => {
  const f = await fixture({ viewport: { width: 1280, height: 800 } });
  try {
    await f.send('Invented first message');
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Response in progress');
    const stop = transcript(f.page).getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeEnabled();
    await expectInsideMessageViewport(stop);
    await expectInsideMessageViewport(transcript(f.page).locator('.run-phase'));
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toHaveCount(0);
    await f.emit('text', 'Invented line in an overflowing response.\n'.repeat(100));
    f.nextStop('unknown');
    await stop.click();
    const check = f.page.getByRole('button', { name: 'Check run status', exact: true });
    await expect(check).toBeVisible();
    await check.click();
    await expect(transcript(f.page).locator('.run-phase')).toBeFocused();
    await expectInsideMessageViewport(transcript(f.page).locator('.run-phase'));
    await f.check();
  } finally { await f.close(); }
});

test('a pending Stop cannot be locally closed and its confirmed terminal event stays visible and saved', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    f.blockStop();
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => f.calls.stops.length).toBe(1);
    await expect(transcript(f.page).getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toHaveCount(0);
    f.releaseStop();
    await expect.poll(() => savedRun(f)?.phase).toBe('stopped');
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Response stopped · provider cancellation unconfirmed');
    await expect(transcript(f.page).getByRole('button', { name: 'Stopped', exact: true })).toBeDisabled();
    assert.equal(savedRun(f).closure, undefined);
    await f.check();
  } finally { await f.close(); }
});

test('explicit Send reveals the new own message after reading older content, while ordinary streaming preserves that reading position', async () => {
  const f = await fixture({ viewport: { width: 1280, height: 800 } });
  try {
    await f.send('Earlier invented request');
    await expect.poll(() => f.calls.starts.length).toBe(1);
    await f.emit('text', 'A long invented line to establish saved scroll history.\n'.repeat(100));
    const log = f.page.getByRole('log', { name: 'Messages', exact: true });
    await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
    await log.hover();
    await f.page.mouse.wheel(0, -700);
    await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100);
    const position = await log.evaluate((element) => element.scrollTop);
    await f.emit('text', '\nMore passive streaming while reading the earlier response.');
    await expect(transcript(f.page).locator('.run-output')).toContainText('More passive streaming');
    assert.ok(Math.abs(await log.evaluate((element) => element.scrollTop) - position) <= 2);
    await f.emit('completed');
    await expect.poll(() => savedRun(f)?.phase).toBe('completed');
    await f.send('A new invented message I explicitly sent');
    await expect.poll(() => f.calls.starts.length).toBe(2);
    const ownMessage = transcript(f.page).last().getByRole('article', { name: 'Your message', exact: true });
    await expect(ownMessage).toContainText('A new invented message I explicitly sent');
    await expectInsideMessageViewport(ownMessage);
    await f.check();
  } finally { await f.close(); }
});

test('a failed workspace save visibly pauses Send while preserving an editable draft, and Retry restores Send', async () => {
  const f = await fixture();
  try {
    const field = f.page.getByRole('textbox', { name: 'Your message', exact: true });
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    f.failNext(() => true);
    await field.fill('Invented draft awaiting a failed workspace save');
    await expect(f.page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
    await expect(send).toBeDisabled();
    await expect(f.page.locator('.conversation-footnote')).toContainText('Participant proof · invented messages only. Do not enter private data.');
    await expect(send).toHaveAccessibleDescription('Sending is paused until the workspace save is resolved. Your draft is retained.');
    await expect(f.page.getByText('Sending is paused until the workspace save is resolved. Your draft is retained.', { exact: true })).toBeVisible();
    await field.fill('Edited invented draft remains here');
    await field.press('Enter');
    assert.equal(f.calls.starts.length, 0);
    await expect(field).toHaveValue('Edited invented draft remains here');
    await f.page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    assert.equal(f.calls.starts[0].input.inputChunks.join(''), 'Edited invented draft remains here');
    await f.check();
  } finally { await f.close(); }
});

test('a changed model on the same participant and host explains saved ownership without offering a futile retry', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    await f.emit('text', 'Saved prefix from the original invented model');
    await expectSavedSequence(f, 2);
    f.changeModelOnReload('Different invented model');
    await f.page.reload();
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Saved run belongs to a different participant or model');
    await expect(transcript(f.page).locator('.run-error')).toContainText('The connected participant has a different identity or model.');
    await expect(transcript(f.page).locator('.run-error')).toContainText('Invented model');
    await expect(transcript(f.page).locator('.run-output')).toHaveText('Saved prefix from the original invented model');
    await expect(f.page.getByRole('button', { name: 'Retry participant connection', exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toBeEnabled();
    assert.equal(await f.page.evaluate(() => window.__participantTest.activeListeners()), 0);
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('reserved view capacity keeps session selection and Stop usable at the edit limit during a save barrier', async () => {
  const f = await fixture({ workspaceBytes: 1024 * 1024 - 48 * 1024, theme: 'dark', capacityDraftSession: true });
  try {
    await f.send();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    const target = f.calls.starts[0].input;
    const currentRun = () => f.stored.conversationRuns.find((run) => run.runId === target.runId);
    await expect.poll(() => currentRun()?.lastSequence).toBe(1);
    const other = f.stored.sessions.find((session) => session.title === 'Budget draft session');
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    const text = 'Literal accepted reply before view changes '.repeat(64);
    const textEvent = await f.emit('text', text);
    const padding = await f.page.evaluate(([state, event, sessionId]) =>
      window.__participantTest.draftAtCapacity(state, event, sessionId), [f.stored, textEvent, other.id]);
    f.failNext((state) => state.drafts[other.id] === padding);
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill(padding);
    await expect(f.page.getByRole('alert', { name: 'Save recovery', exact: true })).toBeVisible();
    const failedEdit = f.calls.saves.findLast(({ failed, snapshot }) => failed && snapshot.drafts[other.id] === padding);
    assert.ok(failedEdit, 'The content edit reaches the exact admitted capacity before view changes.');
    const savesBeforeView = f.calls.saves.length;
    await f.page.getByRole('button', { name: 'Appearance options', exact: true }).click();
    const appearance = f.page.getByRole('dialog', { name: 'Appearance options', exact: true });
    await appearance.getByRole('radio', { name: 'Follow system', exact: true }).check();
    await expect(appearance.getByRole('radio', { name: 'Follow system', exact: true })).toBeChecked();
    await appearance.getByRole('button', { name: 'Close options', exact: true }).click();
    // Selection and preference growth are reserved before admitting the content edit.
    const originalTitle = f.stored.sessions.find((session) => session.id === target.sessionId).title;
    await f.page.getByRole('button', { name: originalTitle, exact: true }).click();
    await expect(transcript(f.page).filter({ has: f.page.locator('[data-run-status]') }).last()).toBeVisible();
    assert.equal(f.calls.saves.length, savesBeforeView, 'View changes do not attempt a shared write.');
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => f.calls.stops.length).toBe(1);
    await f.page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect.poll(() => currentRun()?.phase).toBe('stopped');
    assert.equal(currentRun().lastSequence, textEvent.sequence + 1);
    assert.equal(currentRun().outputChunks.join(''), text);
    assert.equal(f.stored.drafts[other.id], padding);
    assert.equal(f.stored.preferences.theme, 'system');
    await expect(f.page.getByRole('alert', { name: 'Save recovery', exact: true })).toHaveCount(0);
    assert.ok(f.calls.saves.every(({ snapshot }) => Buffer.byteLength(JSON.stringify(snapshot)) <= 1024 * 1024));
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});


test('a definite checkpoint conflict preserves the response and names unsaved work without claiming an unknown save or impossible reconcile', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    f.conflictNext((state) => state.conversationRuns?.some((run) => run.phase === 'completed'));
    await f.emit('text', 'Literal response retained after a known revision conflict');
    await f.emit('completed');
    await expect(f.page.getByRole('alert', { name: 'Save recovery', exact: true })).toContainText('Another copy changed');
    await expect(transcript(f.page).locator('.run-output')).toHaveText('Literal response retained after a known revision conflict');
    await expect(transcript(f.page).locator('.run-error')).toHaveText('This response has unsaved changes. Resolve the workspace save before sending more work.');
    await expect(transcript(f.page)).not.toContainText('save outcome is unknown');
    await expect(f.page.getByRole('button', { name: 'Reconcile original save', exact: true })).toHaveCount(0);
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toBeDisabled();
    await expect(f.page.locator('.conversation-footnote')).toContainText('Your draft is retained.');
    await expect(f.page.locator('.conversation-footnote')).not.toContainText('editable');
    await expect(f.page.locator('.conversation-footnote')).toContainText('Do not enter private data.');
    assert.equal(savedRun(f).lastSequence, 1);
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});


test('a replayable response gap keeps Stop reachable and cannot be abandoned before a Stop attempt answers unknown', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    const delayed = await f.page.evaluate(() => window.__participantTest.hold('text', 'Delayed literal prefix'));
    await f.emit('text', ' and a later chunk');
    await expect(transcript(f.page).locator('.run-error')).toContainText('Some response updates have not arrived');
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toHaveCount(0);
    const stop = transcript(f.page).getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeEnabled();
    assert.equal(f.calls.stops.length, 0);
    await f.page.evaluate((event) => window.__participantTest.deliver(event), delayed);
    await expect(transcript(f.page).locator('.run-output')).toHaveText('Delayed literal prefix and a later chunk');
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toHaveCount(0);
    f.nextStop('unknown');
    await stop.click();
    await expect.poll(() => f.calls.stops.length).toBe(1);
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toBeEnabled();
    await f.check();
  } finally { await f.close(); }
});

test('a reopened running identity without replay requires Stop before offering local unknown closure', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    await f.page.reload();
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Run status unknown');
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toHaveCount(0);
    f.nextStop('unknown');
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => f.calls.stops.length).toBe(1);
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toBeEnabled();
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('focused run status is revealed once, then streaming respects reading position and follows the bottom again', async () => {
  const f = await fixture({ viewport: { width: 1280, height: 800 } });
  try {
    f.nextStart('not-started');
    await f.send();
    const start = f.page.getByRole('button', { name: 'Start prepared message', exact: true });
    await expect(start).toBeEnabled();
    await start.focus();
    await f.page.keyboard.press('Enter');
    const status = transcript(f.page).locator('.run-phase');
    await expect(status).toBeFocused();
    await expectInsideMessageViewport(status);
    await f.emit('text', 'An invented line in a long streaming response.\n'.repeat(120));
    const log = f.page.getByRole('log', { name: 'Messages', exact: true });
    await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(1500);
    await log.hover();
    await log.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    const bottom = await log.evaluate((element) => element.scrollTop);
    await f.page.mouse.wheel(0, -650);
    await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBeCloseTo(bottom - 650, 0);
    await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100);
    await expect(status).toBeFocused();
    const position = await log.evaluate((element) => element.scrollTop);
    await f.emit('text', 'Later text must not pull the reader to the focused status.');
    await expect(transcript(f.page).locator('.run-output')).toContainText('Later text must not pull');
    await f.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const afterUpdate = await log.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight }));
    assert.ok(Math.abs(afterUpdate.top - position) <= 2, `An update scrolled to a status that merely retained focus: before=${position}, after=${JSON.stringify(afterUpdate)}.`);
    await log.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    await f.emit('text', '\nThe latest text remains readable.\n'.repeat(20));
    await expect(transcript(f.page).locator('.run-output')).toContainText('The latest text remains readable.');
    await expect.poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(2);
    await expect(status).toBeFocused();
    await f.check();
  } finally { await f.close(); }
});


test('a legacy workspace beyond the new view reserve keeps Stop reachable without navigation through a conflict barrier', async () => {
  const f = await fixture({ workspaceBytes: 1024 * 1024 - 1024, legacyRunning: true, theme: 'dark', viewport: { width: 1280, height: 800 } });
  try {
    const run = savedRun(f);
    const title = f.stored.sessions.find((session) => session.id === run.sessionId).title;
    await f.externalChange();
    await expect(f.page.getByRole('alert', { name: 'Save recovery', exact: true })).toContainText('Another copy changed');
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toBeDisabled();
    // This old record lacks the newer reserve, but a size-neutral selection
    // must still be admitted without spending future checkpoint capacity.
    assert.equal(Buffer.byteLength(JSON.stringify(f.stored)), 1024 * 1024 - 1024);
    const stop = f.page.getByRole('button', { name: `Stop response in ${title}`, exact: true });
    await expect(stop).toBeEnabled();
    assert.ok(await stop.evaluate((element) => { const box = element.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }));
    f.nextStop('unknown');
    await stop.focus();
    await f.page.keyboard.press('Enter');
    await expect.poll(() => f.calls.stops.length).toBe(1);
    assert.deepEqual(f.calls.stops[0], { runId: run.runId, sessionId: run.sessionId });
    assert.equal(f.calls.starts.length, 0);
    assert.equal(f.calls.saves.length, 0);
    await f.page.getByRole('button', { name: title, exact: true }).click();
    await expect(f.page.locator('.session-link.selected')).toHaveAttribute('data-session-id', run.sessionId);
    await expect(transcript(f.page).first().getByRole('button', { name: 'Retry Stop', exact: true })).toBeEnabled();
    assert.equal(f.calls.saves.length, 0, 'A size-neutral view remains a tab-only choice during the save barrier.');
    await f.check();
  } finally { await f.close(); }
});

test('an incomplete Stop preserves cleanup controls and blocks Send in other sessions until separate cleanup confirmation', async () => {
  const f = await fixture({ cleanupStatus: true });
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    f.nextStop({ kind: 'cleanup-uncertain', owned: true });
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => savedRun(f)?.reason).toBe('stop-incomplete');
    await expect(transcript(f.page).locator('[data-cleanup-state]')).toContainText('local cleanup is not confirmed');
    await expect(transcript(f.page).getByRole('button', { name: 'Retry Stop', exact: true })).toBeEnabled();
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toBeEnabled();
    await expect(f.page.getByRole('button', { name: 'Close as unknown', exact: true })).toHaveCount(0);
    const original = savedRun(f);
    f.nextStatus({ kind: 'status', state: 'cleanup-pending', groupCleared: false, unknownReason: null,
      lastSequence: original.lastSequence, terminal: { type: 'stopped', reason: 'stop-incomplete',
        runId: original.runId, sessionId: original.sessionId, sequence: original.lastSequence, at: original.updatedAt } });
    await f.page.reload();
    await expect(transcript(f.page).getByRole('button', { name: 'Retry Stop', exact: true })).toBeEnabled();
    await expect(transcript(f.page).locator('[data-cleanup-state="owned"]')).toBeVisible();
    assert.equal(f.calls.starts.length, 1, 'Restoring terminal cleanup never dispatches the recorded input again.');
    const title = f.stored.sessions.find((session) => session.id === original.sessionId).title;
    const other = f.stored.sessions.find((session) => session.id !== original.sessionId);
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented next message held for cleanup');
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleDescription(`Cleanup for ${title} (run ${original.runId}) is not confirmed. Use the available recovery controls for that response before sending another message.`);
    const externalStop = f.page.getByRole('button', { name: `Stop response in ${title}`, exact: true });
    await expect(externalStop).toBeEnabled();
    f.nextStop({ kind: 'cleanup-uncertain', owned: true });
    await externalStop.click();
    await expect.poll(() => f.calls.stops.length).toBe(2);
    f.nextStatus({ kind: 'status', state: 'exited', groupCleared: true, unknownReason: null });
    await f.page.getByRole('button', { name: `Check response in ${title}`, exact: true }).click();
    await expect(send).toBeEnabled();
    await expect(externalStop).toHaveCount(0);
    await f.page.getByRole('button', { name: title, exact: true }).click();
    await expect(transcript(f.page).locator('[data-cleanup-state="cleared"]')).toContainText('Local cleanup is confirmed');
    assert.equal(savedRun(f).reason, 'stop-incomplete', 'Cleanup confirmation never rewrites the historical terminal reason.');
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});


test('a restored incomplete Stop can reconnect after subscription failure without losing its cleanup controls', async () => {
  const config = { cleanupStatus: true };
  const f = await fixture(config);
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    f.nextStop({ kind: 'cleanup-uncertain', owned: true });
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => savedRun(f)?.reason).toBe('stop-incomplete');
    const original = savedRun(f);
    f.nextStatus({ kind: 'status', state: 'cleanup-pending', groupCleared: false, unknownReason: null,
      lastSequence: original.lastSequence, terminal: { type: 'stopped', reason: 'stop-incomplete',
        runId: original.runId, sessionId: original.sessionId, sequence: original.lastSequence, at: original.updatedAt } });
    config.subscribeThrows = true;
    await f.page.reload();
    await expect(transcript(f.page).locator('[data-cleanup-state="unknown"]')).toContainText('Reconnect the original participant');
    const retry = f.page.getByRole('button', { name: 'Retry participant connection', exact: true });
    await expect(retry).toBeEnabled();
    await f.page.evaluate(() => window.__participantTest.setSubscribeThrows(false));
    await retry.click();
    await expect(transcript(f.page).getByRole('button', { name: 'Retry Stop', exact: true })).toBeEnabled();
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toBeEnabled();
    await expect(retry).toHaveCount(0);
    assert.equal(f.calls.starts.length, 1);
    assert.equal(savedRun(f).reason, 'stop-incomplete');
    await f.check();
  } finally { await f.close(); }
});


test('an uncontrolled legacy run retains global Retry without resending and allows size-neutral session selection', async () => {
  const f = await fixture({ workspaceBytes: 1024 * 1024 - 1024, legacyRunning: true, subscribeThrows: true, theme: 'dark' });
  try {
    const original = savedRun(f);
    const title = f.stored.sessions.find((session) => session.id === original.sessionId).title;
    const row = f.page.locator(`[data-other-run-id="${original.runId}"]`);
    await expect(row).toContainText(title);
    await expect(row).toContainText(original.runId);
    const retry = row.getByRole('button', { name: `Retry participant connection in ${title}`, exact: true });
    await expect(retry).toBeEnabled();
    await f.page.evaluate(() => window.__participantTest.setSubscribeThrows(false));
    await retry.click();
    await expect.poll(() => f.calls.reconciles.length).toBe(1);
    await expect(row.getByRole('button', { name: `Stop response in ${title}`, exact: true })).toBeEnabled();
    assert.equal(f.calls.starts.length, 0, 'Retry subscribes and checks the original identity, never resends it.');
    await f.page.getByRole('button', { name: title, exact: true }).click();
    await expect(f.page.locator('.session-link.selected')).toHaveAttribute('data-session-id', original.sessionId);
    await expect(transcript(f.page).first().getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    assert.equal(f.calls.starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('global Stop preserves focus and announces its outcome after the response row disappears', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    const original = savedRun(f);
    const title = f.stored.sessions.find((session) => session.id === original.sessionId).title;
    const other = f.stored.sessions.find((session) => session.id !== original.sessionId);
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    const stop = f.page.getByRole('button', { name: `Stop response in ${title}`, exact: true });
    await stop.focus();
    await f.page.keyboard.press('Enter');
    await expect.poll(() => savedRun(f)?.phase).toBe('stopped');
    await expect(f.page.locator(`[data-other-run-id="${original.runId}"]`)).toHaveCount(0);
    const status = f.page.locator('[data-global-run-status]');
    await expect(status).toBeFocused();
    await expect(status).toContainText(`${title} · Invented participant: Response stopped.`);
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    assert.equal(f.calls.starts.length, 1);
    assert.equal(f.calls.stops.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('unreachable saved cleanup names the original run and permits only an explicit durably saved acknowledgment', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    await f.emit('text', 'Invented retained prefix before unreachable cleanup');
    await expectSavedSequence(f, 2);
    f.nextStop({ kind: 'cleanup-uncertain', owned: true });
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => savedRun(f)?.reason).toBe('stop-incomplete');
    const original = savedRun(f);
    const title = f.stored.sessions.find((session) => session.id === original.sessionId).title;
    const other = f.stored.sessions.find((session) => session.id !== original.sessionId);
    await expect(f.page.getByRole('button', { name: 'Leave cleanup unconfirmed', exact: true })).toHaveCount(0);
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    f.changeModelOnReload('Another invented model');
    await f.page.reload();
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    const row = f.page.locator(`[data-other-run-id="${original.runId}"]`);
    await expect(row).toContainText(title);
    await expect(row).toContainText(original.runId);
    await expect(row).toContainText('Invented model');
    await expect(row.getByRole('button', { name: /Retry participant connection/ })).toHaveCount(0);
    await expect(row.getByRole('button', { name: /Stop response/ })).toHaveCount(0);
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Next invented message');
    await expect(send).toBeDisabled();
    await expect(send).toHaveAccessibleDescription(`Cleanup for ${title} (run ${original.runId}) is not confirmed. Use the available recovery controls for that response before sending another message.`);
    f.blockNext((state) => !!state.conversationRuns?.[0]?.cleanupAcknowledgment);
    await row.getByRole('button', { name: `Leave cleanup unconfirmed in ${title}`, exact: true }).click();
    await expect.poll(() => f.blocked).toBe(1);
    await expect(send).toBeDisabled();
    assert.equal(savedRun(f).cleanupAcknowledgment, undefined);
    assert.equal(f.calls.starts.length, 1);
    f.release();
    await expect.poll(() => savedRun(f)?.cleanupAcknowledgment?.kind).toBe('unreachable');
    await expect(send).toBeEnabled();
    await expect(row).toHaveCount(0);
    await expect(f.page.locator('[data-global-run-status]')).toBeFocused();
    await expect(f.page.locator('[data-global-run-status]')).toContainText('Cleanup left unconfirmed by your choice');
    const acknowledged = savedRun(f);
    const { cleanupAcknowledgment, ...evidence } = acknowledged;
    assert.deepEqual(evidence, original, 'The original terminal, timestamp, sequence and prefix must remain exact.');
    assert.equal(f.calls.stops.length, 1, 'Acknowledgment does not issue Stop against the different participant.');
    await f.page.reload();
    await expect(send).toBeEnabled();
    assert.equal(savedRun(f).cleanupAcknowledgment.kind, 'unreachable');
    await send.click();
    await expect.poll(() => f.calls.starts.length).toBe(2);
    assert.notEqual(f.calls.starts[1].input.runId, original.runId);
    assert.equal(f.calls.starts[1].input.participant.model, 'Another invented model');
    await f.check();
  } finally { await f.close(); }
});

test('a prepared message is named truthfully and cannot start while another run owns cleanup', async () => {
  const f = await fixture();
  try {
    await f.send('First invented running request');
    await expectSavedSequence(f, 1);
    const original = savedRun(f);
    const title = f.stored.sessions.find((session) => session.id === original.sessionId).title;
    const other = f.stored.sessions.find((session) => session.id !== original.sessionId);
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    f.nextStart('not-started');
    await f.send('Second invented prepared request');
    await expect.poll(() => f.calls.starts.length).toBe(2);
    const preparedId = f.calls.starts[1].input.runId;
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toBeEnabled();
    await f.page.getByRole('button', { name: title, exact: true }).click();
    const preparedRow = f.page.locator(`[data-other-run-id="${preparedId}"]`);
    await expect(preparedRow.locator('[data-other-run-status]')).toHaveText('Prepared · not started');
    const globalStart = preparedRow.getByRole('button', { name: `Start prepared message in ${other.title}`, exact: true });
    await expect(globalStart).toBeEnabled();
    f.nextStop({ kind: 'cleanup-uncertain', owned: true });
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => savedRun(f)?.reason).toBe('stop-incomplete');
    await expect(globalStart).toBeDisabled();
    await f.page.getByRole('button', { name: other.title, exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toBeDisabled();
    assert.equal(f.calls.starts.length, 2, 'Neither visible nor global Start bypasses owned cleanup.');
    await f.check();
  } finally { await f.close(); }
});

test('a restored incomplete Stop without status support can retain an honest saved cleanup acknowledgment', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    f.nextStop({ kind: 'cleanup-uncertain', owned: true });
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => savedRun(f)?.reason).toBe('stop-incomplete');
    const original = savedRun(f);
    await f.page.reload();
    const acknowledgment = f.page.getByRole('button', { name: 'Leave cleanup unconfirmed', exact: true });
    await expect(acknowledgment).toBeEnabled();
    await expect(f.page.getByRole('button', { name: 'Check run status', exact: true })).toHaveCount(0);
    await acknowledgment.click();
    await expect.poll(() => savedRun(f)?.cleanupAcknowledgment?.kind).toBe('unreachable');
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented draft after acknowledging unknown cleanup');
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    assert.equal(savedRun(f).reason, original.reason);
    assert.equal(savedRun(f).lastSequence, original.lastSequence);
    await expect(transcript(f.page)).not.toContainText('Local cleanup is confirmed');
    assert.equal(f.calls.starts.length, 1);
    assert.equal(f.calls.stops.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('an interrupted reply cannot acknowledge cleanup until Retry saves its closure and every retained text chunk', async () => {
  const f = await fixture();
  try {
    await f.send();
    await expectSavedSequence(f, 1);
    await f.emit('text', 'Invented durable prefix.');
    await expectSavedSequence(f, 2);
    f.failNext((state) => state.conversationRuns?.[0]?.lastSequence === 3);
    await f.emit('text', ' Invented unsaved checkpoint.');
    await expect(f.page.getByRole('button', { name: 'Retry save', exact: true })).toBeVisible();
    await f.emit('text', ' Invented tail after the failure.');
    await f.page.evaluate(() => window.__participantTest.hold('text', 'Invented missing chunk, never delivered.'));
    const terminal = await f.page.evaluate(() => {
      const event = { ...window.__participantTest.hold('stopped'), reason: 'stop-incomplete' };
      window.__participantTest.deliver(event);
      return event;
    });
    const close = f.page.getByRole('button', { name: 'Close interrupted reply', exact: true });
    await expect(close).toBeEnabled();
    await close.click();
    await expect(transcript(f.page).locator('[data-save-state="pending"]')).toBeVisible();
    const acknowledgment = f.page.getByRole('button', { name: 'Leave cleanup unconfirmed', exact: true });
    assert.equal(await acknowledgment.evaluateAll((buttons) => buttons.some((button) => !button.disabled)), false,
      'A failed earlier checkpoint must not offer an executable cleanup acknowledgment.');
    assert.equal(savedRun(f).lastSequence, 2);
    assert.equal(savedRun(f).closure, undefined);
    assert.equal(savedRun(f).cleanupAcknowledgment, undefined);
    const retained = 'Invented durable prefix. Invented unsaved checkpoint. Invented tail after the failure.';
    await expect(transcript(f.page).locator('.run-output')).toHaveText(retained);
    await f.page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect.poll(() => savedRun(f)?.closure?.kind).toBe('interrupted');
    assert.equal(savedRun(f).lastSequence, 4);
    assert.equal(savedRun(f).outputChunks.join(''), retained);
    assert.deepEqual(savedRun(f).closure.terminalEvent, terminal);
    await expect(acknowledgment).toBeEnabled();
    await acknowledgment.click();
    await expect.poll(() => savedRun(f)?.cleanupAcknowledgment?.kind).toBe('unreachable');
    const durable = savedRun(f);
    await f.page.reload();
    await expect(transcript(f.page).locator('.run-output')).toHaveText(retained);
    assert.deepEqual(savedRun(f), durable, 'Reload keeps the saved closure, retained tail and explicit cleanup choice.');
    assert.equal(f.calls.stops.length, 0, 'An unsolicited recorded ending may be closed without inventing a Stop request.');
    assert.equal(f.calls.starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('a near-limit legacy workspace can return from DATA and an ungrouped view without losing its Stop controls', async () => {
  const f = await fixture({ workspaceBytes: 1024 * 1024 - 1024, legacyRunning: true, theme: 'dark' });
  try {
    const before = f.stored;
    const original = savedRun(f);
    const session = before.sessions.find((entry) => entry.id === original.sessionId);
    const folder = before.goals.find((entry) => entry.id === session.goalId);
    const folderRail = f.page.getByRole('navigation', { name: 'Session folders', exact: true });
    await folderRail.getByRole('button', { name: session.title, exact: true }).click();
    await expect(transcript(f.page).first().getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await f.page.getByRole('button', { name: 'DATA', exact: true }).click();
    const globalStop = f.page.getByRole('button', { name: `Stop response in ${session.title}`, exact: true });
    await expect(globalStop).toBeEnabled();
    await f.page.getByRole('button', { name: 'Cloudwork Nexus', exact: true }).click();
    await expect(transcript(f.page).first().getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    await f.page.getByRole('button', { name: 'Ungrouped sessions', exact: true }).click();
    await expect(f.page.locator('#desk-main').getByRole('heading', { name: 'Ungrouped sessions', exact: true })).toBeVisible();
    await expect(globalStop).toBeEnabled();
    await folderRail.getByRole('button', { name: folder.title, exact: true }).click();
    await expect(f.page.locator(`.domain-row.selected[data-drop-goal-id="${folder.id}"]`)).toBeVisible();
    await folderRail.getByRole('button', { name: session.title, exact: true }).click();
    const stop = transcript(f.page).first().getByRole('button', { name: 'Stop', exact: true });
    await expect(stop).toBeEnabled();
    f.nextStop('unknown');
    await stop.click();
    await expect.poll(() => f.calls.stops.length).toBe(1);
    assert.deepEqual(f.calls.stops[0], { runId: original.runId, sessionId: original.sessionId });
    assert.equal(f.calls.saves.length, 0, 'Every view change remains local and spends no shared storage.');
    assert.equal(f.calls.starts.length, 0);
    assert.deepEqual(f.stored, before);
    await f.check();
  } finally { await f.close(); }
});

for (const withoutParticipant of [false, true]) {
  test(`a full legacy workspace explains refused cleanup acknowledgment and keeps retry ${withoutParticipant ? 'without' : 'with'} a controller`, async () => {
    const f = await fixture({ workspaceBytes: 1024 * 1024 - 16, legacyIncomplete: true, withoutParticipant });
    try {
      const before = f.stored;
      const original = savedRun(f);
      const session = before.sessions.find((entry) => entry.id === original.sessionId);
      const acknowledgment = f.page.getByRole('button', { name: `Leave cleanup unconfirmed in ${session.title}`, exact: true });
      await expect(acknowledgment).toBeEnabled();
      await acknowledgment.click();
      const message = 'This workspace has reached its current proof storage limit. The cleanup acknowledgment was not saved. The response and recovery controls are unchanged.';
      await expect(f.page.getByText(message, { exact: true }).first()).toBeVisible();
      await expect(acknowledgment).toBeEnabled();
      await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
      assert.deepEqual(f.stored, before);
      assert.equal(f.calls.saves.length, 0, 'A known capacity refusal must not become a pending or failed durable save.');
      await acknowledgment.click();
      await expect(acknowledgment).toBeEnabled();
      assert.equal(savedRun(f).cleanupAcknowledgment, undefined);
      assert.equal(f.calls.starts.length, 0);
      await f.externalChange();
      await expect(f.page.getByRole('alert', { name: 'Save recovery', exact: true })).toContainText('Another copy changed');
      await expect(acknowledgment).toBeDisabled();
      assert.equal(f.calls.saves.length, 0, 'An unrelated workspace barrier also disables the cleanup choice.');
      await f.check();
    } finally { await f.close(); }
  });
}

// Catalog entries and the injected participant are invented and confined to the
// intercepted entry above. No native provider or subscription is contacted.
const inventedChoice = {
  identity: { id: 'invented-participant', label: 'Invented participant', model: 'Invented model', executionHost: 'Invented worker' },
  provider: 'Invented subscription', destination: 'Invented test destination',
  approved: true, available: true, unavailableReason: null,
};
const unavailableChoice = {
  identity: { id: 'invented-unavailable', label: 'Invented second participant', model: 'Invented second model', executionHost: 'Invented second worker' },
  provider: 'Invented second subscription', destination: 'Invented second test destination',
  approved: true, available: false, unavailableReason: 'This invented participant is not connected.',
};
const pickerTrigger = (page) => page.getByRole('button', { name: /^Model and participant: / });
const pickerDialog = (page) => page.getByRole('dialog', { name: 'Model and participant', exact: true });
const pickerChoice = (page, choice) => pickerDialog(page).getByRole('button', {
  name: `Choose participant: ${choice.identity.label}, ${choice.identity.model}`, exact: true,
});
async function chooseParticipant(f, choice) {
  await pickerTrigger(f.page).click();
  await pickerChoice(f.page, choice).click();
  await pickerDialog(f.page).getByRole('button', { name: 'Done', exact: true }).click();
}
const savedChoice = (f, sessionId = f.stored.selection.sessionId) => f.stored.sessions.find((session) => session.id === sessionId)?.participantChoice;

test('participant picker requires an explicit choice, saves it across reload, and choosing never dispatches', async () => {
  const f = await fixture({ participantChoices: [inventedChoice, { ...unavailableChoice, approved: false }], input: 'Invented retained draft' });
  try {
    const sessionId = f.stored.selection.sessionId;
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeDisabled();
    assert.equal(savedChoice(f, sessionId), undefined);
    await expect(f.page.locator('.conversation-heading .provider-label')).toHaveText('No participant chosen');
    await expect(pickerTrigger(f.page)).toHaveText('Choose participant');
    await expect(pickerTrigger(f.page)).toHaveAccessibleName('Model and participant: Choose participant');
    await pickerTrigger(f.page).click();
    await expect(pickerDialog(f.page)).toContainText(inventedChoice.provider);
    await expect(pickerDialog(f.page)).toContainText(inventedChoice.destination);
    await expect(pickerDialog(f.page)).toContainText(inventedChoice.identity.executionHost);
    await expect(pickerDialog(f.page).getByRole('listitem')).toHaveCount(1);
    await expect(pickerChoice(f.page, unavailableChoice)).toHaveCount(0);
    for (const description of [inventedChoice.provider, inventedChoice.destination, inventedChoice.identity.executionHost, 'Available']) {
      await expect(pickerChoice(f.page, inventedChoice)).toHaveAccessibleDescription(new RegExp(description));
    }
    await expect(pickerChoice(f.page, inventedChoice)).toHaveText('Choose participant');
    await pickerChoice(f.page, inventedChoice).click();
    await expect.poll(() => savedChoice(f, sessionId)).toEqual(inventedChoice.identity);
    await expect(pickerChoice(f.page, inventedChoice)).toHaveAttribute('aria-pressed', 'true');
    assert.equal(f.calls.starts.length, 0);
    await pickerDialog(f.page).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(pickerTrigger(f.page)).toBeFocused();
    await expect(f.page.locator('.conversation-heading .provider-label')).toHaveText(inventedChoice.identity.label);
    await expect(pickerTrigger(f.page)).toHaveText(inventedChoice.identity.model);
    await expect(pickerTrigger(f.page)).toHaveAccessibleName(`Model and participant: ${inventedChoice.identity.label}, ${inventedChoice.identity.model}`);
    await expect(send).toBeEnabled();
    await f.page.reload();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented retained draft');
    await pickerTrigger(f.page).click();
    await expect(pickerChoice(f.page, inventedChoice)).toHaveAttribute('aria-pressed', 'true');
    assert.deepEqual(savedChoice(f, sessionId), inventedChoice.identity);
    assert.equal(f.calls.starts.length, 0, 'Restoring a participant preference must not start a response.');
    assert.equal(savedRun(f), undefined);
    await f.check();
  } finally { await f.close(); }
});

test('participant picker choice must finish saving before Send can dispatch the selected identity', async () => {
  const f = await fixture({ participantChoices: [inventedChoice], input: 'Invented request with a blocked preference save' });
  try {
    const sessionId = f.stored.selection.sessionId;
    f.blockNext((state) => state.sessions.some((session) => session.id === sessionId && !!session.participantChoice));
    await chooseParticipant(f, inventedChoice);
    await expect.poll(() => f.blocked).toBe(1);
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeDisabled();
    assert.equal(savedChoice(f, sessionId), undefined);
    assert.equal(f.calls.starts.length, 0);
    assert.equal(savedRun(f), undefined);
    f.release();
    await expect.poll(() => savedChoice(f, sessionId)).toEqual(inventedChoice.identity);
    await expect(send).toBeEnabled();
    assert.equal(f.calls.starts.length, 0, 'Completing the preference save is not permission to dispatch.');
    await send.click();
    await expect.poll(() => f.calls.starts.length).toBe(1);
    const { input, savedAtStart } = f.calls.starts[0];
    assert.deepEqual(input.participant, inventedChoice.identity);
    assert.deepEqual(savedAtStart.sessions.find((session) => session.id === sessionId).participantChoice, inventedChoice.identity);
    assert.equal(savedAtStart.conversationRuns.find((run) => run.runId === input.runId).phase, 'prepared');
    await f.check();
  } finally { await f.close(); }
});

for (const [name, catalog] of [
  ['missing', [unavailableChoice]],
  ['unapproved', [{ ...inventedChoice, approved: false }, unavailableChoice]],
  ['changed model', [{ ...inventedChoice, identity: { ...inventedChoice.identity, model: 'Different invented model' } }]],
]) {
  test(`participant picker preserves its saved choice when ${name}, without dispatching or choosing a fallback`, async () => {
    const f = await fixture({
      participantChoices: [inventedChoice], participantChoice: inventedChoice.identity, input: 'Invented draft kept with its saved choice',
    });
    try {
      const sessionId = f.stored.selection.sessionId;
      const send = f.page.getByRole('button', { name: 'Send message', exact: true });
      await expect(send).toBeEnabled();
      f.changeChoicesOnReload(catalog);
      await f.page.reload();
      await expect(send).toBeDisabled();
      await expect(send).toHaveAccessibleDescription(/participant|model|selection|available/i);
      await expect(f.page.locator('.conversation-heading .provider-label')).toHaveText(`${inventedChoice.identity.label} · Unavailable`);
      await pickerTrigger(f.page).click();
      await expect(pickerDialog(f.page).getByRole('region', { name: 'Saved participant selection', exact: true })).toContainText(inventedChoice.identity.model);
      await expect(pickerDialog(f.page)).toContainText('Unavailable — this saved selection is not in the approved participant list.');
      await expect(pickerChoice(f.page, inventedChoice)).toHaveCount(0);
      await pickerDialog(f.page).getByRole('button', { name: 'Done', exact: true }).click();
      await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented draft kept with its saved choice');
      assert.deepEqual(savedChoice(f, sessionId), inventedChoice.identity);
      assert.equal(f.calls.starts.length, 0);
      assert.equal(savedRun(f), undefined);
      await f.page.reload();
      await expect(send).toBeDisabled();
      assert.deepEqual(savedChoice(f, sessionId), inventedChoice.identity);
      assert.equal(f.calls.starts.length, 0);
      await f.check();
    } finally { await f.close(); }
  });
}

test('participant picker permits an unavailable preference while giving its reason and preventing Send', async () => {
  const f = await fixture({ participantChoices: [{ ...inventedChoice, approved: false }, unavailableChoice], input: 'Invented draft waiting for its participant' });
  try {
    await pickerTrigger(f.page).click();
    const option = pickerDialog(f.page).locator('.participant-picker-choice').filter({ has: f.page.getByRole('button', { name: `Choose participant: ${unavailableChoice.identity.label}, ${unavailableChoice.identity.model}`, exact: true }) });
    await expect(option.locator('.participant-picker-availability')).toHaveText(`Unavailable — ${unavailableChoice.unavailableReason}`);
    await expect(pickerChoice(f.page, unavailableChoice)).toHaveAccessibleDescription(/Unavailable.*This invented participant is not connected/);
    await pickerChoice(f.page, unavailableChoice).click();
    await expect.poll(() => savedChoice(f)).toEqual(unavailableChoice.identity);
    await pickerDialog(f.page).getByRole('button', { name: 'Done', exact: true }).click();
    const send = f.page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeDisabled();
    await expect(f.page.locator('.conversation-heading .provider-label')).toHaveText(`${unavailableChoice.identity.label} · Unavailable`);
    await expect(send).toHaveAccessibleDescription(new RegExp(unavailableChoice.unavailableReason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented draft waiting for its participant');
    assert.equal(f.calls.starts.length, 0);
    assert.equal(savedRun(f), undefined);
    await f.check();
  } finally { await f.close(); }
});

test('participant picker keeps each session preference and draft independent through navigation and reload', async () => {
  const f = await fixture({ participantChoices: [inventedChoice, { ...unavailableChoice, approved: false }] });
  try {
    const first = f.stored.sessions.find((session) => session.id === f.stored.selection.sessionId);
    const second = f.stored.sessions.find((session) => session.id !== first.id);
    await chooseParticipant(f, inventedChoice);
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill('First invented participant draft');
    await expect.poll(() => f.stored.drafts[first.id]).toBe('First invented participant draft');
    await f.page.getByRole('button', { name: second.title, exact: true }).click();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('');
    assert.equal(savedChoice(f, second.id), undefined);
    await expect(pickerTrigger(f.page)).toHaveAccessibleName('Model and participant: Choose participant');
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Second invented participant draft');
    await expect.poll(() => f.stored.drafts[second.id]).toBe('Second invented participant draft');
    assert.equal(savedChoice(f, second.id), undefined);
    await f.page.getByRole('button', { name: first.title, exact: true }).click();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('First invented participant draft');
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await f.page.reload();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toBeVisible();
    assert.deepEqual(savedChoice(f, first.id), inventedChoice.identity);
    assert.equal(savedChoice(f, second.id), undefined);
    await f.page.getByRole('button', { name: second.title, exact: true }).click();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Second invented participant draft');
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    assert.equal(f.calls.starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('participant picker changes never reassign a restored response and its original Stop remains usable', async () => {
  const f = await fixture({ participantChoices: [inventedChoice, { ...unavailableChoice, approved: false }] });
  try {
    await chooseParticipant(f, inventedChoice);
    await expect.poll(() => savedChoice(f)).toEqual(inventedChoice.identity);
    await f.send('Invented active response whose next preference changes');
    await expectSavedSequence(f, 1);
    const original = savedRun(f);
    f.changeChoicesOnReload([{ ...inventedChoice, approved: false }, unavailableChoice]);
    await f.page.reload();
    await expect(transcript(f.page)).toHaveAttribute('data-run-id', original.runId);
    await chooseParticipant(f, unavailableChoice);
    await expect.poll(() => savedChoice(f)).toEqual(unavailableChoice.identity);
    await expect(transcript(f.page).getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
    assert.deepEqual(savedRun(f).participant, inventedChoice.identity);
    assert.equal(f.calls.starts.length, 1);
    f.nextStop('unknown');
    await transcript(f.page).getByRole('button', { name: 'Stop', exact: true }).click();
    await expect.poll(() => f.calls.stops.length).toBe(1);
    assert.deepEqual(f.calls.stops[0], { runId: original.runId, sessionId: original.sessionId });
    await expect(transcript(f.page).locator('.run-phase')).toHaveText('Run status unknown');
    assert.deepEqual(savedRun(f).participant, inventedChoice.identity);
    assert.deepEqual(savedChoice(f), unavailableChoice.identity);
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await f.check();
  } finally { await f.close(); }
});

test('participant picker reports a refused preference inside its open dialog and keeps the saved choice unchanged', async () => {
  const f = await fixture({ participantChoices: [inventedChoice], workspaceBytes: 1024 * 1024 - 64 });
  try {
    const original = f.stored;
    await pickerTrigger(f.page).click();
    await pickerChoice(f.page, inventedChoice).click();
    await expect(pickerDialog(f.page).getByRole('alert')).toContainText('This workspace has reached its current proof storage limit.');
    await expect(pickerDialog(f.page)).toBeVisible();
    await expect(pickerChoice(f.page, inventedChoice)).toHaveAttribute('aria-pressed', 'false');
    assert.equal(savedChoice(f), undefined);
    assert.deepEqual(f.stored, original);
    assert.equal(f.calls.saves.length, 0);
    assert.equal(f.calls.starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('participant picker reports a failed preference save inside its open dialog without dispatching', async () => {
  const f = await fixture({ participantChoices: [inventedChoice], input: 'Invented draft retained after a preference save failed' });
  try {
    f.failNext((state) => state.sessions.some((session) => !!session.participantChoice));
    await pickerTrigger(f.page).click();
    await pickerChoice(f.page, inventedChoice).click();
    await expect(pickerDialog(f.page).getByRole('alert')).toContainText('Invented definite save failure.');
    await expect(pickerDialog(f.page)).toBeVisible();
    assert.equal(savedChoice(f), undefined);
    assert.equal(f.calls.starts.length, 0);
    assert.equal(savedRun(f), undefined);
    await pickerDialog(f.page).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented draft retained after a preference save failed');
    await f.page.getByRole('button', { name: 'Retry save', exact: true }).click();
    await expect.poll(() => savedChoice(f)).toEqual(inventedChoice.identity);
    await expect(f.page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await pickerTrigger(f.page).click();
    await expect(pickerDialog(f.page).getByRole('alert')).toHaveCount(0);
    await expect(pickerChoice(f.page, inventedChoice)).toHaveAttribute('aria-pressed', 'true');
    assert.equal(f.calls.starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});
