// Invented sources and items only.
export const SOURCES = {
  schemaVersion: 1,
  sources: [
    { id: 'news', name: 'Example newsletter', kind: 'email', topics: ['security'] },
    { id: 'links', name: 'Example links', kind: 'links' },
  ],
};

export function item(id, date, fields = {}) {
  return { source: 'news', id, date, title: `Issue ${id}`, text: `Plain text for ${id}.`, url: `https://news.example/${id}`, ...fields };
}

export const items = (...list) => ({ schemaVersion: 1, items: list });
export const lesson = (title, body = `A short lesson about ${title}.`) => ({ kind: 'lesson', title, body });
export const ok = (...cards) => ({ cards });
// A run of distinct invented words, for quote and overlap tests.
export const wordList = (count, prefix = 'w') => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join(' ');
// Distinct two-letter words, so 79 of them fit in a 280-character body.
export const shortWords = (count, offset = 0) => Array.from({ length: count }, (_, i) => {
  const n = i + offset;
  return String.fromCharCode(97 + Math.floor(n / 26)) + String.fromCharCode(97 + (n % 26));
}).join(' ');
