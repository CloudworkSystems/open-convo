// Node 22 entry point: runs the same handler on a plain HTTP server. Used by
// the tests, and the starting point for any other host.
import { createServer, STATUS_CODES } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { handle } from './handler.js';

export function createFrontPorchServer() {
  const server = createServer(async (req, res) => {
    try {
      await serve(req, res);
    } catch {
      // A malformed request must never take the process down.
      if (!res.headersSent) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      }
      res.end(res.headersSent ? undefined : JSON.stringify({ error: { status: 400, message: 'Bad request.' } }));
    }
  });
  // Node hands CONNECT to its own event with the raw socket, and closes the
  // socket unanswered if nobody listens. Answer it like any other method the
  // handler refuses, then close.
  server.on('connect', async (req, socket) => {
    socket.on('error', () => {});
    let response;
    try {
      response = await handle(new Request(new URL(req.url, ORIGIN), { method: 'DELETE' }));
    } catch {
      response = new Response(JSON.stringify({ error: { status: 400, message: 'Bad request.' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff' },
      });
    }
    const body = Buffer.from(await response.arrayBuffer());
    const head = ['HTTP/1.1 ' + response.status + ' ' + (STATUS_CODES[response.status] || '')];
    for (const [key, value] of response.headers) head.push(key + ': ' + value);
    head.push('Content-Length: ' + body.length, 'Connection: close', '', '');
    socket.end(Buffer.concat([Buffer.from(head.join('\r\n')), body]));
  });
  return server;
}

// The Host header is client input, so the routing URL uses a fixed origin and
// takes only the path and query from the request.
const ORIGIN = 'http://localhost';

// TRACE reaches us from Node's parser, but the WHATWG Request constructor
// refuses to build it. The handler would refuse it anyway, so it is routed as
// another unsupported method with no body, which gives the same 404 or 405
// answer as any other. (Node itself answers TRACK with 400, and CONNECT goes
// to the 'connect' handler above.)
const FORBIDDEN_METHODS = new Set(['TRACE']);

async function serve(req, res) {
  const url = new URL(req.url, ORIGIN);
  if (FORBIDDEN_METHODS.has(req.method)) {
    req.resume();
    return send(res, req.method, await handle(new Request(url, { method: 'DELETE' })));
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
  return send(res, req.method, await handle(request));
}

async function send(res, method, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || 8787;
  createFrontPorchServer().listen(port, '127.0.0.1', () => {
    console.log('Front porch listening on 127.0.0.1 port ' + port);
  });
}
