// User text is forced onto one line, then HTML-escaped. A backslash is
// doubled, line breaks are written as \n, tabs as \t, and controls
// (including bidirectional marks) as \uXXXX. The page never keeps a raw
// control that could change direction or break a tag.

const LINE_BREAK = /\r\n|\n|\r|\u2028|\u2029/g;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function plain(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(LINE_BREAK, '\\n')
    .replace(/\t/g, '\\t')
    .replace(CONTROLS, (ch) => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
}

export function escapeHtml(text) {
  return plain(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
