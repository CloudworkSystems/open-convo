import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSource, recallSource, toNotes } from '../src/sources.mjs';

const image = '![Invented image](https://example.invalid/image.png)';
const notice = 'Images in this card were not imported. Their links may stop working.';
function read(body) { return checkSource(recallSource(), [{ path: 'example.md', text: body }]).items[0]; }

for (const [name, body] of [
  ['backtick fences', '```markdown\n' + image + '\n```\n'],
  ['tilde fences', '~~~markdown\n' + image + '\n~~~\n'],
  ['indented code', '    ' + image + '\n\n\t' + image + '\n'],
  ['inline code', 'Example `' + image + '` and ``' + image + '``.\n']
]) {
  test(`Fourth P1: image examples inside ${name} stay byte for byte`, () => {
    const item = read(body);
    assert.equal(item.body, body);
    assert.equal(item.body.includes(notice), false);
  });
}

test('Fourth P1: mixed Markdown converts only images outside code and warns once', () => {
  const code = '````md\r\n' + image + '\r\n```\r\n' + image + '\r\n````\r\n' +
    '~~~md\r\n' + image + '\r\n~~~\r\n\r\n    ' + image + '\r\n\r\n`' + image + '`\r\n';
  const body = code + image + '\n' + image + '\n';
  const item = read(body);
  assert.equal(item.body, code + image.slice(1) + '\n' + image.slice(1) + '\n\n' + notice + '\n');
});

test('Fourth P1: multiline inline spans and unclosed fences preserve image examples', () => {
  for (const body of ['``example\n' + image + '\nexample``\n', '```md\n' + image + '\n', '~~~\n' + image + '\n']) assert.equal(read(body).body, body);
});

test('Sweep: headings inside code cannot become the card title', () => {
  for (const code of ['```\n# Fake heading\n```\n', '~~~\n# Fake heading\n~~~\n', '    # Fake heading\n', '`example\n# Fake heading\nexample`\n']) {
    assert.equal(read(code).title, 'example');
    assert.equal(read(code + '\n# Real heading\n').title, 'Real heading');
    assert.equal(read(code).body, code);
  }
});

test('Sweep: escaped image syntax and ordinary links and wiki links stay unchanged', () => {
  const body = '\\' + image + '\n[Link](https://example.invalid/page)\n[[Invented wiki link]]\n';
  assert.equal(read(body).body, body);
  const code = '```md\n[Link](https://example.invalid/page)\n[[Invented wiki link]]\n# Example\n```\n';
  assert.equal(read(code).body, code);
  assert.ok(toNotes([read(code)], { source: recallSource(), importedAt: '2026-11-05T12:00:00.000Z' }).notes[0].text.endsWith(code));
});
