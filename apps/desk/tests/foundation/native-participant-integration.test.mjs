import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect as browserExpect } from '@playwright/test';

// Checkpoints use the production cadence. No participant or persistence timer
// is replaced, and this suite never contacts a provider or native executable.
const expect = browserExpect.configure({ timeout: 12_000 });
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const vectors = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/native-participant-v1.json'), 'utf8'));
const hostVectors = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/native-host-v1.json'), 'utf8'));
const participant = vectors.context.participant;
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

// Only the intercepted test entry imports this invented host. initializeNativeProof
// supplies the real repository, strict wire codec, participant adapter and App.
function harness(config) {
  const caps = structuredClone(hostVectors.cases.find((entry) => entry.name === 'host.capabilities').reply.capabilities);
  caps.operations.push('workspace.reconcile', 'dictation.receipt', 'participant.availability', 'participant.start',
    'participant.stop', 'participant.status', 'participant.events');
  return `
import React from '/node_modules/.vite/deps/react.js';
import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
import '/brand/fonts/fonts.css';
import '/brand/tokens.css';
import '/src/shell/foundation.css';
import '/src/shell/nexus.css';
import '/src/app/recovery.css';
import { App } from '/src/app/App.tsx';
import { initializeNativeProof } from '/src/app/native-bootstrap.ts';
const config = ${JSON.stringify(config)};
const clone = (value) => JSON.parse(JSON.stringify(value));
const originalPin = ${JSON.stringify(participant)};
let currentPin = ${JSON.stringify(config.oldPin ? vectors.context.changedPin : participant)};
let availabilityFailure = config.availabilityFailure;
let unavailable = !!config.unavailable;
let unavailableReason = config.unavailableReason ?? 'overflow-unverified';
let confirmation = config.confirmation ?? { state: 'active', confirmedAt: '2026-10-10T00:00:00.000Z', runsLeft: 5 };
const bootstrap = ${JSON.stringify({ v: 1, connectionId: vectors.context.connectionId, generation: vectors.context.documentGeneration })};
const capabilities = ${JSON.stringify(caps)};
let record = ${JSON.stringify(config.prepared ? vectors.records['prepared-r5'] : config.oldPin || config.replayGap ? vectors.records['running-r6'] : vectors.records['base-r4'])};
if (config.selected || config.oldPin) record.sessions[0].participantChoice = clone(originalPin);
if (config.input !== undefined) record.drafts[record.selection.sessionId] = config.input;
if (config.twoSessions) {
  const other = { ...clone(record.sessions[0]), id: '52abcdef-0000-4000-8abc-000000000002',
    title: 'Second invented native session', participantChoice: clone(originalPin) };
  record.sessions.push(other);
  record.drafts[other.id] = 'Invented second-session request';
}
const calls = []; const failures = []; const starts = []; const replies = new Map();
const held = new Map(); const holdNext = new Set();
let run = record.conversationRuns?.[0] ? clone(record.conversationRuns[0]) : undefined;
let events = []; let terminal = null; let sequence = run?.lastSequence ?? 0;
let runState = config.oldPin && !config.prepared ? 'running' : 'not-dispatched';
if (config.replayGap) {
  events = [
    { runId: run.runId, sessionId: run.sessionId, sequence: 3, at: '2026-10-09T00:01:02.000Z', type: 'text', text: 'Recovered invented tail.' },
    { runId: run.runId, sessionId: run.sessionId, sequence: 4, at: '2026-10-09T00:01:03.000Z', type: 'completed' },
  ];
  terminal = events[1]; sequence = 4; runState = 'exited'; holdNext.add('replay');
}
let hostLocked = false;
const check = (condition, message) => { if (!condition) throw Error(message); };
const push = (event) => window.dispatchEvent(new CustomEvent('trueconvo-host', { detail: {
  type: 'participant.event', connectionId: bootstrap.connectionId, generation: bootstrap.generation, event: clone(event),
} }));
function emit(type, text) {
  check(!!run, 'No invented prepared run');
  const event = { runId: run.runId, sessionId: run.sessionId, sequence: ++sequence,
    at: new Date(Math.max(Date.now(), Date.parse(run.createdAt))).toISOString(), type,
    ...(type === 'text' ? { text } : {}), ...(type === 'stopped' ? { reason: 'local-stop' } : {}) };
  events.push(event);
  if (type === 'stopped' || type === 'completed') { terminal = event; runState = 'exited'; }
  push(event); return event;
}
function lock() {
  hostLocked = true;
  window.dispatchEvent(new CustomEvent('trueconvo-host', { detail: { type: 'host.connection',
    connectionId: bootstrap.connectionId, generation: bootstrap.generation, state: 'locked', reason: 'locked' } }));
}
async function postMessage(input) {
  try {
    const request = clone(input); const wire = JSON.stringify(request);
    check(JSON.stringify(Object.keys(request).sort()) === JSON.stringify(['v', 'requestId', 'connectionId', 'generation', 'operation', 'payload'].sort()), 'Unexpected envelope fields');
    check(request.v === 1 && request.connectionId === bootstrap.connectionId && request.generation === bootstrap.generation, 'Wrong native correlation');
    check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.requestId), 'Invalid request id');
    calls.push(request);
    const prior = replies.get(request.requestId);
    if (prior) { check(prior.wire === wire, 'Request identity changed bytes'); return clone(prior.reply); }
    const base = { v: 1, requestId: request.requestId, connectionId: request.connectionId,
      generation: request.generation, operation: request.operation };
    let reply;
    if (hostLocked) reply = { ...base, outcome: 'refused', reason: 'store-locked' };
    else if (request.operation === 'host.capabilities') reply = { ...base, outcome: 'ok', capabilities: clone(capabilities) };
    else if (request.operation === 'participant.availability') {
      check(Object.keys(request.payload).length === 0, 'Availability has no caller inputs');
      if (availabilityFailure === 'transport') return Promise.reject(Error('Invented unavailable transport'));
      if (availabilityFailure === 'timeout') return new Promise(() => {});
      reply = { ...base, outcome: 'ok', participants: [{ ...currentPin,
        available: !unavailable, reason: unavailable ? unavailableReason : null,
        ...(config.noConfirmation ? {} : { confirmation: clone(confirmation) }) }] };
      if (availabilityFailure === 'refused') reply = { ...base, outcome: 'refused', reason: 'participant-unavailable' };
      if (availabilityFailure === 'malformed') reply.unexpected = true;
      if (holdNext.delete('availability')) await new Promise((done) => held.set('availability', done));
    } else {
      check(request.payload.workspaceHandle === capabilities.workspaceHandle, 'Wrong workspace handle');
      if (request.operation === 'workspace.read') reply = { ...base, outcome: 'ok', revision: record.revision, record: clone(record) };
      else if (request.operation === 'workspace.commitProof') {
        const next = request.payload.record;
        const isChoice = next.sessions.some((session) => session.participantChoice) && !record.sessions.some((session) => session.participantChoice);
        const kind = request.payload.participantRun ? 'prepare' : isChoice ? 'choice' : (next.conversationRuns?.[0]?.outputChunks.length ?? 0) > 0 ? 'output' : 'ordinary';
        if (holdNext.delete(kind)) await new Promise((done) => held.set(kind, done));
        if (request.payload.expectedRevision !== record.revision) reply = { ...base, outcome: 'conflict', revision: record.revision, reason: 'revision-mismatch' };
        else {
          const introduced = (next.conversationRuns ?? []).filter((entry) => !(record.conversationRuns ?? []).some((saved) => saved.runId === entry.runId));
          if (introduced.length) {
            check(introduced.length === 1, 'Only one run may be prepared');
            const prepared = introduced[0]; const claim = request.payload.participantRun;
            check(!!claim && JSON.stringify(Object.keys(claim).sort()) === JSON.stringify(['runId', 'sessionId', 'userMessageId', 'assistantMessageId', 'participantId', 'createdAt'].sort()), 'Missing or unexpected prepare claim');
            check(claim.runId === prepared.runId && claim.sessionId === prepared.sessionId && claim.userMessageId === prepared.userMessageId
              && claim.assistantMessageId === prepared.assistantMessageId && claim.participantId === prepared.participant.id
              && claim.createdAt === prepared.createdAt, 'Prepare claim differs from record');
            check(prepared.phase === 'prepared' && Object.keys(prepared).length === 12, 'Run was not exactly prepared');
            check(JSON.stringify(prepared.participant) === JSON.stringify(currentPin), 'Prepared pin differs from current native pin');
            check(new TextEncoder().encode(prepared.inputChunks.join('')).length <= 4096, 'Trial input bound exceeded in preparation');
            run = clone(prepared); sequence = 0; events = []; terminal = null; runState = 'not-dispatched';
          } else check(!request.payload.participantRun, 'An ordinary save must not repeat a preparing claim');
          record = clone(next); reply = { ...base, outcome: 'ok', revision: record.revision };
        }
      } else {
        check(!!run && request.payload.runId === run.runId && request.payload.sessionId === run.sessionId, 'Wrong original run target');
        if (request.operation === 'participant.start') {
          check(!unavailable, 'Unavailable participant was dispatched');
          check(runState === 'not-dispatched', 'Duplicate dispatch');
          check(JSON.stringify(request.payload.participant) === JSON.stringify(run.participant)
            && JSON.stringify(run.participant) === JSON.stringify(currentPin), 'Start substituted a participant');
          check(JSON.stringify(request.payload.inputChunks) === JSON.stringify(run.inputChunks), 'Start changed prepared input');
          check(record.conversationRuns.some((entry) => entry.runId === run.runId && entry.phase === 'prepared'), 'Start preceded durable preparation');
          starts.push({ request: clone(request), savedAtStart: clone(record) }); runState = 'running';
          reply = { ...base, outcome: 'ok', runId: run.runId }; emit('started');
          if (config.endConfirmationAfterStart) {
            unavailable = true; unavailableReason = 'overflow-unverified';
            confirmation = { state: 'ended', endedBy: 'run-limit' };
          }
        } else if (request.operation === 'participant.stop') {
          if (!terminal) emit('stopped');
          reply = { ...base, outcome: 'ok', runId: run.runId, state: 'exited', terminal: clone(terminal), groupCleared: true, providerCancelConfirmed: false };
        } else if (request.operation === 'participant.status') {
          reply = { ...base, outcome: 'ok', runId: run.runId, state: runState, lastSequence: sequence,
            terminal: clone(terminal), groupCleared: terminal ? true : null, unknownReason: null };
        } else if (request.operation === 'participant.events') {
          const page = events.filter((event) => event.sequence > request.payload.afterSequence).slice(0, request.payload.maxEvents);
          reply = { ...base, outcome: 'ok', runId: run.runId, events: clone(page),
            more: events.filter((event) => event.sequence > request.payload.afterSequence).length > page.length,
            lastSequence: sequence, lost: null, terminal: null };
          if (holdNext.delete('replay')) await new Promise((done) => held.set('replay', done));
        } else throw Error('Unexpected invented operation: ' + request.operation);
      }
    }
    replies.set(request.requestId, { wire, reply: clone(reply) }); return clone(reply);
  } catch (error) { failures.push(error.message); throw error; }
}
window.__nativeParticipantFixture = {
  inspect: () => clone({ calls, starts, failures, record, held: [...held.keys()] }),
  hold: (kind) => holdNext.add(kind),
  release: (kind) => { const done = held.get(kind); check(!!done, 'No held ' + kind); held.delete(kind); done(); },
  text: (text) => emit('text', text), complete: () => emit('completed'), lock,
  failAvailability: (failure) => { availabilityFailure = failure; },
  setAvailability: (available, reason = 'cli-missing', nextConfirmation) => {
    unavailable = !available; unavailableReason = reason;
    if (nextConfirmation) confirmation = nextConfirmation;
  },
  setPin: (pin) => { currentPin = pin; },
  refresh: () => initialized.runtime.refreshParticipants(),
};
const initialized = await initializeNativeProof({ bootstrap, postMessage, events: window }, config.shortTimeout ? { timeoutMs: 100 } : {});
if (initialized.kind !== 'ready') throw Error('Invented twelve-operation native bootstrap refused');
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App, { runtime: initialized.runtime }));
`;
}

async function fixture(config = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const page = await context.newPage(); const errors = []; const outside = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.__forbiddenNativeParticipant = [];
      for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) {
        Object.defineProperty(window, key, { configurable: true, get() { window.__forbiddenNativeParticipant.push(key); throw Error('Forbidden browser authority: ' + key); } });
      }
      URL.createObjectURL = () => { window.__forbiddenNativeParticipant.push('object-url'); throw Error('Forbidden plaintext export'); };
    });
    await page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) { outside.push(url.origin); return route.abort(); }
      if (url.pathname === '/src/main.tsx') return route.fulfill({ contentType: 'application/javascript', body: harness(config) });
      return route.continue();
    });
    await page.goto(origin);
    await expect.poll(() => errors.length ? errors.join('\n') : page.getByRole('textbox', { name: 'Your message', exact: true }).count(), { timeout: 20_000 }).toBe(1);
    return {
      page,
      inspect: () => page.evaluate(() => window.__nativeParticipantFixture.inspect()),
      hold: (kind) => page.evaluate((kind) => window.__nativeParticipantFixture.hold(kind), kind),
      release: (kind) => page.evaluate((kind) => window.__nativeParticipantFixture.release(kind), kind),
      async check() {
        assert.deepEqual((await page.evaluate(() => window.__nativeParticipantFixture.inspect())).failures, []);
        assert.deepEqual(await page.evaluate(() => window.__forbiddenNativeParticipant), []);
        assert.deepEqual(errors, []); assert.deepEqual(outside, []);
      },
      close: () => context.close(),
    };
  } catch (error) { await context.close(); throw error; }
}
const picker = (page) => page.getByRole('dialog', { name: 'Model and participant', exact: true });
const trigger = (page) => page.getByRole('button', { name: /^Model and participant: / });
const send = (page) => page.getByRole('button', { name: 'Send message', exact: true });
const stop = (page) => page.locator('.run-stop');
const operations = (inspection, operation) => inspection.calls.filter((request) => request.operation === operation);
async function choose(f, activeConfirmation = false) {
  await trigger(f.page).click();
  if (activeConfirmation) await expect(picker(f.page)).toContainText('You confirmed paid usage was off at');
  await picker(f.page).getByRole('button', { name: `Choose participant: ${participant.label}, ${participant.model}`, exact: true }).click();
  await picker(f.page).getByRole('button', { name: 'Done', exact: true }).click();
}

test('native bootstrap picker durably saves its exact choice and preparing claim before dispatch', async () => {
  const f = await fixture(); const { page } = f;
  try {
    await expect(send(page)).toBeDisabled();
    await f.hold('choice'); await choose(f, true);
    await expect.poll(async () => (await f.inspect()).held).toEqual(['choice']);
    await expect(send(page)).toBeDisabled();
    assert.equal((await f.inspect()).record.sessions[0].participantChoice, undefined);
    assert.equal((await f.inspect()).starts.length, 0);
    await f.release('choice');
    await expect.poll(async () => (await f.inspect()).record.sessions[0].participantChoice).toEqual(participant);
    await expect(send(page)).toBeEnabled();
    await f.hold('prepare'); await send(page).click();
    await expect.poll(async () => (await f.inspect()).held).toEqual(['prepare']);
    assert.equal((await f.inspect()).starts.length, 0);
    assert.equal((await f.inspect()).record.conversationRuns, undefined);
    await f.release('prepare');
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(1);
    const inspected = await f.inspect(); const started = inspected.starts[0];
    assert.deepEqual(started.request.payload.participant, participant);
    assert.deepEqual(started.savedAtStart.sessions[0].participantChoice, participant);
    assert.equal(started.savedAtStart.conversationRuns[0].phase, 'prepared');
    const prepareIndex = inspected.calls.findIndex((request) => request.operation === 'workspace.commitProof' && request.payload.participantRun);
    assert.ok(prepareIndex >= 0 && prepareIndex < inspected.calls.findIndex((request) => request.operation === 'participant.start'));
    assert.deepEqual(inspected.calls.slice(0, 3).map((request) => request.operation), ['host.capabilities', 'participant.availability', 'workspace.read']);
    await f.check();
  } finally { await f.close(); }
});

test('native literal streaming and Stop keep working while the workspace checkpoint is blocked', async () => {
  const f = await fixture({ selected: true }); const { page } = f;
  try {
    await send(page).click();
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(1);
    await f.hold('output');
    const text = '<script>invented only</script>\nA literal partial reply 😀';
    await page.evaluate((text) => window.__nativeParticipantFixture.text(text), text);
    await expect(page.locator('.run-output')).toHaveText(text);
    await expect.poll(async () => (await f.inspect()).held).toEqual(['output']);
    await expect(stop(page)).toBeEnabled();
    await stop(page).click();
    await expect.poll(async () => operations(await f.inspect(), 'participant.stop').length).toBe(1);
    assert.deepEqual((await f.inspect()).held, ['output'], 'Stop must finish before the checkpoint is released.');
    assert.equal((await f.inspect()).record.conversationRuns[0].outputChunks.join(''), '');
    await expect(page.locator('[data-pending-output]')).toHaveText(text);
    await f.release('output');
    await expect.poll(async () => (await f.inspect()).record.conversationRuns[0].phase).toBe('stopped');
    assert.equal((await f.inspect()).record.conversationRuns[0].outputChunks.join(''), text);
    await expect(page.locator('[data-saved-output]')).toHaveText(text);
    await expect(page.locator('.run-output script')).toHaveCount(0);
    await expect.poll(async () => operations(await f.inspect(), 'participant.status').length > 0).toBe(true);
    await f.check();
  } finally { await f.close(); }
});

test('native unavailable confirmation states remain visible and never prepare or send', async () => {
  for (const confirmation of [{ state: 'unconfirmed' }, { state: 'ended', endedBy: 'run-limit' }]) {
    const f = await fixture({ selected: true, unavailable: true, confirmation }); const { page } = f;
    try {
      await expect(send(page)).toBeDisabled();
      await trigger(page).click();
      await expect(picker(page)).toContainText(confirmation.state === 'unconfirmed' ? 'Not yet confirmed' : 'Confirmation ended');
      await expect(picker(page).getByRole('button', { name: `Choose participant: ${participant.label}, ${participant.model}`, exact: true })).toBeVisible();
      await picker(page).getByRole('button', { name: 'Done', exact: true }).click();
      await page.getByRole('textbox', { name: 'Your message', exact: true }).press('Enter');
      await expect(send(page)).toBeDisabled();
      const inspected = await f.inspect();
      assert.equal(operations(inspected, 'participant.start').length, 0);
      assert.equal(inspected.calls.filter((request) => request.payload.participantRun).length, 0);
      assert.equal(inspected.record.conversationRuns, undefined);
      await f.check();
    } finally { await f.close(); }
  }
});

test('native restored runs retain their old pin for status and Stop without dispatching the new pin', async () => {
  const f = await fixture({ oldPin: true }); const { page } = f;
  try {
    await expect(page.locator('.run-participant')).toContainText(participant.model);
    await expect.poll(async () => operations(await f.inspect(), 'participant.status').length > 0).toBe(true);
    await expect(stop(page)).toBeEnabled();
    await stop(page).click();
    await expect.poll(async () => operations(await f.inspect(), 'participant.stop').length).toBe(1);
    await expect.poll(async () => (await f.inspect()).record.conversationRuns[0].phase).toBe('stopped');
    await page.getByRole('textbox', { name: 'Your message', exact: true }).fill('Invented follow-up retained for an unavailable old selection');
    await expect(send(page)).toBeDisabled();
    const inspected = await f.inspect(); const old = vectors.records['running-r6'].conversationRuns[0];
    assert.deepEqual(inspected.record.conversationRuns[0].participant, participant);
    assert.deepEqual(inspected.record.sessions[0].participantChoice, participant);
    for (const call of inspected.calls.filter((request) => ['participant.status', 'participant.events', 'participant.stop'].includes(request.operation))) {
      assert.equal(call.payload.runId, old.runId); assert.equal(call.payload.sessionId, old.sessionId);
    }
    assert.equal(operations(inspected, 'participant.start').length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('native lock clears the full App and ignores late checkpoint replies and participant pushes', async () => {
  const f = await fixture({ selected: true }); const { page } = f;
  try {
    await send(page).click();
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(1);
    await f.hold('output');
    await page.evaluate(() => window.__nativeParticipantFixture.text('Invented text before native lock'));
    await expect.poll(async () => (await f.inspect()).held).toEqual(['output']);
    await trigger(page).click();
    await expect(picker(page)).toBeVisible();
    await page.evaluate(() => window.__nativeParticipantFixture.lock());
    await expect(page.getByRole('heading', { name: 'Workspace connection closed', exact: true })).toBeVisible();
    const callsAtLock = (await f.inspect()).calls.length;
    await f.release('output');
    await page.evaluate(() => window.__nativeParticipantFixture.text('Invented late event that must stay invisible'));
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.run-output')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveCount(0);
    await expect(page.getByText('Invented late event that must stay invisible', { exact: true })).toHaveCount(0);
    assert.equal((await f.inspect()).calls.length, callsAtLock);
    await f.check();
  } finally { await f.close(); }
});

test('native first-trial limit keeps all 4,097 UTF-8 bytes of a draft without preparation or dispatch', async () => {
  const input = '😀'.repeat(1024) + 'x';
  assert.equal(Buffer.byteLength(input, 'utf8'), 4097);
  const f = await fixture({ selected: true, input }); const { page } = f;
  try {
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(input);
    await expect(send(page)).toBeDisabled();
    await page.getByRole('textbox', { name: 'Your message', exact: true }).press('Enter');
    const inspected = await f.inspect();
    assert.equal(inspected.record.drafts[inspected.record.selection.sessionId], input);
    assert.equal(inspected.record.conversationRuns, undefined);
    assert.equal(inspected.calls.filter((request) => request.payload.participantRun).length, 0);
    assert.equal(operations(inspected, 'participant.start').length, 0);
    await f.check();
  } finally { await f.close(); }
});


test('native unsaved response in another session blocks Send until durable without starting automatically', async () => {
  const f = await fixture({ selected: true, twoSessions: true }); const { page } = f;
  try {
    await send(page).click();
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(1);
    await f.hold('output');
    const text = 'Invented completed first-session response that still needs its save.';
    await page.evaluate((text) => window.__nativeParticipantFixture.text(text), text);
    await expect.poll(async () => (await f.inspect()).held).toEqual(['output']);
    await page.evaluate(() => window.__nativeParticipantFixture.complete());
    await expect(page.locator('.run-phase')).toHaveText('Response complete');
    await expect(page.locator('[data-cleanup-state]')).toHaveAttribute('data-cleanup-state', 'cleared');
    await expect(page.locator('[data-pending-output]')).toHaveText(text);
    const firstRunId = (await f.inspect()).starts[0].request.payload.runId;
    await page.getByRole('navigation', { name: 'Session folders', exact: true })
      .getByRole('button', { name: 'Second invented native session', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented second-session request');
    await expect(trigger(page)).toHaveText(participant.model);
    await expect(send(page)).toBeDisabled();
    await page.getByRole('textbox', { name: 'Your message', exact: true }).press('Enter');
    let inspected = await f.inspect();
    assert.equal(inspected.starts.length, 1);
    assert.deepEqual(inspected.held, ['output']);
    assert.equal(inspected.record.conversationRuns[0].outputChunks.join(''), '');
    await f.release('output');
    await expect.poll(async () => (await f.inspect()).record.conversationRuns.find((run) => run.runId === firstRunId)?.phase).toBe('completed');
    await expect(send(page)).toBeEnabled();
    inspected = await f.inspect();
    assert.equal(inspected.starts.length, 1, 'Saving the first response never authorizes another dispatch.');
    assert.equal(inspected.record.conversationRuns.find((run) => run.runId === firstRunId).outputChunks.join(''), text);
    await send(page).click();
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(2);
    inspected = await f.inspect();
    const secondStart = inspected.starts[1];
    assert.equal(secondStart.request.payload.sessionId, '52abcdef-0000-4000-8abc-000000000002');
    assert.equal(secondStart.savedAtStart.conversationRuns.length, 2);
    assert.equal(secondStart.savedAtStart.conversationRuns.find((run) => run.runId === firstRunId).phase, 'completed');
    assert.equal(secondStart.savedAtStart.conversationRuns.find((run) => run.runId === secondStart.request.payload.runId).phase, 'prepared');
    await expect(page.locator('.run-phase')).toHaveText('Response in progress');
    await f.check();
  } finally { await f.close(); }
});

for (const failure of ['transport', 'timeout', 'refused', 'malformed']) {
  test(`native initial ${failure} availability failure is explained without disowning the saved choice`, async () => {
    const input = 'Invented draft kept through an unavailable native check';
    const f = await fixture({ selected: true, availabilityFailure: failure, shortTimeout: true, input });
    try {
      await expect(f.page.locator('#send-blocked-reason')).toContainText('could not confirm participant availability');
      await expect(send(f.page)).toBeDisabled();
      await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(input);
      await trigger(f.page).click();
      await expect(picker(f.page)).toContainText('could not confirm participant availability');
      await expect(picker(f.page)).not.toContainText('not in the approved participant list');
      await expect(picker(f.page)).not.toContainText('No approved participants are listed');
      await expect(f.page.locator('body')).not.toContainText('no longer an approved choice');
      await f.page.evaluate(() => window.__nativeParticipantFixture.failAvailability(null));
      await picker(f.page).getByRole('button', { name: 'Check availability again', exact: true }).click();
      await expect(picker(f.page).getByRole('button', { name: /^Choose participant:/ })).toBeVisible();
      await picker(f.page).getByRole('button', { name: 'Done', exact: true }).click();
      await expect(send(f.page)).toBeEnabled();
      const inspected = await f.inspect();
      assert.equal(inspected.record.drafts[inspected.record.selection.sessionId], input);
      assert.deepEqual(inspected.record.sessions[0].participantChoice, participant);
      assert.equal(inspected.starts.length, 0);
      await f.check();
    } finally { await f.close(); }
  });
}

test('native Start uses its successful fresh check even when a later picker refresh fails', async () => {
  const f = await fixture({ selected: true });
  try {
    await expect(send(f.page)).toBeEnabled();
    await f.hold('prepare');
    await send(f.page).click();
    await expect.poll(async () => (await f.inspect()).held).toEqual(['prepare']);
    await f.hold('availability');
    await f.release('prepare');
    await expect.poll(async () => (await f.inspect()).held).toEqual(['availability']);
    await f.page.evaluate(() => window.__nativeParticipantFixture.failAvailability('refused'));
    await trigger(f.page).click();
    await expect(picker(f.page)).toContainText('could not confirm participant availability');
    await expect(picker(f.page).getByRole('button', { name: /^Choose participant:/ })).toBeVisible();
    await expect(picker(f.page)).not.toContainText('No approved participants are listed');
    await f.release('availability');
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(1);
    await expect(f.page.locator('body')).not.toContainText('The participant did not start');
    await picker(f.page).getByRole('button', { name: 'Done', exact: true }).click();
    await expect(stop(f.page)).toBeEnabled();
    await stop(f.page).click();
    await expect.poll(async () => (await f.inspect()).record.conversationRuns[0].phase).toBe('stopped');
    assert.equal((await f.inspect()).starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('picker focus stays inside the dialog when a refresh replaces its focused choice', async () => {
  const f = await fixture({ selected: true });
  try {
    await trigger(f.page).click();
    const choice = picker(f.page).getByRole('button', { name: /^Choose participant:/ });
    await choice.focus();
    await expect(choice).toBeFocused();
    await f.page.evaluate(async () => {
      const fixture = window.__nativeParticipantFixture;
      fixture.setPin({ id: 'claude-code', label: 'Claude Code', model: 'invented-replacement-model', executionHost: 'this-mac' });
      await fixture.refresh();
    });
    await expect(picker(f.page).getByRole('button', { name: 'Done', exact: true })).toBeFocused();
    await expect(picker(f.page)).toContainText('invented-replacement-model');
    await picker(f.page).getByRole('button', { name: /^Choose participant:/ }).focus();
    const closeButton = picker(f.page).getByRole('button', { name: 'Close model and participant', exact: true });
    await closeButton.focus();
    await f.page.evaluate(async () => {
      window.__nativeParticipantFixture.setPin({ id: 'claude-code', label: 'Claude Code', model: 'another-invented-model', executionHost: 'this-mac' });
      await window.__nativeParticipantFixture.refresh();
    });
    await expect(closeButton).toBeFocused();
    assert.deepEqual((await f.inspect()).record.sessions[0].participantChoice, participant);
    await f.check();
  } finally { await f.close(); }
});

test('a host without confirmation support does not send the user to a nonexistent confirmation control', async () => {
  const f = await fixture({ selected: true, unavailable: true, noConfirmation: true });
  try {
    await expect(send(f.page)).toBeDisabled();
    await trigger(f.page).click();
    await expect(picker(f.page)).toContainText('This Mac app cannot send to the participant yet');
    await expect(picker(f.page)).not.toContainText('Confirm paid usage is off in the Mac app');
    await f.check();
  } finally { await f.close(); }
});

test('restored buffered terminal blocks another session until replayed text and terminal are saved', async () => {
  const f = await fixture({ selected: true, twoSessions: true, replayGap: true });
  try {
    await expect.poll(async () => (await f.inspect()).held).toEqual(['replay']);
    await f.page.getByRole('navigation', { name: 'Session folders', exact: true })
      .getByRole('button', { name: 'Second invented native session', exact: true }).click();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue('Invented second-session request');
    await expect(send(f.page)).toBeDisabled();
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).press('Enter');
    assert.equal((await f.inspect()).starts.length, 0);
    assert.equal((await f.inspect()).record.conversationRuns[0].outputChunks.join(''), 'Four. ');
    await f.hold('output');
    await f.release('replay');
    await expect.poll(async () => {
      const observed = await f.inspect();
      return observed.held.includes('output') ? ['output'] : {
        held: observed.held, failures: observed.failures, run: observed.record.conversationRuns[0],
        recovery: await f.page.locator('.other-run-controls').innerText(),
      };
    }).toEqual(['output']);
    await expect(send(f.page)).toBeDisabled();
    assert.equal((await f.inspect()).starts.length, 0);
    await f.release('output');
    await expect.poll(async () => (await f.inspect()).record.conversationRuns[0].phase).toBe('completed');
    assert.equal((await f.inspect()).record.conversationRuns[0].outputChunks.join(''), 'Four. Recovered invented tail.');
    await expect(send(f.page)).toBeEnabled();
    assert.equal((await f.inspect()).starts.length, 0, 'Recovery must not automatically send the second draft.');
    await f.check();
  } finally { await f.close(); }
});

test('Send refreshes stale native availability before any prepared run or draft consumption', async () => {
  const input = 'Invented draft must stay a draft until availability is checked';
  const f = await fixture({ selected: true, input });
  try {
    await expect(send(f.page)).toBeEnabled();
    const before = await f.inspect();
    await f.page.evaluate(() => window.__nativeParticipantFixture.setAvailability(false, 'overflow-unverified', { state: 'ended', endedBy: 'run-limit' }));
    await send(f.page).click();
    await expect(f.page.locator('#send-blocked-reason')).toContainText('Confirm paid usage is off');
    await expect(send(f.page)).toBeDisabled();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(input);
    const after = await f.inspect();
    assert.ok(operations(after, 'participant.availability').length > operations(before, 'participant.availability').length);
    assert.equal(after.record.conversationRuns, undefined);
    assert.equal(after.calls.filter((request) => request.payload.participantRun).length, 0);
    assert.equal(operations(after, 'workspace.commitProof').length, operations(before, 'workspace.commitProof').length);
    assert.equal(after.starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('focus and visibility refresh native availability in both directions without opening the picker or dispatching', async () => {
  const f = await fixture({ selected: true });
  try {
    await expect(send(f.page)).toBeEnabled();
    await f.page.evaluate(() => {
      window.__nativeParticipantFixture.setAvailability(false, 'signed-out');
      window.dispatchEvent(new Event('focus'));
    });
    await expect(f.page.locator('#send-blocked-reason')).toContainText('signed out');
    await expect(send(f.page)).toBeDisabled();
    await f.page.evaluate(() => {
      window.__nativeParticipantFixture.setAvailability(true);
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(send(f.page)).toBeEnabled();
    assert.equal(await picker(f.page).count(), 0);
    const inspected = await f.inspect();
    assert.equal(inspected.starts.length, 0);
    assert.equal(inspected.record.conversationRuns, undefined);
    await f.check();
  } finally { await f.close(); }
});

test('a cached-unavailable prepared run has an explicit availability retry and starts only after a separate user action', async () => {
  const f = await fixture({ selected: true, prepared: true, unavailable: true, unavailableReason: 'cli-missing' });
  try {
    await expect(f.page.locator('.run-phase')).toHaveText('Prepared · not started');
    await expect(f.page.locator('#send-blocked-reason')).toContainText('not installed');
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toHaveCount(0);
    await f.page.evaluate(() => window.__nativeParticipantFixture.setAvailability(true));
    await f.page.getByRole('button', { name: 'Check participant availability', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toBeEnabled();
    assert.equal((await f.inspect()).starts.length, 0);
    await expect(f.page.getByRole('button', { name: 'Check participant availability', exact: true })).toBeFocused();
    assert.equal(await picker(f.page).count(), 0);
    await f.page.getByRole('button', { name: 'Start prepared message', exact: true }).click();
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(1);
    assert.equal((await f.inspect()).calls.filter((request) => request.payload.participantRun).length, 0, 'Retry reuses the already saved run.');
    await f.check();
  } finally { await f.close(); }
});

test('starting the final confirmed run refreshes the ended confirmation while preserving that live response', async () => {
  const f = await fixture({ selected: true, endConfirmationAfterStart: true });
  try {
    await send(f.page).click();
    await expect.poll(async () => (await f.inspect()).starts.length).toBe(1);
    await expect(f.page.locator('#send-blocked-reason')).toContainText('Confirm paid usage is off');
    await expect(stop(f.page)).toBeEnabled();
    await f.page.evaluate(() => window.__nativeParticipantFixture.text('Invented fifth-run reply still streams'));
    await expect(f.page.locator('.run-output')).toHaveText('Invented fifth-run reply still streams');
    await trigger(f.page).click();
    await expect(picker(f.page)).toContainText('Confirmation ended');
    await expect(picker(f.page)).not.toContainText('You confirmed paid usage was off at');
    assert.equal((await f.inspect()).starts.length, 1);
    await f.check();
  } finally { await f.close(); }
});

test('changing a draft during the Send availability check cancels that preparation and keeps the edited draft', async () => {
  const input = 'Invented draft before its check';
  const changed = 'Invented edited draft must not be silently sent';
  const f = await fixture({ selected: true, input });
  try {
    await expect(send(f.page)).toBeEnabled();
    await f.hold('availability');
    await send(f.page).click();
    await expect.poll(async () => (await f.inspect()).held).toEqual(['availability']);
    await f.page.getByRole('textbox', { name: 'Your message', exact: true }).fill(changed);
    await f.release('availability');
    await expect(send(f.page)).toBeEnabled();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(changed);
    assert.equal((await f.inspect()).record.conversationRuns, undefined);
    assert.equal((await f.inspect()).starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('availability loss during prepared saving keeps idle recovery and Stop after availability returns', async () => {
  const f = await fixture({ selected: true });
  try {
    await f.hold('prepare');
    await send(f.page).click();
    await expect.poll(async () => (await f.inspect()).held).toEqual(['prepare']);
    await f.page.evaluate(async () => {
      window.__nativeParticipantFixture.failAvailability('refused');
      await window.__nativeParticipantFixture.refresh();
    });
    await f.release('prepare');
    await expect(f.page.locator('.run-phase')).toHaveText('Prepared · not started');
    await expect(stop(f.page)).toBeEnabled();
    await expect(f.page.getByRole('button', { name: 'Check participant availability', exact: true })).toBeEnabled();
    assert.equal((await f.inspect()).starts.length, 0);
    await f.page.evaluate(() => window.__nativeParticipantFixture.failAvailability(null));
    await f.page.getByRole('button', { name: 'Check participant availability', exact: true }).click();
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toBeEnabled();
    await expect(stop(f.page)).toBeEnabled();
    const prepared = (await f.inspect()).record.conversationRuns[0];
    await stop(f.page).click();
    await expect(f.page.locator('.run-phase')).toHaveText(`Stopped on ${participant.executionHost} · provider cancellation unconfirmed`);
    await expect.poll(async () => (await f.inspect()).record.conversationRuns[0].phase).toBe('stopped');
    const stopped = (await f.inspect()).record.conversationRuns[0];
    assert.equal(stopped.runId, prepared.runId);
    assert.deepEqual(stopped.participant, prepared.participant);
    assert.deepEqual(stopped.inputChunks, prepared.inputChunks);
    assert.deepEqual(stopped.outputChunks, []);
    assert.equal(stopped.lastSequence, 1);
    assert.equal(stopped.reason, 'local-stop');
    assert.equal(stopped.closure, undefined);
    assert.equal(operations(await f.inspect(), 'participant.stop').length, 1);
    await expect(f.page.getByRole('button', { name: 'Start prepared message', exact: true })).toHaveCount(0);
    assert.equal((await f.inspect()).starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('old-pin prepared idle recovery keeps the promised Check run status control', async () => {
  const f = await fixture({ oldPin: true, prepared: true });
  try {
    await expect(f.page.locator('.run-phase')).toHaveText('Prepared · not started');
    await expect(f.page.getByRole('alert')).toContainText('different participant version');
    const before = operations(await f.inspect(), 'participant.status').length;
    await f.page.getByRole('button', { name: 'Check run status', exact: true }).click();
    await expect.poll(async () => operations(await f.inspect(), 'participant.status').length).toBeGreaterThan(before);
    assert.equal((await f.inspect()).starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('an older successful Send check superseded by a failed display check keeps the draft unprepared', async () => {
  const input = 'Invented overlapping-check draft stays intact';
  const f = await fixture({ selected: true, input });
  try {
    await expect(send(f.page)).toBeEnabled();
    await f.hold('availability');
    await send(f.page).click();
    await expect.poll(async () => (await f.inspect()).held).toEqual(['availability']);
    await f.page.evaluate(async () => {
      window.__nativeParticipantFixture.failAvailability('refused');
      await window.__nativeParticipantFixture.refresh();
    });
    await expect(f.page.locator('#send-blocked-reason')).toContainText('could not confirm participant availability');
    await f.release('availability');
    await expect(f.page.getByRole('button', { name: 'Check participant availability', exact: true })).toBeEnabled();
    await expect(send(f.page)).toBeDisabled();
    await expect(f.page.getByRole('textbox', { name: 'Your message', exact: true })).toHaveValue(input);
    assert.equal((await f.inspect()).record.conversationRuns, undefined);
    assert.equal((await f.inspect()).calls.filter((request) => request.payload.participantRun).length, 0);
    assert.equal((await f.inspect()).starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});

test('picker retry announces checking and outcomes, hides unverified confirmation, and preserves focus', async () => {
  const f = await fixture({ selected: true });
  try {
    await trigger(f.page).click();
    await expect(picker(f.page)).toContainText('You confirmed paid usage was off at');
    const retry = picker(f.page).getByRole('button', { name: 'Check availability again', exact: true });
    const status = picker(f.page).getByRole('status');
    await f.page.evaluate(() => window.__nativeParticipantFixture.failAvailability('refused'));
    await f.hold('availability');
    await retry.click();
    await expect.poll(async () => (await f.inspect()).held).toEqual(['availability']);
    await expect(retry).toBeFocused();
    await expect(retry).toBeDisabled();
    await expect(status).toContainText('Checking participant availability');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(picker(f.page).locator('.participant-picker-choice .participant-picker-availability')).toHaveText('Checking availability');
    await expect(picker(f.page)).not.toContainText('You confirmed paid usage was off at');
    await f.release('availability');
    await expect(status).toContainText('could not confirm participant availability');
    await expect(picker(f.page)).not.toContainText('You confirmed paid usage was off at');
    await expect(retry).toBeFocused();
    await f.page.evaluate(() => window.__nativeParticipantFixture.failAvailability(null));
    await retry.click();
    await expect(status).toContainText('Claude Code: Available.');
    await expect(picker(f.page)).toContainText('You confirmed paid usage was off at');
    await expect(retry).toBeFocused();
    assert.equal((await f.inspect()).starts.length, 0);
    await f.check();
  } finally { await f.close(); }
});
