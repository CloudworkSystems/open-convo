// Keeps one issue, "Needs the owner", listing open pull requests that touch
// owner-protected paths and don't yet have the owner's approval on their
// latest commit. The owner pins the issue once.

import { client, repoFromEnv } from './github.mjs';
import { parseCodeowners, protectedFiles } from './codeowners.mjs';

const TITLE = 'Needs the owner';
const MARKER = '<!-- owner-queue -->';
const gh = client();
const { owner, repo } = repoFromEnv();
const base = `/repos/${owner}/${repo}`;

const repoInfo = await gh.get(base);
const ownerLogin = repoInfo.owner.login;
const codeowners = await gh.get(`${base}/contents/.github/CODEOWNERS?ref=${repoInfo.default_branch}`);
const rules = parseCodeowners(Buffer.from(codeowners.content, 'base64').toString('utf8'));

const rows = [];
for (const pr of await gh.all(`${base}/pulls?state=open`)) {
  if (pr.draft) continue;
  const files = (await gh.all(`${base}/pulls/${pr.number}/files`)).flatMap((f) => [f.filename, f.previous_filename].filter(Boolean));
  const hits = protectedFiles(rules, files);
  if (hits.length === 0) continue;
  const reviews = await gh.all(`${base}/pulls/${pr.number}/reviews`);
  const approved = reviews.some((r) => r.user?.login === ownerLogin && r.state === 'APPROVED' && r.commit_id === pr.head.sha);
  if (approved) continue;
  const status = await gh.get(`${base}/commits/${pr.head.sha}/status`);
  const codex = status.statuses.find((s) => s.context === 'codex-approved')?.state === 'success' ? '✅' : '⏳';
  const note = pr.user.login === ownerLogin ? ' (opened under your login, so GitHub won\'t let you approve it)' : '';
  const shown = hits.slice(0, 3).map((f) => `\`${f}\``).join(', ') + (hits.length > 3 ? ` and ${hits.length - 3} more` : '');
  rows.push(`| [#${pr.number}](${pr.html_url}) ${pr.title.replace(/\|/g, '/')}${note} | ${codex} | ${shown} |`);
}

const body = [
  MARKER,
  'Pull requests waiting for your approval because they touch protected paths. Updated automatically.',
  '',
  rows.length
    ? ['| Pull request | Codex clean | Protected files |', '| --- | --- | --- |', ...rows].join('\n')
    : 'Nothing is waiting on you.',
].join('\n');

const issues = await gh.all(`${base}/issues?state=open&creator=${encodeURIComponent('github-actions[bot]')}`);
const existing = issues.find((i) => !i.pull_request && i.title === TITLE && (i.body ?? '').includes(MARKER));
if (!existing) {
  const created = await gh.post(`${base}/issues`, { title: TITLE, body });
  console.log(`Created #${created.number}`);
} else if (existing.body !== body) {
  await gh.patch(`${base}/issues/${existing.number}`, { body });
  console.log(`Updated #${existing.number}: ${rows.length} waiting`);
}
