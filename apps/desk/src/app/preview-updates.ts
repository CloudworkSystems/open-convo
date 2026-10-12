export interface DeskPreviewBuild {
  application: 'true-convo-desk-preview';
  protocol: 1;
  source_commit: string;
  version: string;
  working_copy: boolean;
}

declare global {
  const __DESK_PREVIEW_BUILD__: DeskPreviewBuild | null;
}

export interface PreviewRefreshSafety {
  workspaceReady: boolean;
  pendingSaves: number;
  saveProblem: boolean;
  retrying: boolean;
  visible: boolean;
  online: boolean;
  modalOpen: boolean;
  composing: boolean;
  interacting: boolean;
  inputActive: boolean;
  lastInteractionAt: number;
}

export interface PreviewUpdateNotice {
  build: DeskPreviewBuild;
  canRefresh: boolean;
  saveProblem: boolean;
  automaticBlocked: boolean;
}

export const PREVIEW_RELOAD_KEY = 'true-convo:desk:preview-reload:v1';
export const PREVIEW_IDLE_MS = 10_000;
const POLL_MS = 30_000;
const CHECK_MS = 2_000;
const FETCH_TIMEOUT_MS = 5_000;
const MANIFEST_LIMIT = 16_384;

// Retire the temporary diagnostic link in place. This preserves the current
// tab, history entry, saved workspace and any other URL parameters.
export function retireAnnotationDiagnostics(
  location: Pick<Location, 'href'>,
  history: Pick<History, 'state' | 'replaceState'>,
): void {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('annotation-diagnostics')) return;
    url.searchParams.delete('annotation-diagnostics');
    history.replaceState(history.state, '', url.href);
  } catch {
    // An unavailable history API must not stop the app or replace user work.
    // The diagnostic UI and update pause have been removed regardless.
  }
}

export function parsePreviewBuild(value: unknown): DeskPreviewBuild | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const build = value as Record<string, unknown>;
  if (build.application !== 'true-convo-desk-preview' || build.protocol !== 1
    || typeof build.source_commit !== 'string' || !/^[a-f0-9]{40}$/.test(build.source_commit)
    || typeof build.version !== 'string' || !build.version.trim() || build.version.length > 128
    || /[\u0000-\u001f]/.test(build.version) || typeof build.working_copy !== 'boolean') return null;
  return {
    application: 'true-convo-desk-preview', protocol: 1, source_commit: build.source_commit,
    version: build.version, working_copy: build.working_copy,
  };
}

export function canRefreshPreview(safety: PreviewRefreshSafety, now: number): boolean {
  return safety.workspaceReady && safety.pendingSaves === 0 && !safety.saveProblem && !safety.retrying
    && safety.visible && safety.online && !safety.modalOpen && !safety.composing
    && !safety.interacting && !safety.inputActive && now - safety.lastInteractionAt >= PREVIEW_IDLE_MS;
}

// Authentication redirects and HTML login pages are not build announcements.
// Only this origin's small JSON manifest is ever requested.
export async function fetchPreviewBuild(signal: AbortSignal): Promise<unknown> {
  const response = await fetch('/desk-build.json', {
    cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    await response.body?.cancel();
    return null;
  }
  const announcedLength = response.headers.get('content-length');
  if (announcedLength && Number(announcedLength) > MANIFEST_LIMIT) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MANIFEST_LIMIT) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

interface PreviewUpdateOptions {
  loadedBuild: DeskPreviewBuild;
  safety: () => PreviewRefreshSafety;
  onNotice: (notice: PreviewUpdateNotice | null) => void;
  reload: () => void;
  marker: Pick<Storage, 'getItem' | 'setItem'>;
  fetchBuild?: (signal: AbortSignal) => Promise<unknown>;
  now?: () => number;
  schedule?: (callback: () => void, delay: number) => () => void;
}

export function watchPreviewUpdates(options: PreviewUpdateOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((callback, delay) => {
    const timer = window.setTimeout(callback, delay);
    return () => window.clearTimeout(timer);
  });
  const fetchBuild = options.fetchBuild ?? fetchPreviewBuild;
  let stopped = false;
  let pending: DeskPreviewBuild | null = null;
  let manifestFresh = false;
  let verifiedAt = 0;
  let lastNotice = '';
  let attempted = '';
  let markerAvailable = true;
  let request: AbortController | null = null;
  let cancelTimeout = () => {};
  let cancelPoll = () => {};
  let cancelCheck = () => {};
  try { attempted = options.marker.getItem(PREVIEW_RELOAD_KEY) ?? ''; }
  catch { markerAvailable = false; }

  function ready(safety = options.safety()) {
    return manifestFresh && now() - verifiedAt < POLL_MS * 2 && canRefreshPreview(safety, now());
  }

  function publish() {
    if (stopped) return;
    const safety = options.safety();
    const notice = pending ? {
      build: pending,
      canRefresh: ready(safety),
      saveProblem: safety.saveProblem,
      automaticBlocked: !markerAvailable || attempted === pending.source_commit,
    } : null;
    const signature = notice ? `${notice.build.source_commit}:${notice.canRefresh}:${notice.saveProblem}:${notice.automaticBlocked}` : 'none';
    if (signature !== lastNotice) { lastNotice = signature; options.onNotice(notice); }
  }

  function refresh(manual = false): boolean {
    if (stopped || !pending || !ready()) return false;
    if (!manual && (!markerAvailable || attempted === pending.source_commit)) return false;
    // Record before reloading. If authentication/CDN returns the old HTML, or
    // the browser's existing unload prompt is cancelled, do not reload again.
    try { options.marker.setItem(PREVIEW_RELOAD_KEY, pending.source_commit); }
    catch {
      markerAvailable = false;
      if (!manual) { publish(); return false; }
    }
    attempted = pending.source_commit;
    publish();
    try { options.reload(); return true; }
    catch { return false; }
  }

  function check() {
    if (stopped) return;
    publish();
    refresh();
  }

  async function poll() {
    if (stopped || request) return;
    const controller = new AbortController();
    request = controller;
    cancelTimeout = schedule(() => {
      manifestFresh = false;
      controller.abort();
      publish();
    }, FETCH_TIMEOUT_MS);
    try {
      const build = parsePreviewBuild(await fetchBuild(controller.signal));
      if (stopped || controller.signal.aborted) return;
      manifestFresh = build !== null;
      if (build) {
        verifiedAt = now();
        pending = build.source_commit === options.loadedBuild.source_commit ? null : build;
      }
    } catch {
      // Offline, timeout and a sign-in page leave the working app untouched.
      if (!stopped) manifestFresh = false;
    } finally {
      cancelTimeout();
      request = null;
      if (!stopped) { check(); cancelPoll = schedule(() => void poll(), POLL_MS); }
    }
  }

  function scheduledCheck() {
    check();
    if (!stopped) cancelCheck = schedule(scheduledCheck, CHECK_MS);
  }
  cancelCheck = schedule(scheduledCheck, CHECK_MS);
  void poll();

  return {
    check,
    refresh: () => refresh(true),
    stop() {
      stopped = true;
      cancelTimeout(); cancelPoll(); cancelCheck();
      request?.abort();
    },
  };
}
