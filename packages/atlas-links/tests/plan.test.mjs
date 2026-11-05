import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENERATED_HEADER, buildAtlas } from '../../atlas-index/src/index.mjs';
import { applyRepairs, formatReport, isGeneratedIndex, planRepairs, sha256Text } from '../src/index.mjs';

const fixture = new URL('./fixtures/wiki/', import.meta.url);

const moves = [
  ['basil.md', 'garden/basil.md'],
  ['old/Seeds.md', 'archive/Seeds.md'],
  ['bed.md', 'plots/bed.md'],
  ['thyme.md', 'Thyme.md'],
  ['old/Seed Plans.md', 'archive/Seed Plans.md'],
  ['old/plan#1.md', 'plan#1.md'],
  ['old/a (draft).md', 'a (draft).md'],
  ['other/Sage.md', 'archive/Sage.md'],
];

const different = new Set(['archive/dill.md', 'archive/kale.md']);

function loadNotes() {
  const notes = [];
  const walk = dir => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else {
        const notePath = path.relative(fileURLToPath(fixture), full).split(path.sep).join('/');
        notes.push({ path: notePath, text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(fileURLToPath(fixture));
  return notes;
}

function sample() {
  const notes = loadNotes();
  const byPath = new Map(notes.map(note => [note.path, note]));
  const moved = new Set(moves.map(([, next]) => next));
  const items = [];
  for (const note of notes) {
    if (moved.has(note.path) || different.has(note.path)) continue;
    items.push({ path: note.path, sha256: sha256Text(note.text) });
  }
  for (const [prev, next] of moves) items.push({ path: prev, sha256: sha256Text(byPath.get(next).text) });
  for (const [notePath, text] of [
    ['ghost.md', 'gone\n'],
    ['old/rosemary.md', 'old rosemary\n'],
    ['old/dill.md', 'old dill\n'],
    ['old/kale.md', 'old kale\n'],
  ]) items.push({ path: notePath, sha256: sha256Text(text) });
  return { notes, snapshot: { notes: items } };
}

function pair(repair) {
  return `${repair.path} ${repair.from} => ${repair.to}`;
}

function onlyTargetsChanged(original, written, repairs) {
  const ordered = repairs.slice().sort((a, b) => a.start - b.start);
  let from = 0;
  let to = 0;
  for (const repair of ordered) {
    const gap = repair.start - from;
    if (original.slice(from, repair.start) !== written.slice(to, to + gap)) return false;
    to += gap;
    from = repair.start;
    if (original.slice(from, repair.end) !== repair.from) return false;
    if (written.slice(to, to + repair.to.length) !== repair.to) return false;
    to += repair.to.length;
    from = repair.end;
  }
  return original.slice(from) === written.slice(to);
}

test('a moved note is repaired from the root, a sibling, and a deeper folder', () => {
  const { notes, snapshot } = sample();
  const result = planRepairs(notes, snapshot);
  const repairs = result.repairs.map(pair);
  assert.ok(repairs.includes('pantry.md basil.md => garden/basil.md'));
  assert.ok(repairs.includes('recipes/soup.md ../basil.md => ../garden/basil.md'));
  assert.ok(repairs.includes('garden/beds/layout.md ../../basil.md => ../basil.md'));
  const repaired = notes.map(note => {
    const write = result.writes.find(item => item.path === note.path);
    return write ? { path: note.path, text: write.text } : note;
  });
  const broken = new Set(
    buildAtlas(repaired).health.filter(item => item.kind === 'broken-link').map(item => `${item.path} ${item.detail}`),
  );
  for (const repair of result.repairs) {
    assert.equal(broken.has(`${repair.path} ${repair.detail}`), false, repair.detail);
  }
});

test('letter case, wiki spelling, anchors, and encoded names are repaired', () => {
  const { notes, snapshot } = sample();
  const result = planRepairs(notes, snapshot);
  const repairs = result.repairs.map(pair);
  assert.ok(repairs.includes('casing.md thyme.md => Thyme.md'));
  assert.ok(repairs.includes('recipes/soup.md seeds => Seeds'));
  assert.equal(result.repairs.filter(item => item.path === 'recipes/soup.md' && item.from === 'seeds').length, 2);
  assert.ok(repairs.includes('garden/beds/layout.md old/Seeds => Seeds'));
  assert.ok(repairs.includes('garden/tomatoes.md ../old/Seeds.md#soil => ../archive/Seeds.md#soil'));
  assert.ok(repairs.includes('links.md old/Seed%20Plans.md#rows => archive/Seed%20Plans.md#rows'));
  assert.ok(repairs.includes('links.md old/plan%231.md => plan%231.md'));
  assert.ok(repairs.includes('links.md <old/a (draft).md> => a%20%28draft%29.md'));
  const soup = result.writes.find(item => item.path === 'recipes/soup.md').text;
  assert.match(soup, /\[\[Seeds\]\]/);
  assert.match(soup, /\[\[Seeds\|the seed list\]\]/);
  const map = notes.find(note => note.path === 'MAP.md');
  const written = result.writes.find(item => item.path === 'MAP.md').text;
  const marker = '<!-- atlas-index:start -->';
  assert.equal(map.text.slice(map.text.indexOf(marker)), written.slice(written.indexOf(marker)));
  assert.match(written, /\[the seeds\]\(archive\/Seeds\.md\)/);
});

test('uncertain links are listed and not repaired', () => {
  const { notes, snapshot } = sample();
  const result = planRepairs(notes, snapshot);
  const needs = result.needsYou.map(item => `${item.path} ${item.reason} ${item.candidates.join(', ')}`);
  assert.ok(needs.includes('pantry.md More than one note has this name. baking/flour.md, shop/flour.md'));
  assert.ok(needs.includes('pantry.md No note has this name. '));
  assert.ok(needs.includes('pantry.md The snapshot does not show that this note moved. archive/rosemary.md'));
  assert.ok(needs.includes('herbs.md The snapshot does not show that this note moved. archive/dill.md'));
  assert.ok(needs.includes('herbs.md The snapshot does not show that this note moved. archive/kale.md'));
  assert.ok(needs.includes('herbs.md The snapshot does not show that this note moved. archive/Sage.md'));
  assert.ok(needs.includes('archive/Seeds.md This link points at its own note. archive/Seeds.md'));
  assert.equal(result.repairs.some(item => item.from === '[[old/Sage]]' || item.to.includes('Sage')), false);
});

test('a wiki link that already matches a note is not listed', () => {
  const result = planRepairs([
    { path: 'baking/flour.md', text: '# Flour\n' },
    { path: 'shop/flour.md', text: '# Flour\n' },
    { path: 'pantry.md', text: 'See [[flour]].\n' },
  ], null);
  assert.equal(result.counts.broken, 0);
  assert.deepEqual(result.repairs, []);
});

test('no snapshot lists every broken link and repairs nothing', () => {
  const { notes } = sample();
  const result = planRepairs(notes, null);
  assert.equal(result.repairs.length, 0);
  assert.equal(result.writes.length, 0);
  assert.equal(result.counts.broken, result.needsYou.length);
  assert.ok(result.needsYou.some(item => item.reason.includes('run --record')));
  assert.match(formatReport(result, { noSnapshot: true }), /Run --record/);
});

test('code, external links, front matter, and a working name are left alone', () => {
  const { notes, snapshot } = sample();
  const result = planRepairs(notes, snapshot);
  const fence = result.writes.find(item => item.path === 'notes/fence.md').text;
  assert.match(fence, /```\n\[gone\]\(\.\.\/basil\.md\)\n```/);
  assert.match(fence, /\[basil\]\(\.\.\/garden\/basil\.md\)/);
  assert.match(fence, /https:\/\/example.com\/basil\.md/);
  assert.match(fence, /mailto:garden@example.com/);
  assert.match(fence, /\]\(\/basil\.md\)/);
  assert.match(fence, /`\[gone\]\(\.\.\/basil\.md\)`/);
  assert.equal(result.repairs.some(item => item.path === 'meta.md' || item.path === 'guide.md'), false);
  assert.equal(result.needsYou.some(item => item.path === 'meta.md' || item.link.includes('soup-guide')), false);
});

test('only the target bytes change, including CRLF and a missing final newline', () => {
  const { notes, snapshot } = sample();
  const result = planRepairs(notes, snapshot);
  for (const write of result.writes) {
    const original = notes.find(note => note.path === write.path);
    const repairs = result.repairs.filter(item => item.path === write.path);
    assert.equal(onlyTargetsChanged(original.text, write.text, repairs), true, write.path);
    assert.equal(applyRepairs(original.text, repairs), write.text);
  }
  const casing = notes.find(note => note.path === 'casing.md');
  const crlfNotes = notes.map(note => note.path === 'casing.md'
    ? { path: note.path, text: casing.text.trimEnd().replace(/\n/g, '\r\n') }
    : note);
  const crlfSnapshot = {
    notes: snapshot.notes.map(item => item.path === 'casing.md'
      ? { path: item.path, sha256: sha256Text(crlfNotes.find(note => note.path === 'casing.md').text) }
      : item),
  };
  const crlf = planRepairs(crlfNotes, crlfSnapshot);
  const written = crlf.writes.find(item => item.path === 'casing.md');
  assert.equal(written.text.includes('\r\n'), true);
  assert.equal(written.text.endsWith('\n'), false);
  assert.equal(onlyTargetsChanged(
    crlfNotes.find(note => note.path === 'casing.md').text,
    written.text,
    crlf.repairs.filter(item => item.path === 'casing.md'),
  ), true);
});

test('the broken set matches atlas-index on the sample wiki', () => {
  const { notes, snapshot } = sample();
  const result = planRepairs(notes, snapshot);
  const atlas = buildAtlas(notes).health
    .filter(item => item.kind === 'broken-link')
    .map(item => `${item.path} ${item.detail}`)
    .sort();
  const ours = [...new Set([...result.repairs, ...result.needsYou].map(item => `${item.path} ${item.detail}`))].sort();
  assert.deepEqual(ours, atlas);
  assert.equal(result.counts.broken, result.repairs.length + result.needsYou.length);
  assert.ok(result.counts.broken > ours.length);
});

test('a generated index is skipped, and a query on a destination is kept', () => {
  const { notes, snapshot } = sample();
  const withIndex = notes.concat({
    path: 'garden/INDEX.md',
    text: `${GENERATED_HEADER}\n# garden\n\n[missing](missing.md)\n`,
  });
  const result = planRepairs(withIndex, snapshot);
  assert.equal(isGeneratedIndex(`\uFEFF${GENERATED_HEADER}\n`), true);
  assert.equal(result.repairs.some(item => item.path === 'garden/INDEX.md'), false);
  assert.equal(result.needsYou.some(item => item.path === 'garden/INDEX.md'), false);
  assert.equal(result.counts.notes, notes.length);
  const moved = planRepairs(
    [
      { path: 'box/a.md', text: '# A\n' },
      { path: 'see.md', text: 'See [a](old/a.md?x=1).\n' },
    ],
    { notes: [{ path: 'old/a.md', sha256: sha256Text('# A\n') }, { path: 'see.md', sha256: sha256Text('See [a](old/a.md?x=1).\n') }] },
  );
  assert.deepEqual(moved.repairs.map(pair), ['see.md old/a.md?x=1 => box/a.md?x=1']);
});

test('unsafe paths, NFC duplicates, and a bad snapshot are refused', () => {
  const refused = [
    ['../x.md', 'it contains ".."'],
    ['/abs.md', 'it starts with "/"'],
    ['a\\b.md', 'it contains a backslash'],
    ['a\nb.md', 'it contains a control character'],
    ['', 'it is empty'],
  ];
  for (const [notePath, reason] of refused) {
    assert.throws(
      () => planRepairs([{ path: notePath, text: 'x' }], null),
      error => error.name === 'LinkRepairError' && error.message.includes(reason) && !error.message.includes('\n'),
    );
  }
  const cafe = 'café.md';
  assert.throws(
    () => planRepairs([
      { path: cafe.normalize('NFC'), text: 'a' },
      { path: cafe.normalize('NFD'), text: 'b' },
    ], null),
    /listed twice/,
  );
  assert.throws(() => planRepairs('nope', null), /Notes must be a list/);
  assert.throws(() => planRepairs([{ path: 'a.md', text: 1 }], null), /not text/);
  assert.throws(() => planRepairs([], undefined), /Snapshot must be an object or null/);
  assert.throws(() => planRepairs([], { notes: [], extra: true }), /Unknown snapshot field/);
  assert.throws(() => planRepairs([], { notes: [{ path: 'a.md', sha256: 'zz' }] }), /64 lowercase hex/);
  const bad = planRepairs([{ path: 'a.md', text: 'See [x](bad%.md).\n' }], null);
  assert.equal(bad.needsYou[0].reason, "This link's target cannot be read.");
  assert.deepEqual(bad.repairs, []);
});

test('the same notes give byte-identical JSON in either input order', () => {
  const { notes, snapshot } = sample();
  const first = JSON.stringify(planRepairs(notes, snapshot));
  const second = JSON.stringify(planRepairs([...notes].reverse(), {
    notes: [...snapshot.notes].reverse(),
  }));
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.deepEqual(Object.keys(parsed), ['repairs', 'needsYou', 'writes', 'counts']);
  assert.deepEqual(Object.keys(parsed.repairs[0]), ['path', 'line', 'from', 'to']);
  assert.deepEqual(Object.keys(parsed.needsYou[0]), ['path', 'line', 'link', 'candidates', 'reason']);
  const input = notes.map(note => ({ path: note.path, text: note.text }));
  const clone = structuredClone(input);
  planRepairs(input, snapshot);
  assert.deepEqual(input, clone);
});

test('the library does not read the disk, the clock, or the network', () => {
  const source = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|child_process|node:https?|node:net|node:dns|Date\.now|new Date|setTimeout|setInterval/);
});
