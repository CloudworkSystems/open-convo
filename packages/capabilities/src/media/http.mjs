// HTTP to a loopback ComfyUI. Redirects are never followed: a 3xx ends the
// run in the caller before another request is made. The progress socket is
// the same host, and a redirect on the upgrade is reported the same way.

import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';

const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_FRAME = 1024 * 1024;

function errorKind(error) {
  const codes = [error?.code, ...(Array.isArray(error?.errors) ? error.errors.map((item) => item?.code) : [])];
  if (codes.includes('ABORT_ERR')) return 'abort';
  if (codes.includes('ECONNREFUSED')) return 'refused';
  if (codes.includes('ETIMEDOUT')) return 'timeout';
  return 'reset';
}

function lookupLoopback(hostname, options, callback) {
  if (hostname !== '127.0.0.1' && hostname !== '::1') {
    const error = new Error('not loopback');
    error.code = 'ENOTFOUND';
    callback(error);
    return;
  }
  callback(null, hostname, hostname === '::1' ? 6 : 4);
}

function hostHeader(address) {
  return address.hostname === '::1'
    ? `[::1]:${address.port}`
    : `${address.hostname}:${address.port}`;
}

/**
 * One request. `kind` is `refused`, `redirect`, `timeout`, `abort`,
 * `too-big` or `reset` when it does not complete.
 */
export function comfyRequest(address, { method, path, headers, body, timeoutMs, maxBytes, signal }) {
  return new Promise((resolve) => {
    // Checked before the request exists. Creating one and then returning
    // leaves a socket with no error handler, and a later reset crashes Node.
    if (signal?.aborted) {
      resolve({ ok: false, kind: 'abort' });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const req = http.request({
      hostname: address.hostname,
      port: address.port,
      family: address.family,
      method,
      path,
      headers: { Host: hostHeader(address), Connection: 'close', ...headers },
      lookup: lookupLoopback,
      agent: false,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        finish({ ok: false, kind: 'redirect', status: res.statusCode });
        return;
      }
      const declared = res.headers['content-length'];
      if (declared != null && Number(declared) > maxBytes) {
        res.resume();
        req.destroy();
        finish({ ok: false, kind: 'too-big', status: res.statusCode });
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          res.destroy();
          finish({ ok: false, kind: 'too-big', status: res.statusCode });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        finish({
          ok: true,
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
      res.on('error', () => finish({ ok: false, kind: 'reset', status: res.statusCode }));
    });
    const onAbort = () => {
      req.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    };
    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      finish({ ok: false, kind: errorKind(error) });
    });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    // The signal can flip in the gap after the early check. The error
    // handler is already on, so destroying here cannot crash the process.
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    if (body) req.end(body);
    else req.end();
  });
}

/**
 * ComfyUI's progress socket. A refused connection, a redirect, or a cancel
 * stops the caller. A socket that is missing, or that accepts and then never
 * finishes the upgrade, is only a missing progress report.
 */
export function openProgress(address, { clientId, timeoutMs, onMessage, signal }) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    if (signal?.aborted) {
      finish({ ok: false, kind: 'abort' });
      return;
    }
    const key = randomBytes(16).toString('base64');
    const req = http.request({
      hostname: address.hostname,
      port: address.port,
      family: address.family,
      method: 'GET',
      path: `/ws?clientId=${encodeURIComponent(clientId)}`,
      headers: {
        Host: hostHeader(address),
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
      lookup: lookupLoopback,
      agent: false,
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }));
    });
    const onAbort = () => {
      req.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    req.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      const kind = errorKind(error);
      if (kind === 'refused' || kind === 'timeout' || kind === 'abort') finish({ ok: false, kind });
      else finish({ ok: false, kind: 'unavailable' });
    });
    req.on('close', () => signal?.removeEventListener('abort', onAbort));
    req.on('upgrade', (res, socket, head) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        socket.destroy();
        finish({ ok: false, kind: 'redirect' });
        return;
      }
      const expected = createHash('sha1').update(key + WS_MAGIC).digest('base64');
      if (res.statusCode !== 101 || res.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        finish({ ok: false, kind: 'unavailable' });
        return;
      }
      const session = readFrames(socket, head, onMessage);
      finish({ ok: true, close: session.close });
    });
    req.on('response', (res) => {
      const kind = res.statusCode >= 300 && res.statusCode < 400 ? 'redirect' : 'unavailable';
      res.resume();
      finish({ ok: false, kind });
    });
    req.end();
  });
}

function readFrames(socket, head, onMessage) {
  let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let fragments = null;

  function take() {
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let length = buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_FRAME)) {
          socket.destroy();
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_FRAME) {
        socket.destroy();
        return;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < offset + maskLen + length) return;
      let payload = buf.subarray(offset + maskLen, offset + maskLen + length);
      if (masked) {
        const mask = buf.subarray(offset, offset + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      }
      buf = Buffer.from(buf.subarray(offset + maskLen + length));
      if (opcode === 0x1 || opcode === 0x0) {
        fragments = fragments ? Buffer.concat([fragments, payload]) : Buffer.from(payload);
        if (fin) {
          const text = fragments.toString('utf8');
          fragments = null;
          try {
            onMessage(JSON.parse(text));
          } catch {
            /* a progress frame that is not JSON is ignored */
          }
        }
      } else if (opcode === 0x8) {
        socket.end();
      } else if (opcode === 0x9) {
        writeFrame(socket, 0xA, payload);
      } else {
        fragments = null;
      }
    }
  }

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    take();
  });
  socket.on('error', () => { /* the run continues without further progress */ });
  if (buf.length) take();
  return {
    close() {
      socket.removeAllListeners('data');
      socket.destroy();
    },
  };
}

function writeFrame(socket, opcode, payload) {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
  const head = Buffer.from([0x80 | opcode, 0x80 | masked.length]);
  if (masked.length >= 126) return;
  socket.write(Buffer.concat([head, mask, masked]));
}
