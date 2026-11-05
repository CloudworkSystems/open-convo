import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSource, recallSource } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';
import { buildAtlas } from '../../atlas-index/src/index.mjs';
const notice = 'Images in this card were not imported. Their links may stop working.';
const read = text => checkSource(recallSource(), [{ path: 'one.md', text }]).items[0];

for (const bom of ['', '\uFEFF']) test(`CRLF P1: ${bom ? 'BOM plus CRLF' : 'full CRLF export'} parses through import and Atlas without changing body`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-crlf-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  const body = '# Body heading\r\n\r\n```md\r\n![code](https://example.invalid/a)\r\n```\r\n~~~\r\n![code](https://example.invalid/a)\r\n~~~\r\n';
  const text = bom + '---\r\ntitle: Header title\r\nurl: https://example.invalid/page\r\ntags:\r\n  - "one, two"\r\n  - three\r\n---\r\n' + body;
  const item = read(text); assert.equal(item.title, 'Header title'); assert.equal(item.url, 'https://example.invalid/page'); assert.deepEqual(item.tags, ['one, two', 'three']); assert.equal(item.body, body);
  fs.writeFileSync(path.join(input, 'one.md'), text); fs.writeFileSync(path.join(input, 'two.md'), '# Other\r\n');
  const report = runImport(['--in', input, '--atlas', atlas, '--write', '--imported-at', '2026-11-05T12:00:00.000Z']);
  const notes = report.paths.map(({ path: file }) => ({ path: file, text: fs.readFileSync(path.join(atlas, file), 'utf8') }));
  assert.ok(notes.find(n => n.path.endsWith('/one.md')).text.endsWith(body));
  const index = buildAtlas(notes, { indexThreshold: 1 }).writes.find(n => n.path === 'sources/recall/INDEX.md').text; assert.match(index, /Header title/);
});

test('Line-ending sweep: LF CRLF mixed headers and BOM fallback headings keep body bytes', () => {
  for (const open of ['\n', '\r\n']) for (const close of ['\n', '\r\n', '']) for (const bom of ['', '\uFEFF']) {
    const body = close ? 'Body\r\nkept\n' : '';
    const text = bom + '---' + open + 'title: Invented\r\ntags: [one, "two, three"]\n---' + close + body;
    const item = read(text); assert.equal(item.title, 'Invented'); assert.equal(item.body, body); assert.deepEqual(item.tags, ['one', 'two, three']);
  }
  for (const eol of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
    const body = bom + '# Invented heading' + eol; assert.equal(read(body).title, 'Invented heading'); assert.equal(read(body).body, body);
    const fenced = bom + '```md' + eol + '# Fake' + eol + '![x](https://example.invalid/a)' + eol + '```' + eol + '# Real' + eol;
    assert.equal(read(fenced).title, 'Real'); assert.equal(read(fenced).body, fenced);
  }
});

const cases = [
  ['double title', '![x](https://example.invalid/a.png "caption")', true],
  ['single title', "![x](https://example.invalid/a.png 'caption')", true],
  ['parenthesized title', '![x](https://example.invalid/a.png (caption))', true],
  ['LF title separator', '![x](https://example.invalid/a.png\n(caption))', true],
  ['CRLF tab separator', '![x](https://example.invalid/a.png\r\n\t(caption))', true],
  ['escaped parentheses title', String.raw`![x](https://example.invalid/a.png (a\(b\)c))`, true],
  ['escaped quote title', String.raw`![x](https://example.invalid/a.png "a\"b")`, true],
  ['multiline double title', '![x](https://example.invalid/a.png "line one\r\nline two")', true],
  ['multiline parenthesized title', '![x](https://example.invalid/a.png (line one\nline two))', true],
  ['whitespace before destination and closing', '![x](\r\n <https://example.invalid/a.png>\r\n)', true],
  ['code brackets in description', '![`bracket ]` image](https://example.invalid/a.png (caption))', true],
  ['balanced bare destination', '![x](https://example.invalid/a(b(c)).png (caption))', true],
  ['escaped bare parentheses', String.raw`![x](https://example.invalid/a\(b\).png (caption))`, true],
  ['angle destination and title', '![x](<https://example.invalid/a b.png> (caption))', true],
  ['full reference', '![x][img]\n\n[img]: https://example.invalid/a.png (caption)', true],
  ['collapsed reference', '![x][]\n\n[x]: https://example.invalid/a.png', true],
  ['shortcut reference', '![x]\n\n[x]: https://example.invalid/a.png', true],
  ['next-line reference destination', '![x][img]\n\n[img]:\r\n  <https://example.invalid/a.png>\r\n  (caption)', true],
  ['multiline reference label', '![x][my image]\n\n[my\r\n image]: https://example.invalid/a.png', true],
  ['protocol-relative destination', '![x](//example.invalid/a.png)', true],
  ['escaped scheme punctuation', String.raw`![x](https\://example.invalid/a.png)`, true],
  ['entity scheme punctuation', '![x](https&#58;//example.invalid/a.png)', true],
  ['HTML double src', '<img src="https://example.invalid/a.png" alt="x">', false],
  ['HTML single src', "<IMG ALT='x' SRC='https://example.invalid/a.png'/>", false],
  ['HTML unquoted src', '<img\r\n src=https://example.invalid/a.png>', false],
  ['HTML srcset', '<img src="local.png" srcset="https://example.invalid/a.png 2x">', false],
  ['malformed destination', '![x](<https://example.invalid/a.png', false],
  ['unbalanced destination', '![x](https://example.invalid/a(b.png', false],
  ['malformed title', '![x](https://example.invalid/a.png (caption)', false],
  ['blank line in title', '![x](https://example.invalid/a.png "line\n\nline")', false],
  ['invalid nested title parentheses', '![x](https://example.invalid/a.png (a(b)))', false],
  ['uncertain reference destination', '![x][img]\n\n[img]: <https://example.invalid/a.png', false],
  ['uncertain HTML', '<img src="https://example.invalid/a.png', false]
];
for (const [name, body, convert] of cases) test(`Image class table: ${name}`, () => {
  const result = read(body).body;
  assert.ok(result.includes(notice), name);
  const expected = convert ? body.replace('![', '[') : body;
  assert.ok(result.startsWith(expected), result);
  assert.equal(result.split(notice).length, 2);
});

test('Image class sweep: all table forms remain byte-identical inside CRLF code', () => {
  for (const [, body] of cases) for (const fence of ['```', '~~~']) {
    const code = fence + '\r\n' + body + '\r\n' + fence + '\r\n'; assert.equal(read(code).body, code);
  }
  for (const body of ['`![x](https://example.invalid/a (caption))`', '    <img src="https://example.invalid/a">\r\n', '\t![x](https://example.invalid/a (caption))\r\n']) assert.equal(read(body).body, body);
});

const excludedImage = '![hidden](https://example.invalid/hidden.png)';
const exclusions = [
  ['HTML 1 pre', `<pre>\n${excludedImage}\n</pre>\n`],
  ['HTML 1 script', `<script>\n${excludedImage}\n</script>\n`],
  ['HTML 1 style', `<style>\n${excludedImage}\n</style>\n`],
  ['HTML 1 textarea', `<textarea>\n${excludedImage}\n</textarea>\n`],
  ['HTML 2 comment', `<!--\n${excludedImage}\n-->\n`],
  ['HTML 3 processing instruction', `<?invented\n${excludedImage}\n?>\n`],
  ['HTML 4 declaration', `<!INVENTED\n${excludedImage}\n>\n`],
  ['HTML 5 CDATA', `<![CDATA[\n${excludedImage}\n]]>\n`],
  ['HTML 6 block tag', `<div>\n${excludedImage}\n</div>\n\n`],
  ['HTML 7 generic tag', `<invented data-x='value'>\n${excludedImage}\n</invented>\n\n`],
  ['inline raw tag attributes', `Text <invented value='${excludedImage}'> after\n`],
  ['inline comment', `Text <!-- ${excludedImage} --> after\n`],
  ['autolink', `<https://example.invalid/${excludedImage}>\n`],
  ['escaped brackets', String.raw`!\[hidden](https://example.invalid/hidden.png)`],
  ['escaped exclamation', String.raw`\![hidden](https://example.invalid/hidden.png)`],
  ['backtick fence', '```md\n' + excludedImage + '\n```\n'],
  ['tilde fence', '~~~\n' + excludedImage + '\n~~~\n'],
  ['indented code', '    ' + excludedImage + '\n'],
  ...[1, 2, 4, 9].map(n => [`inline code ${n} backticks`, '`'.repeat(n) + excludedImage + '`'.repeat(n)])
];
for (const [name, body] of exclusions) test(`Image exclusion table: ${name} keeps every byte`, () => {
  for (const text of [body, body.replaceAll('\n', '\r\n')]) assert.equal(read(text).body, text);
});

test('Image exclusion comment end table: "--!>" never shortens a protected comment', () => {
  for (const body of [
    `<!-- ${excludedImage} --!>\n\nInvented text after.\n`,
    `Invented text <!-- ${excludedImage} --!> more invented text.\n`,
    `Invented text <!-- early --!> ${excludedImage} --> more invented text.\n`,
    `<!--\nearly --!>\n${excludedImage}\n-->\n`
  ]) for (const text of [body, body.replaceAll('\n', '\r\n')]) assert.equal(read(text).body, text, text);
});

test('Image exclusion mixed table: real images after every HTML block end still convert', () => {
  for (const [name, prefix] of exclusions.filter(([name]) => name.startsWith('HTML'))) {
    const image = '![real](https://example.invalid/real.png)';
    const result = read(prefix + image).body;
    assert.ok(result.startsWith(prefix + image.slice(1)), name + ': ' + result);
    assert.equal(result.split(notice).length, 2);
  }
});

test('Image exclusion unterminated table: HTML blocks continue through EOF', () => {
  for (const start of ['<pre>', '<script>', '<style>', '<textarea>', '<!--', '<?invented', '<!INVENTED', '<![CDATA[', '<div>', '<invented>']) {
    const body = start + '\n' + excludedImage + '\n';
    assert.equal(read(body).body, body, start);
  }
});

test('Image exclusion precedence table: opaque comments and raw blocks do not open code or references', () => {
  for (const body of [
    `<!-- \` -->\n${excludedImage}\n\``,
    `<pre>\n\`\`\`\n</pre>\n${excludedImage}`,
    `<!--\n[hidden]: https://example.invalid/hidden.png\n-->\n![hidden]`,
    `<pre>\n[hidden]: https://example.invalid/hidden.png\n</pre>\n![hidden]`
  ]) {
    const result = read(body).body;
    if (body.includes(excludedImage)) { assert.ok(result.includes(excludedImage.slice(1))); assert.ok(result.includes(notice)); }
    else assert.equal(result, body);
  }
});

test('Image exclusion HTML img table: preserve attributes but warn without rewriting their Markdown', () => {
  for (const body of [
    `<img src="https://example.invalid/real.png" alt="${excludedImage}">`,
    `Text <img src='https://example.invalid/real.png' alt='${excludedImage}'> after`,
    `<div>\n<img src="https://example.invalid/real.png" alt="${excludedImage}">\n</div>\n`
  ]) { const result = read(body).body; assert.ok(result.startsWith(body)); assert.equal(result.split(notice).length, 2); }
});

const precedingBlocks = [
  ['ATX heading', '# Heading\n'], ['ATX heading without space', '###\n'],
  ['setext heading equals', 'Heading\n===\n'], ['setext heading hyphens', 'Heading\n---\n'],
  ['thematic break stars', '* * *\n'], ['thematic break underscores', '___\n'], ['thematic break hyphens', '---\n'],
  ['fenced code', '```\ntext\n```\n'], ['indented code', '    text\n'],
  ['HTML block', '<!-- comment -->\n'], ['blank line', 'Paragraph\n\n'],
  ['reference definition', '[label]: https://example.invalid/page\n'],
  ['reference definition with title', '[label]: https://example.invalid/page "Title"\n'],
  ['reference definition multiline', '[label]:\n  <https://example.invalid/page>\n'],
  ['finished list container', '- List item\n'], ['finished quote container', '> Quoted paragraph\n']
];
test('Paragraph tracker block table: every completed block permits a type-7 HTML block', () => {
  for (const [name, prefix] of precedingBlocks) {
    const text = prefix + '<invented>\n' + excludedImage + '\n</invented>\n';
    assert.equal(read(text).body, text, name);
  }
});
test('Paragraph tracker container table: new list items and quotes start independent paragraphs', () => {
  for (const text of [
    `Paragraph\n> <invented>\n> ${excludedImage}\n> </invented>\n`,
    `Paragraph\n- <invented>\n  ${excludedImage}\n  </invented>\n`,
    `- Previous paragraph\n- <invented>\n  ${excludedImage}\n  </invented>\n`,
    `> # Heading\n> <invented>\n> ${excludedImage}\n> </invented>\n`
  ]) assert.equal(read(text).body, text);
});
test('Paragraph tracker continuation table: generic tags cannot interrupt an open paragraph', () => {
  for (const prefix of ['Paragraph\n', '> Paragraph\n> ', '- Paragraph\n  ']) {
    const container = prefix.startsWith('>') ? '> ' : prefix.startsWith('-') ? '  ' : '';
    const text = prefix + '<invented>\n' + container + excludedImage + '\n';
    assert.ok(read(text).body.startsWith(text.replace(excludedImage, excludedImage.slice(1))));
  }
});
