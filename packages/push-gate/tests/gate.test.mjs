// The gate's ordinary run and the plan's "When It Goes Wrong" behaviors
// (docs/plans/push-gate.md). Plan tests 13 and 14 are here.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { NOTHING_WAITING } from '../src/gate.mjs';
import { makeWorld, MINUTE } from './helpers/world.mjs';

test('a push request goes up as Cloudwork Agents and opens a normal, labeled pull request', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/invented-notes');
  world.pushRequest('notes-1', 'claude/invented-notes', commit);

  await world.run();

  assert.equal(world.onGitHub('claude/invented-notes'), commit);
  const result = world.result('notes-1');
  assert.equal(result.state, 'done');
  assert.equal(result.commit, commit);
  const [pull] = world.fake.pulls;
  assert.deepEqual(result.pullRequest, { number: pull.number, url: pull.html_url });
  assert.equal(pull.draft, false);
  assert.equal(pull.base.ref, 'main');
  assert.equal(pull.auto_merge, null);
  assert.deepEqual(pull.labels, [{ name: 'agent: claude' }]);
  // The local review is recorded in the description, and the sign-off line stays last.
  assert.match(pull.body, /^Local review: Codex reviewed commit [0-9a-f]{12}, result "clean" \(recorded by the push gate\)\.$/m);
  assert.equal(pull.body.trimEnd().split('\n').at(-1), world.signOff());
  // The token was made for this one request: this repo, and only what a push and its pull request need.
  assert.deepEqual([...world.fake.tokens.values()].at(-1), { permissions: { contents: 'write', pull_requests: 'write' }, scoped: true, revoked: true });
  // The request left the waiting folder, and every token was revoked.
  assert.deepEqual(readdirSync(world.requests), []);
  assert.deepEqual(world.fake.liveTokens(), []);
  assert.deepEqual(
    world.log().map((line) => [line.kind, line.target, line.result]),
    [
      ['push', 'claude/invented-notes', 'done'],
      ['pull request', 'claude/invented-notes', 'done'],
      ['label', `#${pull.number}`, 'done'],
    ],
  );
});

test('a comment and a reply go up on an open pull request, and a comment on issue #52', async (t) => {
  const world = await makeWorld(t);
  const pull = world.openPull();
  world.fake.reviewComments.push({ id: 7001, pull, body: 'An invented finding.', user: { login: 'chatgpt-codex-connector[bot]' } });
  world.commentRequest('c-pull', { pull });
  world.commentRequest('c-issue', { issue: 52 });
  world.request('r-1', { kind: 'reply', agent: 'codex', thread: 'invented task', pull, inReplyTo: 7001, body: 'Fixed in the next push.\n\nCodex, invented task' });

  await world.run();

  for (const id of ['c-pull', 'c-issue', 'r-1']) assert.equal(world.result(id).state, 'done', id);
  assert.deepEqual(world.fake.comments.map((c) => c.issue).sort(), [52, pull].sort());
  assert.equal(world.fake.reviewComments.at(-1).in_reply_to_id, 7001);
  assert.deepEqual(world.fake.liveTokens(), []);
});

test('a comment on a closed pull request or on another issue is refused in one plain sentence', async (t) => {
  const world = await makeWorld(t);
  const pull = world.openPull();
  world.fake.pulls[0].state = 'closed';
  world.commentRequest('closed', { pull });
  world.commentRequest('other-issue', { issue: 114 });

  await world.run();

  assert.match(world.result('closed').sentence, /^Request "closed" was refused: pull request #\d+ isn't open, so name an open pull request\.$/);
  assert.match(world.result('other-issue').sentence, /^Request "other-issue" was refused: .*issue #52/);
  assert.deepEqual(world.fake.writes, []);
});

test('when it goes wrong 1: with no connection, requests wait and go on the next run', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/offline');
  world.pushRequest('offline-push', 'claude/offline', commit);
  world.commentRequest('offline-comment', { issue: 52 });
  const nowhere = { apiBase: 'http://127.0.0.1:1', gitUrl: 'http://127.0.0.1:1/git/open-convo.git' };

  await world.run(nowhere);

  for (const id of ['offline-push', 'offline-comment']) {
    assert.equal(world.result(id).state, 'waiting');
    assert.match(world.result(id).sentence, /^Waiting: GitHub can't be reached\./);
  }
  assert.equal(world.onGitHub('claude/offline'), null);

  await world.run();
  assert.equal(world.result('offline-push').state, 'done');
  assert.equal(world.result('offline-comment').state, 'done');
  assert.equal(world.onGitHub('claude/offline'), commit);
});

test("when it goes wrong 4: when the key can't be opened, every request waits and says so", async (t) => {
  const world = await makeWorld(t);
  world.commentRequest('k-1', { issue: 52 });
  world.commentRequest('k-2', { issue: 52 });
  world.seam.fail = true;

  const { lines } = await world.run();

  const sentence = "Waiting: the push gate can't open its key. The owner needs to check 1Password.";
  assert.equal(world.result('k-1').sentence, sentence);
  assert.equal(world.result('k-2').sentence, sentence);
  assert.ok(lines.includes(`k-1: ${sentence}`), 'an attended run shows it on screen');
  assert.doesNotMatch(lines.join('\n'), /invented 1Password failure/);
  assert.deepEqual(world.fake.requests, []);

  world.seam.fail = false;
  await world.run();
  assert.equal(world.result('k-1').state, 'done');
  assert.equal(world.result('k-2').state, 'done');
});

test('plan test 13: a push left in "working" after a crash is not pushed or opened twice', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/crash');
  world.pushRequest('crash-1', 'claude/crash', commit);

  // The gate dies right after git finishes the push.
  const dieAfterPush = async (command, args, options) => {
    const out = await world.run.inner(command, args, options);
    if (args.includes('push')) throw new Error('invented crash');
    return out;
  };
  world.run.inner = (await import('../src/git.mjs')).runCommand;
  await assert.rejects(world.run({ run: dieAfterPush }), /invented crash/);
  assert.equal(world.onGitHub('claude/crash'), commit);
  assert.equal(world.fake.pulls.length, 0);

  // The next run finds the branch already there and only opens the pull request.
  await world.run();
  assert.equal(world.fake.pushes, 1);
  assert.equal(world.fake.pulls.length, 1);
  assert.equal(world.result('crash-1').state, 'done');

  // The gate dies again, this time right after GitHub made the pull request of a second request.
  const second = world.commit('claude/crash-two');
  world.pushRequest('crash-2', 'claude/crash-two', second);
  const dieAfterOpening = async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'POST' && url.endsWith('/pulls')) throw new Error('invented crash');
    return response;
  };
  await assert.rejects(world.run({ fetchImpl: dieAfterOpening }), /invented crash/);
  await world.run();
  assert.equal(world.fake.pushes, 2);
  assert.equal(world.fake.pulls.length, 2);
  assert.deepEqual(world.fake.pulls[1].labels, [{ name: 'agent: claude' }]);
  assert.equal(world.result('crash-2').state, 'done');
});

test('plan test 13: a comment or reply left in "working" after a crash is not posted twice', async (t) => {
  const world = await makeWorld(t);
  const pull = world.openPull();
  world.fake.reviewComments.push({ id: 7001, pull, body: 'An invented finding.', user: { login: 'chatgpt-codex-connector[bot]' } });
  world.commentRequest('once', { issue: 52 });
  world.request('reply-once', { kind: 'reply', agent: 'claude', thread: world.thread, pull, inReplyTo: 7001, body: `Answered.\n\n${world.signOff()}` });

  const dieAfterPosting = async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'POST' && /\/(comments|replies)$/.test(url)) throw new Error('invented crash');
    return response;
  };
  await assert.rejects(world.run({ fetchImpl: dieAfterPosting }), /invented crash/);
  await assert.rejects(world.run({ fetchImpl: dieAfterPosting }), /invented crash/);
  await world.run();
  await world.run();

  assert.equal(world.fake.comments.filter((c) => c.issue === 52).length, 1);
  assert.equal(world.fake.reviewComments.filter((c) => c.in_reply_to_id === 7001).length, 1);
  assert.equal(world.result('once').state, 'done');
  assert.equal(world.result('reply-once').state, 'done');
});

test('plan test 14: with nothing waiting, a run does nothing and writes nothing', async (t) => {
  const world = await makeWorld(t);
  const before = world.snapshot();

  const { lines, handled } = await world.run();

  assert.equal(handled, 0);
  assert.deepEqual(lines, [NOTHING_WAITING]);
  assert.deepEqual(world.snapshot(), before);
  assert.deepEqual(world.fake.requests, []);
  assert.equal(world.seam.calls, 0);
  assert.deepEqual(world.commands, []);

  const said = [];
  const code = await main(['status'], { env: { PUSH_GATE_HOME: world.home, PUSH_GATE_SHARED: world.shared }, out: (line) => said.push(line) });
  assert.equal(code, 0);
  assert.deepEqual(said, ['Nothing waiting.']);
  assert.deepEqual(world.snapshot(), before);
});

test('status lists waiting, done and refused requests for any agent session to read', async (t) => {
  const world = await makeWorld(t);
  world.commentRequest('s-done', { issue: 52 });
  world.commentRequest('s-refused', { issue: 52 }, { body: 'No sign-off here.' });
  await world.run();
  world.clock.ms += MINUTE;
  world.commentRequest('s-new', { issue: 52 });

  const { lines } = world.status();

  assert.equal(lines.length, 3);
  assert.match(lines[0], /^s-new: Waiting: the gate hasn't looked at it yet\./);
  assert.ok(lines.some((line) => line.startsWith('s-done: Done: the comment is on #52')));
  assert.ok(lines.some((line) => line.startsWith('s-refused: Request "s-refused" was refused: ')));
});
