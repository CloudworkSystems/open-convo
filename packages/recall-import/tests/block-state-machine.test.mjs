import test from 'node:test';
import assert from 'node:assert/strict';
import { recallSource } from '../src/sources.mjs';
const image = '![diagram](https://example.invalid/diagram.png)';
const picture = '![basil](https://example.invalid/basil.png)';
const notice = 'Images in this card were not imported. Their links may stop working.';
// Invented variants of CommonMark fenced-code, HTML-block and indented-code examples.
const examples = [
  ['P1 containers: bullet inside fence', '```markdown\n- ' + image + '\n```\n'],
  ['P1 containers: quote inside fence', '```\n> ' + image + '\n```\n'],
  ['P1 containers: bullet inside comment', '<!--\n- ' + image + '\n-->\n'],
  ['P1 containers: bullet inside pre', '<pre>\n- ' + image + '\n</pre>\n'],
  ['P1 type1: pre mentions script close', '<pre>\n</script>\n' + image + '\n</pre>\n'],
  ...['script', 'style', 'textarea'].map(tag => [`P1 type1: ${tag} ignores pre close`, `<${tag}>\n</pre>\n${image}\n</${tag.toUpperCase()}>\n`]),
  ['fence precedence: shorter close and other character', '````\n```\n~~~\n- ' + image + '\n`````\n'],
  ['fence precedence: tilde and longer close', '~~~~\n```\n> ' + image + '\n~~~~~\n'],
  ['HTML precedence: processing instruction', '<?invented\n- ' + image + '\n?>\n'],
  ['HTML precedence: declaration', '<!INVENTED\n- ' + image + '\n>\n'],
  ['HTML precedence: CDATA', '<![CDATA[\n- ' + image + '\n]]>\n'],
  ['HTML precedence: block tag until blank', '<div>\n- ' + image + '\n</div>\n\n'],
  ['HTML precedence: generic tag until blank', '<invented>\n> ' + image + '\n</invented>\n\n'],
  ['indented code after blank', '    ' + image + '\n\n']
];
for (const [name, protectedText] of examples) test(`Block state machine table: ${name}`, () => {
  for (const eol of ['\n', '\r\n']) {
    const prefix = protectedText.replaceAll('\n', eol), tail = '# Basil plants' + eol + picture + eol;
    const item = recallSource().read([{ path: 'invented.md', text: prefix + tail }]).items[0];
    assert.equal(item.title, 'Basil plants');
    assert.ok(item.body.startsWith(prefix + tail.replace(picture, picture.slice(1))), item.body);
    assert.equal(item.body.split(notice).length, 2);
  }
});
test('Block state machine P2 paragraph table: indented images lazily continue a paragraph', () => {
  for (const indent of ['    ', '\t']) {
    const text = 'See the figure:\n' + indent + picture + '\n# Basil plants\n';
    const item = recallSource().read([{ path: 'invented.md', text }]).items[0];
    assert.equal(item.title, 'Basil plants'); assert.ok(item.body.startsWith(text.replace(picture, picture.slice(1)))); assert.ok(item.body.includes(notice));
  }
});
