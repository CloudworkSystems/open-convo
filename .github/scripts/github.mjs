// Minimal GitHub REST client for the merge-gate workflows.
// Uses the workflow's own GITHUB_TOKEN; never logs it.

const API = process.env.GITHUB_API_URL || 'https://api.github.com';

export function repoFromEnv() {
  const full = process.env.GITHUB_REPOSITORY;
  if (!full || !full.includes('/')) throw new Error('GITHUB_REPOSITORY is not set');
  const [owner, repo] = full.split('/');
  return { owner, repo };
}

export function client(token = process.env.GITHUB_TOKEN) {
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'open-convo-merge-gate',
  };

  async function request(method, path, body) {
    const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
      method,
      headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${method} ${path} failed: ${response.status} ${text.slice(0, 300)}`);
    }
    return { data: response.status === 204 ? null : await response.json(), link: response.headers.get('link') };
  }

  async function all(path) {
    const items = [];
    let next = `${path}${path.includes('?') ? '&' : '?'}per_page=100`;
    while (next) {
      const { data, link } = await request('GET', next);
      items.push(...data);
      const match = link && link.match(/<([^>]+)>;\s*rel="next"/);
      next = match ? match[1] : null;
    }
    return items;
  }

  return {
    get: (path) => request('GET', path).then((r) => r.data),
    post: (path, body) => request('POST', path, body).then((r) => r.data),
    patch: (path, body) => request('PATCH', path, body).then((r) => r.data),
    all,
  };
}
