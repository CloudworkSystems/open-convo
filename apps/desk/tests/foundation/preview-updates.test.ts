import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchPreviewBuild, parsePreviewBuild, PREVIEW_RELOAD_KEY, retireAnnotationDiagnostics, watchPreviewUpdates,
} from '../../src/app/preview-updates';
import type { DeskPreviewBuild, PreviewRefreshSafety, PreviewUpdateNotice } from '../../src/app/preview-updates';

const build = (letter = 'b'): DeskPreviewBuild => ({
  application: 'true-convo-desk-preview', protocol: 1, source_commit: letter.repeat(40),
  version: '0.31.0', working_copy: false,
});
const flush = async () => { for (let step = 0; step < 6; step += 1) await Promise.resolve(); };

test('retiring the legacy annotation flag preserves other query values, the fragment and the exact history state', () => {
  const location = { href: 'https://preview.invalid/?annotation-diagnostics=1&keep=sample&annotation-diagnostics=0#anchor' };
  const state = { tab: 'desk', selection: { session: 'invented-session' } };
  const calls: Array<{ state: unknown; title: string; url?: string | URL | null }> = [];
  const history = {
    state,
    replaceState: (state: unknown, title: string, url?: string | URL | null) => { calls.push({ state, title, url }); },
  };
  retireAnnotationDiagnostics(location, history);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state, state, 'The existing history state must be passed through without replacement or mutation.');
  assert.equal(calls[0].title, '');
  assert.equal(String(calls[0].url), 'https://preview.invalid/?keep=sample#anchor');
  assert.deepEqual(state, { tab: 'desk', selection: { session: 'invented-session' } });
  assert.equal(location.href, 'https://preview.invalid/?annotation-diagnostics=1&keep=sample&annotation-diagnostics=0#anchor', 'Cleanup must use history replacement rather than location navigation.');
});

test('ordinary preview URLs leave history untouched', () => {
  let replacements = 0;
  retireAnnotationDiagnostics({ href: 'https://preview.invalid/?keep=sample#anchor' }, {
    get state() { throw new Error('An unchanged URL must not need history state.'); },
    replaceState: () => { replacements += 1; },
  });
  assert.equal(replacements, 0);
});

test('malformed preview URLs leave history untouched without preventing the app from opening', () => {
  let replacements = 0;
  assert.doesNotThrow(() => retireAnnotationDiagnostics({ href: 'not a valid URL' }, {
    state: { fixture: 'invented tab state' },
    replaceState: () => { replacements += 1; },
  }));
  assert.equal(replacements, 0);
});

test('failed history replacement keeps the current URL and tab state intact without throwing', () => {
  const location = { href: 'https://preview.invalid/?annotation-diagnostics=1&keep=sample#anchor' };
  const state = { fixture: 'invented tab state' };
  let replacements = 0;
  assert.doesNotThrow(() => retireAnnotationDiagnostics(location, {
    state,
    replaceState: () => { replacements += 1; throw new Error('History unavailable'); },
  }));
  assert.equal(replacements, 1);
  assert.equal(location.href, 'https://preview.invalid/?annotation-diagnostics=1&keep=sample#anchor');
  assert.deepEqual(state, { fixture: 'invented tab state' });
});

function harness(options: { marker?: string; failRead?: boolean; failWrite?: boolean; time?: number } = {}) {
  let time = options.time ?? 20_000;
  let serial = 0;
  let reloads = 0;
  const scheduled = new Map<number, { callback: () => void; at: number }>();
  const storage = new Map<string, string>();
  if (options.marker) storage.set(PREVIEW_RELOAD_KEY, options.marker);
  const safety: PreviewRefreshSafety = {
    workspaceReady: true, pendingSaves: 0, saveProblem: false, retrying: false,
    visible: true, online: true, modalOpen: false, composing: false, interacting: false,
    inputActive: false, lastInteractionAt: 0,
  };
  const notices: Array<PreviewUpdateNotice | null> = [];
  const requests: AbortSignal[] = [];
  let fetcher: (signal: AbortSignal) => Promise<unknown> = async () => build();
  const watcher = watchPreviewUpdates({
    loadedBuild: build('a'), safety: () => safety, onNotice: (notice) => notices.push(notice),
    reload: () => { reloads += 1; }, now: () => time,
    fetchBuild: (signal) => { requests.push(signal); return fetcher(signal); },
    marker: {
      getItem: (key) => { if (options.failRead) throw new Error('Storage unavailable'); return storage.get(key) ?? null; },
      setItem: (key, value) => { if (options.failWrite) throw new Error('Storage full'); storage.set(key, value); },
    },
    schedule: (callback, delay) => {
      const id = ++serial;
      scheduled.set(id, { callback, at: time + delay });
      return () => { scheduled.delete(id); };
    },
  });
  return {
    watcher, safety, notices, requests, storage,
    get reloads() { return reloads; },
    setFetch(next: typeof fetcher) { fetcher = next; },
    async advance(milliseconds: number) {
      const target = time + milliseconds;
      await flush();
      for (let step = 0; step < 1_000; step += 1) {
        const next = [...scheduled.entries()].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; scheduled.delete(next[0]); next[1].callback(); await flush();
      }
      time = target;
      await flush();
    },
  };
}

test('a published build refreshes the current tab once, after a ten-second idle pause', async () => {
  const current = harness({ time: 0 });
  await current.advance(9_999);
  assert.equal(current.reloads, 0);
  assert.equal(current.notices.at(-1)?.canRefresh, false);
  await current.advance(1);
  assert.equal(current.reloads, 1);
  assert.equal(current.storage.get(PREVIEW_RELOAD_KEY), build().source_commit);
  await current.advance(90_000);
  assert.equal(current.reloads, 1, 'cancelled reloads and stale HTML must not cause an automatic loop');
  current.watcher.stop();
});

test('automatic and manual refresh both wait for every work and interaction safety condition', async () => {
  const unsafe: Array<Partial<PreviewRefreshSafety>> = [
    { workspaceReady: false }, { pendingSaves: 1 }, { saveProblem: true }, { retrying: true },
    { visible: false }, { online: false }, { modalOpen: true }, { composing: true },
    { interacting: true }, { inputActive: true }, { lastInteractionAt: 19_999 },
  ];
  for (const condition of unsafe) {
    const current = harness();
    Object.assign(current.safety, condition);
    await flush();
    assert.equal(current.reloads, 0, JSON.stringify(condition));
    assert.equal(current.notices.at(-1)?.canRefresh, false, JSON.stringify(condition));
    assert.equal(current.watcher.refresh(), false, 'manual refresh must recheck the same current safety snapshot');
    assert.equal(current.storage.size, 0);
    current.watcher.stop();
  }
});

test('held updates recheck save state at the moment of refresh rather than trusting an old button state', async () => {
  const current = harness({ marker: build().source_commit });
  await flush();
  assert.equal(current.notices.at(-1)?.canRefresh, true);
  current.safety.pendingSaves = 1;
  assert.equal(current.watcher.refresh(), false);
  current.safety.pendingSaves = 0;
  current.safety.saveProblem = true;
  assert.equal(current.watcher.refresh(), false);
  current.safety.saveProblem = false;
  assert.equal(current.watcher.refresh(), true);
  assert.equal(current.reloads, 1);
  current.watcher.stop();
});

test('a save problem republishes an already disabled update notice without changing its refresh eligibility', async () => {
  const current = harness();
  current.safety.inputActive = true;
  await flush();
  assert.deepEqual(current.notices.at(-1), { build: build(), canRefresh: false, saveProblem: false, automaticBlocked: false });
  const before = current.notices.length;
  current.safety.saveProblem = true;
  current.watcher.check();
  assert.equal(current.notices.length, before + 1);
  assert.deepEqual(current.notices.at(-1), { build: build(), canRefresh: false, saveProblem: true, automaticBlocked: false });
  assert.equal(current.watcher.refresh(), false);
  assert.equal(current.reloads, 0);
  current.safety.saveProblem = false;
  current.watcher.check();
  assert.equal(current.notices.length, before + 2);
  assert.equal(current.notices.at(-1)?.saveProblem, false);
  assert.equal(current.notices.at(-1)?.canRefresh, false);
  current.watcher.stop();
});

test('an existing tab marker holds a stale-HTML update for an explicit safe refresh', async () => {
  const current = harness({ marker: build().source_commit });
  await current.advance(60_000);
  assert.equal(current.reloads, 0);
  assert.equal(current.notices.at(-1)?.automaticBlocked, true);
  assert.equal(current.watcher.refresh(), true);
  assert.equal(current.reloads, 1);
  current.watcher.stop();
});

test('unavailable or full tab storage disables automatic reload without erasing any browser work', async () => {
  for (const failure of [{ failRead: true }, { failWrite: true }]) {
    const current = harness(failure);
    await current.advance(60_000);
    assert.equal(current.reloads, 0);
    assert.equal(current.notices.at(-1)?.automaticBlocked, true);
    assert.equal(current.watcher.refresh(), true, 'explicit safe refresh remains available');
    assert.equal(current.reloads, 1);
    current.watcher.stop();
  }
});

test('an unchanged build does not reload or change the tab marker', async () => {
  const current = harness({ marker: build('c').source_commit });
  current.safety.modalOpen = true;
  await flush();
  current.setFetch(async () => build('a'));
  await current.advance(30_000);
  current.safety.modalOpen = false;
  current.watcher.check();
  assert.equal(current.notices.at(-1), null);
  assert.equal(current.reloads, 0);
  assert.equal(current.storage.get(PREVIEW_RELOAD_KEY), build('c').source_commit);
  current.watcher.stop();
});

test('wrong applications, missing fields, non-JSON data and malformed commits are not update announcements', async () => {
  const invalid = [null, [], '<html>Sign in</html>', {}, { ...build(), application: 'other' },
    { ...build(), protocol: 2 }, { ...build(), source_commit: null },
    { ...build(), source_commit: 'a'.repeat(39) }, { ...build(), source_commit: 'g'.repeat(40) },
    { ...build(), source_commit: 'A'.repeat(40) }, { ...build(), working_copy: 'false' },
    { ...build(), version: '' }, { ...build(), version: 'a'.repeat(129) }, { ...build(), version: 'x\ny' }];
  for (const value of invalid) assert.equal(parsePreviewBuild(value), null);
  assert.deepEqual(parsePreviewBuild(build()), build());
  const current = harness();
  current.safety.inputActive = true;
  await flush();
  current.setFetch(async () => '<html>Sign in</html>');
  await current.advance(30_000);
  current.safety.inputActive = false;
  assert.equal(current.watcher.refresh(), false, 'an invalid later manifest cannot authorize a held refresh');
  assert.equal(current.reloads, 0);
  current.watcher.stop();
});

test('offline requests keep the preview usable and resume only after a fresh valid manifest', async () => {
  const current = harness();
  current.safety.inputActive = true;
  await flush();
  current.setFetch(async () => { throw new Error('Offline'); });
  await current.advance(30_000);
  current.safety.inputActive = false;
  current.watcher.check();
  assert.equal(current.reloads, 0);
  assert.equal(current.watcher.refresh(), false);
  current.setFetch(async () => build());
  await current.advance(30_000);
  assert.equal(current.reloads, 1);
  current.watcher.stop();
});

test('a stalled request times out and its late reply cannot refresh the tab', async () => {
  const current = harness();
  current.safety.inputActive = true;
  await flush();
  let resolve!: (value: unknown) => void;
  current.setFetch(() => new Promise((reply) => { resolve = reply; }));
  await current.advance(30_000);
  const stalledSignal = current.requests.at(-1)!;
  await current.advance(5_000);
  assert.equal(stalledSignal.aborted, true);
  current.safety.inputActive = false;
  resolve(build('c'));
  await flush();
  assert.equal(current.reloads, 0);
  assert.equal(current.watcher.refresh(), false);
  current.watcher.stop();
});

test('stopping cancels timers, aborts a request and ignores replies after unmount', async () => {
  const current = harness();
  current.safety.inputActive = true;
  await flush();
  let resolve!: (value: unknown) => void;
  current.setFetch(() => new Promise((reply) => { resolve = reply; }));
  await current.advance(30_000);
  const notices = current.notices.length;
  current.watcher.stop();
  assert.equal(current.requests.at(-1)?.aborted, true);
  current.safety.inputActive = false;
  resolve(build('c'));
  await current.advance(90_000);
  assert.equal(current.notices.length, notices);
  assert.equal(current.requests.length, 2);
  assert.equal(current.reloads, 0);
  assert.equal(current.watcher.refresh(), false);
});

test('manifest fetch uses only the fixed same-origin endpoint and refuses authentication HTML or oversized bodies', async () => {
  const original = globalThis.fetch;
  const responses = [
    new Response(JSON.stringify(build()), { headers: { 'content-type': 'application/json' } }),
    new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }),
    new Response(JSON.stringify(build()), { status: 401, headers: { 'content-type': 'application/json' } }),
    new Response(' '.repeat(16_385), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '99999' } }),
  ];
  const calls: Array<{ input: RequestInfo | URL; options?: RequestInit }> = [];
  globalThis.fetch = async (input, options) => { calls.push({ input, options }); return responses.shift()!; };
  try {
    const signal = new AbortController().signal;
    assert.deepEqual(await fetchPreviewBuild(signal), build());
    for (let index = 0; index < 4; index += 1) assert.equal(await fetchPreviewBuild(signal), null);
    for (const call of calls) {
      assert.equal(call.input, '/desk-build.json');
      assert.equal(call.options?.cache, 'no-store');
      assert.equal(call.options?.credentials, 'same-origin');
      assert.equal(call.options?.redirect, 'error');
      assert.equal(call.options?.signal, signal);
    }
  } finally { globalThis.fetch = original; }
});
