// The ways a step can fail, each with a plain reason. No error carries a
// token or a key: callers pass text through scrub() before it is shown.

/** A check from the plan failed. The request is refused and never retried. */
export class CheckFailed extends Error {}

/** GitHub can't be reached. The request waits and is tried again next run. */
export class NoConnection extends Error {}

/** GitHub answered 429 or "secondary rate limit". Every write stops for `waitMs`. */
export class RateLimited extends Error {
  constructor(message, waitMs) {
    super(message);
    this.waitMs = waitMs;
  }
}

/** The hourly cap on writes is used up. The request waits until `until`. */
export class CapReached extends Error {
  constructor(until) {
    super('the hourly cap on writes is used up');
    this.until = until;
  }
}

/** GitHub answered 401. Every write stops until the owner restarts the gate. */
export class SignInFailed extends Error {}

/** GitHub refused this one request (403, 404, 422). `reason` is GitHub's, in plain words. */
export class GitHubRefused extends Error {
  /** `why`, when given, is the whole clause for the refusal sentence: what is wrong and what to change. */
  constructor(reason, status, why) {
    super(reason);
    this.status = status;
    this.why = why;
  }
}

/** Git failed on the gate's own Mac (a full disk, a folder it can't write). Nothing was refused by GitHub: requests wait. */
export class LocalFailure extends Error {}

/** 1Password or the app's key can't be opened. Every request waits. */
export class KeyUnavailable extends Error {}

/** The installation reaches something other than this one repo. */
export class WrongReach extends Error {}

const LOOKALIKES = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'a GitHub token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, 'a private key'],
  [/\bops_[A-Za-z0-9+/=_-]{20,}/g, 'a 1Password sign-in'],
];

/** What `text` holds that looks like a secret, or null. */
export function secretLookalike(text) {
  for (const [pattern, name] of LOOKALIKES) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return name;
  }
  return null;
}

/** `text` on one line with anything secret-shaped, and the given secrets, removed. */
export function scrub(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) if (secret) out = out.split(secret).join('[hidden]');
  for (const [pattern] of LOOKALIKES) out = out.replace(pattern, '[hidden]');
  return out.replace(/\s+/g, ' ').trim();
}
