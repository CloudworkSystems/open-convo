import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { chromium, expect } from '@playwright/test';

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

function fixture() {
  return {
    run: {
      version: 1, runId: 'invented-run', sessionId: 'invented-session',
      userMessageId: 'invented-user', assistantMessageId: 'invented-assistant',
      participant: { id: 'invented-participant', label: 'Invented participant', model: 'Invented model', executionHost: 'Invented host' },
      inputChunks: ['Invented ', 'request'], outputChunks: ['Saved ', 'prefix', ' and pending tail'],
      lastSequence: 4, phase: 'running', createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:01Z',
    },
    savedSequence: 2, savedOutput: 'Saved prefix', stopState: 'idle', saving: false,
  };
}

async function open(t, props = fixture()) {
  const page = await browser.newPage({ viewport: { width: 420, height: 680 } });
  t.after(() => page.close());
  // The injected entry is only a test harness; no production global discovers a runtime.
  await page.route('**/src/main.tsx', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import '/brand/tokens.css';
    import { RunTranscript } from '/src/features/RunTranscript.tsx';
    const root = ReactDOM.createRoot(document.getElementById('root'));
    let props = ${JSON.stringify(props)};
    window.stopCalls = 0;
    window.renderTranscript = (next = {}) => {
      props = { ...props, ...next };
      root.render(React.createElement(RunTranscript, { ...props, onStop: () => {
        window.stopCalls += 1;
        window.renderTranscript({ stopState: 'requesting' });
      }}));
    };
    window.renderTranscript();
  ` }));
  await page.goto(origin);
  await expect(page.getByRole('region', { name: 'Run transcript' })).toBeVisible();
  return page;
}

test('renders literal chunks and metadata without executing HTML or inserting whitespace', async (t) => {
  const props = fixture();
  props.run.inputChunks = ['  <b>invented</b>\n', '\trequest🙂 '];
  props.run.outputChunks = ['<img src=x onerror="window.literalExecuted=true">\n', '  <script>window.literalExecuted=true</script>'];
  props.savedOutput = props.run.outputChunks[0];
  const page = await open(t, props);
  assert.equal(await page.getByRole('article', { name: 'Your message' }).locator('.run-message-text').textContent(), props.run.inputChunks.join(''));
  assert.equal(await page.locator('.run-output').textContent(), props.run.outputChunks.join(''));
  assert.equal(await page.locator('.run-output img, .run-output script, .run-message-text b').count(), 0);
  assert.equal(await page.evaluate(() => window.literalExecuted), undefined);
  await expect(page.getByRole('heading', { name: 'Invented participant' })).toBeVisible();
  await expect(page.locator('.run-participant')).toContainText('Invented model');
  await expect(page.locator('.run-participant')).toContainText('Invented host');
  assert.equal(await page.locator('.run-output').evaluate((element) => getComputedStyle(element).whiteSpace), 'pre-wrap');
});

test('shows only the exact persisted prefix and pending tail, including a saved initial snapshot', async (t) => {
  const page = await open(t);
  assert.equal(await page.locator('[data-saved-output]').textContent(), 'Saved prefix');
  assert.equal(await page.locator('[data-pending-output]').textContent(), ' and pending tail');
  await expect(page.locator('.run-save-state')).toContainText('Saved through update 2. Newer updates are not yet saved.');
  await page.evaluate(() => window.renderTranscript({ savedSequence: 0, savedOutput: '' }));
  await expect(page.locator('.run-save-state')).toContainText('Saved through update 0.');
  assert.equal(await page.locator('[data-pending-output]').textContent(), 'Saved prefix and pending tail');
  await page.evaluate(() => window.renderTranscript({ savedSequence: 4, savedOutput: 'Saved prefix and pending tail' }));
  await expect(page.locator('.run-save-state')).toHaveAttribute('data-save-state', 'saved');
  await expect(page.locator('.run-save-state')).toHaveText('Saved through update 4.');
});

test('the exact pending tail is visibly marked and described in light and dark themes without changing response text', async (t) => {
  const page = await open(t);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    const prefix = page.locator('[data-saved-output]');
    const tail = page.locator('[data-pending-output]');
    const style = await tail.evaluate((element) => {
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, decoration: css.textDecorationLine, pattern: css.textDecorationStyle };
    });
    assert.notEqual(style.background, await prefix.evaluate((element) => getComputedStyle(element).backgroundColor));
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)');
    assert.equal(style.decoration, 'underline');
    assert.equal(style.pattern, 'dotted');
    await expect(tail).toHaveAccessibleDescription('Highlighted, dotted-underlined text is not yet saved.');
    await expect(page.getByText('Highlighted, dotted-underlined text is not yet saved.', { exact: true })).toBeVisible();
    assert.equal(await prefix.textContent(), 'Saved prefix');
    assert.equal(await tail.textContent(), ' and pending tail');
    assert.equal(await page.locator('.run-output').textContent(), 'Saved prefix and pending tail');
  }
});

test('does not guess a text boundary or display a mismatched saved prefix', async (t) => {
  const props = fixture(); delete props.savedOutput;
  const page = await open(t, props);
  assert.equal(await page.locator('[data-saved-output], [data-pending-output]').count(), 0);
  await expect(page.locator('.run-save-state')).toContainText('Newer updates are not yet saved.');
  await page.evaluate(() => window.renderTranscript({ savedOutput: 'unrelated invented response' }));
  await expect(page.locator('.run-save-state')).toHaveAttribute('data-save-state', 'unknown');
  await expect(page.locator('.run-save-state')).toContainText('could not be verified');
  assert.equal(await page.locator('.run-output').textContent(), props.run.outputChunks.join(''));
  await expect(page.getByRole('region', { name: 'Run transcript' })).not.toContainText('unrelated invented response');
});

test('Stop remains clickable during blocked saving and an unknown result requires an explicit retry', async (t) => {
  const props = fixture(); props.saving = true; props.error = 'Invented storage failure'; props.savedSequence = null;
  const page = await open(t, props);
  await expect(page.locator('.run-save-state')).toContainText('Save not yet confirmed.');
  await expect(page.getByRole('alert')).toHaveText('Invented storage failure');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  assert.equal(await page.evaluate(() => window.stopCalls), 1);
  await expect(page.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).toHaveText('Stop requested · awaiting confirmation');
  await page.evaluate(() => window.renderTranscript({ stopState: 'unknown' }));
  await expect(page.getByRole('button', { name: 'Retry Stop', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveText('Stop outcome unknown');
  assert.equal(await page.evaluate(() => window.stopCalls), 1);
  await page.getByRole('button', { name: 'Retry Stop', exact: true }).click();
  assert.equal(await page.evaluate(() => window.stopCalls), 2);
  await expect(page.getByRole('button', { name: 'Stopping…', exact: true })).toBeDisabled();
});

test('keyboard Stop moves focus to its stable status through pending and confirmed local stopping', async (t) => {
  const page = await open(t);
  const stop = page.getByRole('button', { name: 'Stop', exact: true });
  await stop.focus();
  await stop.press('Enter');
  const status = page.getByRole('status');
  await expect(status).toHaveAttribute('data-run-status', 'true');
  await expect(status).toBeFocused();
  await expect(status).toHaveText('Stop requested · awaiting confirmation');
  await page.evaluate(() => window.renderTranscript({ stopState: 'confirmed' }));
  await expect(status).toHaveText('Response stopped · provider cancellation unconfirmed');
  await expect(status).toBeFocused();
  await expect(page.getByRole('button', { name: 'Stopped', exact: true })).toBeDisabled();
  assert.equal(await page.evaluate(() => window.stopCalls), 1);
});

test('live unknown and unavailable states never present a saved running phase as current progress', async (t) => {
  const page = await open(t, { ...fixture(), runtimeStatus: 'unknown' });
  await expect(page.getByRole('status')).toHaveText('Run status unknown');
  await expect(page.getByRole('status')).not.toContainText('in progress');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await page.evaluate(() => window.renderTranscript({ runtimeStatus: 'unavailable', canStop: false }));
  await expect(page.getByRole('status')).toHaveText('Participant connection unavailable');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await expect(page.getByRole('status')).not.toContainText('Stop');
  await page.evaluate(() => window.renderTranscript({ runtimeStatus: 'starting' }));
  await expect(page.getByRole('status')).toHaveText('Starting response');
  await page.evaluate(() => window.renderTranscript({ runtimeStatus: 'running' }));
  await expect(page.getByRole('status')).toHaveText('Response in progress');
});

test('closed or interrupted runs keep their literal prefix and never claim a complete response', async (t) => {
  const props = fixture();
  props.run.closure = { kind: 'unknown', reason: 'user-closed', at: '2026-10-09T00:00:03Z' };
  props.savedSequence = props.run.lastSequence;
  props.savedOutput = props.run.outputChunks.join('');
  props.checkpointPending = true;
  const page = await open(t, props);
  await expect(page.getByRole('status')).toHaveText('Closed with outcome unknown');
  await expect(page.locator('.run-save-state')).toHaveAttribute('data-save-state', 'pending');
  await expect(page.locator('.run-save-state')).toContainText('Run status changes are not yet saved.');
  await page.evaluate(() => window.renderTranscript({ checkpointPending: false }));
  await expect(page.locator('.run-save-state')).toHaveAttribute('data-save-state', 'saved');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  const terminalEvent = { runId: props.run.runId, sessionId: props.run.sessionId, sequence: 6, at: '2026-10-09T00:00:03Z', type: 'stopped' };
  await page.evaluate((run) => window.renderTranscript({ run }), {
    ...props.run, closure: { kind: 'interrupted', reason: 'event-refused', at: terminalEvent.at, terminalEvent },
  });
  await expect(page.getByRole('status')).toHaveText('Run ended with incomplete response');
  await expect(page.getByText('Response stopped · provider cancellation unconfirmed', { exact: true })).toBeVisible();
  assert.equal(await page.locator('.run-output').textContent(), props.run.outputChunks.join(''));
  await page.evaluate((run) => window.renderTranscript({ run }), {
    ...props.run, closure: { kind: 'interrupted', reason: 'workspace-limit', at: terminalEvent.at,
      terminalEvent: { ...terminalEvent, type: 'completed' } },
  });
  await expect(page.getByRole('status')).toHaveText('Run ended with incomplete response');
  await expect(page.getByRole('status')).not.toContainText('Response complete');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
});

test('terminal phases disable Stop while unknown run state stays actionable', async (t) => {
  const page = await open(t);
  for (const phase of ['completed', 'stopped', 'failed']) {
    const run = { ...fixture().run, phase };
    await page.evaluate((run) => window.renderTranscript({ run }), run);
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  }
  await page.evaluate((run) => window.renderTranscript({ run }), { ...fixture().run, phase: 'unknown' });
  await expect(page.getByRole('status')).toHaveText('Run status unknown');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled();
  await page.evaluate(() => window.renderTranscript({ stopState: 'confirmed' }));
  await expect(page.getByRole('button', { name: 'Stopped', exact: true })).toBeDisabled();
});

test('long streaming text remains complete and does not enter the phase live region', async (t) => {
  const props = fixture();
  props.run.outputChunks = ['invented-long-token'.repeat(1500), '\n  final🙂\t'];
  delete props.savedOutput;
  const page = await open(t, props);
  assert.equal(await page.locator('.run-output').textContent(), props.run.outputChunks.join(''));
  await expect(page.getByRole('status')).toHaveText('Response in progress');
  assert.equal(await page.getByRole('status').locator('.run-output, .run-save-state').count(), 0);
  await expect(page.locator('.run-output')).toHaveAttribute('aria-live', 'off');
  await expect(page.locator('.run-save-state')).toHaveAttribute('aria-live', 'off');
  assert.ok(await page.locator('.run-output').evaluate((element) => element.scrollWidth <= element.clientWidth + 1));
  await page.evaluate((run) => window.renderTranscript({ run, savedSequence: 5 }), {
    ...props.run, outputChunks: [...props.run.outputChunks, ' later text'], lastSequence: 5,
  });
  await expect(page.getByRole('status')).toHaveText('Response in progress');
  assert.equal(await page.locator('.run-output').textContent(), props.run.outputChunks.join('') + ' later text');
});

async function openFoundation(t, config = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  t.after(() => page.close());
  await page.route('**/src/main.tsx', (route) => route.fulfill({ contentType: 'application/javascript', body: `
    import React from '/node_modules/.vite/deps/react.js';
    import ReactDOM from '/node_modules/.vite/deps/react-dom_client.js';
    import '/brand/tokens.css';
    import '/src/shell/foundation.css';
    import '/src/shell/nexus.css';
    import '/src/app/recovery.css';
    import { DeskFoundation } from '/src/features/DeskFoundation.tsx';
    import { RunTranscript } from '/src/features/RunTranscript.tsx';
    import { DeskRuntimeContext, createBrowserRuntime } from '/src/app/runtime.tsx';
    import { createDemoState } from '/src/domain/demo.ts';
    const config = ${JSON.stringify(config)};
    const runProps = ${JSON.stringify(fixture())};
    if (config.outputText) {
      runProps.run.outputChunks = [config.outputText]; runProps.savedOutput = ''; runProps.savedSequence = 0;
    }
    const root = ReactDOM.createRoot(document.getElementById('root'));
    const runtime = createBrowserRuntime();
    let state = createDemoState();
    state.selection.route = 'sessions';
    state.messages = config.history ? [{ ...state.messages[0], body: 'Previously saved invented demo' }] : [];
    state.drafts[state.selection.sessionId] = 'Invented next message';
    const noop = () => {};
    const callbacks = Object.fromEntries([
      'onRouteChange', 'onGoalSelect', 'onUngroupedSelect', 'onSessionSelect', 'onSessionCreate',
      'onGoalCreate', 'onDomainRename', 'onSessionRename', 'onDomainPin', 'onFolderIconChange',
      'onSessionPin', 'onSessionIntentDraftChange', 'onSessionIntentChange', 'onSessionMove',
      'onDomainPurposeChange', 'onGoalDraftChange', 'onWorkCreate', 'onMemoryCommand',
      'onThemeChange', 'onNexusViewChange',
    ].map((name) => [name, noop]));
    let props = {
      ...callbacks, saveStatus: { kind: 'saved', message: 'Invented fixture saved' }, theme: 'light',
      participantLabel: config.demo ? undefined : 'Observed invented participant',
      participantBusy: false, participantSendUnavailable: false,
      runContent: config.hasRun ? React.createElement(RunTranscript, { ...runProps, onStop: noop }) : undefined,
      onDraftChange: (id, text) => {
        state = { ...state, drafts: { ...state.drafts, [id]: text } };
        window.renderConversation();
      },
      onSend: (id) => { window.sendCalls.push({ id, text: state.drafts[id] }); },
    };
    window.sendCalls = [];
    window.renderConversation = (next = {}) => {
      props = { ...props, ...next };
      root.render(React.createElement(DeskRuntimeContext.Provider, { value: runtime },
        React.createElement('div', { className: 'application-shell' },
          React.createElement('div', { className: 'workspace-wrap' },
            React.createElement(DeskFoundation, { ...props, state })))));
    };
    window.renderRunOutputs = (texts) => window.renderConversation({ runContent: texts.map((text, index) =>
      React.createElement(RunTranscript, { ...runProps, key: index, onStop: noop, savedOutput: '', savedSequence: 0,
        run: { ...runProps.run, runId: 'invented-run-' + index, outputChunks: [text] } })) });
    window.renderConversation();
  ` }));
  await page.goto(origin);
  await expect(page.getByRole('region', { name: 'Conversation', exact: true })).toBeVisible();
  return page;
}

test('Foundation supplies participant labels and appends the run after earlier messages without streaming log announcements', async (t) => {
  const page = await openFoundation(t, { history: true, hasRun: true });
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  await expect(conversation.locator('.provider-label')).toHaveText('Observed invented participant');
  await expect(conversation.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(conversation.getByRole('button', { name: 'Participant connection: invented-data proof', exact: true })).toBeDisabled();
  await expect(conversation.locator('.conversation-footnote')).toHaveText('Participant proof · invented messages only. Do not enter private data.');
  await expect(conversation.getByRole('log')).toHaveAttribute('aria-live', 'off');
  await expect(conversation.locator('.run-phase')).toHaveAttribute('aria-live', 'polite');
  const ordering = await conversation.getByRole('log').evaluate((element) => Array.from(element.children).map((child) => child.className));
  assert.deepEqual(ordering, ['message message-assistant', 'run-transcript']);
  assert.equal(await conversation.locator('.conversation-welcome').count(), 0);
});

test('busy or unavailable participants prevent sends while the draft remains editable', async (t) => {
  const page = await openFoundation(t, { hasRun: true });
  const field = page.getByRole('textbox', { name: 'Your message', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await page.evaluate(() => window.renderConversation({ participantBusy: true }));
  await expect(send).toBeDisabled();
  await field.fill('Editable while the participant is busy');
  await field.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sendCalls), []);
  await expect(field).toHaveValue('Editable while the participant is busy');
  await page.evaluate(() => window.renderConversation({ participantBusy: false, participantSendUnavailable: true }));
  await expect(send).toBeDisabled();
  await field.fill('Editable while sending is unavailable');
  await field.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.sendCalls), []);
  await page.evaluate(() => window.renderConversation({ participantSendUnavailable: false }));
  await expect(send).toBeEnabled();
  await send.click();
  assert.equal((await page.evaluate(() => window.sendCalls)).length, 1);
  await page.evaluate(() => window.renderConversation({ readOnly: true }));
  await expect(field).toBeDisabled();
  await expect(send).toBeDisabled();
});

test('an existing run suppresses the empty state and omitted participant props preserve demo labels', async (t) => {
  const page = await openFoundation(t, { hasRun: true });
  const conversation = page.getByRole('region', { name: 'Conversation', exact: true });
  assert.equal(await conversation.locator('.conversation-welcome').count(), 0);
  await page.evaluate(() => window.renderConversation({ runContent: [], participantLabel: undefined }));
  await expect(conversation.locator('.conversation-welcome')).toBeVisible();
  await expect(conversation.locator('.provider-label')).toHaveText('Demo replies · no model connected');
  await expect(conversation.getByRole('log')).toHaveAttribute('aria-live', 'polite');
  await expect(conversation.getByRole('button', { name: 'Send demo message', exact: true })).toBeEnabled();
  await expect(conversation.getByRole('button', { name: 'Model and harness picker: demo only', exact: true })).toBeDisabled();
  await expect(conversation.locator('.conversation-footnote')).toHaveText("A demo reply tests the flow. It doesn't call an AI model.");
});

test('new runs and streaming follow the bottom, preserve older reading position, and resume when the reader returns', async (t) => {
  const first = 'Invented response line.\n'.repeat(90);
  const page = await openFoundation(t, { hasRun: true, outputText: first });
  const log = page.getByRole('log', { name: 'Messages', exact: true });
  const gap = () => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
  assert.ok(await log.evaluate((element) => element.scrollHeight - element.clientHeight > 1000), 'Fixture must overflow the actual app scroll viewport.');
  await expect.poll(gap).toBeLessThanOrEqual(2);
  const streamed = first + 'More streaming text.\n'.repeat(30);
  await page.evaluate((text) => window.renderRunOutputs([text]), streamed);
  await expect.poll(() => page.locator('.run-output').textContent()).toBe(streamed);
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await page.evaluate((text) => window.renderRunOutputs([text, 'A second invented run.\n'.repeat(25)]), streamed);
  await expect(page.locator('.run-output')).toHaveCount(2);
  await expect.poll(gap).toBeLessThanOrEqual(2);

  // Real wheel input marks the reader as inspecting older content.
  await log.hover();
  assert.ok(await log.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
  }), 'The wheel point must be inside the message log.');
  await page.mouse.wheel(0, -700);
  await expect.poll(gap).toBeGreaterThan(100);
  const position = await log.evaluate((element) => element.scrollTop);
  await page.evaluate((text) => window.renderRunOutputs([text, 'A second invented run.\n'.repeat(70)]), streamed);
  await expect.poll(() => page.locator('.run-output').last().textContent()).toBe('A second invented run.\n'.repeat(70));
  assert.ok(Math.abs(await log.evaluate((element) => element.scrollTop) - position) <= 2, 'Streaming moved the reader away from older content.');
  await page.evaluate((text) => window.renderRunOutputs([text, 'A second invented run.\n'.repeat(70), 'A third invented run.']), streamed);
  await expect(page.locator('.run-output')).toHaveCount(3);
  assert.ok(Math.abs(await log.evaluate((element) => element.scrollTop) - position) <= 2, 'A new run moved the reader away from older content.');

  await log.evaluate((element) => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(gap).toBeLessThanOrEqual(2);
  await page.evaluate((text) => window.renderRunOutputs([text, 'A second invented run.\n'.repeat(70), 'Third run streaming.\n'.repeat(40)]), streamed);
  await expect.poll(() => page.locator('.run-output').last().textContent()).toBe('Third run streaming.\n'.repeat(40));
  await expect.poll(gap).toBeLessThanOrEqual(2);
});

test('stopped and failed reasons report the recorded cause and actual host without inventing a Mac or confirmed termination', async (t) => {
  const page = await open(t);
  for (const phase of ['stopped', 'failed']) {
    for (const [reason, detail] of [
      [undefined, phase === 'stopped' ? 'Response stopped · provider cancellation unconfirmed' : 'Response failed'],
      ['local-stop', `${phase === 'stopped' ? 'Stopped' : 'Local stop reported'} on Invented host · provider cancellation unconfirmed`],
      ['stop-incomplete', 'Stop incomplete · participant termination unconfirmed'],
      ['reply-too-long', `${phase === 'stopped' ? 'Response stopped' : 'Response failed'} · reply length limit reached`],
      ['paid-overflow', `${phase === 'stopped' ? 'Response stopped' : 'Response failed'} · paid usage could not be ruled out; check your provider usage`],
      ['timeout', `${phase === 'stopped' ? 'Response stopped' : 'Response failed'} · time limit reached`],
      ['process-error', `${phase === 'stopped' ? 'Response stopped' : 'Response failed'} · participant process error`],
    ]) {
      await page.evaluate((run) => window.renderTranscript({ run }), { ...fixture().run, phase, ...(reason ? { reason } : {}) });
      await expect(page.getByRole('status')).toHaveText(detail);
      await expect(page.getByRole('status')).not.toContainText('Mac');
      if (reason === 'stop-incomplete') await expect(page.getByRole('button', { name: 'Stop unconfirmed', exact: true })).toBeDisabled();
    }
  }
  const run = fixture().run;
  run.closure = { kind: 'interrupted', reason: 'event-refused', at: '2026-10-09T00:00:03Z',
    terminalEvent: { type: 'failed', reason: 'process-error', sequence: 8, at: '2026-10-09T00:00:03Z', runId: run.runId, sessionId: run.sessionId } };
  await page.evaluate((run) => window.renderTranscript({ run }), run);
  await expect(page.getByRole('status')).toHaveText('Run ended with incomplete response');
  await expect(page.getByText('Response failed · participant process error', { exact: true })).toBeVisible();
  await expect(page.locator('[data-interruption-reason]')).toHaveText('Some response updates could not be verified. The retained response is incomplete.');
});


test('completed cleanup never claims provider cancellation and acknowledged uncertainty stays visible', async (t) => {
  const props = fixture();
  props.run.phase = 'completed';
  props.cleanupState = 'cleared';
  props.canStop = false;
  const page = await open(t, props);
  await expect(page.getByRole('status')).toHaveText('Response complete');
  await expect(page.locator('[data-cleanup-state]')).not.toContainText('cancellation');
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeDisabled();
  await page.evaluate((run) => window.renderTranscript({ run, cleanupState: 'unknown' }), {
    ...props.run, cleanupAcknowledgment: { kind: 'unreachable', at: '2026-10-10T00:00:00.000Z' },
  });
  await expect(page.locator('[data-cleanup-acknowledgment]')).toContainText('does not confirm');
  await expect(page.getByRole('status')).toHaveText('Response complete');
  await page.evaluate((run) => window.renderTranscript({ run, cleanupState: 'unowned', stopState: 'unknown', canStop: false }), props.run);
  await expect(page.getByRole('button', { name: 'Cleanup unconfirmed', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Retry Stop', exact: true })).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('Response complete');
});
