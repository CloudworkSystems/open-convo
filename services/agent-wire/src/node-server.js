import { createServer, STATUS_CODES } from 'node:http';
import { pathToFileURL } from 'node:url';
import { AgentWire } from './worker.js';
import { MemoryStore } from './storage.js';
import { errorResponse, WireError } from './errors.js';

function requestBody(req) {
  let cleanup;
  return new ReadableStream({
    start(controller) {
      const data = (chunk) => { controller.enqueue(new Uint8Array(chunk)); req.pause(); };
      const end = () => { cleanup(); controller.close(); };
      const error = () => { cleanup(); controller.error(new Error('Request interrupted.')); };
      cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', error); };
      req.on('data', data); req.on('end', end); req.on('error', error); req.on('aborted', error);
      req.pause();
    },
    pull() { req.resume(); },
    // Cancelling a web stream must not destroy the HTTP response socket.
    cancel() { cleanup(); req.pause(); },
  });
}

export function createAgentWireServer(env = {}, options = {}) {
  const object = new AgentWire({}, env, { ...options, store: options.store ?? new MemoryStore() });
  const server = createServer(async (req, res) => {
    try {
      // The client-supplied Host header never chooses the routing origin.
      const url = new URL(req.url, 'http://localhost');
      const method = req.method === 'TRACE' ? 'DELETE' : req.method;
      const hasBody = !['GET', 'HEAD', 'DELETE'].includes(method);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      const request = new Request(url, {
        method, headers, body: hasBody ? requestBody(req) : undefined, ...(hasBody ? { duplex: 'half' } : {}),
      });
      const response = await object.fetch(request);
      if (request.body && !request.bodyUsed) await request.body.cancel();
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
      req.resume();
    } catch {
      const response = errorResponse(new WireError('Send a valid HTTP request.'));
      res.shouldKeepAlive = false;
      if (!res.headersSent) res.writeHead(response.status, { ...Object.fromEntries(response.headers), Connection: 'close' });
      res.end(Buffer.from(await response.arrayBuffer()));
    }
  });
  const socketError = (socket) => {
    socket.on('error', () => {});
    const response = errorResponse(new WireError('Send a valid HTTP request.'));
    response.text().then((body) => {
      const headers = [...response.headers].map(([k, v]) => k + ': ' + v);
      socket.end(['HTTP/1.1 400 ' + STATUS_CODES[400], ...headers, 'Connection: close', 'Content-Length: ' + Buffer.byteLength(body), '', body].join('\r\n'));
    }).catch(() => socket.destroy());
  };
  server.on('connect', (_req, socket) => socketError(socket));
  server.on('upgrade', (_req, socket) => socketError(socket));
  server.on('clientError', (_error, socket) => socketError(socket));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  createAgentWireServer(process.env).listen(Number(process.env.PORT) || 8787, '127.0.0.1');
}
