// A fake GitHub on 127.0.0.1 for the push gate's tests: the handful of API
// calls the gate makes, and git over HTTP (through git's own http-backend)
// that only lets a live, unrevoked token with contents access push.
// Everything in it is invented.

import { execFileSync, spawn } from 'node:child_process';
import { createVerify, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';

const REPO = '/repos/CloudworkSystems/open-convo';
const BOT = 'cloudwork-agents[bot]';

export async function startFakeGitHub({ publicKey, gitRoot, now = Date.now }) {
  const backend = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git-http-backend');
  const fake = {
    requests: [], // every API call: "METHOD /path"
    writes: [], // every API call that changes something, and every push
    appRequests: [], // the claims of each signed app request
    tokens: new Map(), // token -> { permissions, scoped, revoked }
    reach: ['CloudworkSystems/open-convo'],
    pulls: [],
    comments: [], // issue and pull request comments: { id, issue, body, user }
    reviewComments: [], // { id, pull, body, in_reply_to_id, user }
    failures: [], // { match(method, path), status, headers, body, times }
    pushes: 0,
    pushPasswords: [],
    nextNumber: 400,
    nextId: 9000,
    /** Makes the next matching calls fail. */
    failNext(match, status, { headers = {}, body = { message: 'invented failure' }, times = 1 } = {}) {
      fake.failures.push({ match, status, headers, body, times });
    },
    liveTokens: () => [...fake.tokens].filter(([, t]) => !t.revoked).map(([token]) => token),
  };

  const send = (res, status, data, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  const url = (pull) => `https://github.com/CloudworkSystems/open-convo/pull/${pull}`;

  function serveGit(req, res, target) {
    const pathInfo = target.pathname.slice('/git'.length);
    const pushing = target.searchParams.get('service') === 'git-receive-pack' || pathInfo.endsWith('/git-receive-pack');
    if (pushing) {
      const header = req.headers.authorization ?? '';
      const password = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':') : null;
      const token = password ? fake.tokens.get(password) : null;
      if (!token || token.revoked || token.permissions.contents !== 'write') {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fake"' });
        return res.end();
      }
      if (req.method === 'POST') {
        const failure = fake.failures.find((f) => f.times > 0 && f.match('PUSH', pathInfo));
        if (failure) {
          failure.times -= 1;
          res.writeHead(failure.status);
          return res.end();
        }
        fake.pushes += 1;
        fake.pushPasswords.push(password);
        fake.writes.push('PUSH');
      }
    }
    const env = {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_PROJECT_ROOT: gitRoot,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method,
      PATH_INFO: pathInfo,
      QUERY_STRING: target.search.slice(1),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      REMOTE_USER: 'agents',
      REMOTE_ADDR: '127.0.0.1',
    };
    if (req.headers['content-length']) env.CONTENT_LENGTH = req.headers['content-length'];
    if (req.headers['content-encoding']) env.HTTP_CONTENT_ENCODING = req.headers['content-encoding'];
    if (req.headers['git-protocol']) env.GIT_PROTOCOL = req.headers['git-protocol'];
    const child = spawn(backend, [], { env });
    child.stdin.on('error', () => {});
    req.pipe(child.stdin);
    let pending = Buffer.alloc(0);
    let started = false;
    child.stdout.on('data', (chunk) => {
      if (started) return res.write(chunk);
      pending = Buffer.concat([pending, chunk]);
      const end = pending.indexOf('\r\n\r\n');
      if (end === -1) return undefined;
      let status = 200;
      const headers = {};
      for (const line of pending.subarray(0, end).toString('utf8').split('\r\n')) {
        const colon = line.indexOf(':');
        const name = line.slice(0, colon).toLowerCase();
        const value = line.slice(colon + 1).trim();
        if (name === 'status') status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      res.writeHead(status, headers);
      res.write(pending.subarray(end + 4));
      started = true;
      return undefined;
    });
    child.on('close', () => res.end());
    return undefined;
  }

  const server = createServer((req, res) => {
    const target = new URL(req.url, 'http://127.0.0.1');
    if (target.pathname.startsWith('/git/')) return serveGit(req, res, target);

    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const { method } = req;
      const path = target.pathname;
      const body = raw ? JSON.parse(raw) : {};
      fake.requests.push(`${method} ${path}`);

      const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      let token = null;
      if (path.startsWith('/app/')) {
        const [head, claims, signature] = bearer.split('.');
        const ok = signature && createVerify('RSA-SHA256').update(`${head}.${claims}`).verify(publicKey, signature, 'base64url');
        const decoded = ok ? JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) : null;
        if (!decoded || decoded.exp * 1000 <= now() || decoded.exp - decoded.iat > 600) return send(res, 401, { message: 'Bad credentials' });
        fake.appRequests.push(decoded);
      } else {
        token = fake.tokens.get(bearer);
        if (!token || token.revoked) return send(res, 401, { message: 'Bad credentials' });
      }

      const failure = fake.failures.find((f) => f.times > 0 && f.match(method, path));
      if (failure) {
        failure.times -= 1;
        return send(res, failure.status, failure.body, failure.headers);
      }
      const changes = method !== 'GET' && !path.startsWith('/app/') && path !== '/installation/token';
      if (changes) fake.writes.push(`${method} ${path}`);
      const needs = (name) => token.permissions[name] === 'write';
      const denied = () => send(res, 403, { message: 'Resource not accessible by integration' });
      let m;

      if (method === 'POST' && path === '/app/installations/179798275/access_tokens') {
        const made = `fake-${randomBytes(18).toString('hex')}`;
        fake.tokens.set(made, { permissions: body.permissions ?? {}, scoped: Boolean(body.repositories), revoked: false });
        return send(res, 201, {
          token: made,
          expires_at: new Date(now() + 3600000).toISOString(),
          permissions: body.permissions ?? {},
          ...(body.repositories ? { repositories: body.repositories.map((name) => ({ name, full_name: `CloudworkSystems/${name}` })) } : {}),
        });
      }
      if (method === 'GET' && path === '/installation/repositories') {
        const names = token.scoped ? ['CloudworkSystems/open-convo'] : fake.reach;
        return send(res, 200, { total_count: names.length, repositories: names.slice(0, 2).map((full_name) => ({ full_name })) });
      }
      if (method === 'DELETE' && path === '/installation/token') {
        token.revoked = true;
        return send(res, 204);
      }
      if (method === 'GET' && path === `${REPO}/pulls`) {
        const branch = (target.searchParams.get('head') ?? '').split(':')[1];
        return send(res, 200, fake.pulls.filter((p) => p.state === 'open' && (!branch || p.head.ref === branch)));
      }
      if (method === 'POST' && path === `${REPO}/pulls`) {
        if (!needs('pull_requests')) return denied();
        const number = (fake.nextNumber += 1);
        const pull = { number, state: 'open', title: body.title, body: body.body, draft: body.draft, head: { ref: body.head }, base: { ref: body.base }, labels: [], user: { login: BOT }, html_url: url(number), auto_merge: null };
        fake.pulls.push(pull);
        return send(res, 201, pull);
      }
      if ((m = new RegExp(`^${REPO}/pulls/(\\d+)$`).exec(path))) {
        const pull = fake.pulls.find((p) => p.number === Number(m[1]));
        if (!pull) return send(res, 404, { message: 'Not Found' });
        if (method === 'PATCH') {
          if (!needs('pull_requests')) return denied();
          Object.assign(pull, body);
        }
        return send(res, 200, pull);
      }
      if (method === 'POST' && (m = new RegExp(`^${REPO}/issues/(\\d+)/labels$`).exec(path))) {
        const pull = fake.pulls.find((p) => p.number === Number(m[1]));
        if (!pull) return send(res, 404, { message: 'Not Found' });
        if (!needs('pull_requests') && !needs('issues')) return denied();
        for (const name of body.labels) pull.labels.push({ name });
        return send(res, 200, pull.labels);
      }
      if ((m = new RegExp(`^${REPO}/issues/(\\d+)/comments$`).exec(path))) {
        const issue = Number(m[1]);
        if (method === 'GET') return send(res, 200, fake.comments.filter((c) => c.issue === issue));
        const isPull = fake.pulls.some((p) => p.number === issue);
        if (!(isPull ? needs('pull_requests') || needs('issues') : needs('issues'))) return denied();
        const comment = { id: (fake.nextId += 1), issue, body: body.body, user: { login: BOT }, html_url: `https://github.com/CloudworkSystems/open-convo/issues/${issue}#issuecomment-${fake.nextId}` };
        fake.comments.push(comment);
        return send(res, 201, comment);
      }
      if (method === 'GET' && (m = new RegExp(`^${REPO}/pulls/(\\d+)/comments$`).exec(path))) {
        return send(res, 200, fake.reviewComments.filter((c) => c.pull === Number(m[1])));
      }
      if (method === 'POST' && (m = new RegExp(`^${REPO}/pulls/(\\d+)/comments/(\\d+)/replies$`).exec(path))) {
        if (!needs('pull_requests')) return denied();
        const parent = fake.reviewComments.find((c) => c.pull === Number(m[1]) && c.id === Number(m[2]));
        if (!parent) return send(res, 404, { message: 'Not Found' });
        const reply = { id: (fake.nextId += 1), pull: parent.pull, body: body.body, in_reply_to_id: parent.id, user: { login: BOT }, html_url: `${url(parent.pull)}#discussion_r${fake.nextId}` };
        fake.reviewComments.push(reply);
        return send(res, 201, reply);
      }
      return send(res, 404, { message: 'Not Found' });
    });
    return undefined;
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = new URL('http://127.0.0.1');
  origin.port = String(port);
  fake.apiBase = origin.origin;
  fake.gitUrl = new URL('/git/open-convo.git', origin).href;
  fake.close = () => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  });
  return fake;
}
