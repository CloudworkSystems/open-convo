import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ABOUT_LIMIT,
  AtlasError,
  GENERATED_HEADER,
  MAP_LINE_LIMIT,
  MAP_MARKER,
  ROOT_INDEX_HEADING,
  buildAtlas,
  caseFoldClash,
  isGeneratedIndex,
  lineCount,
} from '../src/index.mjs';

const note = (path, text) => ({ path, text });

function garden(count, extra = []) {
  const notes = [];
  for (let i = 0; i < count; i += 1) notes.push(note(`garden/n${i}.md`, `# Note ${i}\n`));
  return notes.concat(extra);
}

function textOf(result, notes, path) {
  const written = result.writes.find(item => item.path === path);
  if (written) return written.text;
  if (result.unchanged.includes(path)) return notes.find(item => item.path === path).text;
  return undefined;
}

function materialize(notes, result) {
  const map = new Map(notes.map(item => [item.path, { path: item.path, text: item.text }]));
  for (const path of result.removes) map.delete(path);
  for (const item of result.writes) map.set(item.path, { path: item.path, text: item.text });
  return [...map.values()];
}

function kinds(result, kind) {
  return result.health.filter(item => item.kind === kind);
}

test('a folder with 6 notes gets an index and a folder with 5 does not', () => {
  const six = buildAtlas(garden(6));
  const index = six.writes.find(item => item.path === 'garden/INDEX.md');
  assert.ok(index);
  assert.equal(index.text, [
    GENERATED_HEADER,
    '# garden',
    '',
    '- [Note 0](n0.md)',
    '- [Note 1](n1.md)',
    '- [Note 2](n2.md)',
    '- [Note 3](n3.md)',
    '- [Note 4](n4.md)',
    '- [Note 5](n5.md)',
    '',
  ].join('\n'));
  assert.equal(six.counts.indexesWritten, 1);
  assert.deepEqual(six.removes, []);

  const five = buildAtlas(garden(5));
  assert.equal(five.writes.some(item => item.path.endsWith('/INDEX.md') || item.path === 'INDEX.md'), false);
  assert.equal(five.counts.indexesWritten, 0);
  const map = five.writes.find(item => item.path === 'MAP.md').text;
  assert.match(map, /- \[Note 0\]\(garden\/n0\.md\)/);
  assert.doesNotMatch(map, /INDEX\.md/);
});

test('deleting a note removes a generated index and leaves a hand-made index', () => {
  const built = buildAtlas(garden(6));
  const index = built.writes.find(item => item.path === 'garden/INDEX.md');
  const after = buildAtlas([...garden(5), { path: index.path, text: index.text }]);
  assert.deepEqual(after.removes, ['garden/INDEX.md']);
  assert.equal(after.writes.some(item => item.path === 'garden/INDEX.md'), false);

  const handmade = buildAtlas([...garden(5), note('garden/INDEX.md', '# Mine\n')]);
  assert.deepEqual(handmade.removes, []);
  assert.equal(handmade.writes.some(item => item.path === 'garden/INDEX.md'), false);
  assert.equal(handmade.conflicts[0].path, 'garden/INDEX.md');
});

test('about lines use description, then a heading, then the first line, then the file name', () => {
  const described = buildAtlas([note('bed.md', '---\ndescription: "Window basil"\nname: basil-plant\n---\n\n# Basil plants\n')]);
  assert.match(textOf(described, [], 'MAP.md'), /- \[Window basil\]\(bed\.md\)/);

  const heading = buildAtlas([note('bed.md', 'Intro line\n\n# Real title\n')]);
  assert.match(textOf(heading, [], 'MAP.md'), /- \[Real title\]\(bed\.md\)/);
  assert.doesNotMatch(textOf(heading, [], 'MAP.md'), /Intro line/);

  const sub = buildAtlas([note('bed.md', '## Not a title\n')]);
  assert.match(textOf(sub, [], 'MAP.md'), /- \[## Not a title\]\(bed\.md\)/);

  const emptyDescription = buildAtlas([note('bed.md', '---\ndescription:\n---\n\n# Kept heading\n')]);
  assert.match(textOf(emptyDescription, [], 'MAP.md'), /- \[Kept heading\]\(bed\.md\)/);

  const unclosed = buildAtlas([note('bed.md', '---\ndescription: nope\n# Real title\n')]);
  assert.match(textOf(unclosed, [], 'MAP.md'), /- \[Real title\]\(bed\.md\)/);
  assert.doesNotMatch(textOf(unclosed, [], 'MAP.md'), /nope/);

  const blank = buildAtlas([note('garden/bed.md', '\n\n')]);
  assert.match(textOf(blank, [], 'MAP.md'), /- \[bed\]\(garden\/bed\.md\)/);

  const longLine = `${'a'.repeat(50)} ${'b'.repeat(50)} ${'c'.repeat(50)}`;
  const cut = buildAtlas([note('bed.md', `${longLine}\n`)]);
  const expected = `${'a'.repeat(50)} ${'b'.repeat(50)}`;
  assert.equal(expected.length <= ABOUT_LIMIT, true);
  assert.match(textOf(cut, [], 'MAP.md'), new RegExp(`- \\[${expected}\\]\\(bed\\.md\\)`));
  assert.doesNotMatch(textOf(cut, [], 'MAP.md'), /ccc/);

  const longWord = 'a'.repeat(130);
  const hard = buildAtlas([note('bed.md', `${longWord}\n`)]);
  assert.match(textOf(hard, [], 'MAP.md'), new RegExp(`- \\[${'a'.repeat(ABOUT_LIMIT)}\\]\\(bed\\.md\\)`));
  assert.doesNotMatch(textOf(hard, [], 'MAP.md'), new RegExp(`a{${ABOUT_LIMIT + 1}}`));

  const longHeading = 'H'.repeat(150);
  const kept = buildAtlas([note('bed.md', `# ${longHeading}\n`)]);
  assert.match(textOf(kept, [], 'MAP.md'), new RegExp(`- \\[${longHeading}\\]\\(bed\\.md\\)`));

  const longDescription = 'D'.repeat(150);
  const describedLong = buildAtlas([note('bed.md', `---\ndescription: ${longDescription}\n---\n# Short\n`)]);
  assert.match(textOf(describedLong, [], 'MAP.md'), new RegExp(`- \\[${longDescription}\\]\\(bed\\.md\\)`));
});

test('the root map keeps the bytes above the marker', () => {
  const hand = 'Keep me.\n\nSecond line.\n';
  const notes = [note('MAP.md', `${hand}${MAP_MARKER}\nold line\n`), note('a.md', '# Alpha\n')];
  const map = textOf(buildAtlas(notes), notes, 'MAP.md');
  assert.equal(map.startsWith(`${hand}${MAP_MARKER}\n`), true);
  assert.equal(map.includes('old line'), false);
  assert.match(map, /- \[Alpha\]\(a\.md\)/);

  const plain = 'Just intro.';
  const appended = textOf(buildAtlas([note('MAP.md', plain), note('a.md', '# Alpha\n')]), [], 'MAP.md');
  assert.equal(appended.startsWith(`${plain}\n${MAP_MARKER}\n`), true);

  const doubled = `above\n${MAP_MARKER}\nmiddle\n${MAP_MARKER}\nbelow\n`;
  const firstWins = textOf(buildAtlas([note('MAP.md', doubled)]), [], 'MAP.md');
  assert.equal(firstWins.startsWith(`above\n${MAP_MARKER}\n`), true);
  assert.equal(firstWins.includes('middle'), false);
  assert.equal(firstWins.includes('below'), false);
});

test('a hand-made index is a conflict and is not written', () => {
  const result = buildAtlas([...garden(6), note('garden/INDEX.md', '# Handmade\n')]);
  assert.equal(result.writes.some(item => item.path === 'garden/INDEX.md'), false);
  assert.deepEqual(result.conflicts, [{
    path: 'garden/INDEX.md',
    detail: 'This index was written by hand, so it was left as it is.',
  }]);
  assert.equal(kinds(result, 'conflict').length, 1);
  const small = buildAtlas([...garden(2), note('recipes/INDEX.md', 'Not generated\n')]);
  assert.equal(small.removes.includes('recipes/INDEX.md'), false);
  assert.equal(small.conflicts.some(item => item.path === 'recipes/INDEX.md'), true);
  const map = textOf(small, [], 'MAP.md');
  assert.match(map, /recipes\/INDEX\.md/);
});

test('a second run on the rebuild writes nothing', () => {
  const notes = [...garden(6), note('pantry.md', '# Pantry\n'), note('MAP.md', `Intro.\n\n${MAP_MARKER}\nstale\n`)];
  const first = buildAtlas(notes);
  assert.ok(first.writes.length > 0);
  const second = buildAtlas(materialize(notes, first));
  assert.deepEqual(second.writes, []);
  assert.deepEqual(second.removes, []);
  assert.ok(second.unchanged.includes('garden/INDEX.md'));
  assert.ok(second.unchanged.includes('MAP.md'));
});

test('broken links, wiki links, and links that are not notes', () => {
  const notes = [
    note('a.md', 'See [gone](missing.md), [anchored](missing.md#part), and [[nope]].\n'),
    note('b.md', 'Web [page](https://example.com/missing.md) and [mail](mailto:garden@example.com).\n'),
    note('c.md', 'Stay [here](#local) or go [out](//example.com/a.md).\n'),
    note('d.md', '![picture](missing.md) and [ref][missing].\n'),
    note('e.md', '```\n[gone](missing.md)\n```\nReal [gap](also-missing.md).\n'),
    note('f.md', 'A `[gone](missing.md)` example.\n'),
  ];
  const result = buildAtlas(notes);
  const details = kinds(result, 'broken-link').map(item => `${item.path} ${item.detail}`).sort();
  assert.deepEqual(details, [
    'a.md [[nope]]',
    'a.md missing.md',
    'a.md missing.md#part',
    'e.md also-missing.md',
  ]);
});

test('encoded link targets round-trip, including #, spaces, and parentheses', () => {
  const notes = [
    ...garden(3),
    note('garden/plan#1.md', '# Plan number one\n'),
    note('garden/a (draft).md', '# Draft bed\n'),
    note('garden/two words.md', '# Two words\n'),
    note('garden/linker.md', 'See [plan](plan%231.md), [draft](<a (draft).md>), and [words](two%20words.md).\n'),
  ];
  const result = buildAtlas(notes);
  const index = result.writes.find(item => item.path === 'garden/INDEX.md').text;
  assert.match(index, /\(plan%231\.md\)/);
  assert.match(index, /\(a%20%28draft%29\.md\)/);
  assert.match(index, /\(two%20words\.md\)/);
  assert.equal(kinds(result, 'broken-link').some(item => item.path === 'garden/linker.md'), false);
  assert.equal(kinds(result, 'broken-link').some(item => item.detail.includes('%')), false);
});

test('link labels escape markdown characters', () => {
  const notes = [
    note('garden/p.md', '# [Project](old.md)\n'),
    note('garden/q.md', '# star * and _score_ and `tick` and <tag>\n'),
    ...garden(4),
  ];
  const index = buildAtlas(notes).writes.find(item => item.path === 'garden/INDEX.md').text;
  assert.match(index, /- \[\\\[Project\\\]\\\(old\.md\\\)\]\(p\.md\)/);
  assert.match(index, /- \[star \\\* and \\_score\\_ and \\`tick\\` and \\<tag\\>\]\(q\.md\)/);
});

test('orphans ignore the map, generated indexes, and self links', () => {
  const linked = buildAtlas([
    note('a.md', 'See [b](b.md).\n'),
    note('b.md', '# Bee\n'),
    note('c.md', 'See [myself](c.md).\n'),
  ]);
  assert.deepEqual(kinds(linked, 'orphan').map(item => item.path), ['a.md', 'c.md']);

  const fromMap = buildAtlas([
    note('MAP.md', 'See [b](b.md).\n'),
    note('b.md', '# Bee\n'),
  ]);
  assert.deepEqual(kinds(fromMap, 'orphan').map(item => item.path), ['b.md']);

  const fromIndex = buildAtlas([
    note('INDEX.md', `# Links\n\n[b](b.md)\n`),
    note('b.md', '# Bee\n'),
  ]);
  assert.deepEqual(kinds(fromIndex, 'orphan'), []);
  assert.equal(fromIndex.conflicts[0].path, 'INDEX.md');

  const generated = buildAtlas(garden(6));
  assert.equal(kinds(generated, 'orphan').length, 6);
});

test('duplicates list each group once', () => {
  const same = buildAtlas([
    note('a.md', 'Same\r\nBody\n'),
    note('b.md', 'Same\nBody\n'),
    note('c.md', '# Shared\n\nOne\n'),
    note('d.md', '# Shared\n\nTwo\n'),
  ]);
  assert.deepEqual(kinds(same, 'duplicate').map(item => item.detail), [
    'Same text: a.md, b.md',
    'Same about line: c.md, d.md',
  ]);

  const both = buildAtlas([
    note('a.md', '# Twin\n'),
    note('b.md', '# Twin\n'),
  ]);
  assert.deepEqual(kinds(both, 'duplicate').map(item => item.detail), ['Same text: a.md, b.md']);
});

test('notes over the line limit and a map over 200 lines are too long', () => {
  const exact = buildAtlas([note('a.md', `${'line\n'.repeat(400)}`)]);
  assert.equal(kinds(exact, 'too-long').some(item => item.path === 'a.md'), false);
  const over = buildAtlas([note('a.md', `${'line\n'.repeat(401)}`)], { maxLines: 400 });
  assert.deepEqual(kinds(over, 'too-long').filter(item => item.path === 'a.md'), [{
    kind: 'too-long',
    path: 'a.md',
    detail: '401 lines is over the limit of 400.',
  }]);

  const mapOk = buildAtlas([note('MAP.md', `${'L\n'.repeat(MAP_LINE_LIMIT - 1)}`)]);
  const okText = textOf(mapOk, [], 'MAP.md');
  assert.equal(lineCount(okText), MAP_LINE_LIMIT);
  assert.equal(kinds(mapOk, 'too-long').some(item => item.path === 'MAP.md'), false);

  const mapOver = buildAtlas([note('MAP.md', `${'L\n'.repeat(MAP_LINE_LIMIT)}`)]);
  const overText = textOf(mapOver, [], 'MAP.md');
  assert.equal(lineCount(overText), MAP_LINE_LIMIT + 1);
  assert.equal(kinds(mapOver, 'too-long').some(item => item.path === 'MAP.md'), true);

  const handmade = buildAtlas([
    note('INDEX.md', `${'# x\n'.repeat(3)}`),
  ], { maxLines: 2 });
  assert.equal(kinds(handmade, 'too-long').some(item => item.path === 'INDEX.md'), true);
});

test('refused paths name the path', () => {
  const cases = [
    ['../x.md', 'it contains ".."'],
    ['a/../../x.md', 'it contains ".."'],
    ['/abs.md', 'it starts with "/"'],
    ['a\\b.md', 'it contains a backslash'],
    ['a\nb.md', 'it contains a control character'],
    ['a\u0000b.md', 'it contains a control character'],
    ['a\u2028b.md', 'it contains a control character'],
    ['./a.md', 'it contains a "." segment'],
    ['a//b.md', 'it contains an empty segment'],
    ['a.txt', 'it does not end in .md'],
    ['.md', 'it has no file name'],
  ];
  for (const [path, reason] of cases) {
    assert.throws(
      () => buildAtlas([note(path, 'x')]),
      error => error instanceof AtlasError && error.message.includes(reason) && error.message.includes('Refusing path'),
      path,
    );
  }
  assert.throws(() => buildAtlas([note('a\nb.md', 'x')]), /\\u000a/);
  assert.throws(
    () => buildAtlas([note('a\n\u001b[2J.md', 'x')]),
    error => error instanceof AtlasError
      && error.message.includes('\\u000a\\u001b[2J.md')
      && !error.message.includes('\u001b')
      && !error.message.includes('\n'),
  );
  assert.equal(buildAtlas([note('notes..draft.md', '# Draft\n')]).counts.notes, 1);
});

test('shuffled notes produce byte-identical JSON', () => {
  const notes = [
    note('b.md', '# Bee\n'),
    note('a.md', 'See [b](b.md).\n'),
    ...garden(6),
    note('MAP.md', 'Intro.\n'),
    note('garden/INDEX.md', '# Mine\n'),
  ];
  const first = JSON.stringify(buildAtlas(notes));
  const second = JSON.stringify(buildAtlas([...notes].reverse()));
  assert.equal(first, second);
  const keys = Object.keys(JSON.parse(first));
  assert.deepEqual(keys, ['writes', 'removes', 'unchanged', 'conflicts', 'health', 'counts']);
});

test('edge cases named in the readme', () => {
  const nested = [
    ...garden(5),
    note('garden/herbs/thyme.md', '# Thyme\n'),
    note('garden/herbs/mint.md', '# Nested mint\n'),
  ];
  const under = buildAtlas(nested);
  assert.equal(under.writes.some(item => item.path.includes('INDEX.md')), false);
  const map = textOf(under, [], 'MAP.md');
  assert.match(map, /garden\/herbs\/thyme\.md/);
  assert.match(map, /garden\/n0\.md/);

  const over = buildAtlas([...garden(6), note('garden/herbs/thyme.md', '# Thyme\n')]);
  const index = over.writes.find(item => item.path === 'garden/INDEX.md').text;
  assert.match(index, /herbs\/thyme\.md/);
  assert.doesNotMatch(index, /herbs\/INDEX\.md/);
  assert.equal(over.counts.notes, 7);
  assert.equal(over.counts.folders, 3);

  const root = buildAtlas([
    note('a.md', '# A\n'), note('b.md', '# B\n'), note('c.md', '# C\n'),
    note('d.md', '# D\n'), note('e.md', '# E\n'), note('f.md', '# F\n'),
  ]);
  assert.match(root.writes.find(item => item.path === 'INDEX.md').text, new RegExp(`# ${ROOT_INDEX_HEADING}\n`));

  const order = textOf(buildAtlas([note('a.md', '# a\n'), note('B.md', '# B\n')]), [], 'MAP.md');
  assert.equal(order.indexOf('(B.md)') < order.indexOf('(a.md)'), true);

  assert.throws(
    () => buildAtlas([note('café.md'.normalize('NFC'), 'a'), note('café.md'.normalize('NFD'), 'b')]),
    /listed twice/,
  );
  const accented = 'café'.normalize('NFD');
  const decomposed = Array.from({ length: 6 }, (_, i) => note(`${accented}/n${i}.md`, `# N${i}\n`));
  decomposed.push(note('root.md', `See [bed](${encodeURIComponent(accented.normalize('NFC'))}/n0.md).\n`));
  const spelled = buildAtlas(decomposed);
  const spelledIndex = spelled.writes.find(item => item.path.endsWith('/INDEX.md'));
  assert.equal(spelledIndex.path, `${accented}/INDEX.md`);
  const spelledMap = textOf(spelled, [], 'MAP.md');
  const spelledLink = /\(([^)]+INDEX\.md)\)/.exec(spelledMap);
  assert.equal(spelledLink[1].split('/').map(part => decodeURIComponent(part)).join('/'), `${accented}/INDEX.md`);
  assert.equal(kinds(spelled, 'broken-link').some(item => item.path === 'root.md'), false);
  assert.throws(() => buildAtlas([note('a.md', 'a'), note('a.md', 'b')]), /listed twice/);
  assert.throws(() => buildAtlas('nope'), /Notes must be a list/);
  assert.throws(() => buildAtlas([note('a.md', 'a')], { extra: true }), /Unknown option/);
  assert.throws(() => buildAtlas([note('a.md', 'a')], { indexName: 'MAP.md' }), /different files/);
  assert.throws(() => buildAtlas([note('a.md', 'a')], { indexName: '../INDEX.md' }), /single \.md file name/);
  assert.throws(() => buildAtlas([note('a.md', 'a')], { indexThreshold: -1 }), /whole number/);
  assert.throws(() => buildAtlas([note('a.md', 1)]), /not text/);

  const renamed = buildAtlas(garden(2), { indexName: 'CONTENTS.md', rootMapName: 'HOME.md', indexThreshold: 0 });
  assert.equal(renamed.writes.some(item => item.path === 'garden/CONTENTS.md'), true);
  assert.equal(renamed.writes.some(item => item.path === 'HOME.md'), true);
  assert.equal(renamed.writes.some(item => item.path === 'MAP.md' || item.path.endsWith('/INDEX.md')), false);

  const input = [note('a.md', '# A\n')];
  const clone = structuredClone(input);
  buildAtlas(input);
  assert.deepEqual(input, clone);

  const empty = buildAtlas([]);
  assert.deepEqual(empty.writes.map(item => item.path), ['MAP.md']);
  assert.equal(empty.counts.notes, 0);
  assert.equal(empty.counts.folders, 0);
  assert.equal(empty.writes[0].text, `${MAP_MARKER}\n`);

  const created = buildAtlas([
    ...garden(6),
    note('outside.md', 'See the [index](garden/INDEX.md).\n'),
  ]);
  assert.equal(kinds(created, 'broken-link').some(item => item.detail === 'garden/INDEX.md'), false);

  const stale = buildAtlas([
    ...garden(5),
    note('garden/INDEX.md', `${GENERATED_HEADER}\n# garden\n\n- [Note 0](n0.md)\n`),
    note('outside.md', 'See the [old index](garden/INDEX.md).\n'),
  ]);
  assert.deepEqual(stale.removes, ['garden/INDEX.md']);
  assert.equal(kinds(stale, 'broken-link').some(item => item.detail === 'garden/INDEX.md'), true);

  const bom = buildAtlas([
    ...garden(5),
    note('garden/INDEX.md', `\uFEFF${GENERATED_HEADER}\n# garden\n`),
  ]);
  assert.deepEqual(bom.removes, ['garden/INDEX.md']);
  assert.equal(isGeneratedIndex(`\uFEFF${GENERATED_HEADER}\n`), true);
  assert.equal(isGeneratedIndex(`Hello\n${GENERATED_HEADER}\n`), false);

  const wiki = buildAtlas([
    note('garden/tomatoes.md', '---\nname: tomato\n---\n# Tomatoes\n'),
    note('recipes/tomato.md', '# Other\n'),
    note('a.md', 'See [[tomato]], [[garden/tomatoes]], [[tomatoes]], [[Tomatoes]], and [[tomato|red]].\n'),
  ]);
  const broken = kinds(wiki, 'broken-link').filter(item => item.path === 'a.md').map(item => item.detail);
  assert.deepEqual(broken, ['[[Tomatoes]]']);

  const badEscape = buildAtlas([note('a.md', 'See [x](bad%.md) and [y](bad%2Fname.md).\n')]);
  assert.equal(kinds(badEscape, 'broken-link').length, 2);

  const folder = buildAtlas([
    ...Array.from({ length: 6 }, (_, i) => note(`a (b)/n${i}.md`, `# N${i}\n`)),
    note('root.md', '# Root\n'),
  ]);
  const rootMap = textOf(folder, [], 'MAP.md');
  assert.match(rootMap, /- \[a \\\(b\\\)\]\(a%20%28b%29\/INDEX\.md\)/);

  assert.deepEqual(caseFoldClash(['Garden/A.md', 'garden/a.md']), ['Garden/A.md and garden/a.md']);
  assert.deepEqual(caseFoldClash(['a.md', 'b.md']), []);

  const counts = buildAtlas(garden(6)).counts;
  assert.deepEqual(Object.keys(counts), [
    'notes', 'folders', 'indexesWritten', 'indexesRemoved', 'mapWritten',
    'broken-link', 'conflict', 'duplicate', 'orphan', 'too-long',
  ]);
  for (const item of buildAtlas([...garden(6), note('garden/INDEX.md', '# Mine\n')]).writes) {
    assert.equal(item.path === 'MAP.md' || item.path.endsWith('/INDEX.md'), true);
  }
  assert.deepEqual(Object.keys(buildAtlas([note('a.md', '# A\n')]).health[0]), ['kind', 'path', 'detail']);
});

test('the package has no dependency, no license, and the library touches no disk or network', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.license, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.scripts.test, 'node --test');
  const names = readdirSync(new URL('..', import.meta.url));
  assert.equal(names.some(name => /^licen[sc]e/i.test(name)), false);

  const library = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const command = readFileSync(new URL('../src/atlas.mjs', import.meta.url), 'utf8');
  assert.deepEqual(specifiers(library), []);
  assert.equal(/node:|child_process|\bfetch\s*\(|process\.exit\b|from\s+['"]fs['"]/.test(library), false);
  assert.deepEqual(specifiers(command).sort(), [
    './index.mjs',
    'node:crypto',
    'node:fs',
    'node:path',
    'node:url',
  ]);
  assert.equal(/child_process|\bnode:https?\b|\bnode:net\b|\bnode:dns\b|\bnode:tls\b|\bnode:http2\b|\bfetch\s*\(|process\.exit\b/.test(command), false);
  assert.match(command, /process\.platform === 'darwin'/);
});

function specifiers(source) {
  const found = [];
  const patterns = [
    /\bimport\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'";]*?\s+from\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) found.push(match[1]);
  }
  return [...new Set(found)];
}
