export const MAX_QUERY_LENGTH = 200;

// Keeps the FAQ entries that contain every word of the query (case-insensitive).
// The query is only used to filter; it is never returned.
export function filterFaq(faq, q) {
  if (q === null || q === undefined) return faq;
  const words = String(q).slice(0, MAX_QUERY_LENGTH).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return faq;
  return faq.filter((entry) => {
    const text = `${entry.question} ${entry.answer}`.toLowerCase();
    return words.every((word) => text.includes(word));
  });
}
