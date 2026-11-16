import { fail, WireError } from './errors.js';

function decode(part) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) fail('Sign in through Cloudflare Access.', 401);
  return Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
}

export function settings(env) {
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(env.ACCESS_TEAM ?? '') ||
      typeof env.ACCESS_AUD !== 'string' || !env.ACCESS_AUD ||
      typeof env.OWNER_EMAIL !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(env.OWNER_EMAIL)) {
    fail('This mailbox needs its sign-in settings. Ask the mailbox owner.', 503);
  }
  const defaults = { SUBJECT_CHARS: 120, BODY_BYTES: 8192, REQUEST_BYTES: 16384, NOTE_CAP: 1000, NOTES_PER_HOUR: 60, CALLS_PER_MINUTE: 10 };
  const limits = {};
  for (const [key, value] of Object.entries(defaults)) {
    limits[key] = env[key] === undefined ? value : Number(env[key]);
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) fail('This mailbox needs valid limit settings. Ask the mailbox owner.', 503);
  }
  return { ...limits, team: env.ACCESS_TEAM, audience: env.ACCESS_AUD, owner: 'user:' + env.OWNER_EMAIL };
}

// The only external request in the service. Never follow a redirect to a
// different host. Injecting keys is an in-process test seam, never an env var.
export async function accessKeys(team) {
  const response = await fetch(team + '/cdn-cgi/access/certs', {
    redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) fail('Sign-in is unavailable. Try again soon.', 503);
  return response.json();
}

export async function authenticate(request, config, { keySet, now = Date.now } = {}) {
  try {
    const token = request.headers.get('Cf-Access-Jwt-Assertion');
    if (!token || token.length > 16384) fail('Sign in through Cloudflare Access.', 401);
    const parts = token.split('.');
    if (parts.length !== 3) fail('Sign in through Cloudflare Access.', 401);
    const header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[0])));
    const claims = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decode(parts[1])));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined ||
        claims.iss !== config.team || claims.type !== 'app' ||
        !(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(config.audience) ||
        !Number.isFinite(claims.exp) || claims.exp <= now() / 1000 ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now() / 1000)) ||
        (claims.iat !== undefined && (!Number.isFinite(claims.iat) || claims.iat > now() / 1000))) {
      fail('Sign in through Cloudflare Access.', 401);
    }
    let keys;
    try { keys = keySet ?? await accessKeys(config.team); }
    catch { fail('Sign-in is unavailable. Try again soon.', 503); }
    const jwk = keys.keys?.find((k) => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    if (!jwk || jwk.d) fail('Sign in through Cloudflare Access.', 401);
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decode(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]))) {
      fail('Sign in through Cloudflare Access.', 401);
    }
    // Service identities can never become the owner, even if an email claim
    // is also present. Only a human Access identity may match OWNER_EMAIL.
    if (typeof claims.common_name === 'string' && claims.common_name) return 'service:' + claims.common_name;
    if (typeof claims.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(claims.email)) return 'user:' + claims.email;
    fail('Sign in through Cloudflare Access.', 401);
  } catch (error) {
    if (error instanceof WireError) throw error;
    fail('Sign in through Cloudflare Access.', 401);
  }
}
