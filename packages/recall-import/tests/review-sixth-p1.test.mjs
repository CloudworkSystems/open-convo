import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSource, recallSource, toNotes } from '../src/sources.mjs';
import { runImport } from '../src/import.mjs';

const time = '2026-11-05T12:00:00.000Z';
const imageNotice = 'Images in this card were not imported. Their links may stop working.';
const read = body => checkSource(recallSource(), [{ path: 'one.md', text: body }]).items[0].body;

test('Sixth P1 1: full collapsed shortcut and angle images become plain links', () => {
  for (const [image, definition, expected] of [
    ['![cover][img]', '[img]: https://example.invalid/cover.png', '[cover][img]'],
    ['![cover][]', '[cover]: https://example.invalid/cover.png', '[cover][]'],
    ['![cover]', '[cover]: https://example.invalid/cover.png', '[cover]'],
    ['![cover](<https://example.invalid/cover.png>)', '', '[cover](<https://example.invalid/cover.png>)']
  ]) for (const before of [false, true]) {
    const body = before ? `${definition}\n\n${image}\n` : `${image}\n\n${definition}\n`;
    const expectedBody = before ? `${definition}\n\n${expected}\n` : `${expected}\n\n${definition}\n`;
    assert.equal(read(body), expectedBody + '\n' + imageNotice + '\n');
  }
});

test('Sixth P1 1: image parser respects code escapes local and undefined references', () => {
  const definitions = '[img]: https://example.invalid/a.png\n[cover]: <https://example.invalid/a.png>\n';
  const examples = '![cover][img] ![cover][] ![cover] ![cover](<https://example.invalid/a.png>)';
  for (const code of ['```\n' + examples + '\n```\n', '~~~\n' + examples + '\n~~~\n', '    ' + examples + '\n', '`' + examples + '`\n']) assert.equal(read(definitions + code), definitions + code);
  for (const body of ['![cover][missing]\n', '![cover]\n', '![cover][img]\n[img]: local.png\n', '\\![cover][img]\n' + definitions, '![cover][img]\n```\n[img]: https://example.invalid/a\n```\n']) assert.equal(read(body), body);
});

test('Sixth P1 1: parser handles balanced destinations and normalized reference labels', () => {
  const body = '![cover](https://example.invalid/a(b).png "Invented")\n![cover][ My   Image ]\n[my image]: <HTTP://example.invalid/a.png> "Title"\n';
  assert.equal(read(body), body.replaceAll('![', '[') + '\n' + imageNotice + '\n');
});

function fixture(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-sixth-'));
  const input = path.join(root, 'input'), atlas = path.join(root, 'atlas'); fs.mkdirSync(input);
  for (let i = 0; i < count; i++) fs.writeFileSync(path.join(input, `${String(i).padStart(4, '0')}.md`), '# Invented\n');
  return { input, atlas, dir: path.join(atlas, 'sources/recall'), argv: ['--in', input, '--atlas', atlas, '--write', '--imported-at', time] };
}

test('Sixth P1 2: manifest and journal bytes grow linearly with card count', () => {
  const measure = count => {
    const f = fixture(count), write = fs.writeFileSync, append = fs.appendFileSync;
    let bytes = 0;
    const record = (file, value) => { if (/\.import-(?:manifest|journal)/.test(String(file))) bytes += Buffer.byteLength(value); };
    fs.writeFileSync = (file, value, ...rest) => { record(file, value); return write(file, value, ...rest); };
    fs.appendFileSync = (file, value, ...rest) => { record(file, value); return append(file, value, ...rest); };
    try { runImport(f.argv); } finally { fs.writeFileSync = write; fs.appendFileSync = append; }
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(f.dir, '.import-manifest.json'))).entries).length, count);
    return bytes;
  };
  const small = measure(20), large = measure(40);
  assert.ok(large <= small * 2.25, `20 cards wrote ${small} bytes; 40 wrote ${large}`);
});

test('Sixth P1 2: journal recovers a renamed note when checkpoint failed and export changed', () => {
  const f = fixture(1), rename = fs.renameSync;
  const manifestFile = path.join(f.dir, '.import-manifest.json'), journalFile = path.join(f.dir, '.import-journal.jsonl');
  let checkpointFailed = false;
  fs.renameSync = (from, to) => { if (checkpointFailed && to === manifestFile) throw Error('Simulated checkpoint failure'); return rename(from, to); };
  try {
    assert.throws(() => runImport(f.argv, { afterRename() { checkpointFailed = true; throw Error('Interrupted'); } }), /checkpoint failure/);
  } finally { fs.renameSync = rename; }
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(manifestFile)).entries).length, 0);
  const pending = JSON.parse(fs.readFileSync(journalFile, 'utf8').trim());
  assert.equal(pending.key, '0000.md');
  fs.writeFileSync(path.join(f.input, '0000.md'), '# Changed invented card\n');
  const report = runImport(f.argv);
  assert.match(fs.readFileSync(path.join(f.dir, '0000.md'), 'utf8'), /Changed invented card/);
  assert.equal(report.messages.some(message => message.includes('kept, edited')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)).pending, {});
  assert.equal(fs.existsSync(journalFile), false);
});

test('Sixth P1 2: empty recovery consumes complete journal records and ignores a torn final append', () => {
  const f = fixture(1); runImport(f.argv);
  const manifestFile = path.join(f.dir, '.import-manifest.json'), journalFile = path.join(f.dir, '.import-journal.jsonl');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  const entry = manifest.entries['0000.md'];
  fs.writeFileSync(journalFile, JSON.stringify({ key: '0000.md', entry }) + '\n{"key":"unfinished');
  fs.unlinkSync(path.join(f.input, '0000.md'));
  const report = runImport(f.argv);
  assert.ok(report.messages.some(message => message.includes('no longer in Recall')));
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)).entries['0000.md'], entry);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestFile)).pending, {});
  assert.equal(fs.existsSync(journalFile), false);
});

test('Sixth P1 3: extra arrays recursively preserve objects arrays and scalar text', () => {
  const source = { id: 'invented', name: 'Invented', read() {} };
  const item = { key: 'one.md', title: 'Invented', body: '', url: null, created: null, sourcePath: 'one.md', tags: [], extra: { rows: [{ code: '001', active: true }, ['null', { value: false }, []], {}] } };
  const text = toNotes([item], { source, importedAt: time }).notes[0].text;
  assert.ok(text.includes('invented:\n  rows:\n    -\n      code: "001"\n      active: "true"\n    -\n      - "null"\n      -\n        value: "false"\n      - []\n    - {}\n'), text);
  assert.doesNotMatch(text, /\[object Object\]/);
});
