/**
 * Reply with a quote (plan: docs/plans/desk-message-actions.md, rule 3).
 * The quote is ordinary draft text the owner can see, edit or delete, so the
 * message sent is exactly what the box shows and the input limit counts it.
 */
export const REPLY_QUOTE_MAX_CHARACTERS = 1000;

/** The quoted message as Markdown-style "> " lines, trimmed with "…" when long. */
export function replyQuote(text: string): string {
  const scalars = [...text.replace(/\r\n?/g, '\n').trim()];
  const body = scalars.length > REPLY_QUOTE_MAX_CHARACTERS
    ? `${scalars.slice(0, REPLY_QUOTE_MAX_CHARACTERS).join('').trimEnd()}…`
    : scalars.join('');
  if (!body) return '';
  return body.split('\n').map((line) => line ? `> ${line}` : '>').join('\n');
}

/** Puts the quote at the top of the draft, keeping whatever was already written below it. */
export function draftWithReplyQuote(draft: string, quoted: string): string {
  const quote = replyQuote(quoted);
  if (!quote) return draft;
  const rest = draft.replace(/^\n+/, '');
  return rest ? `${quote}\n\n${rest}` : `${quote}\n\n`;
}
