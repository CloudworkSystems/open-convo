export class WireError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const UNKNOWN = 'This agent is switched off or unknown. Ask the mailbox owner.';
export const RESTORING = 'This mailbox is being restored. Try again soon.';
export const FULL = 'This mailbox is full until its owner clears some notes.';
export const EMPTY = 'No notes yet.';
export const NO_AGENTS = 'No agents can write to this mailbox yet. Add one to let it in.';
export const fail = (message, status) => { throw new WireError(message, status); };

export function json(status, data, extra = {}) {
  return new Response(data === null ? null : JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Agent-Wire': '1',
      ...extra,
    },
  });
}

export function failure(error) {
  return {
    message: error instanceof WireError ? error.message : 'Something went wrong. Try again with this reference code.',
    reference: 'AW-' + crypto.randomUUID().slice(0, 8),
  };
}

export function errorResponse(error) {
  return json(error instanceof WireError ? error.status : 500, { error: failure(error) });
}
