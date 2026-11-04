import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateCapability } from '../src/index.mjs';
import { parseServer } from '../src/media/address.mjs';
import { comfyRequest } from '../src/media/http.mjs';
import { run } from '../src/media/make.mjs';
import { LOCAL_NODES } from '../src/media/nodes.mjs';
import { MAX_READ_BYTES } from '../src/media/store.mjs';
import { REASONS } from '../src/media/reasons.mjs';
import { listRoutes, remainingMs, runLocal, upload, MAX_OUTPUT_BYTES } from '../src/media/runner.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const mediaPath = join(here, 'fixtures', 'make-media.json');
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const NOW = '2026-11-03T18:04:00.000Z';
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0xd9]);

function record() {
  return JSON.parse(readFileSync(mediaPath, 'utf8'));
}

function fixedNow() {
  return NOW;
}

function steppingNow(step = 1000) {
  let ms = Date.parse(NOW);
  return () => {
    const value = new Date(ms).toISOString();
    ms += step;
    return value;
  };
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'oc-media-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeBytes(dir, name, bytes) {
  const filePath = join(dir, name);
  writeFileSync(filePath, bytes);
  return filePath;
}

function filesIn(dir) {
  return readdirSync(dir);
}

function utf16be(text) {
  const le = Buffer.from(text, 'utf16le');
  const be = Buffer.alloc(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return be;
}

function ftyp(major, compatible = []) {
  const size = 16 + compatible.length * 4;
  const bytes = Buffer.alloc(size);
  bytes.writeUInt32BE(size, 0);
  bytes.write('ftyp', 4, 'ascii');
  bytes.write(major.padEnd(4, ' ').slice(0, 4), 8, 'ascii');
  compatible.forEach((brand, index) => {
    bytes.write(brand.padEnd(4, ' ').slice(0, 4), 16 + index * 4, 'ascii');
  });
  return bytes;
}

function receiptBeside(filePath) {
  return JSON.parse(readFileSync(`${filePath}.receipt.json`, 'utf8'));
}

function promptOnly(kind = 'image', extra = {}) {
  return {
    kind,
    prompt: {
      1: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
      2: { class_type: 'SaveImage', inputs: { filename_prefix: 'clip' } },
      ...extra,
    },
  };
}

function fullWorkflow() {
  return {
    kind: 'image',
    prompt: {
      1: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}', clip: ['2', 1] } },
      2: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'invented.safetensors' } },
      3: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: '{{height}}', batch_size: 1 } },
      4: {
        class_type: 'KSampler',
        inputs: {
          seed: 1,
          steps: '{{seconds}}',
          cfg: 7.5,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
          model: ['2', 0],
          positive: ['1', 0],
          negative: ['1', 0],
          latent_image: ['3', 0],
        },
      },
      5: { class_type: 'VAEDecode', inputs: { samples: ['4', 0], vae: ['2', 2] } },
      6: { class_type: 'LoadImage', inputs: { image: '{{reference_file}}' } },
      7: { class_type: 'WanImageToVideo', inputs: { width: 64, height: 64 } },
      8: { class_type: 'SaveImage', inputs: { filename_prefix: 'clip' } },
    },
  };
}

function localOptions(server, extra = {}) {
  return {
    record: record(),
    routeId: 'local',
    server: server.url,
    mediaDir: server.media,
    now: fixedNow,
    workflow: promptOnly(),
    request: { kind: 'image', prompt: 'a small red boat' },
    pollMs: 10,
    requestTimeoutMs: 1000,
    ...extra,
  };
}

function sendText(socket, text) {
  const payload = Buffer.from(text);
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
}

function startComfy(options = {}) {
  const state = {
    paths: [],
    posts: [],
    deletes: [],
    interrupts: [],
    uploads: [],
    views: [],
    running: options.running ? options.running.map((item) => item.slice()) : [],
    pending: options.pending ? options.pending.map((item) => item.slice()) : [],
    promptId: null,
    done: options.done !== false,
    output: options.output ?? PNG,
    outputName: options.outputName ?? 'clip.png',
    subfolder: options.subfolder ?? '',
    historyStatus: options.historyStatus ?? 'success',
    sockets: [],
    globalInterrupt: false,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    state.paths.push(url.pathname);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && url.pathname === '/upload/image') {
      if (options.upload === 'redirect') {
        res.writeHead(302, { Location: options.location, 'Content-Length': 0 });
        res.end();
        return;
      }
      if (options.upload === 'bad-name') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: '../x.png', subfolder: '', type: 'input' }));
        return;
      }
      const match = body.toString('latin1').match(/filename="([^"]+)"/);
      const name = match ? match[1] : 'ref.png';
      state.uploads.push(name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ name, subfolder: '', type: 'input' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/prompt') {
      if (options.prompt === 'redirect') {
        res.writeHead(302, { Location: options.location, 'Content-Length': 0 });
        res.end();
        return;
      }
      if (options.prompt === 'error') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'no' }));
        return;
      }
      if (options.prompt === 'hang') return;
      if (options.prompt === 'hold-response') {
        const parsed = JSON.parse(body.toString('utf8'));
        const id = clientPromptId(parsed);
        state.promptId = id;
        state.posts.push(parsed);
        state.running.push([1, id, {}, {}, []]);
        await new Promise((resolve) => { state.releasePrompt = resolve; });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ prompt_id: id, number: 1, node_errors: {} }));
        return;
      }
      const parsed = JSON.parse(body.toString('utf8'));
      const id = clientPromptId(parsed);
      state.promptId = id;
      state.posts.push(parsed);
      const row = [1, id, {}, {}, []];
      if (options.place === 'pending') state.pending.push(row);
      else state.running.push(row);
      if (options.ws === 'progress' && state.sockets[0]) {
        sendText(state.sockets[0], JSON.stringify({
          type: 'progress',
          data: { value: 1, max: 4, prompt_id: id, node: '3' },
        }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ prompt_id: id, number: 1, node_errors: {} }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/queue') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (options.queue === 'bad') {
        res.end(JSON.stringify({ queue_running: 'nope', queue_pending: [] }));
        return;
      }
      res.end(JSON.stringify({ queue_running: state.running, queue_pending: state.pending }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/queue') {
      const parsed = JSON.parse(body.toString('utf8'));
      state.deletes.push(parsed);
      if (options.startBeforeDelete && Array.isArray(parsed.delete)) {
        for (const id of parsed.delete) {
          const index = state.pending.findIndex((item) => item[1] === id);
          if (index === -1) continue;
          state.running.push(state.pending[index]);
          state.pending.splice(index, 1);
        }
      }
      if (Array.isArray(parsed.delete)) {
        state.pending = state.pending.filter((item) => !parsed.delete.includes(item[1]));
      }
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/interrupt') {
      const parsed = JSON.parse(body.toString('utf8'));
      state.interrupts.push(parsed);
      if (!parsed.prompt_id) {
        state.globalInterrupt = true;
        state.running = [];
      } else {
        state.running = state.running.filter((item) => item[1] !== parsed.prompt_id);
      }
      res.writeHead(200);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (!state.done) {
        res.end('{}');
        return;
      }
      const outputs = options.historyStatus === 'error' ? {} : (options.outputs ?? {
        9: {
          images: [{ filename: state.outputName, subfolder: state.subfolder, type: options.outputType ?? 'output' }],
        },
      });
      res.end(JSON.stringify({
        [id]: {
          outputs,
          status: { status_str: state.historyStatus, completed: true },
        },
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/view') {
      state.views.push(url.search);
      if (options.view === 'redirect') {
        res.writeHead(302, { Location: options.location, 'Content-Length': 0 });
        res.end();
        return;
      }
      if (options.view === 'big') {
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(MAX_OUTPUT_BYTES + 1) });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(state.output);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    state.paths.push(new URL(req.url, 'http://127.0.0.1').pathname);
    if (options.ws === 'hang') return;
    if (options.ws === 'redirect') {
      socket.write(`HTTP/1.1 302 Found\r\nLocation: ${options.location}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
      return;
    }
    if (options.ws === 'progress') {
      const key = req.headers['sec-websocket-key'];
      const accept = createHash('sha1').update(key + WS_MAGIC).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
      state.sockets.push(socket);
      return;
    }
    socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const folder = tempDir();
      resolve({
        state,
        url: `http://127.0.0.1:${port}`,
        port,
        media: folder.dir,
        close: () => {
          folder.remove();
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(done));
        },
      });
    });
  });
}

function startSink() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.end('no');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        hits,
        url: `http://127.0.0.1:${port}/stolen`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function promptPosts(state) {
  return state.paths.filter((path) => path === '/prompt').length;
}

test('with no route, upload and local come first and paid routes are never offered', () => {
  const base = record();
  base.routes = [base.routes[2], base.routes[1], base.routes[0]];
  const paid = base.routes[0];
  base.routes.push({
    id: 'sign-in-example',
    kind: 'sign_in',
    title: 'Sign in to Example',
    provider: paid.provider,
    model: paid.model,
    hosts: paid.hosts.slice(),
    leaves_machine: paid.leaves_machine,
    cost: structuredClone(paid.cost),
    terms: { url: 'https://example.com/terms', checked: '2026-11-02' },
  });
  assert.equal(validateCapability(base).ok, true);
  const listed = listRoutes(base, ['local-video', 'own-key-example', 'sign-in-example']);
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.offered.map((route) => route.id), ['upload', 'local-video']);
  assert.deepEqual(listed.offered.map((route) => route.kind), ['upload', 'local']);
  assert.equal(listed.offered.every((route) => route.available), true);
  assert.equal(listed.offered.some((route) => route.kind === 'own_key' || route.kind === 'sign_in'), false);
  assert.deepEqual(listed.unavailable.map((route) => route.reason), [REASONS.notAvailable, REASONS.notAvailable]);
  const idle = listRoutes(record(), []);
  assert.deepEqual(idle.offered.map((route) => route.id), ['upload']);
  assert.equal(idle.setup[0].id, 'local-video');
  assert.equal(idle.setup[0].reason, REASONS.localSetup);
  const broken = record();
  delete broken.title;
  assert.equal(listRoutes(broken).ok, false);
});

test('an upload of the wrong type or over the size limit is refused and nothing is copied', () => {
  const folder = tempDir();
  try {
    const text = writeBytes(folder.dir, 'notes.png', Buffer.from('hello'));
    const media = tempDir();
    try {
      const wrong = upload({
        record: record(), routeId: 'upload', filePath: text, madeHow: 'filmed-or-drawn-by-me', mediaDir: media.dir, now: fixedNow,
      });
      assert.equal(wrong.ok, false);
      assert.equal(wrong.reason, REASONS.fileType);
      assert.deepEqual(filesIn(media.dir), []);
      assert.equal(readFileSync(text, 'utf8'), 'hello');
      const limited = record();
      limited.inputs.reference_files.max_bytes = PNG.length - 1;
      const png = writeBytes(folder.dir, 'picture.png', PNG);
      const big = upload({
        record: limited, routeId: 'upload', filePath: png, madeHow: 'filmed-or-drawn-by-me', mediaDir: media.dir, now: fixedNow,
      });
      assert.equal(big.reason, REASONS.fileSize);
      assert.deepEqual(filesIn(media.dir), []);
    } finally {
      media.remove();
    }
  } finally {
    folder.remove();
  }
});

test('an upload receipt keeps how the file was made, and provenance beats a filmed answer', () => {
  const folder = tempDir();
  const media = tempDir();
  try {
    const cases = [
      ['clean.png', PNG, 'filmed-or-drawn-by-me', undefined],
      ['marked.png', Buffer.concat([PNG, Buffer.from('trainedAlgorithmicMedia')]), 'filmed-or-drawn-by-me', 'made by AI'],
      ['composite.png', Buffer.concat([PNG, Buffer.from('compositeWithTrainedAlgorithmicMedia')]), 'filmed-or-drawn-by-me', 'made by AI'],
      ['utf16.png', Buffer.concat([PNG, Buffer.from('trainedAlgorithmicMedia', 'utf16le')]), 'filmed-or-drawn-by-me', 'made by AI'],
      ['utf16be.png', Buffer.concat([PNG, utf16be('trainedAlgorithmicMedia')]), 'filmed-or-drawn-by-me', 'made by AI'],
      ['utf16be-composite.png', Buffer.concat([PNG, utf16be('compositeWithTrainedAlgorithmicMedia')]), 'filmed-or-drawn-by-me', 'made by AI'],
      ['unsure.png', PNG, 'not-sure', 'not sure'],
      ['unsure-marked.png', Buffer.concat([PNG, Buffer.from('trainedAlgorithmicMedia')]), 'not-sure', 'not sure'],
      ['ai.png', PNG, 'made-with-ai', 'made by AI'],
      ['photo.jpg', JPEG, 'filmed-or-drawn-by-me', undefined],
    ];
    for (const [name, bytes, madeHow, label] of cases) {
      const filePath = writeBytes(folder.dir, name, bytes);
      const saved = upload({
        record: record(), routeId: 'upload', filePath, madeHow, mediaDir: media.dir, now: fixedNow,
      });
      assert.equal(saved.ok, true, madeHow + name);
      const receipt = receiptBeside(saved.file);
      assert.equal(receipt.ai_label, label);
      assert.equal(receipt.leaves_machine, 'nothing');
      assert.equal(receipt.cost, 'free');
      assert.equal(receipt.prompt, null);
      assert.equal(receipt.provider, null);
      assert.equal(receipt.model, null);
      assert.equal(receipt.time, NOW);
      assert.equal(receipt.route, 'upload');
      assert.notEqual(basename(saved.file), name);
      assert.deepEqual(readFileSync(saved.file), bytes);
      assert.equal(readFileSync(filePath).equals(bytes), true);
      if (!label) assert.equal(JSON.stringify(receipt).includes('made by AI'), false);
      if (label === 'not sure') assert.equal(JSON.stringify(receipt).includes('made by AI'), false);
    }
  } finally {
    folder.remove();
    media.remove();
  }
});

test('an ftyp file is typed from its brand, and a big-endian marker still counts as AI', () => {
  const folder = tempDir();
  const media = tempDir();
  try {
    const cases = [
      [ftyp('isom'), 'video/mp4', 'mp4', true],
      [ftyp('qt  ', ['isom']), 'video/mp4', 'mp4', false],
      [ftyp('qt  ', ['isom']), 'video/quicktime', 'mov', true],
      [ftyp('heic'), 'video/mp4', 'mp4', false],
      [ftyp('heic'), 'image/heic', 'heic', true],
      [ftyp('avif'), 'image/avif', 'avif', true],
      [ftyp('mp42', ['isom', 'qt  ']), 'video/mp4', 'mp4', true],
    ];
    for (const [bytes, type, extension, accepts] of cases) {
      const allowed = record();
      allowed.inputs.reference_files.types = [type];
      allowed.inputs.reference_files.max_bytes = Math.max(bytes.length, 32);
      const filePath = writeBytes(folder.dir, `clip.${extension}`, bytes);
      const saved = upload({
        record: allowed, routeId: 'upload', filePath, madeHow: 'filmed-or-drawn-by-me', mediaDir: media.dir, now: fixedNow,
      });
      if (accepts) {
        assert.equal(saved.ok, true, `${type} ${saved.reason}`);
        assert.equal(basename(saved.file).endsWith(`.${extension}`), true);
        assert.deepEqual(readFileSync(saved.file), bytes);
      } else {
        assert.equal(saved.ok, false, type);
        assert.equal(saved.reason, REASONS.fileType, type);
      }
    }
    const splitAt = (64 * 1024) - 2;
    const marker = utf16be('trainedAlgorithmicMedia');
    const spanning = Buffer.concat([PNG, Buffer.alloc(Math.max(0, splitAt - PNG.length)), marker]);
    const marked = record();
    marked.inputs.reference_files.max_bytes = spanning.length;
    const filePath = writeBytes(folder.dir, 'span.png', spanning);
    const saved = upload({
      record: marked, routeId: 'upload', filePath, madeHow: 'filmed-or-drawn-by-me', mediaDir: media.dir, now: fixedNow,
    });
    assert.equal(saved.ok, true, saved.reason);
    assert.equal(receiptBeside(saved.file).ai_label, 'made by AI');
  } finally {
    folder.remove();
    media.remove();
  }
});

test('a Matroska file is not WebM, and a non-string prompt is refused', async () => {
  const folder = tempDir();
  const media = tempDir();
  const server = await startComfy();
  try {
    const webm = ebml('webm', Buffer.from([0x42, 0x86, 0x81, 0x01]));
    const matroska = ebml('matroska');
    const bare = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80]);
    const allowed = record();
    allowed.inputs.reference_files.types = ['video/webm'];
    allowed.inputs.reference_files.max_bytes = 1000;
    const asWebm = upload({
      record: allowed,
      routeId: 'upload',
      filePath: writeBytes(folder.dir, 'clip.mkv', webm),
      madeHow: 'filmed-or-drawn-by-me',
      mediaDir: media.dir,
      now: fixedNow,
    });
    assert.equal(asWebm.ok, true, asWebm.reason);
    assert.equal(basename(asWebm.file).endsWith('.webm'), true);
    for (const bytes of [matroska, bare]) {
      const saved = upload({
        record: allowed,
        routeId: 'upload',
        filePath: writeBytes(folder.dir, 'other.mkv', bytes),
        madeHow: 'filmed-or-drawn-by-me',
        mediaDir: media.dir,
        now: fixedNow,
      });
      assert.equal(saved.reason, REASONS.fileType);
    }
    const custom = record();
    custom.inputs.prompt = { type: 'enum', values: ['a boat', 'a ship'] };
    assert.equal(validateCapability(custom).ok, true);
    const refused = await runLocal(localOptions(server, {
      record: custom,
      request: { kind: 'image', prompt: 'a'.repeat(5000) },
    }));
    assert.equal(refused.reason, REASONS.badRequest);
    const over = await runLocal(localOptions(server, {
      request: { kind: 'image', prompt: 'a'.repeat(record().inputs.prompt.max_length + 1) },
    }));
    assert.equal(over.reason, REASONS.badRequest);
    assert.equal(server.state.paths.length, 0);
  } finally {
    folder.remove();
    media.remove();
    await server.close();
  }
});

function clientPromptId(parsed) {
  const id = parsed && parsed.prompt_id;
  if (typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  return randomUUID();
}

function ebml(docType, leading = Buffer.alloc(0)) {
  const name = Buffer.from(docType, 'ascii');
  const body = Buffer.concat([leading, Buffer.from([0x42, 0x82, 0x80 | name.length]), name]);
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x80 | body.length]), body]);
}

test('a file the record allows, but that is over 64 MiB, is refused before it is read', async () => {
  const folder = tempDir();
  const media = tempDir();
  const server = await startComfy();
  try {
    const allowed = record();
    allowed.inputs.reference_files.max_bytes = MAX_READ_BYTES + 1;
    assert.equal(validateCapability(allowed).ok, true);
    const filePath = join(folder.dir, 'big.png');
    const fd = openSync(filePath, 'w');
    try {
      ftruncateSync(fd, MAX_READ_BYTES + 1);
    } finally {
      closeSync(fd);
    }
    const saved = upload({
      record: allowed, routeId: 'upload', filePath, madeHow: 'filmed-or-drawn-by-me', mediaDir: media.dir, now: fixedNow,
    });
    assert.equal(saved.reason, REASONS.fileHold);
    assert.deepEqual(filesIn(media.dir), []);
    const local = await runLocal(localOptions(server, {
      record: allowed,
      workflow: fullWorkflow(),
      request: { kind: 'image', prompt: 'a boat', seconds: 2, width: 64, height: 64, referenceFile: filePath },
    }));
    assert.equal(local.reason, REASONS.fileHold);
    assert.equal(server.state.paths.length, 0);
  } finally {
    folder.remove();
    media.remove();
    await server.close();
  }
});

test('a progress socket that accepts but never upgrades does not stop the run', async () => {
  const server = await startComfy({ ws: 'hang' });
  try {
    const result = await runLocal(localOptions(server, { requestTimeoutMs: 80 }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(promptPosts(server.state), 1);
    assert.equal(receiptBeside(result.file).ai_label, 'made by AI');
  } finally {
    await server.close();
  }
});

test('a cancelled request is not opened, so a later reset cannot crash the run', async () => {
  const server = await startComfy();
  try {
    const ac = new AbortController();
    ac.abort();
    const result = await comfyRequest(parseServer(server.url), {
      method: 'GET',
      path: '/queue',
      timeoutMs: 1000,
      maxBytes: 1000,
      signal: ac.signal,
    });
    assert.equal(result.kind, 'abort');
    assert.equal(server.state.paths.length, 0);
  } finally {
    await server.close();
  }
});

test('the saved file matches the kind that was asked for', async () => {
  const outputs = {
    1: { images: [{ filename: 'preview.png', subfolder: '', type: 'output' }] },
    2: { videos: [{ filename: 'clip.mp4', subfolder: '', type: 'output' }] },
  };
  const video = await startComfy({ outputs, output: ftyp('isom') });
  try {
    const result = await runLocal(localOptions(video, {
      workflow: promptOnly('video'),
      request: { kind: 'video', prompt: 'a boat' },
    }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(basename(result.file).endsWith('.mp4'), true);
    assert.equal(video.state.views.some((query) => query.includes('filename=clip.mp4')), true);
    assert.equal(video.state.views.some((query) => query.includes('preview.png')), false);
  } finally {
    await video.close();
  }
  const image = await startComfy({ outputs });
  try {
    const result = await runLocal(localOptions(image, {
      request: { kind: 'image', prompt: 'a boat' },
    }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(basename(result.file).endsWith('.png'), true);
    assert.equal(image.state.views.some((query) => query.includes('filename=preview.png')), true);
  } finally {
    await image.close();
  }
  const still = await startComfy({
    outputs: { 1: { images: [{ filename: 'preview.png', subfolder: '', type: 'output' }] } },
  });
  try {
    const result = await runLocal(localOptions(still, {
      workflow: promptOnly('video'),
      request: { kind: 'video', prompt: 'a boat' },
    }));
    assert.equal(result.reason, REASONS.noOutput);
    assert.equal(still.state.views.length, 0);
    assert.deepEqual(filesIn(still.media), []);
  } finally {
    await still.close();
  }
});

test('a local video saved as MKV is kept as MKV', async () => {
  const clip = ebml('matroska');
  const server = await startComfy({
    output: clip,
    outputName: 'clip.mkv',
    outputs: { 1: { videos: [{ filename: 'clip.mkv', subfolder: '', type: 'output' }] } },
  });
  try {
    const result = await runLocal(localOptions(server, {
      workflow: promptOnly('video'),
      request: { kind: 'video', prompt: 'a boat' },
    }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(basename(result.file).endsWith('.mkv'), true);
    assert.deepEqual(readFileSync(result.file), clip);
    assert.equal(server.state.views.some((query) => query.includes('filename=clip.mkv')), true);
  } finally {
    await server.close();
  }
});

test('an uploaded file is not saved as the file the run made', async () => {
  const onlyInput = await startComfy({
    outputs: { 1: { images: [{ filename: 'boat.png', subfolder: '', type: 'input' }] } },
  });
  try {
    const result = await runLocal(localOptions(onlyInput, {
      request: { kind: 'image', prompt: 'a boat' },
    }));
    assert.equal(result.reason, REASONS.noOutput);
    assert.equal(onlyInput.state.views.length, 0);
    assert.deepEqual(filesIn(onlyInput.media), []);
  } finally {
    await onlyInput.close();
  }
  const mixed = await startComfy({
    outputs: {
      1: { images: [{ filename: 'boat.png', subfolder: '', type: 'input' }] },
      2: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
      3: { images: [{ filename: 'made.png', subfolder: '', type: 'output' }] },
    },
  });
  try {
    const result = await runLocal(localOptions(mixed, {
      request: { kind: 'image', prompt: 'a boat' },
    }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(mixed.state.views.length, 1);
    assert.equal(mixed.state.views[0].includes('filename=made.png'), true);
    assert.equal(mixed.state.views[0].includes('type=output'), true);
  } finally {
    await mixed.close();
  }
  const tempOnly = await startComfy({
    outputs: { 1: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] } },
  });
  try {
    const result = await runLocal(localOptions(tempOnly, {
      request: { kind: 'image', prompt: 'a boat' },
    }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(tempOnly.state.views[0].includes('filename=preview.png'), true);
    assert.equal(tempOnly.state.views[0].includes('type=temp'), true);
  } finally {
    await tempOnly.close();
  }
});

test('a reference file is checked against reference_files, not every files input', async () => {
  const folder = tempDir();
  const server = await startComfy();
  try {
    const custom = record();
    custom.inputs.reference_files = {
      type: 'files', max_items: 1, max_bytes: PNG.length, types: ['image/png'],
    };
    custom.inputs.mask_files = {
      type: 'files', max_items: 1, max_bytes: 5000000, types: ['image/jpeg'],
    };
    assert.equal(validateCapability(custom).ok, true);
    const jpeg = writeBytes(folder.dir, 'mask.jpg', JPEG);
    const png = writeBytes(folder.dir, 'boat.png', PNG);
    const request = { kind: 'image', prompt: 'a boat', seconds: 2, width: 64, height: 64 };
    const wrongType = await runLocal(localOptions(server, {
      record: custom,
      workflow: fullWorkflow(),
      request: { ...request, referenceFile: jpeg },
    }));
    assert.equal(wrongType.reason, REASONS.fileType);
    const tooBig = Buffer.concat([PNG, Buffer.from('x')]);
    const big = writeBytes(folder.dir, 'big.png', tooBig);
    const over = await runLocal(localOptions(server, {
      record: custom,
      workflow: fullWorkflow(),
      request: { ...request, referenceFile: big },
    }));
    assert.equal(over.reason, REASONS.fileSize);
    delete custom.inputs.reference_files;
    const missing = await runLocal(localOptions(server, {
      record: custom,
      workflow: fullWorkflow(),
      request: { ...request, referenceFile: png },
    }));
    assert.equal(missing.reason, REASONS.noReference);
    assert.equal(server.state.paths.length, 0);
    custom.inputs.reference_files = {
      type: 'files', max_items: 1, max_bytes: PNG.length, types: ['image/png'],
    };
    const ok = await runLocal(localOptions(server, {
      record: custom,
      workflow: fullWorkflow(),
      request: { ...request, referenceFile: png },
    }));
    assert.equal(ok.ok, true, ok.reason);
    assert.equal(server.state.uploads.length, 1);
  } finally {
    folder.remove();
    await server.close();
  }
});

test('a local run returns a file and a receipt that says made by AI, and the queued workflow holds the request', async () => {
  const server = await startComfy({ ws: 'off' });
  const inputs = tempDir();
  try {
    const reference = writeBytes(inputs.dir, 'boat.png', PNG);
    const prompt = 'a small red boat';
    const workflow = fullWorkflow();
    const result = await runLocal(localOptions(server, {
      workflow,
      request: { kind: 'image', prompt, seconds: 4, width: 640, height: 480, referenceFile: reference },
    }));
    assert.equal(result.ok, true, result.reason);
    const receipt = receiptBeside(result.file);
    assert.equal(receipt.ai_label, 'made by AI');
    assert.equal(receipt.leaves_machine, 'nothing');
    assert.equal(receipt.cost, 'free');
    assert.equal(receipt.prompt, prompt);
    assert.equal(receipt.provider, 'Invented Local Studio');
    assert.equal(receipt.model, 'invented-video-1');
    assert.equal(receipt.time, NOW);
    assert.deepEqual(readFileSync(result.file), PNG);
    assert.equal(promptPosts(server.state), 1);
    const posted = server.state.posts[0];
    assert.deepEqual(Object.keys(posted).sort(), ['client_id', 'prompt', 'prompt_id']);
    assert.equal(posted.prompt['1'].inputs.text, prompt);
    assert.equal(posted.prompt['3'].inputs.width, 640);
    assert.equal(posted.prompt['3'].inputs.height, 480);
    assert.equal(posted.prompt['4'].inputs.steps, 4);
    assert.equal(posted.prompt['6'].inputs.image, server.state.uploads[0]);
    assert.equal(posted.prompt['7'].class_type, 'WanImageToVideo');
    assert.equal(workflow.prompt['1'].inputs.text, '{{prompt}}');
    assert.equal(basename(result.file).endsWith('.png'), true);
    assert.notEqual(basename(result.file), 'clip.png');
  } finally {
    inputs.remove();
    await server.close();
  }
});

test('a non-loopback address is refused before any connection, and a redirect is not followed', async () => {
  const server = await startComfy();
  const sink = await startSink();
  try {
    const workflow = promptOnly();
    const request = { kind: 'image', prompt: 'a boat' };
    for (const address of [
      'http://192.168.1.5:9',
      'http://example.com',
      `http://localhost:${server.port}`,
      `http://127.0.0.2:${server.port}`,
      `https://127.0.0.1:${server.port}`,
      `http://user@127.0.0.1:${server.port}`,
      `http://127.0.0.1:${server.port}/comfy`,
      `http://[::ffff:127.0.0.1]:${server.port}`,
    ]) {
      const result = await runLocal(localOptions(server, { server: address, workflow, request }));
      assert.equal(result.ok, false, address);
      assert.equal(result.reason, REASONS.serverAddress, address);
    }
    assert.equal(server.state.paths.length, 0);
    const redirected = await startComfy({ prompt: 'redirect', location: sink.url });
    try {
      const result = await runLocal(localOptions(redirected, { workflow, request }));
      assert.equal(result.reason, REASONS.redirect);
      assert.equal(promptPosts(redirected.state), 1);
      assert.deepEqual(sink.hits, []);
    } finally {
      await redirected.close();
    }
    const offMachine = await startComfy({ prompt: 'redirect', location: 'http://192.168.1.5/stolen' });
    try {
      const started = Date.now();
      const result = await runLocal(localOptions(offMachine, { workflow, request, requestTimeoutMs: 200 }));
      assert.equal(result.reason, REASONS.redirect);
      assert.ok(Date.now() - started < 1000);
    } finally {
      await offMachine.close();
    }
  } finally {
    await sink.close();
    await server.close();
  }
});

test('a workflow with an API, partner or custom node is refused before anything is sent', async () => {
  const server = await startComfy();
  try {
    const request = { kind: 'image', prompt: 'a boat' };
    for (const name of ['KlingImageToVideoNode', 'PartnerBillingNode', 'MyCustomNode', 'WebcamCapture']) {
      const workflow = promptOnly('image', {
        9: { class_type: name, inputs: { text: 'outside' } },
      });
      const result = await runLocal(localOptions(server, { workflow, request }));
      assert.equal(result.ok, false, name);
      assert.match(result.reason, new RegExp(name));
    }
    assert.equal(server.state.paths.length, 0);
    assert.equal(LOCAL_NODES.has('KSampler'), true);
    assert.equal(LOCAL_NODES.has('SaveVideo'), true);
    assert.equal(LOCAL_NODES.has('LoadVideo'), true);
    assert.equal(LOCAL_NODES.has('WanImageToVideo'), true);
    assert.equal(LOCAL_NODES.has('EmptyLTXVLatentVideo'), true);
    assert.equal(LOCAL_NODES.has('WebcamCapture'), false);
    for (const name of LOCAL_NODES) {
      assert.doesNotMatch(name, /API|Partner|Webcam|Train|RecordAudio/);
    }
  } finally {
    await server.close();
  }
});

test('a required seconds, width or height cannot be left out', async () => {
  const server = await startComfy();
  try {
    for (const name of ['seconds', 'width', 'height']) {
      const custom = record();
      custom.inputs[name].required = true;
      assert.equal(validateCapability(custom).ok, true, name);
      const request = { kind: 'image', prompt: 'a boat', seconds: 2, width: 64, height: 64 };
      delete request[name];
      const result = await runLocal(localOptions(server, {
        record: custom,
        workflow: fullWorkflow(),
        request,
      }));
      assert.equal(result.reason, REASONS.badRequest, name);
    }
    assert.equal(server.state.paths.length, 0);
    const optional = record();
    assert.equal(optional.inputs.seconds.required, undefined);
    const omitted = await runLocal(localOptions(server, {
      record: optional,
      request: { kind: 'image', prompt: 'a boat' },
    }));
    assert.equal(omitted.ok, true, omitted.reason);
  } finally {
    await server.close();
  }
});

test('a required reference cannot be left out', async () => {
  const folder = tempDir();
  const server = await startComfy();
  try {
    const custom = record();
    custom.inputs.reference_files.required = true;
    assert.equal(validateCapability(custom).ok, true);
    const omitted = await runLocal(localOptions(server, {
      record: custom,
      workflow: fullWorkflow(),
      request: { kind: 'image', prompt: 'a boat', seconds: 2, width: 64, height: 64 },
    }));
    assert.equal(omitted.reason, REASONS.badRequest);
    assert.equal(server.state.paths.length, 0);
    const png = writeBytes(folder.dir, 'boat.png', PNG);
    const supplied = await runLocal(localOptions(server, {
      record: custom,
      workflow: fullWorkflow(),
      request: { kind: 'image', prompt: 'a boat', seconds: 2, width: 64, height: 64, referenceFile: png },
    }));
    assert.equal(supplied.ok, true, supplied.reason);
    custom.inputs.reference_files.required = false;
    const optional = await runLocal(localOptions(server, {
      record: custom,
      request: { kind: 'image', prompt: 'a boat' },
    }));
    assert.equal(optional.ok, true, optional.reason);
  } finally {
    folder.remove();
    await server.close();
  }
});

test('cancelling when the queue answer never arrives still stops that job', async () => {
  const server = await startComfy({ prompt: 'hold-response', done: false });
  try {
    const ac = new AbortController();
    const run = runLocal(localOptions(server, { signal: ac.signal, requestTimeoutMs: 150 }));
    for (let i = 0; i < 50 && !server.state.promptId; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(server.state.promptId);
    ac.abort();
    const result = await run;
    assert.equal(result.stopped, true);
    assert.equal(result.reason, REASONS.stopped);
    const cancelled = server.state.interrupts[0]?.prompt_id ?? server.state.deletes[0]?.delete?.[0];
    assert.equal(cancelled, server.state.promptId);
    assert.equal(server.state.running.some((item) => item[1] === server.state.promptId), false);
  } finally {
    server.state.releasePrompt?.();
    await server.close();
  }
});

test('cancelling while the queue answer is still on its way stops that job', async () => {
  const server = await startComfy({ prompt: 'hold-response', done: false });
  try {
    const ac = new AbortController();
    const run = runLocal(localOptions(server, { signal: ac.signal, requestTimeoutMs: 2000 }));
    for (let i = 0; i < 50 && !server.state.promptId; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(server.state.promptId);
    ac.abort();
    server.state.releasePrompt();
    const result = await run;
    assert.equal(result.stopped, true);
    assert.equal(result.reason, REASONS.stopped);
    const cancelled = server.state.interrupts[0]?.prompt_id ?? server.state.deletes[0]?.delete?.[0];
    assert.equal(cancelled, server.state.promptId);
    assert.equal(server.state.running.some((item) => item[1] === server.state.promptId), false);
    assert.deepEqual(filesIn(server.media), []);
  } finally {
    await server.close();
  }
});

test('cancelling removes only that waiting job and does not interrupt a different running job', async () => {
  const server = await startComfy({
    done: false,
    place: 'pending',
    running: [[0, 'other-job', {}, {}, []]],
  });
  try {
    const ac = new AbortController();
    let sawQueued;
    const queued = new Promise((resolve) => { sawQueued = resolve; });
    const run = runLocal(localOptions(server, {
      signal: ac.signal,
      onProgress(info) {
        if (info.status === 'queued') sawQueued();
      },
    }));
    await queued;
    ac.abort();
    const result = await run;
    assert.equal(result.stopped, true);
    assert.equal(result.reason, REASONS.stopped);
    assert.equal(server.state.interrupts.length, 0);
    assert.equal(server.state.globalInterrupt, false);
    assert.deepEqual(server.state.deletes, [{ delete: [server.state.promptId] }]);
    assert.equal(server.state.running[0][1], 'other-job');
    assert.equal(server.state.pending.some((item) => item[1] === server.state.promptId), false);
    assert.deepEqual(filesIn(server.media), []);
  } finally {
    await server.close();
  }
});

test('a job that starts running before its delete arrives is still interrupted', async () => {
  const server = await startComfy({ done: false, place: 'pending', startBeforeDelete: true });
  try {
    const ac = new AbortController();
    let sawQueued;
    const queued = new Promise((resolve) => { sawQueued = resolve; });
    const run = runLocal(localOptions(server, {
      signal: ac.signal,
      onProgress(info) {
        if (info.status === 'queued') sawQueued();
      },
    }));
    await queued;
    ac.abort();
    const result = await run;
    assert.equal(result.stopped, true);
    assert.equal(result.reason, REASONS.stopped);
    assert.deepEqual(server.state.deletes, [{ delete: [server.state.promptId] }]);
    assert.deepEqual(server.state.interrupts, [{ prompt_id: server.state.promptId }]);
    assert.equal(server.state.globalInterrupt, false);
    assert.equal(server.state.running.some((item) => item[1] === server.state.promptId), false);
    assert.deepEqual(filesIn(server.media), []);
  } finally {
    await server.close();
  }
});

test('an interrupt is sent only when that prompt id is the one running', async () => {
  const server = await startComfy({
    done: false,
    pending: [[2, 'other-job', {}, {}, []]],
  });
  try {
    const ac = new AbortController();
    let sawRunning;
    const running = new Promise((resolve) => { sawRunning = resolve; });
    const run = runLocal(localOptions(server, {
      signal: ac.signal,
      onProgress(info) {
        if (info.status === 'running') sawRunning();
      },
    }));
    await running;
    ac.abort();
    const result = await run;
    assert.equal(result.stopped, true);
    assert.deepEqual(server.state.interrupts, [{ prompt_id: server.state.promptId }]);
    assert.equal(server.state.deletes.length, 0);
    assert.equal(server.state.pending[0][1], 'other-job');
    assert.equal(server.state.globalInterrupt, false);
  } finally {
    await server.close();
  }
});

test('a server that is not running gives the plain message and nothing is sent again', async () => {
  const server = await startComfy();
  const port = server.port;
  await server.close();
  const folder = tempDir();
  try {
    const result = await runLocal({
      record: record(),
      routeId: 'local',
      server: `http://127.0.0.1:${port}`,
      mediaDir: folder.dir,
      now: fixedNow,
      workflow: promptOnly(),
      request: { kind: 'image', prompt: 'a boat' },
      requestTimeoutMs: 200,
    });
    assert.equal(result.reason, REASONS.notRunning);
    assert.match(result.reason, /Open ComfyUI/);
    assert.deepEqual(filesIn(folder.dir), []);
  } finally {
    folder.remove();
  }
});

test('hostile prompt text stays text in the receipt and in the queued workflow', async () => {
  const server = await startComfy();
  try {
    const prompt = 'say "hello" <script>alert(1)</script>\nline two\u202e\u200f"}, "class_type": "KlingImageToVideoNode"';
    const result = await runLocal(localOptions(server, {
      request: { kind: 'image', prompt },
    }));
    assert.equal(result.ok, true, result.reason);
    const raw = readFileSync(`${result.file}.receipt.json`, 'utf8');
    const receipt = JSON.parse(raw);
    assert.equal(receipt.prompt, prompt);
    assert.equal(server.state.posts[0].prompt['1'].inputs.text, prompt);
    assert.deepEqual(
      Object.values(server.state.posts[0].prompt).map((node) => node.class_type).sort(),
      ['CLIPTextEncode', 'SaveImage'],
    );
    assert.equal(promptPosts(server.state), 1);
  } finally {
    await server.close();
  }
});

test('a record that promises a file type this runner cannot read, or a provider on an upload, is refused before anything is copied', () => {
  const folder = tempDir();
  const media = tempDir();
  try {
    const png = writeBytes(folder.dir, 'picture.png', PNG);
    const bmp = record();
    bmp.inputs.reference_files.types = ['image/bmp'];
    const named = upload({
      record: bmp, routeId: 'upload', filePath: png, madeHow: 'filmed-or-drawn-by-me', mediaDir: media.dir, now: fixedNow,
    });
    assert.equal(named.reason, REASONS.record);
    const credited = record();
    credited.routes.find((item) => item.kind === 'upload').provider = 'Example Media';
    credited.routes.find((item) => item.kind === 'upload').model = 'example-1';
    const claimed = upload({
      record: credited, routeId: 'upload', filePath: png, madeHow: 'filmed-or-drawn-by-me', mediaDir: media.dir, now: fixedNow,
    });
    assert.equal(claimed.reason, REASONS.record);
    assert.deepEqual(filesIn(media.dir), []);
  } finally {
    folder.remove();
    media.remove();
  }
});

test('a record that fails the validator is refused before anything runs', async () => {
  const server = await startComfy();
  try {
    const broken = record();
    broken.extra = true;
    const result = await runLocal(localOptions(server, { record: broken }));
    assert.equal(result.reason, REASONS.record);
    assert.ok(result.errors.length > 0);
    assert.equal(server.state.paths.length, 0);
    const folder = tempDir();
    try {
      const filePath = writeBytes(folder.dir, 'picture.png', PNG);
      const uploaded = upload({
        record: broken, routeId: 'upload', filePath, madeHow: 'filmed-or-drawn-by-me', mediaDir: folder.dir, now: fixedNow,
      });
      assert.equal(uploaded.reason, REASONS.record);
      assert.deepEqual(filesIn(folder.dir), ['picture.png']);
    } finally {
      folder.remove();
    }
  } finally {
    await server.close();
  }
});

test('the time estimate comes from progress so far and the caller clock', async () => {
  const server = await startComfy({ ws: 'progress', done: false });
  try {
    let seen;
    const result = await runLocal(localOptions(server, {
      now: steppingNow(1000),
      onProgress(info) {
        if (info.progress === 0.25) {
          seen = info;
          server.state.done = true;
        }
      },
    }));
    assert.equal(result.ok, true, result.reason);
    assert.ok(seen, 'progress was not reported');
    assert.equal(seen.status, 'running');
    assert.equal(seen.elapsedMs, 1000);
    assert.equal(seen.estimateMs, remainingMs(1000, 0.25));
    assert.equal(seen.estimateMs, 3000);
  } finally {
    await server.close();
  }
});

test('edge cases: placeholders, cancel before contact, redirects, size and links', async () => {
  assert.equal(remainingMs(1000, 0), null);
  assert.equal(remainingMs(1000, 1), 0);
  assert.equal(remainingMs(-1, 0.5), null);

  const server = await startComfy();
  const sink = await startSink();
  const folder = tempDir();
  try {
    const request = { kind: 'image', prompt: 'a boat' };
    const early = new AbortController();
    early.abort();
    const stopped = await runLocal(localOptions(server, { signal: early.signal, request }));
    assert.equal(stopped.stopped, true);
    assert.equal(server.state.paths.length, 0);

    const paid = await runLocal(localOptions(server, { routeId: 'own-key-example', request }));
    assert.equal(paid.reason, REASONS.notAvailable);
    assert.equal(server.state.paths.length, 0);

    const mismatch = await runLocal(localOptions(server, { request: { kind: 'video', prompt: 'a boat' } }));
    assert.equal(mismatch.reason, REASONS.workflowKind);
    const missing = await runLocal(localOptions(server, {
      workflow: { kind: 'image', prompt: { 1: { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } } } },
      request,
    }));
    assert.equal(missing.reason, REASONS.workflowPrompt);
    const buried = await runLocal(localOptions(server, {
      workflow: { kind: 'image', prompt: { 1: { class_type: 'CLIPTextEncode', inputs: { text: 'a {{prompt}} cat' } } } },
      request,
    }));
    assert.equal(buried.reason, REASONS.workflowPrompt);
    const twice = await runLocal(localOptions(server, {
      workflow: promptOnly('image', { 3: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } } }),
      request,
    }));
    assert.equal(twice.reason, REASONS.workflowPrompt);
    const spare = await runLocal(localOptions(server, {
      workflow: {
        kind: 'image',
        prompt: {
          1: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
          2: { class_type: 'EmptyLatentImage', inputs: { width: '{{width}}', height: 64 } },
        },
      },
      request,
    }));
    assert.equal(spare.reason, REASONS.workflowValue);
    const kept = await runLocal(localOptions(server, {
      workflow: {
        kind: 'image',
        prompt: {
          1: { class_type: 'CLIPTextEncode', inputs: { text: '{{prompt}}' } },
          3: { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512 } },
        },
      },
      request: { kind: 'image', prompt: 'a boat', width: 640 },
    }));
    assert.equal(kept.reason, REASONS.workflowValue);
    const low = await runLocal(localOptions(server, { request: { kind: 'image', prompt: 'a boat', seconds: 0 } }));
    assert.equal(low.reason, REASONS.badRequest);
    const high = await runLocal(localOptions(server, { request: { kind: 'image', prompt: 'a boat', seconds: 11 } }));
    assert.equal(high.reason, REASONS.badRequest);
    const fraction = await runLocal(localOptions(server, { request: { kind: 'image', prompt: 'a boat', width: 64.5 } }));
    assert.equal(fraction.reason, REASONS.badRequest);
    const badClock = await runLocal(localOptions(server, { now: () => 'yesterday', request }));
    assert.equal(badClock.reason, REASONS.badTime);
    const proto = JSON.parse('{"kind":"image","prompt":{"__proto__":{"class_type":"KSampler","inputs":{"text":"{{prompt}}"}}}}');
    const polluted = await runLocal(localOptions(server, { workflow: proto, request }));
    assert.equal(polluted.reason, REASONS.workflow);
    assert.equal(server.state.paths.length, 0);

    const literal = await runLocal(localOptions(server, { request: { kind: 'image', prompt: '{{prompt}}' } }));
    assert.equal(literal.ok, true, literal.reason);
    assert.equal(server.state.posts.at(-1).prompt['1'].inputs.text, '{{prompt}}');

    const errored = await startComfy({ historyStatus: 'error' });
    try {
      const result = await runLocal(localOptions(errored, { request }));
      assert.equal(result.reason, REASONS.comfyFailed);
      assert.equal(promptPosts(errored.state), 1);
      assert.deepEqual(filesIn(errored.media), []);
    } finally {
      await errored.close();
    }

    const unsafe = await startComfy({ outputName: '../x.png' });
    try {
      const result = await runLocal(localOptions(unsafe, { request }));
      assert.equal(result.reason, REASONS.noOutput);
      assert.equal(unsafe.state.views.length, 0);
      assert.deepEqual(filesIn(unsafe.media), []);
    } finally {
      await unsafe.close();
    }

    const viewRedirect = await startComfy({ view: 'redirect', location: sink.url });
    try {
      const result = await runLocal(localOptions(viewRedirect, { request }));
      assert.equal(result.reason, REASONS.redirect);
      assert.deepEqual(sink.hits, []);
      assert.deepEqual(filesIn(viewRedirect.media), []);
    } finally {
      await viewRedirect.close();
    }

    const hangingSocket = await startComfy({ ws: 'hang' });
    try {
      const ac = new AbortController();
      const run = runLocal(localOptions(hangingSocket, { signal: ac.signal, request, requestTimeoutMs: 2000 }));
      setTimeout(() => ac.abort(), 30);
      const result = await run;
      assert.equal(result.stopped, true);
      assert.equal(promptPosts(hangingSocket.state), 0);
    } finally {
      await hangingSocket.close();
    }

    const socketRedirect = await startComfy({ ws: 'redirect', location: sink.url });
    try {
      const result = await runLocal(localOptions(socketRedirect, { request }));
      assert.equal(result.reason, REASONS.redirect);
      assert.equal(promptPosts(socketRedirect.state), 0);
      assert.deepEqual(sink.hits, []);
    } finally {
      await socketRedirect.close();
    }

    const uploadRedirect = await startComfy({ upload: 'redirect', location: sink.url });
    try {
      const reference = writeBytes(folder.dir, 'ref.png', PNG);
      const result = await runLocal(localOptions(uploadRedirect, {
        workflow: fullWorkflow(),
        request: { kind: 'image', prompt: 'a boat', seconds: 2, width: 64, height: 64, referenceFile: reference },
      }));
      assert.equal(result.reason, REASONS.redirect);
      assert.equal(promptPosts(uploadRedirect.state), 0);
      assert.deepEqual(sink.hits, []);
    } finally {
      await uploadRedirect.close();
    }

    const badName = await startComfy({ upload: 'bad-name' });
    try {
      const reference = writeBytes(folder.dir, 'ref2.png', PNG);
      const result = await runLocal(localOptions(badName, {
        workflow: fullWorkflow(),
        request: { kind: 'image', prompt: 'a boat', seconds: 2, width: 64, height: 64, referenceFile: reference },
      }));
      assert.equal(result.reason, REASONS.comfyFailed);
      assert.equal(promptPosts(badName.state), 0);
    } finally {
      await badName.close();
    }

    const hung = await startComfy({ prompt: 'hang' });
    try {
      const result = await runLocal(localOptions(hung, { request, requestTimeoutMs: 80 }));
      assert.equal(result.reason, REASONS.noAnswer);
      assert.equal(promptPosts(hung.state), 1);
    } finally {
      await hung.close();
    }

    const quiet = await startComfy({ queue: 'bad', done: false });
    try {
      const ac = new AbortController();
      let saw;
      const ready = new Promise((resolve) => { saw = resolve; });
      const run = runLocal(localOptions(quiet, {
        signal: ac.signal,
        onProgress() { saw(); },
      }));
      await ready;
      ac.abort();
      const result = await run;
      assert.equal(result.stopped, true);
      assert.equal(quiet.state.interrupts.length, 0);
      assert.equal(quiet.state.deletes.length, 0);
    } finally {
      await quiet.close();
    }

    const big = await startComfy({ view: 'big' });
    try {
      const result = await runLocal(localOptions(big, { request, maxOutputBytes: 8 }));
      assert.equal(result.reason, REASONS.tooBig);
      assert.deepEqual(filesIn(big.media), []);
    } finally {
      await big.close();
    }

    const video = await startComfy({ outputName: 'clip.mp4', output: Buffer.from('invented-video') });
    try {
      const result = await runLocal(localOptions(video, {
        workflow: promptOnly('video'),
        request: { kind: 'video', prompt: 'a boat' },
      }));
      assert.equal(result.reason, REASONS.noOutput);
      assert.deepEqual(filesIn(video.media), []);
    } finally {
      await video.close();
    }
    const realClip = await startComfy({ outputName: 'clip.mp4', output: ftyp('isom') });
    try {
      const result = await runLocal(localOptions(realClip, {
        workflow: promptOnly('video'),
        request: { kind: 'video', prompt: 'a boat' },
      }));
      assert.equal(result.ok, true, result.reason);
      assert.equal(basename(result.file).endsWith('.mp4'), true);
      assert.equal(receiptBeside(result.file).ai_label, 'made by AI');
    } finally {
      await realClip.close();
    }

    let threw = false;
    const flaky = await startComfy({ done: false });
    try {
      const result = await runLocal(localOptions(flaky, {
        onProgress() {
          flaky.state.done = true;
          threw = true;
          throw new Error('the screen broke');
        },
      }));
      assert.equal(threw, true);
      assert.equal(result.ok, true, result.reason);
    } finally {
      await flaky.close();
    }

    const finished = await startComfy();
    try {
      let called = false;
      const result = await runLocal(localOptions(finished, {
        onProgress() { called = true; },
      }));
      assert.equal(result.ok, true, result.reason);
      assert.equal(called, false);
    } finally {
      await finished.close();
    }

    const linkDir = join(folder.dir, 'linked');
    const realMedia = join(folder.dir, 'real-media');
    mkdirSync(realMedia);
    symlinkSync(realMedia, linkDir);
    const png = writeBytes(folder.dir, 'picture.png', PNG);
    const linkedFile = join(folder.dir, 'alias.png');
    symlinkSync(png, linkedFile);
    const linkUpload = upload({
      record: record(), routeId: 'upload', filePath: linkedFile, madeHow: 'filmed-or-drawn-by-me', mediaDir: realMedia, now: fixedNow,
    });
    assert.equal(linkUpload.reason, REASONS.fileLink);
    assert.deepEqual(filesIn(realMedia), []);
    const linkFolder = upload({
      record: record(), routeId: 'upload', filePath: png, madeHow: 'not-sure', mediaDir: linkDir, now: fixedNow,
    });
    assert.equal(linkFolder.reason, REASONS.mediaLink);

    const noRule = record();
    delete noRule.inputs.reference_files;
    const noFiles = upload({
      record: noRule, routeId: 'upload', filePath: png, madeHow: 'not-sure', mediaDir: realMedia, now: fixedNow,
    });
    assert.equal(noFiles.reason, REASONS.noFileRule);
    assert.equal(upload({
      record: record(), routeId: 'upload', filePath: png, madeHow: 'somewhere', mediaDir: realMedia, now: fixedNow,
    }).reason, REASONS.madeHow);
  } finally {
    folder.remove();
    await sink.close();
    await server.close();
  }
});

test('the command copies an upload and refuses a local server that is not on this Mac', async () => {
  const folder = tempDir();
  const media = tempDir();
  try {
    const filePath = writeBytes(folder.dir, 'picture.png', PNG);
    const uploaded = await run([
      '--record', mediaPath,
      '--route', 'upload',
      '--file', filePath,
      '--made-how', 'filmed-or-drawn-by-me',
      '--media', media.dir,
      '--now', NOW,
    ]);
    assert.equal(uploaded.code, 0, uploaded.lines.join('\n'));
    const receipt = JSON.parse(readFileSync(`${uploaded.lines[0]}.receipt.json`, 'utf8'));
    assert.equal(receipt.time, NOW);
    assert.equal('ai_label' in receipt, false);
    const workflow = join(folder.dir, 'workflow.json');
    writeFileSync(workflow, JSON.stringify(promptOnly()));
    const local = await run([
      '--record', mediaPath,
      '--route', 'local',
      '--server', 'http://example.com:9',
      '--workflow', workflow,
      '--prompt', 'a boat',
      '--media', media.dir,
      '--now', NOW,
    ]);
    assert.equal(local.code, 1);
    assert.equal(local.lines[0], REASONS.serverAddress);
  } finally {
    folder.remove();
    media.remove();
  }
});

test('a loopback address written as ::1 is accepted', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '::1', resolve));
  const { port } = server.address();
  const folder = tempDir();
  try {
    const result = await runLocal({
      record: record(),
      routeId: 'local',
      server: `http://[::1]:${port}`,
      mediaDir: folder.dir,
      now: fixedNow,
      workflow: promptOnly(),
      request: { kind: 'image', prompt: 'a boat' },
      requestTimeoutMs: 500,
    });
    assert.notEqual(result.reason, REASONS.serverAddress);
    assert.notEqual(result.reason, REASONS.notRunning);
  } finally {
    folder.remove();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the library does not read the clock', () => {
  const dir = fileURLToPath(new URL('../src/media/', import.meta.url));
  for (const name of readdirSync(dir)) {
    if (name === 'make.mjs') continue;
    const text = readFileSync(join(dir, name), 'utf8');
    assert.equal(text.includes('Date.now'), false, name);
    assert.equal(/new Date\(\)/.test(text), false, name);
  }
});
