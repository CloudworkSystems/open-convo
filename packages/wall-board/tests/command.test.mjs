import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';

import { FILE_BYTES } from '../src/errors.mjs';
import { main } from '../src/board.mjs';
import { renderBoard } from '../src/index.mjs';
import { mapleBoard } from './helpers.mjs';

function capture() {
  const out = { stdout: '', stderr: '' };
  return {
    out,
    io: {
      stdout: { write(text) { out.stdout += text; } },
      stderr: { write(text) { out.stderr += text; } },
    },
  };
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'wall-board-'));
}

describe('command', { concurrency: 1 }, () => {
  it('writes the page, refuses to overwrite, and replaces it with --force', () => {
    const dir = tempDir();
    const boardPath = join(dir, 'board.json');
    const outPath = join(dir, 'page.html');
    writeFileSync(boardPath, JSON.stringify(mapleBoard()));
    const cap = capture();
    try {
      assert.equal(main(['--board', boardPath, '--out', outPath], cap.io), 0);
      const html = readFileSync(outPath, 'utf8');
      assert.equal(html, renderBoard(mapleBoard()).html);
      assert.equal(statSync(outPath).mode & 0o777, 0o600);
      assert.match(cap.out.stdout, /Sam: 4 events shown/);
      assert.match(cap.out.stdout, /warning: private, item 2:/);
      assert.equal(cap.out.stderr, '');
      assert.equal(readdirSync(dir).some(name => name.endsWith('.tmp')), false);

      const again = capture();
      assert.equal(main(['--board', boardPath, '--out', outPath], again.io), 1);
      assert.equal(readFileSync(outPath, 'utf8'), html);
      assert.match(again.out.stderr, /Refused to overwrite/);
      assert.equal(again.out.stdout, '');

      const forced = capture();
      assert.equal(main(['--board', boardPath, '--out', outPath, '--force', '--json'], forced.io), 0);
      const printed = JSON.parse(forced.out.stdout);
      assert.equal(printed.counts.people[0].eventsShown, 4);
      assert.equal(printed.html, undefined);
      assert.equal(forced.out.stdout.includes('Tooth cleaning'), false);
      assert.equal(readFileSync(outPath, 'utf8'), html);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a temporary file and renames it, and a failed rename leaves no half page', () => {
    const dir = tempDir();
    const boardPath = join(dir, 'board.json');
    const outPath = join(dir, 'page.html');
    writeFileSync(boardPath, JSON.stringify(mapleBoard()));
    writeFileSync(outPath, 'old page');
    const opened = [];
    const renamed = [];
    const realOpen = fs.openSync;
    const realRename = fs.renameSync;
    fs.openSync = (file, flags, mode) => {
      opened.push(String(file));
      return realOpen(file, flags, mode);
    };
    fs.renameSync = (from, to) => {
      renamed.push([String(from), String(to)]);
      return realRename(from, to);
    };
    try {
      const cap = capture();
      assert.equal(main(['--board', boardPath, '--out', outPath, '--force'], cap.io), 0);
      const temps = opened.filter(file => file.includes('.wall-board-'));
      assert.equal(temps.length, 1);
      assert.deepEqual(renamed, [[temps[0], outPath]]);
      assert.equal(dirname(temps[0]), dirname(outPath));
      assert.equal(readdirSync(dir).some(name => name.includes('.wall-board-')), false);
      assert.equal(readFileSync(outPath, 'utf8').startsWith('<!DOCTYPE html>'), true);

      fs.renameSync = () => {
        throw new Error('stopped');
      };
      const stopped = capture();
      assert.equal(main(['--board', boardPath, '--out', outPath, '--force'], stopped.io), 1);
      assert.match(stopped.out.stderr, /Couldn't write the page/);
      assert.equal(readFileSync(outPath, 'utf8').startsWith('<!DOCTYPE html>'), true);
      assert.equal(readdirSync(dir).some(name => name.includes('.wall-board-')), false);
    } finally {
      fs.openSync = realOpen;
      fs.renameSync = realRename;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints one message and writes nothing when the board is refused', () => {
    const dir = tempDir();
    const boardPath = join(dir, 'board.json');
    const outPath = join(dir, 'page.html');
    const missing = capture();
    const bad = join(dir, 'bad.json');
    const big = join(dir, 'big.json');
    try {
      assert.equal(main(['--board', join(dir, 'missing.json'), '--out', outPath], missing.io), 1);
      assert.match(missing.out.stderr, /Couldn't open the board file/);
      assert.equal(missing.out.stdout, '');

      writeFileSync(bad, '{');
      const parsed = capture();
      assert.equal(main(['--board', bad, '--out', outPath], parsed.io), 1);
      assert.match(parsed.out.stderr, /not valid JSON/);

      writeFileSync(boardPath, '{"schemaVersion":1}\n');
      const refused = capture();
      assert.equal(main(['--board', boardPath, '--out', outPath], refused.io), 1);
      assert.match(refused.out.stderr, /board: title is missing/);
      assert.equal(readdirSync(dir).includes('page.html'), false);

      writeFileSync(big, Buffer.alloc(FILE_BYTES + 1, 0x20));
      const over = capture();
      assert.equal(main(['--board', big, '--out', outPath], over.io), 1);
      assert.match(over.out.stderr, /2 MB/);

      const args = capture();
      assert.equal(main(['--out', outPath], args.io), 1);
      assert.match(args.out.stderr, /--board is required/);
      assert.equal(args.out.stderr.includes('\n', args.out.stderr.indexOf('\n') + 1), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a missing folder and does not follow the command into a second write', () => {
    const dir = tempDir();
    const boardPath = join(dir, 'board.json');
    writeFileSync(boardPath, JSON.stringify(mapleBoard()));
    const cap = capture();
    try {
      assert.equal(main(['--board', boardPath, '--out', join(dir, 'missing', 'page.html')], cap.io), 1);
      assert.match(cap.out.stderr, /folder is missing/);
      assert.equal(readdirSync(dir).some(name => name.includes('.wall-board-')), false);
      const noise = capture();
      assert.equal(main(['--board', boardPath, '--out', outUnused(dir), '--json', '--json'], noise.io), 1);
      assert.match(noise.out.stderr, /--json was given twice/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function outUnused(dir) {
  return join(dir, `page-${randomBytes(4).toString('hex')}.html`);
}
