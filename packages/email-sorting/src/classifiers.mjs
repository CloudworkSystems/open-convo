// The two classifiers that ship with the package. Both are deterministic
// and make no network or model calls.

function refKey(inbox, id) {
  return JSON.stringify([inbox, id]);
}

// Answers from a table keyed by the question's ref (inbox and id). Each
// entry is { inbox, id } plus exactly one of:
//   answer: any value, returned as the answer (good or bad);
//   throws: true or an error message, to fail the call;
//   hang: true, to return a promise that never settles.
// A question whose ref isn't in the table throws, so a test can't pass by
// accident. Every question asked is kept in `questions`.
export function createScriptedClassifier(entries) {
  if (!Array.isArray(entries)) throw new TypeError('createScriptedClassifier needs a list of entries.');
  const table = new Map();
  for (const entry of entries) {
    const key = refKey(entry.inbox, entry.id);
    if (table.has(key)) throw new TypeError(`Two scripted entries for ${key}.`);
    table.set(key, entry);
  }
  const questions = [];
  return {
    questions,
    async classify(question) {
      questions.push(question);
      const ref = question && question.ref;
      const entry = ref ? table.get(refKey(ref.inbox, ref.id)) : undefined;
      if (!entry) throw new Error(`No scripted answer for ${ref ? refKey(ref.inbox, ref.id) : 'a question without a ref'}.`);
      if (entry.throws) throw new Error(typeof entry.throws === 'string' ? entry.throws : 'Scripted failure.');
      if (entry.hang) return new Promise(() => {});
      return entry.answer;
    },
  };
}

// A small fixed keyword table, so the command runs without a model. It is a
// stand-in for the local model, not a product feature. Rules are tried in
// order; the first that matches answers with its fixed confidence.
const KEYWORD_RULES = Object.freeze([
  { category: 'newsletters', confidence: 0.9, fact: (f) => f.hasListId || f.hasListUnsubscribe, reason: 'Sent to a mailing list' },
  { category: 'alerts', confidence: 0.85, words: ['verification code', 'security code', 'sign-in', 'sign in', 'password', 'security alert'], reason: 'Looks like a security or account notice' },
  { category: 'alerts', confidence: 0.8, words: ['shipped', 'out for delivery', 'delivered', 'tracking number', 'reminder', 'appointment'], reason: 'Looks like a shipping update or reminder' },
  { category: 'receipts', confidence: 0.8, words: ['receipt', 'order', 'invoice', 'payment', 'booking', 'confirmation', 'confirmed'], reason: 'Mentions an order, payment or booking' },
  { category: 'newsletters', confidence: 0.7, words: ['newsletter', 'digest', 'unsubscribe', '% off', 'sale ends'], reason: 'Reads like a newsletter or offer' },
  { category: 'work', confidence: 0.8, fact: (f) => f.senderIsWorkDomain, reason: 'From a work domain' },
  { category: 'alerts', confidence: 0.75, fact: (f) => f.autoSubmitted !== null && f.autoSubmitted !== 'no', reason: 'Sent automatically' },
  { category: 'people', confidence: 0.65, fact: (f) => f.isReply, reason: 'A reply in a conversation' },
]);

const FALLBACK_ANSWER = Object.freeze({ category: 'people', confidence: 0.55, reason: 'No keyword matched; maybe a person' });

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WORD_PATTERNS = new Map();
function wordPattern(word) {
  if (!WORD_PATTERNS.has(word)) {
    const start = /^\w/.test(word) ? '\\b' : '';
    const end = /\w$/.test(word) ? '\\b' : '';
    WORD_PATTERNS.set(word, new RegExp(`${start}${escapeRegExp(word)}${end}`));
  }
  return WORD_PATTERNS.get(word);
}

export function createKeywordClassifier() {
  return {
    async classify(question) {
      const text = `${question.subject}\n${question.snippet}`.toLowerCase();
      for (const rule of KEYWORD_RULES) {
        const hit = rule.fact
          ? rule.fact(question.facts)
          : rule.words.some(word => wordPattern(word).test(text));
        if (hit) return { category: rule.category, confidence: rule.confidence, reason: rule.reason };
      }
      return { ...FALLBACK_ANSWER };
    },
  };
}
