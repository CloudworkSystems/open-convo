import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = name => join(root, 'fixtures', name);
const SAMPLE = ['--sources', fixture('sources.json'), '--items', fixture('items.json'), '--state', fixture('state.json'), '--known', fixture('known.json')];

async function capture(argv) {
  const out = [];
  const err = [];
  const code = await main(argv, { write: text => out.push(text), error: text => err.push(text) });
  return { code, out: out.join(''), err: err.join('') };
}

function tempFile(name, content) {
  const dir = mkdtempSync(join(tmpdir(), 'followed-'));
  const path = join(dir, name);
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  return path;
}

test('the sample run prints the expected summary and cards', () => {
  const out = execFileSync(process.execPath, [join(root, 'src', 'followed.mjs'), ...SAMPLE], { encoding: 'utf8' });
  assert.equal(out, [
    '3 new items from 2 sources: 3 lessons, 1 red flag',
    '[lesson] Lesson: Always keep keys out of the … (The Example Faction (daily email))',
    '[lesson] Lesson: Check every new dependency before an … (The Example Faction (daily email))',
    '[lesson] Lesson: Teams that never let a pull … (Saved build links)',
    '[red-flag] This item tried to give instructions (The Example Faction (daily email))',
    '',
  ].join('\n'));
});

test('--json prints the whole result, including the new state', async () => {
  const { code, out } = await capture([...SAMPLE, '--json']);
  assert.equal(code, 0);
  const result = JSON.parse(out);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.skipped['older-than-checkpoint'], 1);
  assert.deepEqual(result.state.checkpoints, { 'example-faction': '2026-10-22T12:00:00Z', 'saved-links': '2026-10-21T09:30:00Z' });
  assert.deepEqual(result.cards.map(card => card.sourceUrl), [
    'https://faction.example/daily/101', 'https://faction.example/daily/101', 'https://links.example/small-prs', 'https://faction.example/daily/102',
  ]);
});

test('a second run with the new state says "Nothing new."', async () => {
  const first = JSON.parse((await capture([...SAMPLE, '--json'])).out);
  const state = tempFile('state.json', first.state);
  const { code, out } = await capture(['--sources', fixture('sources.json'), '--items', fixture('items.json'), '--state', state]);
  assert.equal(code, 0);
  assert.equal(out, 'Nothing new.\n');
});

test('problem lines appear in the plain output, with source text made safe', async () => {
  const items = tempFile('items.json', {
    schemaVersion: 1,
    items: [{ source: 'nobody', id: 'x-1', date: '2026-10-20T00:00:00Z', title: 'Bad\u001b[31m red\u001b[0m\nline\ttab', text: 'Hi.' }],
  });
  const { code, out } = await capture(['--sources', fixture('sources.json'), '--items', items]);
  assert.equal(code, 0);
  assert.equal(out, 'Nothing new.\nProblem: nobody/x-1 "Bad red line tab": its source isn\'t in the sources file, so it was skipped.\n');
  assert.doesNotMatch(out, /\u001b/);
});

test('printed text writes line breaks and tabs as \\n and \\t and drops ANSI escapes', async () => {
  const { safeText } = await import('../src/index.mjs');
  assert.equal(safeText('a\nb\tc\u001b[2Jd\u001b]0;title\u0007e\u0000f'), 'a\\nb\\tcdef');
});

test('invalid JSON and a wrong schemaVersion are refused with one line naming the file', async () => {
  const broken = tempFile('items.json', '{ not json');
  const old = tempFile('known.json', { schemaVersion: 2, known: [] });
  const one = await capture(['--sources', fixture('sources.json'), '--items', broken]);
  assert.equal(one.code, 1);
  assert.equal(one.err, `Refused ${broken}: not valid JSON.\n`);
  assert.equal(one.out, '');
  const two = await capture(['--sources', fixture('sources.json'), '--items', fixture('items.json'), '--known', old]);
  assert.equal(two.code, 1);
  assert.equal(two.err, `Refused ${old}: schemaVersion must be 1.\n`);
});

test('bad shapes and missing files are refused, naming the file', async () => {
  const badItem = tempFile('items.json', { schemaVersion: 1, items: [{ source: 'a', id: 'b', date: 'yesterday', title: '', text: '' }] });
  const result = await capture(['--sources', fixture('sources.json'), '--items', badItem]);
  assert.equal(result.code, 1);
  assert.equal(result.err, `Refused ${badItem}: items[0].date must be an ISO 8601 date.\n`);
  const missing = join(tmpdir(), 'followed-does-not-exist.json');
  const gone = await capture(['--sources', missing, '--items', fixture('items.json')]);
  assert.equal(gone.code, 1);
  assert.equal(gone.err, `Refused ${missing}: could not be read.\n`);
  const nullState = tempFile('state.json', 'null');
  const nothing = await capture(['--sources', fixture('sources.json'), '--items', fixture('items.json'), '--state', nullState]);
  assert.equal(nothing.err, `Refused ${nullState}: must be a JSON object.\n`);
});

test('usage errors exit 2 with the usage line', () => {
  const result = spawnSync(process.execPath, [join(root, 'src', 'followed.mjs'), '--items', fixture('items.json')], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^--sources is required\.\nUsage: node src\/followed\.mjs/);
});
