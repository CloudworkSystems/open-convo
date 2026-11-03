/**
 * Preview a pasted checklist, or save it as a household list file.
 * The library reads nothing. This command reads one note and writes one file.
 */

import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  EMPTY_NOTE,
  IMPORT_DEVICE_ID,
  LIMITS,
  NotesImportError,
  fixedNow,
  formatReport,
  parseChecklist,
  toListFile,
  tooBigMessage,
} from './index.mjs';

const HELP = `Read a checklist copied from Notes and preview it, or save a household list.

node packages/notes-import/src/import.mjs --in <note.txt> [--title <name>] [--out <list.json>] [--force]

--in - reads pasted text. Without --out, nothing is written.
A second save to the same file needs --force.
`;

const realFs = { statSync, openSync, writeSync, fchmodSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync };

function fail(message) {
  throw new NotesImportError(message);
}

function parseArgs(argv) {
  const args = { in: undefined, title: undefined, out: undefined, force: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    if (arg === '--force') {
      args.force = true;
      continue;
    }
    if (arg === '--in' || arg === '--title' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) fail(`Add a value after ${arg}.`);
      const key = arg.slice(2);
      if (args[key] !== undefined) fail(`Say ${arg} only once.`);
      args[key] = value;
      i += 1;
      continue;
    }
    fail(`Unknown option ${arg}. Run with --help to see the command.`);
  }
  return args;
}

function decode(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('This note is not plain text. Copy the note in Notes, then paste it as plain text.');
  }
}

function defaultRead(fd, buffer, offset, length) {
  return readSync(fd, buffer, offset, length);
}

/** Read until the stream ends. One byte past the limit refuses the note. */
export function readBounded(read, limit, fd = 0) {
  const chunks = [];
  let total = 0;
  const buffer = Buffer.alloc(64 * 1024);
  for (;;) {
    const count = read(fd, buffer, 0, buffer.length);
    if (count === 0) break;
    if (!Number.isInteger(count) || count < 0) fail('That note could not be read. Check the path and run again.');
    total += count;
    if (total > limit) fail(tooBigMessage());
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  return Buffer.concat(chunks);
}

function readNote(inputPath, options) {
  if (inputPath === '-') {
    if (typeof options.input === 'string') return options.input;
    return decode(readBounded(options.stdinRead ?? defaultRead, LIMITS.bytes));
  }
  let stat;
  try {
    stat = statSync(inputPath);
  } catch {
    fail('That note could not be read. Check the path and run again.');
  }
  if (stat.isDirectory()) fail('That note is a folder. Give the path to a text file and run again.');
  if (!stat.isFile()) fail('That note could not be read. Check the path and run again.');
  if (stat.size > LIMITS.bytes) fail(tooBigMessage());
  const bytes = readFileSync(inputPath);
  if (bytes.length > LIMITS.bytes) fail(tooBigMessage());
  return decode(bytes);
}

function writeAll(fileSystem, fd, text) {
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const wrote = fileSystem.writeSync(fd, buffer, offset, buffer.length - offset, null);
    if (!Number.isInteger(wrote) || wrote <= 0) fail('That list could not be written. Check the path and run again.');
    offset += wrote;
  }
}

/**
 * Write `text` to a temporary file in the same folder, then rename it into place.
 * An existing file is left unchanged unless `force` is set.
 */
export function writeListFile(dest, text, { force = false, fileSystem = realFs } = {}) {
  let stat = null;
  try {
    stat = fileSystem.statSync(dest);
  } catch (error) {
    if (error.code !== 'ENOENT') fail('That list could not be written. Check the path and run again.');
  }
  if (stat?.isDirectory()) fail('That output path is a folder. Give a file path and run again.');
  if (stat && !force) {
    fail('A list is already at that path, so nothing was written. Run again with --force to replace it, or choose another --out path.');
  }

  const dir = dirname(dest);
  try {
    const parent = fileSystem.statSync(dir);
    if (!parent.isDirectory()) fail('The folder for that list does not exist. Create it and run again.');
  } catch (error) {
    if (error instanceof NotesImportError) throw error;
    fail('The folder for that list does not exist. Create it and run again.');
  }

  const tmp = join(dir, `.${basename(dest)}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fileSystem.openSync(tmp, 'wx', 0o600);
    writeAll(fileSystem, fd, text);
    fileSystem.fchmodSync(fd, 0o600);
    fileSystem.fsyncSync(fd);
    fileSystem.closeSync(fd);
    fd = undefined;
    fileSystem.renameSync(tmp, dest);
  } catch (error) {
    if (fd !== undefined) {
      try { fileSystem.closeSync(fd); } catch { /* the temp file is closed next */ }
    }
    try { fileSystem.unlinkSync(tmp); } catch { /* the temp file may already be gone */ }
    if (error instanceof NotesImportError) throw error;
    fail('That list could not be written. Check the path and run again.');
  }
}

function refuse(error) {
  const message = error instanceof NotesImportError ? error.message : 'That note could not be read. Check the path and run again.';
  return { code: 1, stdout: '', stderr: `${message}\n` };
}

export function runImport(argv, options = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    return refuse(error);
  }
  if (args.help) return { code: 0, stdout: HELP, stderr: '' };
  if (args.in === undefined) {
    return refuse(new NotesImportError('Say which note to read with --in, or use --in - to read pasted text.'));
  }
  if (args.force && args.out === undefined) {
    return refuse(new NotesImportError('--force replaces an existing list. Add --out, or leave it off to preview.'));
  }

  try {
    const text = readNote(args.in, options);
    const parsed = parseChecklist(text, { title: args.title });
    if (parsed.items.length === 0) {
      const extra = parsed.list.titleFrom !== 'fallback' || parsed.skipped.length > 0 || parsed.warnings.length > 0
        ? formatReport(parsed)
        : '';
      return { code: 1, stdout: '', stderr: extra ? `${EMPTY_NOTE}\n${extra}` : `${EMPTY_NOTE}\n` };
    }
    const report = formatReport(parsed);
    if (args.out === undefined) return { code: 0, stdout: report, stderr: '' };
    if (args.in !== '-' && resolve(args.in) === resolve(args.out)) {
      fail('The list would replace the note. Choose a different --out path.');
    }
    const json = toListFile(parsed, {
      deviceId: options.deviceId ?? IMPORT_DEVICE_ID,
      now: options.now ?? fixedNow,
    });
    writeListFile(args.out, json, { force: args.force, fileSystem: options.fileSystem });
    return { code: 0, stdout: `${report}Wrote ${args.out}.\n`, stderr: '' };
  } catch (error) {
    if (error instanceof NotesImportError) return refuse(error);
    if (error instanceof Error && error.message && !error.message.includes('\n')) return refuse(new NotesImportError(error.message));
    return refuse(error);
  }
}

function runningAsScript() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

/** Resolve when `text` has been handed to the stream, so a pipe keeps the rest. */
export function writeFlushed(stream, text) {
  if (!text) return Promise.resolve();
  return new Promise((resolve, reject) => {
    try {
      stream.write(text, error => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

/** Write the command's screen, and resolve with its exit code only after both streams flush. */
export function publishResult(result, stdout, stderr) {
  return Promise.all([
    writeFlushed(stdout, result.stdout),
    writeFlushed(stderr, result.stderr),
  ]).then(() => result.code);
}

if (runningAsScript()) {
  const result = runImport(process.argv.slice(2));
  // Let the pipe finish. Forcing an immediate exit would drop a preview still queued on a pipe.
  publishResult(result, process.stdout, process.stderr).then(code => {
    process.exitCode = code;
  }, () => {
    process.exitCode = 1;
  });
}
