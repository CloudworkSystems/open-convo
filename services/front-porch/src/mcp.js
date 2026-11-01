// MCP over Streamable HTTP, stateless and read-only: each POST carries one
// JSON-RPC message and gets one JSON answer. No sessions, no server-sent
// events, no notifications from the server.

import { filterFaq, MAX_QUERY_LENGTH } from './faq.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
export const SERVER_INFO = { name: 'true-convo-front-porch', version: '0.1.0' };

const NO_ARGS = { type: 'object', properties: {}, additionalProperties: false };

export function tools(content) {
  return {
    about: {
      description: 'What True Convo is, who makes it, and whether it is available.',
      inputSchema: NO_ARGS,
      run: () => content.about,
    },
    features: {
      description: 'True Convo features, each labeled available, in development or planned.',
      inputSchema: NO_ARGS,
      run: () => ({ features: content.features }),
    },
    faq: {
      description: 'Frequently asked questions about True Convo, optionally filtered by words.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', maxLength: MAX_QUERY_LENGTH, description: 'Words that every returned entry must contain.' },
        },
        additionalProperties: false,
      },
      run: (args) => ({ faq: filterFaq(content.faq, args.q ?? null) }),
    },
    privacy: {
      description: "True Convo's privacy promises and a link to its privacy policy.",
      inputSchema: NO_ARGS,
      run: () => content.privacy,
    },
    status: {
      description: 'How far along True Convo development is.',
      inputSchema: NO_ARGS,
      run: () => content.status,
    },
    updates: {
      description: 'Dated update notes about True Convo, newest first.',
      inputSchema: NO_ARGS,
      run: () => ({ updates: [...content.updates].sort((a, b) => b.date.localeCompare(a.date)) }),
    },
  };
}

// Reads the body, refusing anything over maxBytes without buffering it all.
async function readLimited(request, maxBytes) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });

function validArgs(tool, args) {
  if (args === undefined) return {};
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const allowed = tool.inputSchema.properties;
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(allowed, key)) return null;
    if (typeof value !== 'string' || value.length > MAX_QUERY_LENGTH) return null;
  }
  return args;
}

export async function handleMcp(request, { content, json, error, maxBytes }) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return error(415, 'Content-Type must be application/json.');

  let text;
  try {
    text = await readLimited(request, maxBytes);
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error.'));
  }
  if (text === null) return error(413, `Request body is larger than ${maxBytes} bytes.`);

  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return json(400, rpcError(null, -32700, 'Parse error.'));
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return json(400, rpcError(null, -32600, 'Invalid request.'));
  }

  const isNotification = !('id' in message);
  if (isNotification) {
    // initialized, cancelled and the like: accepted, nothing to answer.
    return json(202, null);
  }
  const { id } = message;
  if (id === null || (typeof id !== 'string' && typeof id !== 'number')) {
    return json(400, rpcError(null, -32600, 'Invalid request.'));
  }
  const params = message.params ?? {};

  const toolset = tools(content);
  switch (message.method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0];
      return json(200, rpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Read-only facts about True Convo, a personal AI app for the Mac. Nothing here is about any user.',
      }));
    }
    case 'ping':
      return json(200, rpcResult(id, {}));
    case 'tools/list':
      return json(200, rpcResult(id, {
        tools: Object.entries(toolset).map(([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false },
        })),
      }));
    case 'tools/call': {
      const name = params.name;
      const tool = typeof name === 'string' && Object.hasOwn(toolset, name) ? toolset[name] : null;
      if (!tool) return json(200, rpcError(id, -32602, 'Unknown tool.'));
      const args = validArgs(tool, params.arguments);
      if (!args) return json(200, rpcError(id, -32602, 'Invalid arguments.'));
      const data = tool.run(args);
      return json(200, rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
        isError: false,
      }));
    }
    default:
      return json(200, rpcError(id, -32601, 'Method not found.'));
  }
}
