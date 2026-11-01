// Cloudflare Workers entry point. The only host-specific file: it hands each
// request to the portable handler.
import { handle } from './handler.js';

export default {
  fetch: (request) => handle(request),
};
