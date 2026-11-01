// Plain text for the command. Text that came from the drop is forced onto
// one line: a backslash is doubled, line breaks are written as \n, tabs as
// \t, and bidirectional controls (and the other ASCII controls) as \uXXXX.
// The JSON result keeps those characters unchanged.

const LINE_BREAK = /\r\n|\n|\r|\u2028|\u2029/g;
const BIDI_OR_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function oneLine(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(LINE_BREAK, '\\n')
    .replace(/\t/g, '\\t')
    .replace(BIDI_OR_CONTROL, (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function section(lines, title, rows, empty) {
  lines.push(title);
  if (rows.length === 0) lines.push(empty);
  else lines.push(...rows);
  lines.push('');
}

function formatSource(source) {
  return `${source.kind}  ${oneLine(source.id)}  ${oneLine(source.title)}  ${oneLine(source.sourceKey)}  ${oneLine(source.addedAt)}`;
}

function formatDuplicate(duplicate) {
  return `${oneLine(duplicate.id)}  repeats ${oneLine(duplicate.repeats)}  ${oneLine(duplicate.sourceKey)}`;
}

function formatRefusal(refusal) {
  return `${oneLine(refusal.id)}  ${oneLine(refusal.reason)}`;
}

export function formatDrop(result) {
  const counts = result.counts;
  const lines = [
    `items: ${counts.items}`,
    `sources: ${counts.sources}`,
    `links: ${counts.links}`,
    `clips: ${counts.clips}`,
    `duplicates: ${counts.duplicates}`,
    `refused: ${counts.refused}`,
    `dropped words: ${counts.droppedWords}`,
    '',
  ];
  section(lines, 'Sources', result.sources.map(formatSource), 'None.');
  section(lines, 'Duplicates', result.duplicates.map(formatDuplicate), 'None.');
  section(lines, 'Refused', result.refused.map(formatRefusal), 'None.');
  return `${lines.join('\n')}\n`;
}
