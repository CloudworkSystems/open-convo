import assert from 'node:assert/strict';
import fs, {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { GENERATED_HEADER, buildAtlas } from '../src/index.mjs';
import { applyPlan, formatSummary, run, scanDirectory } from '../src/atlas.mjs';

const fixture = fileURLToPath(new URL('./fixtures/wiki/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

function copyWiki() {
  const dir = join(tmpdir(), `atlas-index-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

function snapshot(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else out.push([full, String(stat.mtimeNs ?? stat.mtimeMs), readFileSync(full).toString('base64')]);
    }
  };
  walk(dir);
  return out;
}

function capture(argv) {
  let out = '';
  let err = '';
  const code = run(argv, {
    stdout: text => { out += text; },
    stderr: text => { err += text; },
  });
  return { code, out, err };
}

test('a dry run writes nothing and --write writes only the index and the map', () => {
  const dir = copyWiki();
  try {
    const before = snapshot(dir);
    const dry = capture(['--dir', dir]);
    assert.equal(dry.code, 0);
    assert.equal(dry.err, '');
    assert.deepEqual(snapshot(dir), before);

    const scanned = scanDirectory(dir);
    const result = buildAtlas(scanned.notes);
    assert.equal(dry.out, formatSummary(result));
    const asJson = capture(['--json', '--dir', dir]);
    assert.equal(asJson.code, 0);
    assert.deepEqual(JSON.parse(asJson.out), result);

    const index = result.writes.find(item => item.path === 'garden/INDEX.md').text;
    assert.match(index, /How to grow tomatoes/);
    assert.match(index, /plan%231\.md/);
    assert.match(index, /a%20%28draft%29\.md/);
    assert.match(index, /two%20words\.md/);
    assert.match(index, /herbs\/thyme\.md/);
    const map = result.writes.find(item => item.path === 'MAP.md').text;
    assert.equal(map.startsWith('# Garden and kitchen\n\nAn invented notebook. Start with [the pantry](pantry.md).\n\n<!-- atlas-index:start -->\n'), true);
    assert.equal(map.includes('stale'), false);
    assert.equal(result.health.some(item => item.kind === 'orphan' && item.path === 'pantry.md'), true);
    assert.equal(result.health.some(item => item.kind === 'orphan' && item.path === 'garden/tomatoes.md'), false);
    assert.deepEqual(
      result.health.filter(item => item.kind === 'broken-link').map(item => `${item.path} ${item.detail}`),
      ['pantry.md missing.md'],
    );

    const wrote = capture(['--dir', dir, '--write']);
    assert.equal(wrote.code, 0);
    const changed = [];
    const after = new Map(snapshot(dir).map(([full, time, bytes]) => [full, { time, bytes }]));
    for (const [full, time, bytes] of before) {
      const next = after.get(full);
      if (!next || next.time !== time || next.bytes !== bytes) changed.push(full.slice(dir.length + 1));
    }
    for (const [full] of after) {
      if (!before.some(([old]) => old === full)) changed.push(full.slice(dir.length + 1));
    }
    assert.deepEqual(changed.sort(), ['MAP.md', 'garden/INDEX.md']);
    assert.equal(readFileSync(join(dir, 'garden', 'tomatoes.md'), 'utf8'), readFileSync(join(fixture, 'garden', 'tomatoes.md'), 'utf8'));
    assert.equal(readdirSync(dir, { recursive: true }).some(name => String(name).includes('.tmp')), false);

    const again = capture(['--write', '--dir', dir, '--json']);
    assert.equal(again.code, 0);
    const second = JSON.parse(again.out);
    assert.deepEqual(second.writes, []);
    assert.deepEqual(second.removes, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a map edited between the scan and --write is left as edited', () => {
  const dir = copyWiki();
  try {
    const scanned = scanDirectory(dir);
    const edited = 'edited by hand\n';
    writeFileSync(join(dir, 'MAP.md'), edited);
    const applied = applyPlan(dir, scanned, buildAtlas(scanned.notes));
    assert.equal(readFileSync(join(dir, 'MAP.md'), 'utf8'), edited);
    assert.equal(applied.writes.some(item => item.path === 'MAP.md'), false);
    assert.equal(applied.conflicts.some(item => item.path === 'MAP.md' && /left as it is/.test(item.detail)), true);
    assert.equal(statSync(join(dir, 'garden', 'tomatoes.md')).isFile(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a generated index that changed after the scan is not removed', () => {
  const dir = copyWiki();
  try {
    assert.equal(capture(['--dir', dir, '--write']).code, 0);
    for (const name of ['watering.md', 'plan#1.md', 'a (draft).md', 'two words.md']) {
      rmSync(join(dir, 'garden', name));
    }
    const scanned = scanDirectory(dir);
    const planned = buildAtlas(scanned.notes);
    assert.ok(planned.removes.includes('garden/INDEX.md'));
    writeFileSync(join(dir, 'garden', 'INDEX.md'), `${GENERATED_HEADER}\n# garden\n\n- edited\n`);
    const applied = applyPlan(dir, scanned, planned);
    assert.match(readFileSync(join(dir, 'garden', 'INDEX.md'), 'utf8'), /edited/);
    assert.equal(applied.removes.includes('garden/INDEX.md'), false);
    assert.equal(applied.conflicts.some(item => item.path === 'garden/INDEX.md'), true);

    const fresh = scanDirectory(dir);
    const remove = buildAtlas(fresh.notes);
    assert.ok(remove.removes.includes('garden/INDEX.md'));
    const done = applyPlan(dir, fresh, remove);
    assert.equal(done.removes.includes('garden/INDEX.md'), true);
    assert.equal(statExists(join(dir, 'garden', 'INDEX.md')), false);
    assert.equal(statExists(join(dir, 'garden', 'tomatoes.md')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command refuses a folder with .git, the repository root, and a path that is not an index', () => {
  const dir = copyWiki();
  const outside = join(tmpdir(), `atlas-outside-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try {
    writeFileSync(join(dir, '.git'), 'gitdir: /nowhere\n');
    const refused = capture(['--dir', dir, '--write']);
    assert.equal(refused.code, 1);
    assert.match(refused.err, /contains \.git/);
    assert.equal(refused.err.includes(dir), false);
    assert.equal(refused.out, '');
    assert.match(readFileSync(join(dir, 'pantry.md'), 'utf8'), /Pantry/);

    const root = capture(['--dir', repoRoot]);
    assert.equal(root.code, 1);
    assert.match(root.err, /contains \.git/);
    assert.equal(root.out, '');

    rmSync(join(dir, '.git'));
    const scanned = scanDirectory(dir);
    const original = readFileSync(join(dir, 'pantry.md'), 'utf8');
    const badWrite = { ...buildAtlas(scanned.notes), writes: [{ path: 'pantry.md', text: 'nope\n' }] };
    assert.throws(() => applyPlan(dir, scanned, badWrite), /not an index or the map/);
    assert.equal(readFileSync(join(dir, 'pantry.md'), 'utf8'), original);
    assert.equal(statExists(join(dir, 'garden', 'INDEX.md')), false);

    const escape = { writes: [{ path: '../INDEX.md', text: `${GENERATED_HEADER}\n` }], removes: [], conflicts: [], health: [], counts: {} };
    assert.throws(() => applyPlan(dir, scanned, escape), /outside the folder/);
    mkdirSync(outside, { recursive: true });
    assert.equal(statExists(join(outside, 'INDEX.md')), false);

    const handmade = join(dir, 'INDEX.md');
    writeFileSync(handmade, '# Handmade\n');
    const withHand = scanDirectory(dir);
    const forced = { ...buildAtlas(withHand.notes), removes: ['INDEX.md'] };
    const kept = applyPlan(dir, withHand, forced);
    assert.match(readFileSync(handmade, 'utf8'), /Handmade/);
    assert.equal(kept.conflicts.some(item => item.path === 'INDEX.md'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('hidden folders and symbolic links are skipped, and a hidden note is read', () => {
  const dir = copyWiki();
  const outside = join(tmpdir(), `atlas-linked-${process.pid}-${Math.random().toString(16).slice(2)}`);
  try {
    mkdirSync(join(dir, '.secret'), { recursive: true });
    writeFileSync(join(dir, '.secret', 'hidden.md'), '# Hidden\nSee [gone](missing.md).\n');
    writeFileSync(join(dir, '.note.md'), '# Secret note\n');
    writeFileSync(join(dir, 'SKIP.MD'), '# Upper\n');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'outside.md'), '# Outside\n');
    symlinkSync(join(outside, 'outside.md'), join(dir, 'linked.md'));
    symlinkSync(outside, join(dir, 'linked-dir'));

    const scanned = scanDirectory(dir);
    const paths = scanned.notes.map(item => item.path).sort();
    assert.equal(paths.includes('.note.md'), true);
    assert.equal(paths.includes('.secret/hidden.md'), false);
    assert.equal(paths.includes('linked.md'), false);
    assert.equal(paths.includes('linked-dir/outside.md'), false);
    assert.equal(paths.includes('SKIP.MD'), false);
    const result = buildAtlas(scanned.notes);
    assert.equal(result.health.some(item => item.path === '.secret/hidden.md'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('linux keeps two markdown paths that differ only by case', () => {
  assert.equal(process.platform === 'darwin' || process.platform === 'linux', true);
  if (process.platform === 'darwin') return;
  const dir = copyWiki();
  try {
    writeFileSync(join(dir, 'A.md'), '# Upper\n');
    writeFileSync(join(dir, 'a.md'), '# Lower\n');
    const scanned = scanDirectory(dir);
    assert.equal(scanned.notes.some(item => item.path === 'A.md'), true);
    assert.equal(scanned.notes.some(item => item.path === 'a.md'), true);
    assert.equal(buildAtlas(scanned.notes).counts.notes > 0, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed rename stops the run and leaves the folder unchanged', () => {
  const dir = copyWiki();
  try {
    const before = snapshot(dir);
    const scanned = scanDirectory(dir);
    const failing = Object.create(fs);
    failing.renameSync = () => { throw new Error('disk full'); };
    assert.throws(() => applyPlan(dir, scanned, buildAtlas(scanned.notes), failing), /Could not write/);
    assert.deepEqual(snapshot(dir), before);
    assert.equal(readdirSync(dir, { recursive: true }).some(name => String(name).includes('.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a decomposed folder name is written with the spelling on disk', () => {
  const dir = join(tmpdir(), `atlas-nfd-${process.pid}-${Math.random().toString(16).slice(2)}`);
  const folder = 'café'.normalize('NFD');
  try {
    mkdirSync(join(dir, folder), { recursive: true });
    for (let i = 0; i < 6; i += 1) writeFileSync(join(dir, folder, `n${i}.md`), `# N${i}\n`);
    const wrote = capture(['--dir', dir, '--write']);
    assert.equal(wrote.code, 0, wrote.err);
    const listed = readdirSync(dir).find(name => name.normalize('NFC') === folder.normalize('NFC'));
    assert.equal(statSync(join(dir, listed, 'INDEX.md')).isFile(), true);
    const map = readFileSync(join(dir, 'MAP.md'), 'utf8');
    const linked = /\(([^)]+INDEX\.md)\)/.exec(map);
    assert.equal(linked[1].split('/').map(part => decodeURIComponent(part)).join('/'), `${listed}/INDEX.md`);
    if (process.platform !== 'darwin' && listed !== folder.normalize('NFC')) {
      assert.equal(statExists(join(dir, folder.normalize('NFC'))), false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a new index is private and a replacement keeps the mode it already has', () => {
  const dir = copyWiki();
  try {
    rmSync(join(dir, 'MAP.md'));
    assert.equal(capture(['--dir', dir, '--write']).code, 0);
    const map = join(dir, 'MAP.md');
    const index = join(dir, 'garden', 'INDEX.md');
    assert.equal(statSync(map).mode & 0o777, 0o600);
    assert.equal(statSync(index).mode & 0o777, 0o600);
    chmodSync(map, 0o640);
    chmodSync(index, 0o604);
    writeFileSync(join(dir, 'pantry.md'), '# Larder\n\nFlour.\n');
    writeFileSync(join(dir, 'garden', 'basil.md'), '# Window basil\n');
    const again = capture(['--dir', dir, '--write']);
    assert.equal(again.code, 0, again.err);
    assert.equal(statSync(map).mode & 0o777, 0o640);
    assert.equal(statSync(index).mode & 0o777, 0o604);
    assert.match(readFileSync(map, 'utf8'), /Larder/);
    assert.match(readFileSync(index, 'utf8'), /Window basil/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command refuses a missing folder and unknown arguments', () => {
  const missingDir = join(tmpdir(), 'atlas-does-not-exist');
  const missing = capture(['--dir', missingDir]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /Could not read this folder/);
  assert.equal(missing.err.includes(missingDir), false);
  assert.equal(missing.out, '');

  const bare = capture([]);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /--dir needs a folder/);

  const twice = capture(['--dir', fixture, '--dir', fixture]);
  assert.equal(twice.code, 1);
  assert.match(twice.err, /twice/);

  const unknown = capture(['--dir', fixture, '--force']);
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /Unknown argument/);

  const flag = capture(['--write']);
  assert.equal(flag.code, 1);
  assert.equal(flag.out, '');
});

function statExists(file) {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}
