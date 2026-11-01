// Node 22 entry point: runs the same handler on a plain HTTP server. Used by
// the tests, and the starting point for any other host.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { handle } from './handler.js';

export function createFrontPorchServer() {
  return createServer(async (req, res) => {
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
}

// The Host header is client input, so the routing URL uses a fixed origin and
// takes only the path and query from the request.
const ORIGIN = 'http://localhost';

async function serve(req, res) {
  const url = new URL(req.url, ORIGIN);
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
  const response = await handle(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || 8787;
  createFrontPorchServer().listen(port, '127.0.0.1', () => {
    console.log('Front porch listening on 127.0.0.1 port ' + port);
  });
}
