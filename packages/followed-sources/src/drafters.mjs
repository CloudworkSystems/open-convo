// Two deterministic drafters with no network or model. A real local-model
// drafter follows the same contract: draft(question) returns a promise of
// { cards: [{ kind, title, body }] }, and never sends question.ref to a model.

import { cut, normalize } from './text.mjs';

const refKey = ref => `${ref.source}/${ref.itemId}`;

/**
 * Answers from a table keyed by "source/itemId". Each entry is one of:
 * { cards: [...] } (returned as is), { throws: 'message' }, { hangs: true }
 * (never answers) or { returns: anything } (returned verbatim, for bad
 * answers). A ref not in the table throws, so a test can't pass by accident.
 * Every question it is asked is kept in `calls`.
 */
export function createScriptedDrafter(answers = {}) {
  const table = new Map(Object.entries(answers));
  const calls = [];
  return {
    calls,
    async draft(question) {
      calls.push(structuredClone(question));
      const name = refKey(question.ref);
      if (!table.has(name)) throw new Error(`no scripted answer for ${name}`);
      const entry = table.get(name);
      if (entry?.throws !== undefined) throw new Error(String(entry.throws));
      if (entry?.hangs) return new Promise(() => {});
      if (entry && Object.hasOwn(entry, 'returns')) return entry.returns;
      return structuredClone(entry);
    },
  };
}

const KEYWORDS = ['always', 'never', 'check', 'make sure', 'avoid', 'don t'];
// A sentence's words, then its end marks (kept out of the capture).
const SENTENCE = /([^.!?]+)[.!?]*/g;

/**
 * A stand-in so the command runs without a model, not a product feature:
 * each sentence with a word like "always", "never" or "check" becomes a
 * short lesson, up to three per item.
 */
export function createKeywordDrafter() {
  return {
    async draft(question) {
      const cards = [];
      for (const [, sentence] of question.item.text.matchAll(SENTENCE)) {
        const normalized = ` ${normalize(sentence)} `;
        if (!KEYWORDS.some(word => normalized.includes(` ${word} `))) continue;
        const list = sentence.trim().split(/\s+/);
        cards.push({
          kind: 'lesson',
          title: cut(`Lesson: ${list.slice(0, 6).join(' ')}${list.length > 6 ? ' …' : ''}`, 80),
          body: cut(`${question.source.name} suggests: ${list.slice(0, 10).join(' ')}${list.length > 10 ? ' …' : ''}`, 280),
        });
        if (cards.length === 3) break;
      }
      return { cards };
    },
  };
}
