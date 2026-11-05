import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildAtlas } from '../../atlas-index/src/index.mjs';
import { run } from '../src/repair.mjs';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
let seq = 0;

function tempDir() {
  const dir = path.join(tmpdir(), `atlas-links-${process.pid}-${seq += 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeNote(dir, notePath, text) {
  const full = path.join(dir, ...notePath.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, text);
}

function readNote(dir, notePath) {
  return readFileSync(path.join(dir, ...notePath.split('/')), 'utf8');
}

async function capture(argv, io = {}) {
  let out = '';
  let err = '';
  const code = await run(argv, {
    stdout: text => { out += text; },
    stderr: text => { err += text; },
    ...io,
  });
  return { code, out, err };
}

function tree(dir) {
  const out = [];
  const walk = current => {
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const listed = lstatSync(full);
      if (listed.isDirectory()) walk(full);
      else out.push([path.relative(dir, full).split(path.sep).join('/'), readFileSync(full).toString('base64'), listed.mode & 0o777]);
    }
  };
  walk(dir);
  return out.sort((a, b) => a[0] < b[0] ? -1 : 1);
}

function deadPid() {
  for (let pid = 1_000_000; pid < 1_000_200; pid += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
  }
  throw new Error('no unused pid');
}

function move(dir, from, to) {
  const target = path.join(dir, ...to.split('/'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, readFileSync(path.join(dir, ...from.split('/'))));
  rmSync(path.join(dir, ...from.split('/')));
}

test('a dry run writes nothing, and --write then a second run leaves the notes', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'pantry.md', 'See [basil](basil.md).\n');
    writeNote(dir, 'recipes/soup.md', 'Use [basil](../basil.md).\n');
    writeNote(dir, 'garden/beds/layout.md', 'See [basil](../../basil.md).\n');
    writeNote(dir, 'basil.md', '# Basil\n');
    chmodSync(path.join(dir, 'pantry.md'), 0o640);
    const recorded = await capture(['--dir', dir, '--record']);
    assert.equal(recorded.code, 0);
    assert.match(recorded.out, /Recorded 4 notes/);
    assert.equal(statSync(path.join(dir, '.atlas-links', 'paths.json')).mode & 0o777, 0o600);
    assert.equal(statSync(path.join(dir, '.atlas-links')).mode & 0o777, 0o700);
    move(dir, 'basil.md', 'garden/basil.md');
    const before = tree(dir);
    const dry = await capture(['--dir', dir]);
    assert.equal(dry.code, 0);
    assert.equal(dry.err, '');
    assert.match(dry.out, /pantry.md:1 basil.md → garden\/basil.md/);
    assert.match(dry.out, /recipes\/soup.md:1 \.\.\/basil.md → \.\.\/garden\/basil.md/);
    assert.match(dry.out, /garden\/beds\/layout.md:1 \.\.\/\.\.\/basil.md → \.\.\/basil.md/);
    assert.deepEqual(tree(dir), before);
    const asJson = await capture(['--json', '--dir', dir]);
    assert.equal(asJson.code, 0);
    assert.equal(JSON.parse(asJson.out).repairs.length, 3);

    const wrote = await capture(['--dir', dir, '--write']);
    assert.equal(wrote.code, 0);
    assert.equal(readNote(dir, 'pantry.md'), 'See [basil](garden/basil.md).\n');
    assert.equal(readNote(dir, 'recipes/soup.md'), 'Use [basil](../garden/basil.md).\n');
    assert.equal(readNote(dir, 'garden/beds/layout.md'), 'See [basil](../basil.md).\n');
    assert.equal(statSync(path.join(dir, 'pantry.md')).mode & 0o777, 0o640);
    assert.equal(readdirSync(dir, { recursive: true }).some(name => String(name).includes('.tmp')), false);
    assert.equal(readdirSync(path.join(dir, '.atlas-links')).includes('run.lock'), false);
    const health = buildAtlas([
      { path: 'pantry.md', text: readNote(dir, 'pantry.md') },
      { path: 'recipes/soup.md', text: readNote(dir, 'recipes/soup.md') },
      { path: 'garden/beds/layout.md', text: readNote(dir, 'garden/beds/layout.md') },
      { path: 'garden/basil.md', text: readNote(dir, 'garden/basil.md') },
    ]).health.filter(item => item.kind === 'broken-link');
    assert.deepEqual(health, []);
    const again = await capture(['--dir', dir, '--write', '--json']);
    assert.equal(again.code, 0);
    const second = JSON.parse(again.out);
    assert.deepEqual(second.repairs, []);
    assert.equal(second.snapshotKept, false);
    assert.equal(readNote(dir, 'pantry.md'), 'See [basil](garden/basil.md).\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a note edited during the pause is skipped and the next run repairs it', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'old/a.md', 'See [c](../c.md).\n');
    writeNote(dir, 'c.md', '# Cee\n');
    writeNote(dir, 'z.md', 'See [a](old/a.md).\n');
    assert.equal((await capture(['--dir', dir, '--record'])).code, 0);
    move(dir, 'old/a.md', 'archive/a.md');
    move(dir, 'c.md', 'plots/c.md');
    const input = new PassThrough();
    let out = '';
    const pending = run(['--dir', dir, '--write', '--pause-before-write'], {
      stdin: input,
      stdout: text => { out += text; },
      stderr: text => { out += text; },
    });
    assert.match(out, /Paused before writing/);
    writeFileSync(path.join(dir, 'z.md'), 'See [a](old/a.md).\nExtra.\n');
    input.end('\n');
    assert.equal(await pending, 0);
    assert.match(out, /Skipped z\.md because it changed after the scan/);
    assert.match(out, /Kept the old snapshot/);
    assert.match(readNote(dir, 'archive/a.md'), /\.\.\/plots\/c\.md/);
    assert.match(readNote(dir, 'z.md'), /\(old\/a\.md\)/);
    const second = await capture(['--dir', dir, '--write']);
    assert.equal(second.code, 0);
    assert.match(readNote(dir, 'z.md'), /archive\/a\.md/);
    assert.doesNotMatch(second.out, /Kept the old snapshot/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a destination that disappears, changes, or becomes a link is skipped', async () => {
  const cases = ['delete', 'edit', 'replace', 'symlink'];
  for (const kind of cases) {
    const dir = tempDir();
    try {
      writeNote(dir, 'old/a.md', 'See [c](../c.md).\n');
      writeNote(dir, 'c.md', '# Cee\n');
      writeNote(dir, 'z.md', 'See [a](old/a.md).\n');
      assert.equal((await capture(['--dir', dir, '--record'])).code, 0);
      move(dir, 'old/a.md', 'archive/a.md');
      move(dir, 'c.md', 'plots/c.md');
      const input = new PassThrough();
      let out = '';
      const pending = run(['--dir', dir, '--write', '--pause-before-write'], {
        stdin: input,
        stdout: text => { out += text; },
        stderr: text => { out += text; },
      });
      assert.match(out, /Paused before writing/);
      const dest = path.join(dir, 'plots', 'c.md');
      if (kind === 'delete') rmSync(dest);
      if (kind === 'edit') writeFileSync(dest, '# Cee\nEdited.\n');
      if (kind === 'replace') writeFileSync(dest, '# Replaced\n');
      if (kind === 'symlink') {
        rmSync(dest);
        symlinkSync(path.join(dir, 'z.md'), dest);
      }
      input.end('\n');
      assert.equal(await pending, 0, kind);
      assert.match(out, /Skipped archive\/a\.md because plots\/c\.md/, kind);
      assert.match(out, /Kept the old snapshot/);
      assert.match(readNote(dir, 'z.md'), /archive\/a\.md/);
      if (kind !== 'symlink' && kind !== 'delete') assert.equal(readFileSync(dest, 'utf8').includes('plots'), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('two moved notes that link to each other are both repaired', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'old/a.md', 'See [b](../old/b.md).\n');
    writeNote(dir, 'old/b.md', 'See [a](../old/a.md).\n');
    assert.equal((await capture(['--dir', dir, '--record'])).code, 0);
    move(dir, 'old/a.md', 'nest/a.md');
    move(dir, 'old/b.md', 'pot/b.md');
    const wrote = await capture(['--dir', dir, '--write']);
    assert.equal(wrote.code, 0);
    assert.equal(readNote(dir, 'nest/a.md'), 'See [b](../pot/b.md).\n');
    assert.equal(readNote(dir, 'pot/b.md'), 'See [a](../nest/a.md).\n');
    const broken = buildAtlas([
      { path: 'nest/a.md', text: readNote(dir, 'nest/a.md') },
      { path: 'pot/b.md', text: readNote(dir, 'pot/b.md') },
    ]).health.filter(item => item.kind === 'broken-link');
    assert.deepEqual(broken, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash after one write still lets the next run repair the skipped link', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'old/a.md', 'See [c](../c.md).\n');
    writeNote(dir, 'c.md', '# Cee\n');
    writeNote(dir, 'z.md', 'See [a](old/a.md).\n');
    assert.equal((await capture(['--dir', dir, '--record'])).code, 0);
    move(dir, 'old/a.md', 'archive/a.md');
    move(dir, 'c.md', 'plots/c.md');
    const snapshotBefore = readFileSync(path.join(dir, '.atlas-links', 'paths.json'), 'utf8');
    await assert.rejects(
      () => run(['--dir', dir, '--write'], { crashAfterWrites: 1, stdout() {}, stderr() {} }),
      /Stopped before the snapshot/,
    );
    assert.match(readNote(dir, 'archive/a.md'), /\.\.\/plots\/c\.md/);
    assert.match(readNote(dir, 'z.md'), /\(old\/a\.md\)/);
    assert.equal(readFileSync(path.join(dir, '.atlas-links', 'paths.json'), 'utf8'), snapshotBefore);
    const journal = JSON.parse(readFileSync(path.join(dir, '.atlas-links', 'journal.json'), 'utf8'));
    assert.ok(journal.notes.some(item => item.path === 'archive/a.md'));
    assert.equal(lstatSync(path.join(dir, '.atlas-links')).isDirectory(), true);
    const blocked = await capture(['--dir', dir, '--record']);
    assert.equal(blocked.code, 1);
    assert.match(blocked.err, /Run --write to finish it before recording/);
    const second = await capture(['--dir', dir, '--write']);
    assert.equal(second.code, 0);
    assert.match(readNote(dir, 'z.md'), /archive\/a\.md/);
    assert.equal(readdirSync(path.join(dir, '.atlas-links')).includes('journal.json'), false);
    const saved = JSON.parse(readFileSync(path.join(dir, '.atlas-links', 'paths.json'), 'utf8'));
    const z = saved.notes.find(item => item.path === 'z.md');
    assert.equal(z.sha256, createHash('sha256').update(readNote(dir, 'z.md')).digest('hex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a stale or empty lock is cleared, and a live reclaim lock is not', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'a.md', '# A\n');
    const meta = path.join(dir, '.atlas-links');
    mkdirSync(meta);
    const pid = deadPid();
    writeFileSync(path.join(meta, 'run.lock'), `${pid}\n${hostname()}\n`);
    writeFileSync(path.join(meta, 'journal.json'), JSON.stringify({
      notes: [{ path: 'a.md', before: 'a'.repeat(64), after: createHash('sha256').update('# A\n').digest('hex') }],
    }));
    const cleared = await capture(['--dir', dir, '--record']);
    assert.equal(cleared.code, 1);
    assert.match(cleared.err, /Run --write/);
    rmSync(path.join(meta, 'journal.json'));
    writeFileSync(path.join(meta, 'run.lock'), '');
    const empty = await capture(['--dir', dir, '--record']);
    assert.equal(empty.code, 0);
    assert.match(empty.out, /cleared its lock/);
    writeFileSync(path.join(meta, 'run.lock'), `1\nother-host\n`);
    const other = await capture(['--dir', dir, '--record']);
    assert.equal(other.code, 1);
    assert.match(other.err, /another computer/);
    assert.equal(readFileSync(path.join(meta, 'run.lock'), 'utf8'), '1\nother-host\n');
    rmSync(path.join(meta, 'run.lock'));
    writeFileSync(path.join(meta, 'run.lock.reclaim'), `${pid}\n${hostname()}\n`);
    const stuck = await capture(['--dir', dir, '--write']);
    assert.equal(stuck.code, 1);
    assert.match(stuck.err, /--unlock/);
    assert.equal(readNote(dir, 'a.md'), '# A\n');
    const unlocked = await capture(['--dir', dir, '--unlock']);
    assert.equal(unlocked.code, 0);
    assert.match(unlocked.out, /Removed \.atlas-links\/run\.lock\.reclaim/);
    assert.equal(readdirSync(meta).includes('run.lock.reclaim'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one recoverer proceeds and the other stops', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'a.md', '# A\n');
    mkdirSync(path.join(dir, '.atlas-links'));
    writeFileSync(path.join(dir, '.atlas-links', 'run.lock'), `${deadPid()}\n${hostname()}\n`);
    let err = '';
    let second;
    const code = await run(['--dir', dir, '--record'], {
      stdout() {},
      stderr: text => { err += text; },
      onReclaim() {
        second = run(['--dir', dir, '--record'], {
          stdout() {},
          stderr: text => { err += text; },
        });
      },
    });
    assert.equal(code, 0);
    assert.equal(await second, 1);
    assert.match(err, /Another command is recovering/);
    assert.equal(statSync(path.join(dir, 'a.md')).isFile(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second write stops while the first one is paused', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'a.md', 'See [b](b.md).\n');
    writeNote(dir, 'b.md', '# Bee\n');
    assert.equal((await capture(['--dir', dir, '--record'])).code, 0);
    move(dir, 'b.md', 'nest/b.md');
    const input = new PassThrough();
    let out = '';
    const pending = run(['--dir', dir, '--write', '--pause-before-write'], {
      stdin: input,
      stdout: text => { out += text; },
      stderr: text => { out += text; },
    });
    assert.match(out, /Paused before writing/);
    const second = await capture(['--dir', dir, '--write']);
    assert.equal(second.code, 1);
    assert.match(second.err, /already running/);
    assert.match(readNote(dir, 'a.md'), /\(b\.md\)/);
    input.end('\n');
    assert.equal(await pending, 0);
    assert.match(readNote(dir, 'a.md'), /nest\/b\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsafe folders, hidden files, links, and bad bytes are refused', async () => {
  const gitDir = tempDir();
  const hidden = tempDir();
  const bad = tempDir();
  const linked = tempDir();
  try {
    mkdirSync(path.join(gitDir, '.git'));
    writeNote(gitDir, 'a.md', '# A\n');
    const git = await capture(['--dir', gitDir, '--record']);
    assert.equal(git.code, 1);
    assert.match(git.err, /contains \.git/);
    assert.equal(readNote(gitDir, 'a.md'), '# A\n');

    const root = await capture(['--dir', repoRoot, '--record']);
    assert.equal(root.code, 1);
    assert.match(root.err, /contains \.git/);

    writeNote(hidden, 'visible.md', 'See [b](b.md).\n');
    writeNote(hidden, '.secret/hidden.md', 'See [b](b.md).\n');
    writeNote(hidden, 'b.md', '# Bee\n');
    const outside = tempDir();
    writeNote(outside, 'outside.md', '# Out\n');
    symlinkSync(path.join(outside, 'outside.md'), path.join(hidden, 'link.md'));
    symlinkSync(outside, path.join(hidden, 'linked-dir'));
    assert.equal((await capture(['--dir', hidden, '--record'])).code, 0);
    move(hidden, 'b.md', 'nest/b.md');
    assert.equal((await capture(['--dir', hidden, '--write'])).code, 0);
    assert.match(readNote(hidden, 'visible.md'), /nest\/b\.md/);
    assert.match(readNote(hidden, '.secret/hidden.md'), /\(b\.md\)/);
    assert.equal(readFileSync(path.join(outside, 'outside.md'), 'utf8'), '# Out\n');

    writeFileSync(path.join(bad, 'bad.md'), Buffer.from([0xff, 0xfe, 0xfd]));
    const utf = await capture(['--dir', bad, '--write']);
    assert.equal(utf.code, 1);
    assert.match(utf.err, /bad\.md/);
    assert.match(utf.err, /UTF-8/);
    assert.equal(readdirSync(bad).includes('.atlas-links'), false);

    const nfc = tempDir();
    const cafe = 'café.md';
    writeNote(nfc, cafe.normalize('NFC'), '# A\n');
    writeNote(nfc, cafe.normalize('NFD'), '# B\n');
    const dup = await capture(['--dir', nfc, '--record']);
    assert.equal(dup.code, 1);
    assert.match(dup.err, /listed twice/);
    rmSync(nfc, { recursive: true, force: true });

    writeNote(linked, 'a.md', '# A\n');
    symlinkSync(tempDir(), path.join(linked, '.atlas-links'));
    const link = await capture(['--dir', linked, '--record']);
    assert.equal(link.code, 1);
    assert.match(link.err, /symbolic link/);
    assert.equal(readNote(linked, 'a.md'), '# A\n');

    const messy = tempDir();
    writeNote(messy, 'a.md', '# A\n');
    mkdirSync(path.join(messy, '.atlas-links'));
    writeFileSync(path.join(messy, '.atlas-links', 'paths.json'), '{');
    const malformed = await capture(['--dir', messy, '--write']);
    assert.equal(malformed.code, 1);
    assert.match(malformed.err, /not usable/);
    assert.equal(readNote(messy, 'a.md'), '# A\n');
  } finally {
    rmSync(gitDir, { recursive: true, force: true });
    rmSync(hidden, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
    rmSync(linked, { recursive: true, force: true });
  }
});

test('a fresh folder tells the owner to record before a move can be repaired', async () => {
  const dir = tempDir();
  try {
    writeNote(dir, 'pantry.md', 'See [basil](basil.md).\n');
    writeNote(dir, 'garden/basil.md', '# Basil\n');
    const dry = await capture(['--dir', dir]);
    assert.equal(dry.code, 0);
    assert.match(dry.out, /Run --record/);
    assert.equal(readdirSync(dir).includes('.atlas-links'), false);
    assert.equal((await capture(['--dir', dir, '--write', '--record'])).code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the command does not spawn processes or read the clock', () => {
  const source = readFileSync(new URL('../src/repair.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /child_process|node:https?|node:net|node:dns|Date\.now|new Date|setTimeout|setInterval/);
});
