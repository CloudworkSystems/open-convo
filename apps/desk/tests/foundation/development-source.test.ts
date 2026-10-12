import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { copyAllowedSourceFiles, DEVELOPMENT_SOURCE_FILES } from '../../scripts/development-source.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'true-convo-source-copy-'));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  const outside = join(root, 'outside');
  for (const path of [source, destination, outside]) mkdirSync(path);
  return { root, source, destination, outside, clean: () => rmSync(root, { recursive: true, force: true }) };
}

function populate(source: string, paths: readonly string[], contents = 'invented source fixture') {
  for (const path of paths) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), contents);
  }
}

function copiedFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? copiedFiles(root, path) : [path];
  }).sort();
}

test('the development source manifest leaves arbitrary ignored owner records and credentials untouched', () => {
  for (const manifest of [DEVELOPMENT_SOURCE_FILES]) {
    const files = fixture();
    try {
      populate(files.source, manifest);
      const privatePaths = [
        '.env', '.env.local', '.npmrc', 'owner.log', 'export.json',
        'exports/conversations.json', 'notes/private.md', 'signing/owner.p8',
        '.true-convo-local/retained.json', 'runtime-state/owner.json',
        'scripts/untracked-owner.log', 'src/untracked-private.json',
      ];
      populate(files.source, privatePaths, 'invented-owner-canary-never-copy');
      copyAllowedSourceFiles(files.source, files.destination, manifest);
      assert.deepEqual(copiedFiles(files.destination), [...manifest].sort());
      for (const path of privatePaths) {
        assert.equal(existsSync(join(files.destination, path)), false);
        assert.equal(readFileSync(join(files.source, path), 'utf8'), 'invented-owner-canary-never-copy');
      }
    } finally { files.clean(); }
  }
});

test('unknown files and escaping manifest paths are rejected before any copy', () => {
  const files = fixture();
  try {
    populate(files.source, ['package.json']);
    for (const path of ['.env', 'untracked-owner.json', '../outside/owner.json', '/outside/owner.json', 'scripts/../package.json', '..\\owner.json', 'C:\\owner.json']) {
      assert.throws(() => copyAllowedSourceFiles(files.source, files.destination, [path]), /inside|allowlist|escapes/);
      assert.deepEqual(copiedFiles(files.destination), []);
    }
  } finally { files.clean(); }
});

test('allowlisted source file and parent symlinks cannot expose another directory', () => {
  const files = fixture();
  try {
    writeFileSync(join(files.outside, 'owner.json'), 'invented-outside-owner');
    symlinkSync(join(files.outside, 'owner.json'), join(files.source, 'package.json'));
    assert.throws(() => copyAllowedSourceFiles(files.source, files.destination, ['package.json']), /regular file.*symlink/);
    symlinkSync(files.outside, join(files.source, 'src'), 'dir');
    writeFileSync(join(files.outside, 'main.tsx'), 'invented-outside-owner');
    assert.throws(() => copyAllowedSourceFiles(files.source, files.destination, ['src/main.tsx']), /Source parent.*symlink/);
    assert.deepEqual(copiedFiles(files.destination), []);
    assert.equal(readFileSync(join(files.outside, 'owner.json'), 'utf8'), 'invented-outside-owner');
  } finally { files.clean(); }
});

test('directories cannot stand in for source files and a symlinked root is refused', () => {
  const files = fixture();
  try {
    mkdirSync(join(files.source, 'package.json'));
    assert.throws(() => copyAllowedSourceFiles(files.source, files.destination, ['package.json']), /regular file/);
    const alias = join(files.root, 'source-alias');
    symlinkSync(files.source, alias, 'dir');
    assert.throws(() => copyAllowedSourceFiles(alias, files.destination, ['package.json']), /Source root.*symlink/);
    assert.deepEqual(copiedFiles(files.destination), []);
  } finally { files.clean(); }
});

test('an allowlisted source hardlink cannot expose an invented outside owner file', () => {
  const files = fixture();
  try {
    const canary = join(files.outside, 'owner.json');
    writeFileSync(canary, 'invented-outside-owner-never-copy');
    linkSync(canary, join(files.source, 'index.html'));
    assert.throws(() => copyAllowedSourceFiles(files.source, files.destination, ['index.html']), /hardlink/);
    assert.deepEqual(copiedFiles(files.destination), []);
    assert.equal(readFileSync(canary, 'utf8'), 'invented-outside-owner-never-copy');
  } finally { files.clean(); }
});

test('destination symlinks cannot redirect copies or overwrite existing outside contents', () => {
  const files = fixture();
  try {
    populate(files.source, ['package.json', 'src/main.tsx']);
    writeFileSync(join(files.outside, 'owner.json'), 'invented-outside-owner');
    symlinkSync(files.outside, join(files.destination, 'src'), 'dir');
    assert.throws(() => copyAllowedSourceFiles(files.source, files.destination, ['src/main.tsx']), /Destination parent.*symlink/);
    assert.equal(existsSync(join(files.outside, 'main.tsx')), false);
    symlinkSync(join(files.outside, 'owner.json'), join(files.destination, 'package.json'));
    assert.throws(() => copyAllowedSourceFiles(files.source, files.destination, ['package.json']), /EEXIST/);
    assert.equal(readFileSync(join(files.outside, 'owner.json'), 'utf8'), 'invented-outside-owner');
  } finally { files.clean(); }
});
