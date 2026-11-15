// The token helper (docs/plans/push-gate.md, "The Token Helper").
//
// It signs a short request as the Cloudwork Agents app, checks that the
// installation reaches this one repo and nothing else, asks GitHub for an
// installation token limited to this repo and to the permissions one action
// needs, hands it to one piece of work, and revokes it when that work ends.
// The key and the token are never logged, written to a file or put in a
// command's arguments.

import { createSign } from 'node:crypto';
import { API_BASE, APP_ID, APP_NAME, FULL_NAME, HOUR, INSTALLATION_ID, LIMITS, REPO } from './constants.mjs';
import { GitHubRefused, KeyUnavailable, NoConnection, RateLimited, SignInFailed, WrongReach, scrub } from './errors.mjs';

const b64url = (value) => Buffer.from(value).toString('base64url');

/** The app's signed request: names App ID 5665711 and expires in 8 minutes. */
export function signAppRequest(pem, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iat: now - 60, exp: now + 480, iss: APP_ID }));
  const signature = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(pem).toString('base64url');
  return `${head}.${claims}.${signature}`;
}

/** The one line that says a token was handed over (docs/agent-process.md, "Accounts And Provenance"). */
export function handOverLine(expiresAt) {
  return `${APP_NAME} token: App ID ${APP_ID}, installation ${INSTALLATION_ID}, ${FULL_NAME}, expires ${expiresAt}`;
}

function plainReason(status, data, auth) {
  const parts = [];
  if (data && typeof data.message === 'string') parts.push(data.message);
  if (data && Array.isArray(data.errors)) {
    for (const item of data.errors) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.message === 'string') parts.push(item.message);
    }
  }
  const said = scrub(parts.join(' '), [auth]).slice(0, 240);
  if (said) return `GitHub answered "${said}"`;
  if (status === 403) return "GitHub says the agents' app isn't allowed to do this";
  if (status === 404) return "GitHub couldn't find what the request names";
  if (status === 422) return "GitHub couldn't accept the request as written";
  return 'GitHub turned the request down without a reason';
}

function rateLimitWait(response, nowMs) {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset * 1000 > nowMs) return reset * 1000 - nowMs;
  }
  return 0;
}

/**
 * One GitHub API call. Returns `{ status, data }` on success and throws one
 * of the errors in errors.mjs otherwise, so every caller treats a 429, a 401
 * and the other refusals the way the plan says.
 */
export async function callGitHub({ apiBase = API_BASE, fetchImpl = fetch, now = Date.now }, method, path, auth, body) {
  let response;
  try {
    response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${auth}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'push-gate',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (error) {
    if (['TypeError', 'AbortError', 'TimeoutError'].includes(error?.name)) throw new NoConnection("GitHub can't be reached");
    throw error;
  }
  let data = null;
  try {
    const text = await response.text();
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (response.ok) return { status: response.status, data };
  const status = response.status;
  const message = typeof data?.message === 'string' ? data.message.toLowerCase() : '';
  if (status === 429 || (status === 403 && (message.includes('rate limit') || response.headers.get('retry-after') || response.headers.get('x-ratelimit-remaining') === '0'))) {
    throw new RateLimited('GitHub asked for a pause', Math.max(rateLimitWait(response, now()), LIMITS.rateLimitPauseMs));
  }
  if (status === 401) throw new SignInFailed("GitHub didn't accept the app's sign-in");
  if (status >= 500) throw new NoConnection("GitHub can't be reached");
  throw new GitHubRefused(plainReason(status, data, auth), status);
}

/**
 * One run's dealings with GitHub as the app. `seam.readAppKey()` returns the
 * app's private key (PEM); on the Mac it reads it through the 1Password
 * service account (scripts/push-gate/mac-seam.mjs), and tests pass a fake.
 */
export function createSession({ seam, apiBase = API_BASE, fetchImpl = fetch, now = Date.now, say = () => {} }) {
  const net = { apiBase, fetchImpl, now };
  let signed = null;
  let signedUntil = 0;
  let reachChecked = false;

  async function appRequest() {
    if (signed && now() < signedUntil) return signed;
    let pem;
    try {
      pem = await seam.readAppKey();
    } catch {
      throw new KeyUnavailable("the push gate can't open its key");
    }
    try {
      signed = signAppRequest(pem, now());
    } catch {
      throw new KeyUnavailable("the push gate can't open its key");
    }
    signedUntil = now() + 5 * 60 * 1000;
    return signed;
  }

  const revoke = (token) => callGitHub(net, 'DELETE', '/installation/token', token);

  /** Checks, once a run, that the installation reaches exactly this repo. */
  async function checkReach() {
    if (reachChecked) return;
    const request = await appRequest();
    // A token with no repository named shows everything the installation reaches.
    const { data } = await callGitHub(net, 'POST', `/app/installations/${INSTALLATION_ID}/access_tokens`, request, { permissions: { metadata: 'read' } });
    let reach;
    try {
      reach = (await callGitHub(net, 'GET', '/installation/repositories?per_page=2', data.token)).data;
    } finally {
      await revoke(data.token).catch(() => {});
    }
    const names = (reach?.repositories ?? []).map((repo) => repo.full_name);
    if (reach?.total_count !== 1 || names.length !== 1 || names[0] !== FULL_NAME) {
      throw new WrongReach(`the agents' app installation reaches something other than ${FULL_NAME} alone`);
    }
    reachChecked = true;
  }

  /**
   * Runs `work(token)` with a token limited to this repo and to
   * `permissions`, then revokes it. Returns what `work` returns.
   */
  async function withToken(permissions, work) {
    await checkReach();
    const request = await appRequest();
    const { data } = await callGitHub(net, 'POST', `/app/installations/${INSTALLATION_ID}/access_tokens`, request, { repositories: [REPO], permissions });
    const token = data?.token;
    if (typeof token !== 'string' || !token) throw new SignInFailed('GitHub gave no token');
    try {
      const limited = (data.repositories ?? []).map((repo) => repo.full_name);
      if (data.repositories && (limited.length !== 1 || limited[0] !== FULL_NAME)) {
        throw new WrongReach(`GitHub's token reaches something other than ${FULL_NAME} alone`);
      }
      say(handOverLine(data.expires_at ?? new Date(now() + HOUR).toISOString()));
      return await work(token);
    } finally {
      await revoke(token).catch(() => {});
    }
  }

  return { withToken, call: (method, path, token, body) => callGitHub(net, method, path, token, body) };
}
