import test from 'node:test';
import assert from 'node:assert/strict';
import { recallSource } from '../src/sources.mjs';
const imageURL = 'https://example.invalid/cover.png', pageURL = 'https://example.invalid/page';
const notice = 'Images in this card were not imported. Their links may stop working.';
const read = body => recallSource().read([{ path: 'invented.md', text: body }]).items[0].body;
const images = [
  ['inline image', `![cover](${imageURL})`, ''],
  ['full reference image', '![cover][img]', `\n\n[img]: ${imageURL}`],
  ['collapsed reference image', '![cover][]', `\n\n[cover]: ${imageURL}`],
  ['shortcut reference image', '![cover]', `\n\n[cover]: ${imageURL}`]
];
for (const [innerName, image, defs] of images) for (const form of ['inline', 'full reference', 'collapsed reference', 'shortcut reference']) {
  test(`Linked image table: ${form} wrapping ${innerName}`, () => {
    const label = image.replace(/[\\[\]]/g, '\\$&');
    const suffix = form === 'inline' ? `(<${pageURL}> "Page title")` : form === 'full reference' ? '[page]' : form === 'collapsed reference' ? '[]' : '';
    const outerDef = form === 'inline' ? '' : `\n\n[${form === 'full reference' ? 'page' : label}]: <${pageURL}> "Page title"`;
    const result = read(`[${image}]${suffix}${defs}${outerDef}`);
    const expected = form === 'inline' ? `[cover]${suffix}` : form === 'full reference' ? '[cover][page]' : `[cover](<${pageURL}> "Page title")`;
    assert.ok(result.startsWith(expected), result);
    const note = result.slice(result.indexOf(notice)); assert.ok(note.includes(`[cover](<${imageURL}>)`), result);
    assert.ok(!result.slice(0, result.indexOf(notice)).includes('[[cover]'), result);
  });
}
test('Linked image table: empty alt and several images retain one outer destination', () => {
  const result = read(`[![](${imageURL}) and ![other](https://example.invalid/other.png)](${pageURL})`);
  assert.ok(result.startsWith(`[image and other](${pageURL})`), result);
  const note = result.slice(result.indexOf(notice)); assert.ok(note.includes(`[image](<${imageURL}>)`)); assert.ok(note.includes('[other](<https://example.invalid/other.png>)'));
});
test('Linked image table: autolinks inside alt text become text without a nested link', () => {
  const result = read(`[![<https://example.invalid/alt>](${imageURL})](${pageURL})`);
  assert.ok(result.startsWith(`[https://example.invalid/alt](${pageURL})`), result);
  assert.ok(result.slice(result.indexOf(notice)).includes(imageURL));
});
