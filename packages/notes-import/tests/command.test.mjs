import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HouseholdLists } from '../../household-lists/src/index.mjs';
import { EMPTY_NOTE, IMPORT_DEVICE_ID, IMPORT_TIME, LIMITS, formatReport, parseChecklist } from '../src/index.mjs';
import { readBounded, runImport, writeListFile } from '../src/import.mjs';

const sample = readFileSync(new URL('../samples/grocery.txt', import.meta.url), 'utf8');

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'notes-import-'));
}

function scripted(chunks) {
  let index = 0;
  return (_fd, buffer) => {
    if (index >= chunks.length) return 0;
    const chunk = chunks[index];
    index += 1;
    chunk.copy(buffer, 0, 0, Math.min(chunk.length, buffer.length));
    return Math.min(chunk.length, buffer.length);
  };
}

test('a dry run writes nothing and shows the checklist', () => {
  const dir = tempDir();
  try {
    const note = join(dir, 'note.txt');
    writeFileSync(note, sample);
    const before = readdirSync(dir);
    const result = runImport(['--in', note]);
    assert.equal(result.code, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout, formatReport(parseChecklist(sample)));
    assert.match(result.stdout, /Title: Weekend groceries/);
    assert.match(result.stdout, /Produce\n\[ \] apples/);
    assert.match(result.stdout, /\[x\] lemons/);
    assert.deepEqual(readdirSync(dir), before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('--out writes a private file, refuses to replace it, then replaces it with --force', () => {
  const dir = tempDir();
  try {
    const note = join(dir, 'note.txt');
    const out = join(dir, 'list.json');
    writeFileSync(note, sample);
    const wrote = runImport(['--in', note, '--out', out]);
    assert.equal(wrote.code, 0);
    assert.match(wrote.stdout, new RegExp(`Wrote ${out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\n$`));
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const first = readFileSync(out);
    assert.equal(first.includes(10), false);
    const saved = JSON.parse(first.toString('utf8'));
    assert.equal(saved.fields.name.stamp.device, IMPORT_DEVICE_ID);
    assert.equal(saved.fields.name.stamp.time, IMPORT_TIME);
    const engine = new HouseholdLists({ deviceId: 'reader', now: () => IMPORT_TIME });
    const loaded = engine.load(first.toString('utf8'));
    assert.equal(engine.view(loaded.id).name, 'Weekend groceries');

    const again = runImport(['--in', note, '--out', out]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /nothing was written/);
    assert.match(again.stderr, /--force/);
    assert.deepEqual(readFileSync(out), first);

    const forced = runImport(['--in', note, '--out', out, '--force']);
    assert.equal(forced.code, 0);
    assert.equal(statSync(out).mode & 0o777, 0o600);
    const second = readFileSync(out);
    assert.notDeepEqual(second, first);
    const reloaded = new HouseholdLists({ deviceId: 'reader', now: () => IMPORT_TIME });
    assert.equal(reloaded.view(reloaded.load(second.toString('utf8')).id).items.length, 8);
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a bad note and an empty note leave an existing list whole', () => {
  const dir = tempDir();
  try {
    const out = join(dir, 'list.json');
    const note = join(dir, 'empty.txt');
    writeFileSync(out, '{"keep":true}\n');
    writeFileSync(note, '\n\n');
    const before = readFileSync(out);
    const blank = runImport(['--in', note, '--out', out, '--force']);
    assert.equal(blank.code, 1);
    assert.equal(blank.stderr, `${EMPTY_NOTE}\n`);
    assert.equal(blank.stdout, '');

    const titled = runImport(['--title', 'Saturday', '--in', '-', '--out', out], { input: '\n' });
    assert.equal(titled.code, 1);
    assert.match(titled.stderr, /Title: Saturday/);

    const control = runImport(['--in', '-', '--out', out, '--force'], { input: 'Title\n- milk\u0000\n' });
    assert.equal(control.code, 1);
    assert.match(control.stderr, /Line 2 has a control character, so nothing was written/);
    assert.deepEqual(readFileSync(out), before);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('the command refuses a missing note, a folder, a huge file, and a note that is not text', () => {
  const dir = tempDir();
  try {
    const missing = runImport(['--in', join(dir, 'missing.txt')]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /could not be read/);

    const folder = runImport(['--in', dir]);
    assert.match(folder.stderr, /folder/);

    const big = join(dir, 'big.txt');
    writeFileSync(big, Buffer.alloc(LIMITS.bytes + 1, 0x61));
    const huge = runImport(['--in', big, '--out', join(dir, 'out.json')]);
    assert.match(huge.stderr, /larger than 1,048,576 bytes/);
    assert.equal(readdirSync(dir).includes('out.json'), false);

    const binary = join(dir, 'binary.txt');
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00]));
    const bad = runImport(['--in', binary]);
    assert.match(bad.stderr, /not plain text/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('stdin, titles, help, and overlapping paths', () => {
  const dir = tempDir();
  try {
    const pasted = runImport(['--in', '-'], { input: '- milk\n- eggs\n' });
    assert.equal(pasted.code, 0);
    assert.match(pasted.stdout, /Title: Checklist/);
    assert.match(pasted.stdout, /\[ \] milk/);

    const named = runImport(['--in', '-', '--title', 'Saturday market'], { input: 'Produce\n- apples\n' });
    assert.match(named.stdout, /Title: Saturday market/);
    assert.doesNotMatch(named.stdout, /^Produce$/m);

    const help = runImport(['--help']);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /--in -/);

    assert.match(runImport([]).stderr, /--in/);
    assert.match(runImport(['--force']).stderr, /--in/);
    assert.match(runImport(['--in', 'note.txt', '--force']).stderr, /--out/);
    assert.match(runImport(['--in']).stderr, /Add a value/);
    assert.match(runImport(['--in', 'a', '--in', 'b']).stderr, /only once/);
    assert.match(runImport(['--nope']).stderr, /Unknown option/);

    const note = join(dir, 'note.txt');
    writeFileSync(note, sample);
    const same = runImport(['--in', note, '--out', note]);
    assert.match(same.stderr, /replace the note/);
    assert.equal(readFileSync(note, 'utf8'), sample);

    const nested = join(dir, 'missing-folder', 'list.json');
    const nowhere = runImport(['--in', note, '--out', nested]);
    assert.match(nowhere.stderr, /folder for that list does not exist/);

    mkdirSync(join(dir, 'subdir'));
    const asFolder = runImport(['--in', note, '--out', join(dir, 'subdir')]);
    assert.match(asFolder.stderr, /output path is a folder/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test('a write is a temporary file plus a rename', () => {
  const dir = '/tmp/notes-import-fake';
  const out = join(dir, 'list.json');
  const fileSystem = fakeFs();
  fileSystem.dirs.add(dir);
  const result = runImport(['--in', '-', '--out', out], { input: sample, fileSystem });
  assert.equal(result.code, 0);
  const names = fileSystem.calls.map(call => call[0]);
  assert.deepEqual(names.filter(name => name !== 'stat'), ['open', 'write', 'chmod', 'fsync', 'close', 'rename']);
  const opened = fileSystem.calls.find(call => call[0] === 'open');
  const renamed = fileSystem.calls.find(call => call[0] === 'rename');
  assert.equal(opened[1] === out, false);
  assert.match(opened[1], /\.tmp$/);
  assert.equal(opened[2], 'wx');
  assert.equal(opened[3], 0o600);
  assert.equal(fileSystem.calls.find(call => call[0] === 'chmod')[2], 0o600);
  assert.equal(renamed[1], opened[1]);
  assert.equal(renamed[2], out);
  assert.equal(fileSystem.files.has(opened[1]), false);
  const engine = new HouseholdLists({ deviceId: 'reader', now: () => IMPORT_TIME });
  const loaded = engine.load(fileSystem.files.get(out).data);
  assert.equal(engine.view(loaded.id).sectionsEnabled, true);

  const blocked = fakeFs({ existing: { path: out, data: 'KEEP' } });
  blocked.dirs.add(dir);
  const refused = runImport(['--in', '-', '--out', out], { input: sample, fileSystem: blocked });
  assert.equal(refused.code, 1);
  assert.equal(blocked.files.get(out).data, 'KEEP');
  assert.equal(blocked.calls.some(call => call[0] === 'open'), false);

  const failing = fakeFs({ failRename: true });
  failing.dirs.add(dir);
  const failed = runImport(['--in', '-', '--out', out, '--force'], { input: sample, fileSystem: failing });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /could not be written/);
  assert.equal(failing.files.has(out), false);
  assert.equal(failing.calls.some(call => call[0] === 'unlink'), true);
});

test('readBounded stops one byte past the limit', () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const exact = scripted(Array.from({ length: 16 }, () => chunk));
  const bytes = readBounded(exact, LIMITS.bytes);
  assert.equal(bytes.length, LIMITS.bytes);
  assert.throws(() => readBounded(scripted([...Array.from({ length: 16 }, () => chunk), Buffer.from('x')]), LIMITS.bytes), /1,048,576/);
});

test('writeListFile on a real folder uses mode 0600', () => {
  const dir = tempDir();
  try {
    const out = join(dir, 'list.json');
    writeListFile(out, '{"ok":true}');
    assert.equal(statSync(out).mode & 0o777, 0o600);
    assert.equal(readFileSync(out, 'utf8'), '{"ok":true}');
    assert.throws(() => writeListFile(out, '{"ok":false}'), /nothing was written/);
    assert.equal(readFileSync(out, 'utf8'), '{"ok":true}');
    writeListFile(out, '{"ok":false}', { force: true });
    assert.equal(readFileSync(out, 'utf8'), '{"ok":false}');
    assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

function fakeFs({ failRename = false, existing = null } = {}) {
  const calls = [];
  const files = new Map();
  const dirs = new Set();
  const open = new Map();
  let fd = 0;
  if (existing) files.set(existing.path, { mode: 0o644, data: existing.data });
  return {
    calls,
    files,
    dirs,
    statSync(path) {
      calls.push(['stat', path]);
      if (dirs.has(path)) return { isDirectory: () => true, isFile: () => false };
      const file = files.get(path);
      if (!file) {
        const error = new Error(`missing ${path}`);
        error.code = 'ENOENT';
        throw error;
      }
      return { isDirectory: () => false, isFile: () => true, mode: file.mode };
    },
    openSync(path, flag, mode) {
      calls.push(['open', path, flag, mode]);
      if (String(flag).includes('x') && files.has(path)) {
        const error = new Error('exists');
        error.code = 'EEXIST';
        throw error;
      }
      fd += 1;
      files.set(path, { mode, data: '' });
      open.set(fd, path);
      return fd;
    },
    writeSync(handle, buffer, offset, length) {
      calls.push(['write', open.get(handle)]);
      const file = files.get(open.get(handle));
      file.data += buffer.subarray(offset, offset + length).toString('utf8');
      return length;
    },
    fchmodSync(handle, mode) {
      calls.push(['chmod', open.get(handle), mode]);
      files.get(open.get(handle)).mode = mode;
    },
    fsyncSync(handle) {
      calls.push(['fsync', open.get(handle)]);
    },
    closeSync(handle) {
      calls.push(['close', open.get(handle)]);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
      if (failRename) throw Object.assign(new Error('disk full'), { code: 'EIO' });
      files.set(to, files.get(from));
      files.delete(from);
    },
    unlinkSync(path) {
      calls.push(['unlink', path]);
      files.delete(path);
    },
  };
}
