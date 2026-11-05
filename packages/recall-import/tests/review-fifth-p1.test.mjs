import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAtlas } from '../../atlas-index/src/index.mjs';
import { recallSource, toNotes } from '../src/sources.mjs';

const importedAt = '2026-11-05T12:00:00.000Z';
const item = title => ({ key: 'one.md', title, body: 'Invented body stays as written.\n', url: null, tags: [], created: null, sourcePath: 'one.md' });
const label = text => text.replace(/[\\[\]()*_`<>]/g, ch => '\\' + ch);
const companion = () => ({ ...item('Other invented card'), key: 'two.md', sourcePath: 'two.md' });

test('Fifth P1: quotes and backslashes round-trip through the real Atlas reader', () => {
  for (const title of ['An "invented" title', 'A \\ path', 'Both "quotes" and \\slashes', 'An \'apostrophe\' and "quote" and \\ path']) {
    const { notes, warnings } = toNotes([item(title), companion()], { source: recallSource(), importedAt });
    const result = buildAtlas(notes, { indexThreshold: 1 });
    const index = result.writes.find(note => note.path === 'sources/recall/INDEX.md').text;
    assert.ok(index.includes(`- [${label(title)}](one.md)\n`), index);
    assert.deepEqual(warnings, []);
    assert.ok(notes[0].text.endsWith(item(title).body));
  }
});

test('Fifth P1: tabs and newlines become spaces with a file warning through Atlas', () => {
  for (const title of ['An\tinvented title', 'An\ninvented title', 'An\rinvented title', 'An\u2028invented title']) {
    const original = item(title);
    const { notes, warnings } = toNotes([original, companion()], { source: recallSource(), importedAt });
    const result = buildAtlas(notes, { indexThreshold: 1 });
    const index = result.writes.find(note => note.path === 'sources/recall/INDEX.md').text;
    assert.ok(index.includes('- [An invented title](one.md)\n'), index);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /one.md/);
    assert.match(warnings[0], /space/i);
    assert.ok(notes[0].text.includes('title: An invented title\n'));
    assert.ok(notes[0].text.includes('description: An invented title\n'));
    assert.equal(original.title, title);
  }
});
