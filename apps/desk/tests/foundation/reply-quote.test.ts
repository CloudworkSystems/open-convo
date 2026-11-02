import assert from 'node:assert/strict';
import test from 'node:test';
import { draftWithReplyQuote, replyQuote, REPLY_QUOTE_MAX_CHARACTERS } from '../../src/domain/reply-quote';

test('a reply quote marks every line, keeps blank lines and normalizes line endings', () => {
  assert.equal(replyQuote('First line\r\n\r\nThird line\rFourth'), '> First line\n>\n> Third line\n> Fourth');
  assert.equal(replyQuote('  \n'), '');
});

test('a long message is trimmed by characters, never splitting an emoji, and marked with an ellipsis', () => {
  const long = '🙂'.repeat(REPLY_QUOTE_MAX_CHARACTERS + 5);
  const quote = replyQuote(long);
  assert.equal(quote, `> ${'🙂'.repeat(REPLY_QUOTE_MAX_CHARACTERS)}…`);
  assert.equal(replyQuote('a'.repeat(REPLY_QUOTE_MAX_CHARACTERS)), `> ${'a'.repeat(REPLY_QUOTE_MAX_CHARACTERS)}`);
});

test('the quote goes above what was already written, which is kept', () => {
  assert.equal(draftWithReplyQuote('', 'Invented reply'), '> Invented reply\n\n');
  assert.equal(draftWithReplyQuote('My thought', 'Invented reply'), '> Invented reply\n\nMy thought');
  assert.equal(draftWithReplyQuote('\n\nMy thought', 'Invented reply'), '> Invented reply\n\nMy thought');
  assert.equal(draftWithReplyQuote('Kept', '   '), 'Kept');
});
