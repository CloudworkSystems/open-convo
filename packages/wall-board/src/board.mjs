#!/usr/bin/env node
// node packages/wall-board/src/board.mjs --board <board.json> --out <page.html> [--force] [--json]
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { FILE_BYTES, WallBoardError } from './errors.mjs';
import { renderBoard } from './index.mjs';

const USAGE = 'Usage: node packages/wall-board/src/board.mjs --board <board.json> --out <page.html> [--force] [--json]';

function fail(message) {
  throw new WallBoardError(message);
}

function parseArgs(argv) {
  const args = { board: null, out: null, force: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--force') {
      if (args.force) fail('--force was given twice.');
      args.force = true;
    } else if (arg === '--json') {
      if (args.json) fail('--json was given twice.');
      args.json = true;
    } else if (arg === '--board' || arg === '--out') {
      const name = arg.slice(2);
      if (args[name] !== null) fail(`${arg} was given twice.`);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`${arg} needs a file path.`);
      args[name] = value;
      i += 1;
    } else {
      fail(`Unknown option: ${JSON.stringify(arg)}. ${USAGE}`);
    }
  }
  if (args.board === null) fail(`--board is required. ${USAGE}`);
  if (args.out === null) fail(`--out is required. ${USAGE}`);
  return args;
}

function readLimited(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    fail("Couldn't open the board file.");
  }
  try {
    let stat;
    try {
      stat = fs.fstatSync(fd);
    } catch {
      fail("Couldn't read the board file.");
    }
    if (!stat.isFile()) fail('The board path must be a file.');
    if (stat.size > FILE_BYTES) {
      fail(`board: the file is ${stat.size} bytes; the limit is ${FILE_BYTES} bytes (2 MB).`);
    }
    try {
      return fs.readFileSync(fd, 'utf8');
    } catch {
      fail("Couldn't read the board file.");
    }
  } finally {
    fs.closeSync(fd);
  }
}

function existing(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    fail("Couldn't write the page.");
  }
}

// Write the whole page to a new temp file, then rename it into place.
// An interrupted run leaves the old page whole. The temp file is removed
// if the rename does not happen.
function writePage(target, text, force) {
  const prior = existing(target);
  if (prior && prior.isDirectory()) fail("Couldn't write the page because that path is a folder.");
  if (prior && !force) fail(`Refused to overwrite ${target}. Use --force to replace it.`);
  const temporary = path.join(
    path.dirname(target),
    `.wall-board-${process.pid}-${randomBytes(8).toString('hex')}.tmp`,
  );
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  let fd;
  try {
    fd = fs.openSync(temporary, flags, 0o600);
    fs.writeFileSync(fd, text);
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the write already failed */ }
      fd = undefined;
    }
    try { fs.unlinkSync(temporary); } catch { /* the temp file may not exist */ }
    if (error.code === 'ENOENT') fail("Couldn't write the page because its folder is missing.");
    fail("Couldn't write the page.");
  }
  try {
    fs.closeSync(fd);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* the temp file may not exist */ }
    fail("Couldn't write the page.");
  }
  try {
    fs.renameSync(temporary, target);
  } catch {
    try { fs.unlinkSync(temporary); } catch { /* the temp file may not exist */ }
    fail("Couldn't write the page.");
  }
}

export function formatReport(counts, warnings) {
  const lines = [];
  for (const person of counts.people) {
    lines.push(
      `${person.name}: ${person.eventsShown} events shown, ${person.eventsCut} cut, ${person.busyShown} busy; `
      + `${person.tasksShown} tasks shown, ${person.tasksCut} cut, ${person.tasksHidden} hidden; `
      + `${person.habitsShown} habits shown, ${person.habitsCut} cut, ${person.habitsHidden} hidden`,
    );
  }
  lines.push(`Lists: ${counts.listsShown} shown, ${counts.listItemsShown} items, ${counts.listItemsMore} more`);
  for (const warning of warnings) lines.push(`warning: ${warning}`);
  return `${lines.join('\n')}\n`;
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  let outPath = null;
  try {
    const args = parseArgs(argv);
    outPath = path.resolve(args.out);
    let parsed;
    try {
      parsed = JSON.parse(readLimited(args.board));
    } catch (error) {
      if (error instanceof WallBoardError) throw error;
      fail('board: the file is not valid JSON.');
    }
    const result = renderBoard(parsed);
    writePage(outPath, result.html, args.force);
    const body = args.json
      ? `${JSON.stringify({ counts: result.counts, warnings: result.warnings }, null, 2)}\n`
      : formatReport(result.counts, result.warnings);
    io.stdout.write(body);
    return 0;
  } catch (error) {
    if (error instanceof WallBoardError) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main(process.argv.slice(2));
}
