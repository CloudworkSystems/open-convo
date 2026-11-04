// make_media for the upload and local routes. Upload and local are free, so
// this runner does not reserve or settle on the cap. Paid routes are not
// offered and are not run. The caller passes `now()`; this file does not
// read the clock.

import { randomBytes, randomUUID } from 'node:crypto';
import { validateCapability } from '../validate.mjs';
import { parseServer } from './address.mjs';
import { comfyRequest, openProgress } from './http.mjs';
import { REASONS } from './reasons.mjs';
import {
  extensionFor,
  mediaDirKind,
  sniffType,
  supportedFileTypes,
  removeFile,
  scanFile,
  streamCopy,
  writeNewFile,
  writeReceipt,
} from './store.mjs';
import { instantMs, remainingMs } from './time.mjs';
import { fillWorkflow, inspectWorkflow } from './workflow.mjs';

export { remainingMs } from './time.mjs';

const MADE = new Set(['filmed-or-drawn-by-me', 'made-with-ai', 'not-sure']);
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_NAME = /^[A-Za-z0-9._-]{1,200}$/;
const OUTPUT_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov', 'mkv']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'mkv']);
const OUTPUT_KEYS = ['images', 'gifs', 'video', 'videos'];

export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 250;

function fail(reason, extra = {}) {
  return { ok: false, reason, ...extra };
}

function fileFields(record) {
  if (!record.inputs || typeof record.inputs !== 'object') return [];
  return Object.values(record.inputs).filter((field) => (
    field && field.type === 'files' && Array.isArray(field.types) && Number.isInteger(field.max_bytes)
  ));
}

function checkBytes(record, scanned) {
  const fields = fileFields(record);
  if (fields.length === 0) return fail(REASONS.noFileRule);
  return checkField(fields, scanned);
}

function referenceField(record) {
  const field = record.inputs?.reference_files;
  if (!field || field.type !== 'files' || !Array.isArray(field.types) || !Number.isInteger(field.max_bytes)) {
    return null;
  }
  return field;
}

function checkField(fields, scanned) {
  const type = scanned.type;
  if (!type) return fail(REASONS.fileType);
  const typed = fields.filter((field) => field.types.includes(type));
  if (typed.length === 0) return fail(REASONS.fileType);
  if (!typed.some((field) => scanned.size <= field.max_bytes)) return fail(REASONS.fileSize);
  return { ok: true, type };
}

function fileCeiling(record) {
  const fields = fileFields(record);
  if (fields.length === 0) return null;
  return Math.max(...fields.map((field) => field.max_bytes));
}

function readClock(now) {
  if (typeof now !== 'function') return fail(REASONS.badTime);
  let value;
  try {
    value = now();
  } catch {
    return fail(REASONS.badTime);
  }
  if (instantMs(value) === null) return fail(REASONS.badTime);
  return { ok: true, value };
}

function validated(record) {
  const result = validateCapability(record);
  if (!result.ok) return fail(REASONS.record, { errors: result.errors });
  return { ok: true, record };
}

const READABLE = new Set(supportedFileTypes());

// The shared record check allows any file type. This runner only reads the
// types it can sniff, and only once upload or local is the route chosen.
function chosenMedia(record) {
  const checked = validated(record);
  if (!checked.ok) return checked;
  const errors = [];
  const inputs = record.inputs;
  if (inputs && typeof inputs === 'object') {
    for (const [name, field] of Object.entries(inputs)) {
      if (!field || field.type !== 'files' || !Array.isArray(field.types)) continue;
      field.types.forEach((type, index) => {
        if (!READABLE.has(type)) {
          errors.push({
            path: `inputs.${name}.types[${index}]`,
            message: 'must be a file type this runner can read, such as image/png',
          });
        }
      });
    }
  }
  if (errors.length > 0) return fail(REASONS.record, { errors });
  return checked;
}

function pickRoute(record, routeId, expectedKind) {
  const routes = Array.isArray(record.routes) ? record.routes : [];
  let route = routes.find((item) => item.id === routeId);
  if (!route) {
    const same = routes.filter((item) => item.kind === routeId);
    if (same.length === 1) route = same[0];
  }
  if (!route) return fail(REASONS.routeMissing);
  if (route.kind === 'own_key' || route.kind === 'sign_in') return fail(REASONS.notAvailable);
  if (route.kind !== expectedKind) return fail(REASONS.routeKind);
  return { ok: true, route };
}

function readyIds(setUp) {
  const ready = new Set();
  const list = Array.isArray(setUp) ? setUp : setUp instanceof Set ? [...setUp] : [];
  for (const id of list) {
    if (typeof id === 'string') ready.add(id);
  }
  return ready;
}

function listed(route, index, extra) {
  return {
    index,
    id: route.id,
    kind: route.kind,
    title: route.title ?? null,
    ...extra,
  };
}

function rank(kind) {
  if (kind === 'upload') return 0;
  if (kind === 'local') return 1;
  return 2;
}

/** Routes the person can run, free ones first. Paid routes are never offered. */
export function listRoutes(record, setUp) {
  const checked = validated(record);
  if (!checked.ok) return checked;
  const ready = readyIds(setUp);
  const offered = [];
  const setup = [];
  const unavailable = [];
  (record.routes ?? []).forEach((route, index) => {
    if (route.kind === 'upload') {
      offered.push(listed(route, index, { available: true }));
    } else if (route.kind === 'local') {
      if (ready.has(route.id)) offered.push(listed(route, index, { available: true }));
      else setup.push(listed(route, index, { available: false, reason: REASONS.localSetup }));
    } else if (route.kind === 'own_key' || route.kind === 'sign_in') {
      unavailable.push(listed(route, index, { available: false, reason: REASONS.notAvailable }));
    }
  });
  offered.sort((a, b) => rank(a.kind) - rank(b.kind) || a.index - b.index);
  for (const item of [...offered, ...setup, ...unavailable]) delete item.index;
  return { ok: true, offered, setup, unavailable };
}

function labelFor(madeHow, provenance) {
  if (madeHow === 'not-sure') return 'not sure';
  if (madeHow === 'made-with-ai' || provenance) return 'made by AI';
  return null;
}

function receiptFor({ route, prompt, time, label, file }) {
  const ownFile = route.kind === 'upload';
  const receipt = {
    route: route.id,
    provider: ownFile ? null : (route.provider ?? null),
    model: ownFile ? null : (route.model ?? null),
    prompt,
    leaves_machine: 'nothing',
    cost: 'free',
    time,
    file,
  };
  if (label) receipt.ai_label = label;
  return receipt;
}

function savePair(mediaDir, extension, bytes, fields) {
  const written = writeNewFile(mediaDir, extension, bytes);
  if (!written) return fail(REASONS.notSaved);
  const receipt = receiptFor({ ...fields, file: written.name });
  try {
    const receiptPath = writeReceipt(written.filePath, receipt);
    return { ok: true, file: written.filePath, receiptPath, receipt };
  } catch {
    removeFile(written.filePath);
    return fail(REASONS.notSaved);
  }
}

function scanProblem(scanned) {
  if (scanned.ok) return null;
  if (scanned.code === 'link') return fail(REASONS.fileLink);
  if (scanned.code === 'size') return fail(REASONS.fileSize);
  if (scanned.code === 'ceiling') return fail(REASONS.fileHold);
  return fail(REASONS.fileUnreadable);
}

function saveScanned(mediaDir, extension, scanned, fields) {
  const written = streamCopy(scanned.filePath, mediaDir, extension, scanned.size);
  if (!written) return fail(REASONS.notSaved);
  const receipt = receiptFor({ ...fields, file: written.name });
  try {
    const receiptPath = writeReceipt(written.filePath, receipt);
    return { ok: true, file: written.filePath, receiptPath, receipt };
  } catch {
    removeFile(written.filePath);
    return fail(REASONS.notSaved);
  }
}

function folderProblem(mediaDir) {
  const folder = mediaDirKind(mediaDir);
  if (folder === 'symlink') return fail(REASONS.mediaLink);
  if (folder !== 'directory') return fail(REASONS.mediaFolder);
  return null;
}

/**
 * Copy a file the person made into the media folder and write the receipt
 * beside it. Nothing is sent anywhere.
 */
export function upload({ record, routeId, filePath, madeHow, mediaDir, now }) {
  const checked = chosenMedia(record);
  if (!checked.ok) return checked;
  const picked = pickRoute(record, routeId ?? 'upload', 'upload');
  if (!picked.ok) return picked;
  if (!MADE.has(madeHow)) return fail(REASONS.madeHow);
  const folder = folderProblem(mediaDir);
  if (folder) return folder;
  const time = readClock(now);
  if (!time.ok) return time;
  const ceiling = fileCeiling(record);
  if (ceiling == null) return fail(REASONS.noFileRule);
  const scanned = scanFile(filePath, ceiling);
  const problem = scanProblem(scanned);
  if (problem) return problem;
  const typed = checkBytes(record, scanned);
  if (!typed.ok) return typed;
  const extension = extensionFor(typed.type);
  if (!extension) return fail(REASONS.fileType);
  return saveScanned(mediaDir, extension, scanned, {
    route: picked.route,
    prompt: null,
    time: time.value,
    label: labelFor(madeHow, scanned.provenance),
  });
}

function integerInput(record, name, value) {
  const field = record.inputs?.[name];
  if (value == null) {
    if (field && field.required === true) return fail(REASONS.badRequest);
    return { ok: true, present: false };
  }
  if (!field || field.type !== 'integer' || !Number.isInteger(value)) return fail(REASONS.badRequest);
  if (value < field.min || value > field.max) return fail(REASONS.badRequest);
  return { ok: true, present: true };
}

function checkLocalRequest(record, request) {
  const kindField = record.inputs?.kind;
  if (!kindField || !Array.isArray(kindField.values) || !kindField.values.includes(request.kind)) {
    return fail(REASONS.badRequest);
  }
  const promptField = record.inputs?.prompt;
  // An enum or other non-string prompt has no max_length, and a missing
  // limit would accept every string. This runner only takes a string prompt.
  if (!promptField || promptField.type !== 'string' || !Number.isInteger(promptField.max_length)) {
    return fail(REASONS.badRequest);
  }
  if (typeof request.prompt !== 'string' || request.prompt.length > promptField.max_length) {
    return fail(REASONS.badRequest);
  }
  const seconds = integerInput(record, 'seconds', request.seconds);
  if (!seconds.ok) return seconds;
  const width = integerInput(record, 'width', request.width);
  if (!width.ok) return width;
  const height = integerInput(record, 'height', request.height);
  if (!height.ok) return height;
  const hasReference = request.referenceFile != null;
  const reference = record.inputs?.reference_files;
  if (!hasReference && reference?.required === true) return fail(REASONS.badRequest);
  if (hasReference && typeof request.referenceFile !== 'string') return fail(REASONS.badRequest);
  return {
    ok: true,
    hasSeconds: seconds.present,
    hasWidth: width.present,
    hasHeight: height.present,
    hasReference,
  };
}

function limits(options) {
  const asked = options.maxOutputBytes;
  const maxOutputBytes = Number.isInteger(asked) && asked > 0
    ? Math.min(asked, MAX_OUTPUT_BYTES)
    : MAX_OUTPUT_BYTES;
  const pollAsked = options.pollMs;
  const pollMs = Number.isInteger(pollAsked) && pollAsked >= 10
    ? Math.min(pollAsked, 60_000)
    : DEFAULT_POLL_MS;
  const timeoutAsked = options.requestTimeoutMs;
  const timeoutMs = Number.isInteger(timeoutAsked) && timeoutAsked >= 10
    ? Math.min(timeoutAsked, 120_000)
    : REQUEST_TIMEOUT_MS;
  return { maxOutputBytes, pollMs, timeoutMs };
}

function netFail(result, sent) {
  if (!result) return fail(sent ? REASONS.stoppedServer : REASONS.notRunning);
  if (result.kind === 'abort') return { ok: false, abort: true };
  if (result.kind === 'redirect') return fail(REASONS.redirect);
  if (result.kind === 'timeout') return fail(REASONS.noAnswer);
  if (result.kind === 'too-big') return fail(REASONS.tooBig);
  if (result.kind === 'refused') return fail(sent ? REASONS.stoppedServer : REASONS.notRunning);
  return fail(REASONS.stoppedServer);
}

function jsonHeaders(body) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
  };
}

function parseJson(body) {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}

function queueIds(list) {
  if (!Array.isArray(list)) return null;
  const ids = [];
  for (const item of list) {
    if (!Array.isArray(item) || typeof item[1] !== 'string') return null;
    ids.push(item[1]);
  }
  return ids;
}

function outputExtension(filename) {
  if (typeof filename !== 'string' || !SAFE_NAME.test(filename) || filename.includes('..')) return null;
  const ext = filename.split('.').pop().toLowerCase();
  if (!OUTPUT_EXT.has(ext)) return null;
  return ext === 'jpeg' ? 'jpg' : ext;
}

function mediaKind(ext) {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function safeSubfolder(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string' || value.length > 200 || value.includes('\\') || value.startsWith('/')) return null;
  const parts = value.split('/');
  if (parts.some((part) => !/^[A-Za-z0-9._-]{1,100}$/.test(part) || part === '..')) return null;
  return parts.join('/');
}

function firstOutput(entry, kind) {
  const outputs = entry?.outputs;
  if (!outputs || typeof outputs !== 'object') return null;
  const found = [];
  for (const node of Object.values(outputs)) {
    if (!node || typeof node !== 'object') continue;
    for (const key of OUTPUT_KEYS) {
      const list = node[key];
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const ext = outputExtension(item.filename);
        const subfolder = safeSubfolder(item.subfolder);
        const type = item.type == null ? 'output' : item.type;
        if (!ext || subfolder == null || mediaKind(ext) !== kind) continue;
        // An input entry is the file that was uploaded, not a file this run made.
        if (type !== 'output' && type !== 'temp') continue;
        found.push({ filename: item.filename, subfolder, type, ext, kind: mediaKind(ext) });
      }
    }
  }
  const sameKind = found.filter((item) => item.kind === kind);
  return sameKind.find((item) => item.type === 'output') ?? sameKind[0] ?? null;
}

function progressFraction(data) {
  if (!data || typeof data !== 'object') return null;
  const { value, max } = data;
  if (typeof value !== 'number' || typeof max !== 'number') return null;
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value < 0 || value > max) return null;
  return value / max;
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    if (signal?.aborted) {
      done();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function reportProgress(onProgress, info) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(info);
  } catch {
    // A broken progress screen does not stop the run or send anything else.
  }
}

function uploadParts(name, type) {
  const boundary = `openconvo${randomBytes(12).toString('hex')}`;
  const prefix = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`,
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { boundary, prefix, suffix };
}

/**
 * Send one local job to ComfyUI and copy the file it makes into the media
 * folder. Cancelling removes that job only: a waiting job is deleted by its
 * prompt id, and an interrupt is sent only when that id is the one running.
 */
export async function runLocal(options) {
  const checked = chosenMedia(options.record);
  if (!checked.ok) return checked;
  const picked = pickRoute(options.record, options.routeId ?? 'local', 'local');
  if (!picked.ok) return picked;
  const address = parseServer(options.server);
  if (!address) return fail(REASONS.serverAddress);
  const folder = folderProblem(options.mediaDir);
  if (folder) return folder;
  const started = readClock(options.now);
  if (!started.ok) return started;
  const request = options.request ?? {};
  const fields = checkLocalRequest(options.record, request);
  if (!fields.ok) return fields;

  let reference = null;
  if (fields.hasReference) {
    const field = referenceField(options.record);
    if (!field) return fail(REASONS.noReference);
    const scanned = scanFile(request.referenceFile, field.max_bytes);
    const problem = scanProblem(scanned);
    if (problem) return problem;
    const typed = checkField([field], scanned);
    if (!typed.ok) return typed;
    reference = scanned;
  }

  const inspected = inspectWorkflow(options.workflow, { kind: request.kind, ...fields });
  if (!inspected.ok) return inspected;
  if (options.signal?.aborted) return fail(REASONS.stopped, { stopped: true });

  const { maxOutputBytes, pollMs, timeoutMs } = limits(options);
  const clientId = randomUUID();
  let promptId = null;
  const pendingMessages = [];
  let fraction = null;
  const noteMessage = (message) => {
    if (!message || message.type !== 'progress') return;
    if (promptId && message.data?.prompt_id !== promptId) return;
    if (!promptId) {
      pendingMessages.push(message);
      return;
    }
    const next = progressFraction(message.data);
    if (next != null) fraction = next;
  };
  const applyPending = () => {
    for (const message of pendingMessages) {
      if (message.data?.prompt_id !== promptId) continue;
      const next = progressFraction(message.data);
      if (next != null) fraction = next;
    }
    pendingMessages.length = 0;
  };

  let closeSocket = null;
  try {
    const socket = await openProgress(address, {
      clientId,
      timeoutMs,
      onMessage: noteMessage,
      signal: options.signal,
    });
    // A missing socket, or one that accepts and then never upgrades, only
    // means there is no progress. Abort and redirect still stop the run.
    const noProgress = socket.kind === 'unavailable' || socket.kind === 'timeout';
    if (!socket.ok && !noProgress) {
      const problem = netFail(socket, false);
      if (problem.abort) return fail(REASONS.stopped, { stopped: true });
      return problem;
    }
    if (socket.ok) closeSocket = socket.close;

    const call = (spec) => comfyRequest(address, { timeoutMs, maxBytes: MAX_JSON_BYTES, signal: options.signal, ...spec });

    if (reference) {
      const extension = extensionFor(reference.type);
      const name = `ref-${randomBytes(8).toString('hex')}.${extension}`;
      const form = uploadParts(name, reference.type);
      const uploaded = await call({
        method: 'POST',
        path: '/upload/image',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${form.boundary}`,
          'Content-Length': String(form.prefix.length + reference.size + form.suffix.length),
        },
        stream: { path: reference.filePath, size: reference.size, prefix: form.prefix, suffix: form.suffix },
        maxBytes: MAX_JSON_BYTES,
      });
      if (!uploaded.ok) {
        const problem = netFail(uploaded, false);
        if (problem.abort) return fail(REASONS.stopped, { stopped: true });
        return problem;
      }
      if (uploaded.status !== 200) return fail(REASONS.comfyFailed);
      const body = parseJson(uploaded.body);
      const returned = body?.name;
      const subfolder = body?.subfolder;
      if (typeof returned !== 'string' || !SAFE_NAME.test(returned) || returned.includes('..')) {
        return fail(REASONS.comfyFailed);
      }
      if (subfolder != null && subfolder !== '') return fail(REASONS.comfyFailed);
      reference.name = returned;
    }

    if (options.signal?.aborted) return fail(REASONS.stopped, { stopped: true });

    const graph = fillWorkflow(options.workflow, {
      prompt: request.prompt,
      seconds: request.seconds,
      width: request.width,
      height: request.height,
      reference_file: reference?.name,
    });
    // The id is chosen here so a lost answer can still name the job ComfyUI accepted.
    const chosenId = randomUUID();
    const payload = Buffer.from(JSON.stringify({ prompt: graph, client_id: clientId, prompt_id: chosenId }));
    // Do not abort this request. ComfyUI may already have taken the job
    // before its answer arrives, and the answer is what names that job.
    // The request timeout still bounds the wait.
    const posted = await comfyRequest(address, {
      method: 'POST',
      path: '/prompt',
      headers: jsonHeaders(payload),
      body: payload,
      timeoutMs,
      maxBytes: MAX_JSON_BYTES,
    });
    if (!posted.ok || posted.status !== 200) {
      if (options.signal?.aborted) {
        await cancelExact(address, chosenId, timeoutMs);
        return fail(REASONS.stopped, { stopped: true });
      }
      if (!posted.ok) return netFail(posted, false);
      return fail(REASONS.comfyFailed);
    }
    const postedBody = parseJson(posted.body);
    if (!postedBody || typeof postedBody.prompt_id !== 'string' || !PROMPT_ID.test(postedBody.prompt_id)) {
      if (options.signal?.aborted) {
        await cancelExact(address, chosenId, timeoutMs);
        return fail(REASONS.stopped, { stopped: true });
      }
      return fail(REASONS.comfyFailed);
    }
    promptId = postedBody.prompt_id;
    applyPending();
    if (options.signal?.aborted) {
      await cancelExact(address, promptId, timeoutMs);
      return fail(REASONS.stopped, { stopped: true });
    }

    const startedAt = started.value;
    while (true) {
      if (options.signal?.aborted) {
        await cancelExact(address, promptId, timeoutMs);
        return fail(REASONS.stopped, { stopped: true });
      }
      const history = await call({ method: 'GET', path: `/history/${promptId}` });
      if (!history.ok) {
        if (history.kind === 'abort' || options.signal?.aborted) {
          await cancelExact(address, promptId, timeoutMs);
          return fail(REASONS.stopped, { stopped: true });
        }
        return netFail(history, true);
      }
      if (history.status !== 200) return fail(REASONS.comfyFailed);
      const parsed = parseJson(history.body);
      if (!parsed || typeof parsed !== 'object') return fail(REASONS.comfyFailed);
      const entry = parsed[promptId];
      if (entry?.status?.status_str === 'error') return fail(REASONS.comfyFailed);
      const output = entry ? firstOutput(entry, request.kind) : null;
      if (output) {
        if (options.signal?.aborted) {
          await cancelExact(address, promptId, timeoutMs);
          return fail(REASONS.stopped, { stopped: true });
        }
        return await fetchOutput({
          address,
          output,
          kind: request.kind,
          timeoutMs,
          maxOutputBytes,
          signal: options.signal,
          mediaDir: options.mediaDir,
          route: picked.route,
          prompt: request.prompt,
          now: options.now,
          promptId,
        });
      }
      if (entry?.status?.completed === true) return fail(REASONS.noOutput);

      const queue = await call({ method: 'GET', path: '/queue' });
      if (!queue.ok) {
        if (queue.kind === 'abort' || options.signal?.aborted) {
          await cancelExact(address, promptId, timeoutMs);
          return fail(REASONS.stopped, { stopped: true });
        }
        return netFail(queue, true);
      }
      const queueBody = queue.status === 200 ? parseJson(queue.body) : null;
      const running = queueBody ? queueIds(queueBody.queue_running) : null;
      const status = running?.includes(promptId) ? 'running' : 'queued';
      const at = readClock(options.now);
      const elapsed = at.ok ? instantMs(at.value) - instantMs(startedAt) : null;
      const progress = status === 'queued' ? 0 : fraction;
      reportProgress(options.onProgress, {
        status,
        progress,
        elapsedMs: elapsed,
        estimateMs: remainingMs(elapsed, progress),
      });
      await wait(pollMs, options.signal);
    }
  } finally {
    try {
      closeSocket?.();
    } catch {
      /* the socket is already gone */
    }
  }
}

async function fetchOutput({
  address, output, kind, timeoutMs, maxOutputBytes, signal, mediaDir, route, prompt, now, promptId,
}) {
  const params = new URLSearchParams({
    filename: output.filename,
    type: output.type,
    subfolder: output.subfolder,
  });
  const viewed = await comfyRequest(address, {
    method: 'GET',
    path: `/view?${params}`,
    timeoutMs,
    maxBytes: maxOutputBytes,
    signal,
  });
  if (!viewed.ok) {
    if (viewed.kind === 'abort' || signal?.aborted) {
      await cancelExact(address, promptId, timeoutMs);
      return fail(REASONS.stopped, { stopped: true });
    }
    return netFail(viewed, true);
  }
  if (viewed.status !== 200 || viewed.body.length === 0) return fail(REASONS.noOutput);
  if (signal?.aborted) return fail(REASONS.stopped, { stopped: true });
  // The history name is not proof. The bytes have to be the kind that was asked for.
  const ext = extensionFor(sniffType(viewed.body));
  if (!ext || mediaKind(ext) !== kind) return fail(REASONS.noOutput);
  const time = readClock(now);
  if (!time.ok) return time;
  return savePair(mediaDir, ext, viewed.body, {
    route,
    prompt,
    time: time.value,
    label: 'made by AI',
  });
}

/**
 * Cancel one prompt id. A waiting id is removed from the queue. An interrupt
 * is sent only when that id is the one running. Another running job is left
 * alone, and a queue this runner cannot read does not get an interrupt.
 * A job that starts after the queue was read, and so misses the delete, is
 * read again and interrupted when it is the one running.
 */
async function cancelExact(address, promptId, timeoutMs) {
  const seen = await readQueue(address, timeoutMs);
  if (!seen) return;
  try {
    if (seen.pending.includes(promptId) && !seen.running.includes(promptId)) {
      const payload = Buffer.from(JSON.stringify({ delete: [promptId] }));
      await comfyRequest(address, {
        method: 'POST',
        path: '/queue',
        headers: jsonHeaders(payload),
        body: payload,
        timeoutMs,
        maxBytes: MAX_JSON_BYTES,
      });
      const again = await readQueue(address, timeoutMs);
      if (again && onlyThisRunning(again.running, promptId)) {
        await interruptPrompt(address, promptId, timeoutMs);
      }
      return;
    }
    if (onlyThisRunning(seen.running, promptId)) {
      await interruptPrompt(address, promptId, timeoutMs);
    }
  } catch {
    /* the run is still marked stopped */
  }
}

async function readQueue(address, timeoutMs) {
  let queue;
  try {
    queue = await comfyRequest(address, {
      method: 'GET',
      path: '/queue',
      timeoutMs,
      maxBytes: MAX_JSON_BYTES,
    });
  } catch {
    return null;
  }
  if (!queue.ok || queue.status !== 200) return null;
  const body = parseJson(queue.body);
  if (!body) return null;
  const running = queueIds(body.queue_running);
  const pending = queueIds(body.queue_pending);
  if (!running || !pending) return null;
  return { running, pending };
}

function onlyThisRunning(running, promptId) {
  return running.length > 0 && running.every((id) => id === promptId);
}

async function interruptPrompt(address, promptId, timeoutMs) {
  const payload = Buffer.from(JSON.stringify({ prompt_id: promptId }));
  await comfyRequest(address, {
    method: 'POST',
    path: '/interrupt',
    headers: jsonHeaders(payload),
    body: payload,
    timeoutMs,
    maxBytes: MAX_JSON_BYTES,
  });
}
