export const TEXT_LIMIT = 100_000;
export const URL_LIMIT = 2_000;
export const ENTRY_LIMIT = 100_000;
export const LEDGER_BYTES = 32 * 1024 * 1024;
export const SIDE_FILE_BYTES = 1024 * 1024;
export const COPY_LIMIT = 1_000;
export const ANCHOR_LIMIT = 100;
export const ZERO_HASH = '0'.repeat(64);

export const AMENDABLE = Object.freeze(['platform', 'postUrl', 'postedAt', 'notes']);
export const KINDS = Object.freeze(['stolen-video', 'impersonation', 'fake-fundraiser']);
export const LINK_KINDS = Object.freeze(['donate', 'account', 'other']);
export const ANCHOR_KINDS = Object.freeze(['email', 'post', 'page']);

export class ProofError extends Error {
  constructor(message, { seq = null, problems = null } = {}) {
    super(message);
    this.name = 'ProofError';
    this.seq = seq;
    this.problems = problems;
  }
}

export function fail(message, extra) {
  throw new ProofError(message, extra);
}
