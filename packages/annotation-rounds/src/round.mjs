import { closeSync, constants, lstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Annotation-rounds checker. Reads one saved round, reports gaps in plain
 * words, and writes a checklist. The owner's words are copied into the
 * output and never treated as instructions. No network and no dependencies.
 */

export const SCHEMA_VERSION = 1;

const MAX_BYTES = 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW || 0);

const LABEL_DEFS = [
  ['element or area', 'element'],
  ["owner's words", 'ownersWords'],
  ['requested change', 'change'],
  ['screenshots', 'screenshots'],
  ['screenshot', 'screenshots'],
  ['owner said', 'ownersWords'],
  ['element', 'element'],
  ['screen', 'screen'],
  ['change', 'change'],
  ['words', 'ownersWords'],
  ['area', 'element'],
].sort((a, b) => b[0].length - a[0].length);

const LABEL_NAME = {
  screen: 'Screen',
  element: 'Element',
  ownersWords: "Owner's words",
  change: 'Change',
  screenshots: 'Screenshot',
};

const REQUIRED = [
  ['screen', 'a screen', 'an empty screen'],
  ['element', 'an element', 'an empty element'],
  ['ownersWords', "the owner's words", "empty owner's words"],
  ['change', 'a change', 'an empty change'],
];

export class RoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoundError';
  }
}

export function checkRound(roundPath) {
  const { report, markdown } = inspectRound(roundPath);
  return { report, markdown };
}

export function inspectRound(roundPath) {
  const text = readRound(roundPath);
  const { report, mentionedNames } = buildReport(roundPath, text);
  return { report, markdown: renderMarkdown(report), mentionedNames };
}

export function reportJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function hasErrors(report) {
  if (report.problems.some(entry => entry.level === 'error')) return true;
  return report.items.some(item => item.problems.some(entry => entry.level === 'error'));
}

export function outputRefusal(roundPath, mentionedNames, jsonPath, mdPath) {
  if (jsonPath && mdPath && sameFile(jsonPath, mdPath)) {
    return 'Refusing to write: --json and --md are the same file.';
  }
  const protectedPaths = collectProtected(roundPath, mentionedNames);
  for (const target of [jsonPath, mdPath]) {
    if (!target) continue;
    const reason = pathProblem(target, protectedPaths);
    if (reason) return `Refusing to write ${target}: ${reason}`;
  }
  return null;
}

function readRound(roundPath) {
  let info;
  try {
    info = statSync(roundPath);
  } catch {
    throw new RoundError('Could not open the round file.');
  }
  if (!info.isFile()) throw new RoundError('The round path is not a file.');
  if (info.size > MAX_BYTES) throw new RoundError('This round file is over 1 MB, so it was refused.');
  try {
    return readFileSync(roundPath, 'utf8');
  } catch {
    throw new RoundError('Could not open the round file.');
  }
}

function buildReport(roundPath, text) {
  const session = sessionOf(roundPath);
  const roundFile = path.basename(roundPath);
  const roundDir = path.dirname(path.resolve(roundPath));
  const parsed = parseRound(text);

  const orphanNames = parsed.orphanShots.flatMap(chunk => splitNames(chunk.text));

  if (parsed.items.length === 0) {
    const message = text.trim() === ''
      ? 'This round file is empty.'
      : 'This round has no numbered items.';
    return {
      report: {
        schemaVersion: SCHEMA_VERSION,
        session,
        roundFile,
        items: [],
        problems: [problem('error', message, null)],
      },
      mentionedNames: orphanNames,
    };
  }

  for (const item of parsed.items) {
    item.mentioned = item.shotChunks.flatMap(chunk => splitNames(chunk.text));
  }

  const problems = [...parsed.problems, ...numberProblems(parsed.items)];
  const items = parsed.items.map(item => finishItem(item, session, roundDir));
  problems.push(...sharedWarnings(parsed.items));
  problems.push(...unnamedWarnings(roundDir, session, parsed.items));

  return {
    report: {
      schemaVersion: SCHEMA_VERSION,
      session,
      roundFile,
      items,
      problems,
    },
    mentionedNames: [...orphanNames, ...parsed.items.flatMap(item => item.mentioned)],
  };
}

function parseRound(text) {
  const problems = [];
  const items = [];
  const orphanShots = [];
  let item = null;
  let orphan = null;

  function couldNotRead(lineNo) {
    problems.push(problem('error', `Could not read line ${lineNo}.`, lineNo));
  }

  for (const [index, line] of splitLines(text).entries()) {
    const lineNo = index + 1;
    if (line.startsWith('  ')) {
      if (item?.current) {
        continueField(item, line.slice(2));
        continue;
      }
      if (orphan) {
        orphan.text = `${orphan.text}\n${line.slice(2)}`;
        continue;
      }
      couldNotRead(lineNo);
      continue;
    }
    orphan = null;
    if (line === '') {
      if (item) item.current = null;
      continue;
    }
    const itemMatch = /^(\d+)\.(.*)$/.exec(line);
    if (itemMatch) {
      item = startItem(itemMatch[1], lineNo);
      items.push(item);
      const rest = itemMatch[2].replace(/^[ \t]+/, '');
      if (rest !== '') {
        const label = matchLabel(rest);
        if (label) applyField(item, label.key, label.value, lineNo);
        else couldNotRead(lineNo);
      }
      continue;
    }
    const label = matchLabel(line);
    if (label) {
      if (!item) {
        couldNotRead(lineNo);
        if (label.key === 'screenshots') {
          orphan = { text: label.value };
          orphanShots.push(orphan);
        }
        continue;
      }
      applyField(item, label.key, label.value, lineNo);
      continue;
    }
    couldNotRead(lineNo);
  }

  return { items, problems, orphanShots };
}

function startItem(digits, lineNo) {
  const parsed = parseItemNumber(digits);
  return {
    number: parsed.number,
    numberLabel: parsed.label,
    bounded: parsed.bounded,
    line: lineNo,
    fields: {},
    current: null,
    shotChunks: [],
    mentioned: [],
    screenshotLine: null,
    problems: [],
  };
}

function parseItemNumber(digits) {
  const label = digits.length > 20 ? `${digits.slice(0, 20)}...` : digits;
  if (digits.length > 15) return { bounded: false, number: null, label };
  const number = Number(digits);
  if (!Number.isSafeInteger(number)) return { bounded: false, number: null, label };
  return { bounded: true, number, label: String(number) };
}

function itemName(item) {
  return item.bounded ? item.number : item.numberLabel;
}

function applyField(item, key, value, lineNo) {
  if (key === 'screenshots') {
    item.shotChunks.push({ text: value });
    item.screenshotLine = lineNo;
  }
  const existing = item.fields[key];
  if (existing) {
    existing.discarded = true;
    existing.value = null;
    if (!existing.reported) {
      item.problems.push(problem(
        'error',
        `Item ${itemName(item)} uses the label ${LABEL_NAME[key]} more than once.`,
        lineNo,
      ));
      existing.reported = true;
    }
  } else {
    item.fields[key] = { value, line: lineNo, discarded: false, reported: false };
  }
  item.current = key;
}

function continueField(item, extra) {
  const field = item.fields[item.current];
  if (!field) return;
  if (item.current === 'screenshots' && item.shotChunks.length > 0) {
    const chunk = item.shotChunks[item.shotChunks.length - 1];
    chunk.text = `${chunk.text}\n${extra}`;
    if (!field.discarded) field.value = chunk.text;
    return;
  }
  if (!field.discarded) field.value = `${field.value}\n${extra}`;
}

function finishItem(item, session, roundDir) {
  const values = { screen: null, element: null, ownersWords: null, change: null };
  for (const [key, missingPhrase, emptyPhrase] of REQUIRED) {
    const field = item.fields[key];
    if (!field) {
      item.problems.push(problem('error', `Item ${itemName(item)} is missing ${missingPhrase}.`, item.line));
    } else if (field.discarded) {
      values[key] = null;
    } else if (String(field.value).trim() === '') {
      item.problems.push(problem('error', `Item ${itemName(item)} has ${emptyPhrase}.`, field.line));
      values[key] = field.value;
    } else {
      values[key] = field.value;
    }
  }

  const screenshots = [];
  const shot = item.fields.screenshots;
  if (shot && !shot.discarded) {
    for (const name of splitNames(shot.value)) {
      const nameError = screenshotNameError(session, name);
      if (nameError) {
        item.problems.push(problem('error', nameError, shot.line));
        screenshots.push({ name, present: false });
      } else {
        const present = isPresentPng(roundDir, name);
        if (!present) {
          item.problems.push(problem(
            'error',
            `Screenshot "${name}" is named but not present.`,
            shot.line,
          ));
        }
        screenshots.push({ name, present });
      }
    }
  }

  return {
    number: item.bounded ? item.number : null,
    screen: values.screen,
    element: values.element,
    ownersWords: values.ownersWords,
    change: values.change,
    screenshots,
    done: false,
    problems: item.problems,
  };
}

const SKIP_LIST_LIMIT = 20;

function numberProblems(items) {
  const problems = [];
  const seen = new Set();
  let previous = null;
  for (const item of items) {
    if (!item.bounded) {
      problems.push(problem('error', `Item number ${item.numberLabel} is too large.`, item.line));
      continue;
    }
    if (seen.has(item.number)) {
      problems.push(problem('error', `Item number ${item.number} is repeated.`, item.line));
    } else {
      seen.add(item.number);
    }
    if (item.number < 1 || (previous !== null && item.number < previous)) {
      problems.push(problem('error', `Item number ${item.number} is out of order.`, item.line));
    }
    previous = item.number;
  }
  const present = [...seen].filter(number => number >= 1).sort((a, b) => a - b);
  let next = 1;
  for (const number of present) {
    if (number > next) addSkip(problems, items, next, number - 1);
    if (number >= next) next = number + 1;
  }
  return problems;
}

function addSkip(problems, items, start, end) {
  const later = items.find(item => item.bounded && item.number > end);
  const line = later ? later.line : null;
  const count = end - start + 1;
  if (count <= SKIP_LIST_LIMIT) {
    for (let number = start; number <= end; number += 1) {
      problems.push(problem('error', `Item number ${number} is skipped.`, line));
    }
    return;
  }
  problems.push(problem('error', `Item numbers ${start} through ${end} are skipped.`, line));
}

function sharedWarnings(items) {
  const counts = new Map();
  const warnings = [];
  for (const item of items) {
    const seen = new Set();
    for (const name of item.mentioned) {
      if (seen.has(name)) continue;
      seen.add(name);
      const previous = counts.get(name) ?? 0;
      counts.set(name, previous + 1);
      if (previous === 1) {
        warnings.push(problem(
          'warning',
          `Screenshot "${name}" is named by more than one item.`,
          item.screenshotLine ?? item.line,
        ));
      }
    }
  }
  return warnings;
}

function unnamedWarnings(roundDir, session, items) {
  const named = new Set();
  for (const item of items) {
    for (const name of item.mentioned) {
      if (sessionShotName(session, name)) named.add(name);
    }
  }
  const extras = listRoundDir(roundDir)
    .filter(entry => entry.isFile() && sessionShotName(session, entry.name) && !named.has(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return extras.map(name => problem(
    'warning',
    `Screenshot "${name}" is beside the round but no item names it.`,
    null,
  ));
}

function screenshotNameError(session, name) {
  if (!isPlainFileName(name)) {
    return `Screenshot "${name}" must be a plain file name, with no folder.`;
  }
  const match = new RegExp(`^${escapeRegex(session)}-(\\d+)\\.png$`).exec(name);
  if (!match) return `Screenshot "${name}" must be named ${session}-NN.png.`;
  if (match[1].length < 2) return `Screenshot "${name}" must use at least two digits.`;
  return null;
}

function isPresentPng(roundDir, name) {
  if (!isPlainFileName(name)) return false;
  const root = path.resolve(roundDir);
  const full = path.resolve(root, name);
  if (path.dirname(full) !== root) return false;
  let listed;
  try {
    listed = lstatSync(full);
  } catch {
    return false;
  }
  if (!listed.isFile()) return false;
  let fd;
  try {
    fd = openSync(full, READ_FLAGS);
  } catch {
    return false;
  }
  try {
    const buf = Buffer.alloc(PNG_SIGNATURE.length);
    const read = readSync(fd, buf, 0, buf.length, 0);
    return read === PNG_SIGNATURE.length && buf.equals(PNG_SIGNATURE);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

function isPlainFileName(name) {
  if (typeof name !== 'string' || name.length === 0 || name === '.' || name === '..') return false;
  if (/[/\\\0\r\n]/.test(name)) return false;
  return path.basename(name) === name;
}

function sessionShotName(session, name) {
  return new RegExp(`^${escapeRegex(session)}-\\d{2,}\\.png$`).test(name);
}

function sessionOf(roundPath) {
  return path.basename(roundPath, '.md');
}

function listRoundDir(roundDir) {
  try {
    return readdirSync(roundDir, { withFileTypes: true });
  } catch {
    throw new RoundError('Could not read the round folder.');
  }
}

function collectProtected(roundPath, mentionedNames) {
  const roundDir = path.dirname(path.resolve(roundPath));
  const session = sessionOf(roundPath);
  const paths = [path.resolve(roundPath)];
  for (const entry of listRoundDir(roundDir)) {
    if (sessionShotName(session, entry.name)) paths.push(path.join(roundDir, entry.name));
  }
  for (const name of mentionedNames) paths.push(path.resolve(roundDir, name));
  return paths;
}

function pathProblem(target, protectedPaths) {
  let listed = null;
  try {
    listed = lstatSync(target);
  } catch (err) {
    if (err.code !== 'ENOENT') return 'the path could not be checked.';
  }
  if (listed?.isSymbolicLink()) return 'it is a symbolic link.';
  if (listed?.isDirectory()) return 'it is a folder.';
  if (listed && listed.nlink > 1) return 'it has another hard link.';
  const given = path.resolve(target);
  const full = fullyResolved(target);
  if (!full) return 'the path could not be resolved.';
  if (full !== given) return 'a folder on the way is a symbolic link.';
  const parent = path.dirname(given);
  try {
    if (!statSync(parent).isDirectory()) return 'its folder does not exist.';
  } catch {
    return 'its folder does not exist.';
  }
  for (const protectedPath of protectedPaths) {
    if (sameFile(target, protectedPath)) return 'it is the same file as an input.';
  }
  return null;
}

function sameFile(a, b) {
  const resolvedA = fullyResolved(a);
  const resolvedB = fullyResolved(b);
  if (resolvedA && resolvedB && resolvedA === resolvedB) return true;
  const statA = statOrNull(a);
  const statB = statOrNull(b);
  return Boolean(statA && statB && statA.dev === statB.dev && statA.ino === statB.ino);
}

function fullyResolved(target) {
  const absolute = path.resolve(target);
  try {
    return realpathSync(absolute);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
  }
  const missing = [];
  let current = absolute;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    missing.push(path.basename(current));
    try {
      return path.join(realpathSync(parent), ...missing.slice().reverse());
    } catch (err) {
      if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') return null;
      current = parent;
    }
  }
}

function statOrNull(target) {
  try {
    return statSync(target);
  } catch {
    return null;
  }
}

function matchLabel(line) {
  const bold = unwrapBold(line);
  if (bold) {
    const labelText = bold.inner.replace(/[ \t]*:[ \t]*$/, '').trim();
    const key = canonical(labelText);
    if (key) return { key, value: stripSeparator(bold.after) };
  }
  return matchPlain(line);
}

function unwrapBold(line) {
  for (const mark of ['**', '__']) {
    if (!line.startsWith(mark)) continue;
    const end = line.indexOf(mark, mark.length);
    if (end === -1) return null;
    return { inner: line.slice(mark.length, end).trim(), after: line.slice(end + mark.length) };
  }
  return null;
}

function matchPlain(text) {
  const lower = text.toLowerCase();
  for (const [name, key] of LABEL_DEFS) {
    if (!lower.startsWith(name)) continue;
    const rest = text.slice(name.length);
    if (rest !== '' && !/^[ \t:]/.test(rest)) continue;
    return { key, value: stripSeparator(rest) };
  }
  return null;
}

function canonical(text) {
  const lower = text.toLowerCase();
  for (const [name, key] of LABEL_DEFS) {
    if (lower === name) return key;
  }
  return null;
}

function stripSeparator(rest) {
  const colon = /^[ \t]*:[ \t]?/.exec(rest);
  if (colon) return rest.slice(colon[0].length);
  if (rest.startsWith(' ') || rest.startsWith('\t')) return rest.slice(1);
  return rest;
}

function splitNames(value) {
  return String(value ?? '').split(',').map(part => part.trim()).filter(part => part.length > 0);
}

function splitLines(text) {
  const ended = text.endsWith('\n');
  const parts = text.split('\n');
  if (ended) parts.pop();
  return parts.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function problem(level, message, line) {
  return { level, message, line };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renderMarkdown(report) {
  const errors = countLevel(report, 'error');
  const warnings = countLevel(report, 'warning');
  const lines = [
    `# ${escapeMarkdown(report.session)}`,
    '',
    `${plural(report.items.length, 'item', 'items')}, ${plural(errors, 'error', 'errors')}, ${plural(warnings, 'warning', 'warnings')}`,
    '',
    '## Before you start',
    '',
  ];
  const bullets = [...report.problems, ...report.items.flatMap(item => item.problems)];
  if (bullets.length === 0) lines.push('None.');
  else {
    for (const entry of bullets) {
      const text = entry.level === 'warning' ? `Warning: ${entry.message}` : entry.message;
      lines.push(place('- ', escapeMarkdown(text), '  '));
    }
  }
  lines.push('');
  for (const item of report.items) {
    lines.push(renderItem(item));
    lines.push('');
  }
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

function renderItem(item) {
  const pad = '      ';
  const parts = [
    place(`- [ ] ${item.number == null ? 'too large' : item.number}. `, displayField(item.screen), pad),
    place(`${pad}Element: `, displayField(item.element), pad),
    place(`${pad}Change: `, displayField(item.change), pad),
    place(`${pad}Owner's words: `, displayWords(item.ownersWords), pad),
    place(`${pad}Screenshots: `, displayShots(item.screenshots), pad),
  ];
  for (const entry of item.problems) {
    const text = entry.level === 'warning' ? `Warning: ${entry.message}` : entry.message;
    parts.push(place(`${pad}- `, escapeMarkdown(text), `${pad}  `));
  }
  return parts.join('\n');
}

function displayField(value) {
  if (value == null) return '(missing)';
  if (String(value).trim() === '') return '(empty)';
  return escapeMarkdown(String(value));
}

function displayWords(value) {
  if (value == null) return '(missing)';
  if (String(value).trim() === '') return '(empty)';
  return `"${escapeMarkdown(String(value))}"`;
}

function displayShots(shots) {
  if (shots.length === 0) return 'none';
  return shots.map(shot => {
    const state = shot.present ? 'present' : 'not present';
    return `${escapeMarkdown(shot.name)} (${state})`;
  }).join(', ');
}

function place(prefix, value, continuation) {
  const lines = String(value).split('\n');
  return lines.map((line, index) => (index === 0 ? prefix + line : continuation + line)).join('\n');
}

function escapeMarkdown(text) {
  return String(text).split('\n').map(escapeMarkdownLine).join('\n');
}

function escapeMarkdownLine(line) {
  let escaped = line.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  escaped = escaped.replaceAll('[', '\\[').replaceAll(']', '\\]');
  escaped = escaped.replace(/^(\s*)(#{1,6})/, (_, spaces, marks) => `${spaces}\\${marks}`);
  escaped = escaped.replace(/^(\s*)([-*+])(?=\s)/, (_, spaces, mark) => `${spaces}\\${mark}`);
  escaped = escaped.replace(/^(\s*)(\d+)\./, (_, spaces, number) => `${spaces}${number}\\.`);
  return escaped;
}

function countLevel(report, level) {
  let count = report.problems.filter(entry => entry.level === level).length;
  for (const item of report.items) count += item.problems.filter(entry => entry.level === level).length;
  return count;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}
