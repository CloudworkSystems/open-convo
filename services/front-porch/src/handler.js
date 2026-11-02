// The front porch: one Web-standard fetch handler (docs/plans/front-porch-api.md).
// It imports nothing host-specific, so any host that speaks Request/Response
// can run it. Answers come only from the reviewed public content file.

import content from '../content.json' with { type: 'json' };
import openapi from '../openapi.json' with { type: 'json' };
import { handleMcp } from './mcp.js';
import { filterFaq, MAX_QUERY_LENGTH } from './faq.js';

export const MAX_MCP_BYTES = 16 * 1024;

// Sent on every response (security.md section 3, "Any server we run").
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
};

const REST_CACHE = 'public, max-age=300';

export function json(status, body, extra = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

// Fixed messages only: nothing from the request or from an exception is echoed.
export function error(status, message, extra = {}) {
  return json(status, { error: { status, message } }, extra);
}

const REST = {
  '/v1/about': () => content.about,
  '/v1/features': () => ({ features: content.features }),
  '/v1/faq': (url) => ({ faq: filterFaq(content.faq, url.searchParams.get('q')) }),
  '/v1/privacy': () => content.privacy,
  '/v1/status': () => content.status,
  '/v1/updates': () => ({ updates: [...content.updates].sort((a, b) => b.date.localeCompare(a.date)) }),
  '/openapi.json': () => openapi,
};

export const REST_PATHS = Object.keys(REST);

async function route(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/mcp') {
    if (request.method !== 'POST') return error(405, 'Method not allowed.', { Allow: 'POST' });
    return handleMcp(request, { content, json, error, maxBytes: MAX_MCP_BYTES });
  }

  const answer = REST[path];
  if (!answer) return error(404, 'Not found.');
  if (request.method !== 'GET') return error(405, 'Method not allowed.', { Allow: 'GET' });

  const q = url.searchParams.get('q');
  if (q !== null && q.length > MAX_QUERY_LENGTH) {
    return error(400, `Query is longer than ${MAX_QUERY_LENGTH} characters.`);
  }
  return json(200, answer(url), { 'Cache-Control': REST_CACHE });
}

// Never return a stack trace, a file path or the exception's text. Exported
// so a test can force an internal error through the same wrapper.
export function guarded(fn) {
  return async (request) => {
    try {
      return await fn(request);
    } catch {
      return error(500, 'Internal error.');
    }
  };
}

export const handle = guarded(route);
