import { createHandler } from './handler.js';
import { SqlStore } from './storage.js';
import { errorResponse } from './errors.js';

export class AgentWire {
  constructor(ctx, env, options = {}) {
    this.handle = createHandler(options.store ?? new SqlStore(ctx.storage), env, options);
  }
  fetch(request) { return this.handle(request); }
}

export default {
  async fetch(request, env) {
    try {
      // Every caller reaches the same single writer, never an object chosen
      // by a caller-controlled name, URL, identity or header.
      const id = env.MAILBOX.idFromName('mailbox');
      return await env.MAILBOX.get(id).fetch(request);
    } catch (error) { return errorResponse(error); }
  },
};
