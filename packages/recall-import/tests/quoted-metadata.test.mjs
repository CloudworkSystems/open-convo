import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runImport } from '../src/import.mjs';
import { checkSource, recallSource } from '../src/sources.mjs';
import { buildAtlas } from '../../atlas-index/src/index.mjs';

const read = front => checkSource(recallSource(), [{ path: 'one.md', text: `---\n${front}\n---\nInvented body\n` }]);

test('Quoted metadata P1: escaped export titles round-trip through import and Atlas', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-quoted-')), input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  const titles = [String.raw`title: "Invented said \"hello\""`, String.raw`title: "Invented \\ path"`, "title: 'Invented ''hello'''", String.raw`title: 'Invented \ path'`];
  const expected = ['Invented said "hello"', 'Invented \\ path', "Invented 'hello'", 'Invented \\ path'];
  for (let i = 0; i < titles.length; i++) fs.writeFileSync(path.join(input, `${i}.md`), `---\n${titles[i]}\n---\nInvented body\n`);
  const report = runImport(['--in', input, '--atlas', atlas, '--write', '--imported-at', '2026-11-05T12:00:00.000Z']);
  const notes = report.paths.map(({ path: file }) => ({ path: file, text: fs.readFileSync(path.join(atlas, file), 'utf8') }));
  const generated = buildAtlas(notes, { indexThreshold: 1 });
  const index = generated.writes.find(note => note.path === 'sources/recall/INDEX.md').text;
  for (let i = 0; i < expected.length; i++) assert.ok(index.includes(`- [${expected[i].replaceAll('\\', '\\\\')}](${i}.md)\n`), index);
});

test('Quoted tags P1: flow tags retain quoted commas and decode both quote forms', () => {
  const result = read(String.raw`tags: ["research, AI", "one", 'two, three', "say \"hi\"", 'it''s fine', "a\\b", 'c\d']`);
  assert.deepEqual(result.items[0].tags, ['research, AI', 'one', 'two, three', 'say "hi"', "it's fine", 'a\\b', 'c\\d']);
});

test('Quoted parser sweep: every scalar key uses the same quote decoder', () => {
  const result = read(String.raw`title: "Invented \"quoted\""
url: "https://example.invalid/a\\b"
source: 'https://example.invalid/it''s'
created: "2026\u002d01\u002d02"
date: 'Invented ''date'''
custom: "extra \"quoted\" and \\ slash"
other: 'extra ''quoted'' and \ slash'`);
  const item = result.items[0];
  assert.equal(item.title, 'Invented "quoted"'); assert.equal(item.url, 'https://example.invalid/a\\b'); assert.equal(item.created, '2026-01-02');
  assert.equal(item.extra.custom, 'extra "quoted" and \\ slash'); assert.equal(item.extra.other, "extra 'quoted' and \\ slash");
  const aliases = read(String.raw`source: 'https://example.invalid/it''s'
date: "2026\u002d01\u002d02"`).items[0];
  assert.equal(aliases.url, "https://example.invalid/it's"); assert.equal(aliases.created, '2026-01-02');
});

test('Quoted parser sweep: block tags decode quotes without splitting commas', () => {
  const result = read(String.raw`tags:
  - "research, AI"
  - 'it''s one, tag'
  - "a\\b"
  - 'c\d'
title: Invented`);
  assert.equal(result.warnings.length, 0);
  assert.deepEqual(result.items[0].tags, ['research, AI', "it's one, tag", 'a\\b', 'c\\d']);
});

test('Quoted parser sweep: plain apostrophes and backslashes are literal', () => {
  const result = read(String.raw`title: Invented's \path
tags: [don't split, plain\path]`);
  assert.equal(result.items[0].title, "Invented's \\path"); assert.deepEqual(result.items[0].tags, ["don't split", 'plain\\path']);
});

test('Quoted parser sweep: malformed quotes and unsupported block fields preserve the original', () => {
  for (const front of [String.raw`title: "bad\q"`, 'title: "unclosed', 'tags: ["unclosed, one]', "tags: ['bad'quote']", 'custom:\n  - one\n  - two']) {
    const result = read(front);
    assert.equal(result.items[0].body, `---\n${front}\n---\nInvented body\n`);
    assert.equal(result.warnings.length, 1);
  }
  const flow = '["research, AI", "one"]'; assert.equal(read(`custom: ${flow}`).items[0].extra.custom, flow);
});

test('Quoted parser sweep: backslash parity and doubled quotes do not end flow values early', () => {
  const result = read(String.raw`tags: ["ends\\", "say \"x,y\"", 'it''s, still one', "plain"]`);
  assert.deepEqual(result.items[0].tags, ['ends\\', 'say "x,y"', "it's, still one", 'plain']);
});

test('Quoted parser sweep: block tags support no indentation and retain count and length limits', () => {
  assert.deepEqual(read("tags:\n- 'one, two'\n- \"three\"").items[0].tags, ['one, two', 'three']);
  assert.equal(read('tags:\n' + Array(50).fill('  - "one, two"').join('\n')).items[0].tags.length, 50);
  assert.match(read('tags:\n' + Array(51).fill('  - "one, two"').join('\n')).skipped[0].reason, /invalid tags/);
  assert.match(read('tags:\n  - "' + 'x'.repeat(101) + '"').skipped[0].reason, /invalid tags/);
});
