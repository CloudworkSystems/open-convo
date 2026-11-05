import { LINK_KINDS, TEXT_LIMIT, URL_LIMIT, fail } from './errors.mjs';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function requireHttps(url, label) {
  if (typeof url !== 'string' || url.length === 0 || url.length > URL_LIMIT) {
    fail(`Only https links can go on the page. ${label} was refused.`);
  }
  if (/[\s"'<>`]/.test(url)) fail(`Only https links can go on the page. ${label} was refused.`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`Only https links can go on the page. ${label} was refused.`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname === '') {
    fail(`Only https links can go on the page. ${url} was refused.`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    fail(`Only https links can go on the page. ${url} was refused.`);
  }
  return url;
}

function linkBlock(link) {
  const safeUrl = escapeHtml(link.url);
  const safeLabel = escapeHtml(link.label);
  return [
    '<li>',
    `<p>${safeLabel}</p>`,
    `<p><a href="${safeUrl}">${safeLabel}</a></p>`,
    `<p class="address">${safeUrl}</p>`,
    '</li>',
  ].join('\n');
}

export function realLinksPage({ creatorName, intro, links, updatedAt, ledgerHash } = {}) {
  if (typeof creatorName !== 'string' || creatorName.length === 0 || creatorName.length > TEXT_LIMIT) {
    fail('The page needs the creator\'s name.');
  }
  if (typeof updatedAt !== 'string' || updatedAt.length === 0 || updatedAt.length > TEXT_LIMIT) {
    fail('The page needs updatedAt, the date you want fans to see.');
  }
  if (intro !== undefined && intro !== null && intro !== '') {
    if (typeof intro !== 'string' || intro.length > TEXT_LIMIT) fail('The intro must be text.');
  }
  if (ledgerHash !== undefined && ledgerHash !== null && ledgerHash !== '') {
    if (typeof ledgerHash !== 'string' || !/^[0-9a-f]{64}$/.test(ledgerHash)) {
      fail('The proof code must be 64 lowercase hex characters.');
    }
  }
  if (!Array.isArray(links)) fail('The page needs a list of links.');
  const clean = links.map((link, index) => {
    if (!isPlainObject(link)) fail(`Link ${index + 1} needs a label, an https address and a kind.`);
    if (!LINK_KINDS.includes(link.kind)) fail('A link kind must be donate, account or other.');
    if (typeof link.label !== 'string' || link.label.length === 0 || link.label.length > TEXT_LIMIT) {
      fail(`Link ${index + 1} needs a label.`);
    }
    return { label: link.label, url: requireHttps(link.url, link.label || `link ${index + 1}`), kind: link.kind };
  });

  const name = escapeHtml(creatorName);
  const donate = clean.filter((link) => link.kind === 'donate');
  const accounts = clean.filter((link) => link.kind === 'account');
  const other = clean.filter((link) => link.kind === 'other');
  const donateHtml = donate.length === 0
    ? '<p>No donation link is listed.</p>'
    : `<ul>\n${donate.map(linkBlock).join('\n')}\n</ul>`;
  const section = (title, items) => {
    if (items.length === 0) return '';
    return `<h2>${title}</h2>\n<ul>\n${items.map(linkBlock).join('\n')}\n</ul>`;
  };

  const parts = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>Real links for ${name}</title>`,
    '<style>',
    'body { font-family: Georgia, "Times New Roman", serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; color: #1a1a1a; background: #fff; }',
    'h1 { font-size: 1.6rem; }',
    '.warning { font-size: 1.15rem; }',
    '.address { font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }',
    '.proof { font-size: 0.85rem; }',
    'a { color: #083; }',
    '</style>',
    '</head>',
    '<body>',
    `<h1>Real links for ${name}</h1>`,
    `<p class="warning">These are the only real donation links for ${name}. Anything else asking for money in my name is not me.</p>`,
    `<p>Updated ${escapeHtml(updatedAt)}</p>`,
  ];
  if (typeof ledgerHash === 'string' && ledgerHash !== '') {
    parts.push(`<p class="proof">Proof code: ${escapeHtml(ledgerHash)}</p>`);
  }
  if (typeof intro === 'string' && intro !== '') parts.push(`<p>${escapeHtml(intro)}</p>`);
  parts.push('<h2>Donation links</h2>', donateHtml);
  const accountsHtml = section('Accounts', accounts);
  const otherHtml = section('Other links', other);
  if (accountsHtml) parts.push(accountsHtml);
  if (otherHtml) parts.push(otherHtml);
  parts.push('</body>', '</html>', '');
  return parts.join('\n');
}
