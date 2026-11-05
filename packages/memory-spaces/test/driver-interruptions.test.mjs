import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSample } from '../src/sample.mjs';
import { renderWrites } from '../src/index.mjs';

const warning = "The last change didn't finish and was not saved.";
const label = { kind: 'owner said', date: '2040-01-01' };
function call(dir, verb, data, afterWrite) {
  const output = [];
  runSample(['--dir', dir, verb, ...(data ? ['--data', JSON.stringify(data)] : [])], { output: s => output.push(s), afterWrite });
  return output;
}
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-save-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function seed(t) {
  const dir = temp(t); call(dir, 'init');
  call(dir, 'propose', { id: 'p', actor: 'person', candidate: { id: 'note', text: 'Invented original.' } });
  call(dir, 'keep', { id: 'k', actor: 'person', candidateId: 'note', space: 'personal', subject: 'covers', label });
  return dir;
}
test('P1 pending recovery state reports interruption before state write', t => {
  const dir = seed(t);
  const before = JSON.parse(call(dir, 'show').at(-1));
  assert.throws(() => call(dir, 'correct', { id: 'c', actor: 'person', entryId: 'note', text: 'Invented revision.' }, point => {
    if (point === '.sample-committed.json:renamed') throw new Error('Invented interruption');
  }), /Invented interruption/);
  const output = call(dir, 'show');
  assert.equal(output[0], warning);
  assert.deepEqual(JSON.parse(output.at(-1)), before);
  assert.deepEqual(call(dir, 'show'), [JSON.stringify(before, null, 2)]);
});

test('Save promise sweep: 12 commands at every named write point', t => {
  const verbs = ['init', 'propose', 'keep', 'skip', 'correct', 'forget', 'restore', 'undo', 'share', 'move', 'allowCloud', 'purge'];
  let cases = 0;
  for (const verb of verbs) {
    function prepare() {
      const dir = verb === 'init' ? temp(t) : seed(t);
      if (['keep', 'skip'].includes(verb)) call(dir, 'propose', { id: 'p-other', actor: 'person', candidate: { id: 'other', text: 'Invented other.' } });
      if (['restore', 'purge'].includes(verb)) call(dir, 'forget', { id: 'f', actor: 'person', entryId: 'note' });
      return dir;
    }
    const data = { id: 'change', actor: 'person', entryId: 'note', candidateId: 'other', subject: 'covers', space: verb === 'keep' ? 'personal' : 'studio', label, text: 'Invented revised.', opId: 'k', candidate: { id: 'other', text: 'Invented other.' }, ...(verb === 'purge' ? { now: '2041-01-01T00:00:00Z' } : {}) };
    const probe = prepare(); const points = [];
    call(probe, verb, data, point => points.push(point));
    assert.equal(new Set(points).size, points.length);
    const complete = JSON.parse(call(probe, 'show').at(-1));
    for (const point of points) {
      cases++;
      const dir = prepare(); const before = verb === 'init' ? undefined : JSON.parse(call(dir, 'show').at(-1));
      assert.throws(() => call(dir, verb, data, reached => { if (reached === point) throw new Error('Invented interruption'); }), /Invented interruption/);
      const output = call(dir, 'show'); const recovered = JSON.parse(output.at(-1));
      const isComplete = JSON.stringify(recovered) === JSON.stringify(complete);
      if (!isComplete) {
        assert.deepEqual(recovered, before, `${verb}: ${point}: partial state`);
        assert.equal(output[0], warning, `${verb}: ${point}: silent interrupted save`);
      }
      for (const w of renderWrites(recovered)) assert.equal(fs.readFileSync(path.join(dir, w.path), 'utf8'), w.text, `${verb}: ${point}`);
      const expectedFiles = new Set(renderWrites(recovered).map(w => w.path));
      for (const file of fs.readdirSync(dir, { recursive: true })) {
        const relative = file.split(path.sep).join('/');
        if (relative.endsWith('.md')) assert.ok(expectedFiles.has(relative), `${verb}: ${point}: unfinished subject file ${relative}`);
      }
      assert.deepEqual(call(dir, 'show'), [JSON.stringify(recovered, null, 2)], `${verb}: ${point}: recovery should finish`);
    }
  }
  assert.equal(cases, 195);
  t.diagnostic(`${verbs.length} commands, ${cases} command/write-point cases`);
});
