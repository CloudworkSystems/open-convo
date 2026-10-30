// Plan test 1: three invented calendars (iCloud, Google and Outlook styles)
// merged for one week match the saved JSON and agenda exactly.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { HERE, fixture } from './helpers.mjs';
import { formatAgenda, mergeCalendars } from '../src/index.mjs';
import { run } from '../src/merge.mjs';

const QUERY = { from: '2026-11-01', to: '2026-11-07', timeZone: 'America/New_York' };
const SOURCES = ['home', 'family', 'work'].map((id) => ({ id, name: id, ics: fixture(`${id}.ics`) }));
const expectedJson = fs.readFileSync(path.join(HERE, 'expected', 'three-calendars.json'), 'utf8');
const expectedAgenda = fs.readFileSync(path.join(HERE, 'expected', 'three-calendars.txt'), 'utf8');

test('the merged week matches the saved JSON and agenda', async () => {
  const result = await mergeCalendars(SOURCES, QUERY);
  assert.equal(`${JSON.stringify(result, null, 2)}\n`, expectedJson);
  assert.equal(formatAgenda(result), expectedAgenda);
});

function capture() {
  const out = { text: '', write(chunk) { this.text += chunk; return true; } };
  return out;
}

test('the command prints the same agenda and JSON', async () => {
  const files = ['home', 'family', 'work'].map((id) => path.join(HERE, 'fixtures', `${id}.ics`));
  const args = ['--from', QUERY.from, '--to', QUERY.to, '--tz', QUERY.timeZone, ...files];
  const stdout = capture();
  const stderr = capture();
  assert.equal(await run(args, { stdout, stderr }), 0);
  assert.equal(stdout.text, expectedAgenda);
  assert.equal(stderr.text, '');
  const json = capture();
  assert.equal(await run([...args, '--json'], { stdout: json, stderr }), 0);
  assert.equal(json.text, expectedJson);
});

test('a refusal goes to stderr with exit code 1', async () => {
  const stdout = capture();
  const stderr = capture();
  const code = await run(['--from', '2026-11-08', '--to', '2026-11-01', '--tz', 'America/New_York', path.join(HERE, 'fixtures', 'home.ics')], { stdout, stderr });
  assert.equal(code, 1);
  assert.equal(stdout.text, '');
  assert.match(stderr.text, /"to" is before "from"/);
});
