import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationRun, ParticipantIdentity } from '../../src/domain/conversation-run-types';
import { createConversationRun } from '../../src/domain/conversation-runs';
import {
  canRetryClaudeRun, CLAUDE_DESTINATION, CLAUDE_FIRST_TRIAL_BYTES, claudeChoiceTitle, claudeSendLine, isOffMacClaude, selectClaudeContext,
} from '../../src/domain/claude-participant';

// Claude Code adapter PR 4a: the page's side of an off-Mac Claude run
// (contract section 21). Invented models and text only.
const offMac: ParticipantIdentity = { id: 'claude-code', label: 'Claude', model: 'invented-pinned-model', executionHost: 'anthropic' };
const revision3: ParticipantIdentity = { ...offMac, label: 'Claude Code', executionHost: 'this-mac' };
const local: ParticipantIdentity = { id: 'ollama-local', label: 'invented-model:7b', model: `invented-model:7b@${'a'.repeat(64)}`, executionHost: 'this-mac' };
const sessionId = '24000000-0000-4000-8000-000000000001';
let next = 100;
const id = () => `24000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;

function run(participant: ParticipantIdentity, text: string, reply: string, phase: ConversationRun['phase'] = 'completed', session = sessionId): ConversationRun {
  const created = createConversationRun({ runId: id(), sessionId: session, userMessageId: id(), assistantMessageId: id(), participant,
    input: text, createdAt: '2026-10-30T12:00:00.000Z', contextRunIds: [] });
  assert.equal(created.kind, 'ok');
  if (created.kind !== 'ok') throw new Error();
  return { ...created.run, outputChunks: reply ? [reply] : [], phase, lastSequence: phase === 'completed' ? 3 : 2 };
}

test('only a revision-5 Claude pin is off the Mac, and its name always says Anthropic, never this Mac', () => {
  assert.equal(isOffMacClaude(offMac), true);
  assert.equal(isOffMacClaude(revision3), false);
  assert.equal(isOffMacClaude(local), false);
  assert.equal(isOffMacClaude(undefined), false);
  assert.equal(claudeChoiceTitle(offMac), 'Claude · invented-pinned-model · Anthropic (not on this Mac)');
  assert.equal(CLAUDE_DESTINATION, 'Anthropic (not on this Mac)');
  assert.doesNotMatch(claudeChoiceTitle(offMac), /stays on this Mac/);
});

test('a Claude run’s earlier turns are every completed turn of the session, local ones included, within 4,096 bytes with the message', () => {
  const first = run(local, 'Invented local question.', 'Invented local answer.');
  const failed = run(offMac, 'Invented failed.', 'Cut', 'failed');
  const other = run(offMac, 'Invented elsewhere.', 'Elsewhere.', 'completed', '24000000-0000-4000-8000-000000000099');
  const second = run(offMac, 'Invented Claude question.', 'Invented Claude answer.');
  const result = selectClaudeContext([first, failed, other, second], sessionId, 'Invented new message.');
  assert.deepEqual(result, { kind: 'ok', contextRunIds: [first.runId, second.runId],
    contextBytes: 'Invented local question.Invented local answer.Invented Claude question.Invented Claude answer.'.length });
  // The bound counts context and message together; the oldest whole turns stay out.
  const big = run(offMac, 'x'.repeat(3000), 'y'.repeat(500));
  const fitted = selectClaudeContext([first, big, second], sessionId, 'z'.repeat(520));
  assert.deepEqual(fitted.kind === 'ok' && fitted.contextRunIds, [big.runId, second.runId]);
  const tight = selectClaudeContext([first, big, second], sessionId, 'z'.repeat(1000));
  assert.deepEqual(tight.kind === 'ok' && tight.contextRunIds, [second.runId]);
  assert.deepEqual(selectClaudeContext([first], sessionId, 'a'.repeat(CLAUDE_FIRST_TRIAL_BYTES)), { kind: 'ok', contextRunIds: [], contextBytes: 0 });
  assert.deepEqual(selectClaudeContext([], sessionId, 'é'.repeat(CLAUDE_FIRST_TRIAL_BYTES / 2 + 1)), { kind: 'too-large' });
});

test('the line above the composer counts what Send takes, and says when older turns stay on this Mac', () => {
  const first = run(local, 'Invented local question.', 'Invented local answer.');
  const second = run(offMac, 'Invented Claude question.', 'Invented Claude answer.');
  assert.equal(claudeSendLine([], sessionId, 'Invented.'), 'Sends this message to Anthropic, with no earlier turns.');
  assert.equal(claudeSendLine([first], sessionId, 'Invented.'), 'Sends this message and 1 earlier turn to Anthropic.');
  assert.equal(claudeSendLine([first, second], sessionId, ''), 'Sends this message and 2 earlier turns to Anthropic.');
  const big = run(offMac, 'x'.repeat(3000), 'y'.repeat(500));
  assert.equal(claudeSendLine([first, big, second], sessionId, 'z'.repeat(1000)),
    'Sends this message and 1 earlier turn to Anthropic. The 2 oldest turns stay on this Mac to fit the current trial’s limit.');
  assert.equal(claudeSendLine([big], sessionId, 'z'.repeat(1000)),
    'Sends this message to Anthropic, with no earlier turns. The oldest turn stays on this Mac to fit the current trial’s limit.');
  assert.equal(claudeSendLine([first], sessionId, 'z'.repeat(CLAUDE_FIRST_TRIAL_BYTES + 1)), null, 'the composer already says it is too long');
});

test('Retry is offered for a stopped, failed or cut-off Claude reply, never a completed one or a revision-3 pin’s', () => {
  const at = '2026-10-30T12:01:00.000Z';
  const completed = run(offMac, 'Q.', 'A.');
  const stopped: ConversationRun = { ...run(offMac, 'Q.', 'Partial', 'stopped'), reason: 'local-stop' };
  const failed: ConversationRun = { ...run(offMac, 'Q.', 'Partial', 'failed'), reason: 'reply-too-long' };
  const crashed: ConversationRun = { ...run(offMac, 'Q.', 'Partial', 'running'), closure: { kind: 'unknown', reason: 'user-closed', at } };
  assert.deepEqual([completed, stopped, failed, crashed].map(canRetryClaudeRun), [false, true, true, true]);
  assert.equal(canRetryClaudeRun({ ...stopped, participant: revision3 }), false);
  assert.equal(canRetryClaudeRun({ ...stopped, participant: local }), false, 'a local reply has its own Retry');
});
