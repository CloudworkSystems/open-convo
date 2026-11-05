import test from 'node:test';
import assert from 'node:assert/strict';
import { recallSource } from '../src/sources.mjs';
const url = 'https://example.invalid/a.png', notice = 'Images in this card were not imported. Their links may stop working.';
const read = text => recallSource().read([{ path: 'invented.md', text }]).items[0];
const shapes = [
  ['quote', '> ', '> '], ['nested quote', '> > ', '> > '], ['list', '- ', '  '],
  ['quote in list', '- > ', '  > '], ['list in quote', '> - ', '>   ']
];
for (const [name, open, continuation] of shapes) test(`Container metadata definitions table: ${name}`, () => {
  const text = `${open}[img]: ${url}\n${continuation}\n${continuation}![cover][img]\n`;
  const item = read(text); assert.ok(item.body.startsWith(text.replace('![cover]', '[cover]')), item.body); assert.ok(item.body.includes(notice));
  assert.ok(item.body.slice(item.body.indexOf(notice)).includes(url));
});
for (const [name, open, continuation] of shapes) test(`Container metadata continuation table: ${name} destination and title`, () => {
  const text = `${open}[page]:\n${continuation}  <https://example.invalid/page>\n${continuation}  "Page title"\n${continuation}\n${continuation}[![cover](${url})][page]\n`;
  const item = read(text); assert.ok(item.body.includes('[cover][page]'), item.body); assert.ok(item.body.includes(notice));
  // Shortcut outer links must retain the next-line reference title when made explicit.
  const label = `![cover](${url})`, escaped = label.replace(/[\\[\]]/g, '\\$&');
  const shortcut = `${open}[${escaped}]:\n${continuation}  <https://example.invalid/page>\n${continuation}  "Page title"\n${continuation}\n${continuation}[${label}]\n`;
  assert.ok(read(shortcut).body.includes('[cover](<https://example.invalid/page>\n  "Page title")'), read(shortcut).body);
});
for (const [name, open, continuation] of shapes) test(`Container metadata heading table: ${name} ATX and setext stay excluded from fallback titles`, () => {
  for (const lines of [['# Basil plants'], ['Basil plants', '==='], ['Basil plants', '---']]) {
    const text = open + lines.join('\n' + continuation) + '\n' + continuation + '\n' + continuation + `![cover](${url})\n`;
    const item = read(text); assert.equal(item.title, 'invented'); assert.ok(item.body.startsWith(text.replace('![cover]', '[cover]')));
  }
});
test('Container metadata protection table: quoted code HTML and front matter never define references or titles', () => {
  for (const [open, close] of [['> ```\n', '> ```\n'], ['> <pre>\n', '> </pre>\n'], ['> <!--\n', '> -->\n']]) {
    const text = open + `> [img]: ${url}\n> # Fake\n` + close + '\n![cover][img]\n';
    assert.equal(read(text).body, text); assert.equal(read(text).title, 'invented');
  }
  const text = `---\nnote: [img]: ${url}\n---\n![cover][img]\n`; assert.equal(read(text).body, '![cover][img]\n');
});
test('Container metadata lazy table: continuation headings and definitions stay in their paragraph', () => {
  const text = `> Existing paragraph\n[img]: ${url}\n\n![cover][img]\n`;
  assert.equal(read(text).body, text);
});
test('Container metadata sweep table: unindented destinations and continued titles end the definition block', () => {
  for (const destination of [`[img]:\n> <${url}>\n> 'Image title'`, `[img]: ${url}\n> 'Image title'`]) {
    const text = '> ' + destination + '\n> <invented>\n> ![hidden](https://example.invalid/hidden.png)\n> </invented>\n>\n> ![cover][img]\n';
    const body = read(text).body;
    assert.ok(body.includes('> ![hidden](https://example.invalid/hidden.png)')); assert.ok(body.includes('> [cover][img]')); assert.ok(body.slice(body.indexOf(notice)).includes(url));
  }
});
test('Container metadata sweep table: container headings remain excluded regardless of level or setext style', () => {
  for (const [body, title] of [['> First line\n> second line\n> ===\n', 'invented'], ['- ## Basil plants ##\n', 'invented']]) assert.equal(read(body).title, title);
});
