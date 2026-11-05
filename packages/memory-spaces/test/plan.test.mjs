import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOperation, emptyState, read, renderWrites } from '../src/index.mjs';
import { runSample } from '../src/sample.mjs';

const now = '2040-01-01T00:00:00Z';
const label = { kind: 'owner said', date: '2040-01-01' };
const base = () => emptyState([{ id: 'personal', name: 'Personal', kind: 'personal' }, { id: 'studio', name: 'Invented Studio', kind: 'business' }]);
const op = (s, type, data = {}) => applyOperation(s, { id: `op-${s.log.length}`, actor: 'person', now, type, ...data });
const step = (s, type, data) => op(s, type, data).state;
function proposal(s = base(), id = 'note', text = 'Invented blue cover.') { return step(s, 'propose', { actor: 'helper', candidate: { id, text } }); }
function keep(s = proposal(), id = 'note', subject = 'covers', space = 'personal') { return step(s, 'keep', { candidateId: id, subject, space, label }); }
const visible = (s, space = 'personal', cloud = false) => read(s, { space, cloud });
function unchangedRefusal(s, type, data, pattern) { const before = JSON.stringify(s); assert.throws(() => op(s, type, data), pattern); assert.equal(JSON.stringify(s), before); }

test('Plan 1: candidates, keep, separation, skip', () => {
  const p = proposal(); assert.deepEqual(visible(p), []);
  const k = keep(p); assert.equal(visible(k)[0].id, 'note'); assert.deepEqual(visible(k, 'studio'), []);
  const skipped = step(p, 'skip', { candidateId: 'note' }); assert.deepEqual(skipped.proposed, []); assert.equal(skipped.log.at(-1).type, 'skip');
});
test('Plan 2: person actors and unconfirmed proposals', () => {
  for (const type of ['keep', 'correct', 'forget', 'undo', 'share', 'allowCloud']) unchangedRefusal(keep(), type, { actor: 'helper' }, /person/);
  assert.equal(proposal().proposed[0].unconfirmedAgent, true);
});
test('Plan 3: no label, two labels, all valid labels and required fields', () => {
  const labels = [label, { kind: "agent's reading, kept", agent: 'Invented helper' }, { kind: 'from a source', link: 'https://example.invalid/invented' }];
  for (const good of labels) {
    assert.equal(op(proposal(), 'keep', { candidateId: 'note', space: 'personal', subject: 'covers', label: good }).result.label.kind, good.kind);
    unchangedRefusal(proposal(), 'keep', { candidateId: 'note', space: 'personal', subject: 'covers', label: { kind: good.kind } }, /label|needs/);
  }
  for (const bad of [undefined, [label, labels[1]], { ...label, agent: 'Invented helper' }]) unchangedRefusal(proposal(), 'keep', { candidateId: 'note', space: 'personal', subject: 'covers', label: bad }, /label/);
});
test('Plan 4: business separation, share origin, person move', () => {
  const k = keep(); assert.deepEqual(visible(k, 'studio'), []);
  const shared = step(k, 'share', { entryId: 'note', space: 'studio' }); assert.equal(visible(shared, 'studio')[0].origin, 'personal');
  unchangedRefusal(k, 'move', { entryId: 'note', space: 'studio', actor: 'helper' }, /person/);
  const moved = step(k, 'move', { entryId: 'note', space: 'studio' }); assert.equal(visible(moved, 'studio')[0].id, 'note'); assert.deepEqual(visible(moved), []);
});
test('Plan 5: sensitive save and explicit cloud permission', () => {
  const p = step(base(), 'propose', { candidate: { id: 'note', text: 'Invented sensitive text.', sensitive: true } });
  const data = { candidateId: 'note', subject: 'covers', space: 'personal', label };
  unchangedRefusal(p, 'keep', data, /save: true/);
  const k = step(p, 'keep', { ...data, save: true }); assert.equal(visible(k)[0].cloud, false); assert.deepEqual(visible(k, 'personal', true), []);
  assert.equal(visible(step(k, 'allowCloud', { entryId: 'note' }), 'personal', true).length, 1);
});
test('Plan 6: correction history and current text only', () => {
  const s = step(keep(), 'correct', { entryId: 'note', text: 'Invented green cover.' });
  assert.deepEqual(s.subjects.personal.covers[0].history, [{ text: 'Invented blue cover.', actor: 'person', at: now }]);
  assert.equal(visible(s)[0].text, 'Invented green cover.'); assert.equal(JSON.stringify(visible(s)).includes('blue'), false);
});
test('Plan 7: immediate forget, restore, undo, permanent purge of every version', () => {
  let s = step(keep(), 'correct', { entryId: 'note', text: 'Invented green cover.' });
  s = step(s, 'share', { entryId: 'note', space: 'studio' }); s = step(s, 'allowCloud', { entryId: 'note' }); s = step(s, 'forget', { entryId: 'note' });
  for (const space of ['personal', 'studio']) for (const cloud of [false, true]) assert.deepEqual(visible(s, space, cloud), []);
  assert.equal(visible(step(s, 'restore', { entryId: 'note' })).length, 1);
  assert.equal(visible(step(s, 'undo', { opId: s.log.at(-1).id })).length, 1);
  const purged = op(s, 'purge', { now: '2040-02-01T00:00:00Z' });
  for (const text of ['Invented blue cover.', 'Invented green cover.']) assert.equal(JSON.stringify(purged).includes(text), false);
  for (const record of purged.state.log.filter(r => r.purged)) assert.deepEqual(Object.keys(record).sort(), ['actor', 'id', 'now', 'purged', 'type']);
  unchangedRefusal(purged.state, 'undo', { opId: purged.state.log.at(-1).id }, /cannot be undone/);
});
test('Plan 8: undo every supported kind and name dependencies', () => {
  const k = keep(); const undoneKeep = step(k, 'undo', { opId: k.log.at(-1).id }); assert.deepEqual(visible(undoneKeep), []); assert.equal(undoneKeep.proposed[0].id, 'note');
  for (const [type, data] of [['correct', { text: 'Invented revision.' }], ['forget', {}], ['share', { space: 'studio' }], ['move', { space: 'studio' }], ['allowCloud', {}]]) {
    const changed = step(k, type, { entryId: 'note', ...data }); const undone = step(changed, 'undo', { opId: changed.log.at(-1).id });
    assert.deepEqual(visible(undone), visible(k)); assert.deepEqual(visible(undone, 'studio'), []);
  }
  const corrected = step(k, 'correct', { entryId: 'note', text: 'Invented revision.' }); unchangedRefusal(corrected, 'undo', { opId: k.log.at(-1).id }, new RegExp(corrected.log.at(-1).id + '.*depends'));
});
test('Plan 9: subject and index 4 KB caps and generated first lines', () => {
  const k = keep(); unchangedRefusal(k, 'correct', { entryId: 'note', text: 'x'.repeat(4096) }, /This subject is full/);
  unchangedRefusal(proposal(base(), 'big', 'x'.repeat(4096)), 'keep', { candidateId: 'big', subject: 'covers', space: 'personal', label }, /This subject is full/);
  const s = base(); s.subjects.personal = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`subject-${i}-${'x'.repeat(40)}`, []])); assert.throws(() => renderWrites(s), /index is full/);
  const writes = renderWrites(k); const index = writes.find(w => w.path === 'personal/INDEX.md').text;
  for (const w of writes.filter(w => w.path.startsWith('personal/') && !w.path.endsWith('/INDEX.md'))) assert.ok(index.includes(`${w.path.split('/')[1]}: ${w.text.split('\n')[0]}`));
  for (const w of writes.filter(w => w.path.endsWith('.md'))) assert.ok(Buffer.byteLength(w.text) <= 4096);
});
test('Plan 10: write layout, dot folders, invalid subject ids, path containment', () => {
  for (const subject of ['../business/client', 'INDEX', 'index', 'Work', 'a.b', '', '-bad', 'x'.repeat(65)]) unchangedRefusal(proposal(), 'keep', { candidateId: 'note', space: 'personal', subject, label }, /Subject id/);
  const writes = renderWrites(keep());
  for (const w of writes) assert.match(w.path, /^(?:(?:personal|studio)\/(?:INDEX|[a-z][a-z0-9-]*)\.md|\.proposed\/candidates\.json|\.trash\/trash\.json|\.log\/log\.jsonl)$/);
  for (const p of ['.proposed/candidates.json', '.trash/trash.json', '.log/log.jsonl']) assert.ok(writes.some(w => w.path === p));
});
test('Plan 11: byte deterministic operations and forbidden source APIs', () => {
  const sequence = () => op(step(keep(), 'correct', { entryId: 'note', text: 'Invented change.' }), 'forget', { entryId: 'note' });
  assert.equal(JSON.stringify(sequence()), JSON.stringify(sequence()));
  const source = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Date\.now|new Date\s*\(|performance\.now|process\.hrtime|(?:from\s*|import\s*\()['"](?:node:)?(?:fs|child_process|https?|net|tls|dns|dgram)\b|\bfetch\s*\(/);
});

function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-memory-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function driver(dir, verb, data, options) { const output = []; runSample(['--dir', dir, verb, ...(data ? ['--data', JSON.stringify(data)] : [])], { output: s => output.push(s), ...options }); return output; }
function seed(dir) { driver(dir, 'init'); driver(dir, 'propose', { id: 'p', actor: 'helper', candidate: { id: 'note', text: 'Invented blue cover.' } }); driver(dir, 'keep', { id: 'k', actor: 'person', candidateId: 'note', space: 'personal', subject: 'covers', label }); }
test('Plan 12: sample marker refusal, successful run and interrupted recovery', t => {
  const dir = temp(t); assert.throws(() => driver(dir, 'show'), /This isn't a sample memory folder. Run init in an empty folder first./); assert.deepEqual(fs.readdirSync(dir), []);
  seed(dir); assert.equal(JSON.parse(driver(dir, 'show').at(-1)).subjects.personal.covers[0].text, 'Invented blue cover.');
  const oldLog = fs.readFileSync(path.join(dir, '.log/log.jsonl'), 'utf8');
  driver(dir, 'correct', { id: 'c', actor: 'person', entryId: 'note', text: 'Invented green cover.' });
  fs.writeFileSync(path.join(dir, '.log/log.jsonl'), oldLog);
  const output = driver(dir, 'show'); assert.match(output[0], /The last change didn't finish and was not saved./); assert.equal(JSON.parse(output.at(-1)).subjects.personal.covers[0].text, 'Invented blue cover.');
  fs.writeFileSync(path.join(dir, 'personal/covers.md'), 'Interrupted file.');
  assert.match(driver(dir, 'show')[0], /didn't finish/); assert.match(fs.readFileSync(path.join(dir, 'personal/covers.md'), 'utf8'), /Invented blue cover/);
  const points = [];
  driver(dir, 'correct', { id: 'probe', actor: 'person', entryId: 'note', text: 'Invented completed change.' }, { afterWrite: p => points.push(p) });
  for (const point of points) {
    const trial = temp(t); seed(trial);
    assert.throws(() => driver(trial, 'correct', { id: 'change', actor: 'person', entryId: 'note', text: 'Invented completed change.' }, { afterWrite: p => { if (p === point) throw new Error('Invented interruption'); } }), /Invented interruption/);
    const shown = driver(trial, 'show'); const recovered = JSON.parse(shown.at(-1));
    assert.ok(['Invented blue cover.', 'Invented completed change.'].includes(recovered.subjects.personal.covers[0].text));
    for (const w of renderWrites(recovered)) assert.equal(fs.readFileSync(path.join(trial, w.path), 'utf8'), w.text, point);
  }
});

test('Carried 1: purge survives interruption at every write step', t => {
  const probe = temp(t); seed(probe); driver(probe, 'forget', { id: 'f', actor: 'person', entryId: 'note' });
  const points = []; driver(probe, 'purge', { id: 'purge', actor: 'person', now: '2041-01-01T00:00:00Z' }, { afterWrite: p => points.push(p) });
  for (const point of points) {
    const dir = temp(t); seed(dir); driver(dir, 'forget', { id: 'f', actor: 'person', entryId: 'note' });
    assert.throws(() => driver(dir, 'purge', { id: 'purge', actor: 'person', now: '2041-01-01T00:00:00Z' }, { afterWrite: p => { if (p === point) throw new Error('Invented interruption'); } }), /Invented interruption/);
    const output = driver(dir, 'show'); assert.equal(output.join('').includes('Invented blue cover.'), false, point);
    const recovered = JSON.parse(output.at(-1)); assert.deepEqual(recovered.trash, []);
    for (const w of renderWrites(recovered)) assert.equal(fs.readFileSync(path.join(dir, w.path), 'utf8').includes('Invented blue cover.'), false, point);
    for (const file of fs.readdirSync(dir, { recursive: true })) {
      const full = path.join(dir, file);
      if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full, 'utf8').includes('Invented blue cover.'), false, `${point}: ${file}`);
    }
  }
});
test('Carried 2: restore skip purge require person', () => { for (const type of ['restore', 'skip', 'purge']) unchangedRefusal(keep(), type, { actor: 'helper' }, /person/); });
test('Carried 3: every content operation checks size and refuses atomically', () => {
  let s = keep(proposal(base(), 'large', 'x'.repeat(3900)), 'large'); s = keep(proposal(s, 'small', 'y'.repeat(200)), 'small', 'other');
  unchangedRefusal(s, 'move', { entryId: 'small', subject: 'covers', space: 'personal' }, /subject is full/);
  let forgotten = step(keep(), 'forget', { entryId: 'note' }); forgotten = keep(proposal(forgotten, 'large', 'x'.repeat(4010)), 'large');
  unchangedRefusal(forgotten, 'restore', { entryId: 'note' }, /subject is full/);
  unchangedRefusal(forgotten, 'undo', { opId: 'op-2' }, /subject is full/);
  unchangedRefusal(keep(), 'correct', { entryId: 'note', text: 'x'.repeat(4096) }, /subject is full/);
  const full = keep(); full.subjects.studio = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`subject-${i}-${'x'.repeat(40)}`, []]));
  unchangedRefusal(full, 'share', { entryId: 'note', space: 'studio' }, /index is full/);
  unchangedRefusal(proposal(base(), 'large', 'x'.repeat(4096)), 'keep', { candidateId: 'large', subject: 'covers', space: 'personal', label }, /subject is full/);
});
test('Carried 4: space ids nonempty unique and checked before operations', () => {
  for (const ids of [['', 'studio'], ['same', 'same']]) { const s = base(); s.spaces.forEach((space, i) => space.id = ids[i]); assert.throws(() => read(s, { space: 'personal' }), /Space id/); assert.throws(() => op(s, 'unknown'), /Space id/); }
});
test('Carried 5: operation ids nonempty unique and undo selects one record', () => {
  const s = keep(); unchangedRefusal(s, 'purge', { id: '' }, /must not be empty/); unchangedRefusal(s, 'purge', { id: s.log[0].id }, /already in the log/);
  const dup = structuredClone(s); dup.log.push(structuredClone(dup.log[0])); unchangedRefusal(dup, 'undo', { opId: dup.log[0].id }, /repeated in the log/);
  const empty = structuredClone(s); empty.log[0].id = ''; unchangedRefusal(empty, 'purge', {}, /must not be empty/);
  const undone = step(s, 'undo', { opId: s.log.at(-1).id }); assert.equal(undone.log.length, s.log.length + 1); assert.equal(undone.log.at(-1).targetId, s.log.at(-1).id);
});
test('Carried 6: candidate kept trash ids nonempty unique across every set', () => {
  const k = keep(); const p = proposal(); const f = step(k, 'forget', { entryId: 'note' });
  for (const original of [p, k, f]) {
    const s = structuredClone(original); const list = s.proposed.length ? s.proposed : s.trash.length ? s.trash : s.subjects.personal.covers;
    list.push(structuredClone(list[0])); unchangedRefusal(s, 'purge', {}, /repeated/);
    list.pop(); list[0].id = ''; unchangedRefusal(s, 'purge', {}, /must not be empty/);
  }
  for (const original of [k, f]) { const s = structuredClone(original); s.proposed.push({ id: 'note', text: 'Invented duplicate.' }); unchangedRefusal(s, 'purge', {}, /repeated/); }
  const s = structuredClone(k); s.trash.push(structuredClone(f.trash[0])); unchangedRefusal(s, 'purge', {}, /repeated/);
  assert.equal(p.proposed[0].id, k.subjects.personal.covers[0].id); assert.equal(f.trash[0].id, visible(step(f, 'restore', { entryId: 'note' }))[0].id);
});
test('Carried 7: restore and undo enforce 30 days before purge', () => {
  const s = step(keep(), 'forget', { entryId: 'note' });
  for (const type of ['restore', 'undo']) {
    const data = type === 'restore' ? { entryId: 'note' } : { opId: s.log.at(-1).id };
    assert.equal(visible(step(s, type, { ...data, now: '2040-01-30T00:00:00Z' })).length, 1);
    assert.equal(visible(step(s, type, { ...data, now: '2040-01-31T00:00:00Z' })).length, 1);
    unchangedRefusal(s, type, { ...data, now: '2040-02-01T00:00:00Z' }, /This memory's 30 days in Trash are over./);
  }
});
