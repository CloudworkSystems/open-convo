import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { main } from '../src/command.mjs';
import { FILE_BYTES } from '../src/errors.mjs';
import { formatSaved } from '../src/index.mjs';
import { sampleList } from './helpers.mjs';

const fixture = fileURLToPath(new URL('./fixtures/sample.json', import.meta.url));
const expectedText = fileURLToPath(new URL('./expected/sample.txt', import.meta.url));
const expectedJson = fileURLToPath(new URL('./expected/sample.json', import.meta.url));

function run(argv) {
  let stdout = '';
  let stderr = '';
  const code = main(argv, {
    stdout: { write(chunk) { stdout += chunk; } },
    stderr: { write(chunk) { stderr += chunk; } },
  });
  return { code, stdout, stderr };
}

test('the command prints the sample view and writes nothing', () => {
  const saved = readFileSync(fixture);
  assert.equal(saved.toString('utf8'), formatSaved(sampleList()));
  const names = readdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url)));
  const printed = run(['--file', fixture, '--today', '2026-11-02']);
  assert.equal(printed.code, 0);
  assert.equal(printed.stderr, '');
  assert.equal(printed.stdout, readFileSync(expectedText, 'utf8'));
  assert.match(printed.stdout, /13 days overdue/);
  assert.match(printed.stdout, /Due today \(2\)/);
  assert.match(printed.stdout, /Coming up \(1\)/);
  assert.match(printed.stdout, /Missing item \(0\)/);
  const json = run(['--today', '2026-11-02', '--json', '--file', fixture]);
  assert.equal(json.code, 0);
  assert.equal(json.stdout, readFileSync(expectedJson, 'utf8'));
  assert.deepEqual(readFileSync(fixture), saved);
  assert.deepEqual(readdirSync(fileURLToPath(new URL('./fixtures/', import.meta.url))), names);

  const none = run(['--file', fixture, '--today', '2026-11-02', '--days', '0']);
  assert.equal(none.code, 0);
  assert.match(none.stdout, /Coming up \(0\)/);
  const narrow = run(['--file', fixture, '--today', '2026-11-02', '--days', '1']);
  assert.equal(narrow.code, 0);
  assert.match(narrow.stdout, /Coming up \(0\)/);
  assert.doesNotMatch(narrow.stdout, /path-link/);
});

test('the command refuses to run without --today and writes nothing', () => {
  const saved = readFileSync(fixture);
  const missingToday = run(['--file', fixture]);
  assert.equal(missingToday.code, 1);
  assert.equal(missingToday.stdout, '');
  assert.match(missingToday.stderr, /field today/);
  assert.match(missingToday.stderr, /--today is required/);
  const missingFile = run(['--today', '2026-11-02']);
  assert.equal(missingFile.code, 1);
  assert.equal(missingFile.stdout, '');
  assert.match(missingFile.stderr, /field file/);
  assert.match(run(['--file', fixture, '--today=2026-11-02']).stderr, /field arguments/);
  assert.match(run(['--file', fixture, '--file', fixture, '--today', '2026-11-02']).stderr, /field file/);
  assert.match(run(['--file', fixture, '--today', '2026-11-02', '--days', '08']).stderr, /field days/);
  assert.match(run(['--file', fixture, '--today', '2026-11-02', '--days', '3651']).stderr, /field days/);
  assert.match(run(['--file', fixture, '--today', '2026-02-30']).stderr, /field today/);
  assert.equal(run(['--file', fixture, '--today', '2026-02-30']).stdout, '');
  assert.deepEqual(readFileSync(fixture), saved);
});

test('a bad reminders file is refused as a whole and the command writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'revisit-reminders-'));
  try {
    const bad = join(dir, 'bad.json');
    const badText = `${JSON.stringify({
      version: 1,
      reminders: [{
        id: 'bad-one',
        itemId: 'session-bad',
        itemKind: 'session',
        title: 'Come back to the bad session',
        when: { on: '2026-02-30' },
        createdOn: '2026-01-01',
      }],
    })}\n`;
    writeFileSync(bad, badText);
    const refused = run(['--file', bad, '--today', '2026-11-02']);
    assert.equal(refused.code, 1);
    assert.equal(refused.stdout, '');
    assert.match(refused.stderr, /reminder "bad-one"/);
    assert.match(refused.stderr, /field when\.on/);
    assert.equal(readFileSync(bad, 'utf8'), badText);
    assert.deepEqual(readdirSync(dir), ['bad.json']);

    const utf8 = join(dir, 'bad-utf8.json');
    writeFileSync(utf8, Buffer.from([0xff, 0xfe]));
    const decoded = run(['--file', utf8, '--today', '2026-11-02']);
    assert.equal(decoded.code, 1);
    assert.equal(decoded.stdout, '');
    assert.match(decoded.stderr, /field file/);
    assert.match(decoded.stderr, /UTF-8/);

    const big = join(dir, 'big.json');
    writeFileSync(big, Buffer.alloc(FILE_BYTES + 1, 0x20));
    const oversized = run(['--file', big, '--today', '2026-11-02']);
    assert.equal(oversized.code, 1);
    assert.equal(oversized.stdout, '');
    assert.match(oversized.stderr, /field file/);
    assert.equal(statSync(big).size, FILE_BYTES + 1);

    const body = formatSaved([]);
    const exact = join(dir, 'exact.json');
    const padded = `${' '.repeat(FILE_BYTES - Buffer.byteLength(body))}${body}`;
    assert.equal(Buffer.byteLength(padded), FILE_BYTES);
    writeFileSync(exact, padded);
    const accepted = run(['--file', exact, '--today', '2026-11-02']);
    assert.equal(accepted.code, 0);
    assert.match(accepted.stdout, /Overdue \(0\)/);
    assert.equal(readFileSync(exact, 'utf8'), padded);

    const folder = run(['--file', dir, '--today', '2026-11-02']);
    assert.equal(folder.code, 1);
    assert.equal(folder.stdout, '');
    assert.match(folder.stderr, /field file/);
    assert.deepEqual(readdirSync(dir).sort(), ['bad-utf8.json', 'bad.json', 'big.json', 'exact.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
