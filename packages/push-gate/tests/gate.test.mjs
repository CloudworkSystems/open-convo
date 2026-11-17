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

test('a push that GitHub accepted before a crash or a dropped connection still starts the 10 minutes for its branch', async (t) => {
  const { runCommand } = await import('../src/git.mjs');
  const world = await makeWorld(t);
  const start = world.now();

  // A crash right after the push: the next request for the branch must still wait.
  const first = world.commit('claude/timed');
  world.pushRequest('timed-1', 'claude/timed', first);
  const dieAfterPush = async (command, args, options) => {
    const out = await runCommand(command, args, options);
    if (args.includes('push')) throw new Error('invented crash');
    return out;
  };
  await assert.rejects(world.run({ run: dieAfterPush }), /invented crash/);
  assert.equal(world.onGitHub('claude/timed'), first);
  world.clock.ms = start + MINUTE;
  const second = world.commit('claude/timed', { 'notes.txt': 'a fix\n' });
  world.pushRequest('timed-2', 'claude/timed', second);
  await world.run();
  assert.equal(world.result('timed-1').state, 'done', 'the interrupted request finishes without waiting on its own push');
  assert.equal(world.result('timed-2').state, 'waiting');
  assert.equal(world.result('timed-2').until, new Date(start + 10 * MINUTE).toISOString());
  assert.equal(world.onGitHub('claude/timed'), first);
  assert.equal(world.fake.pushes, 1);

  // GitHub takes the push, but the command reports a lost connection.
  const other = world.commit('claude/dropped');
  world.pushRequest('dropped-1', 'claude/dropped', other);
  const dropAfterPush = async (command, args, options) => {
    const out = await runCommand(command, args, options);
    return args.includes('push') ? { code: 128, stdout: '', stderr: "fatal: unable to access 'invented': Failed to connect to 127.0.0.1" } : out;
  };
  await world.run({ run: dropAfterPush });
  assert.equal(world.result('dropped-1').state, 'waiting');
  assert.match(world.result('dropped-1').sentence, /^Waiting: GitHub can't be reached\./);
  const droppedAt = world.now();
  world.clock.ms += MINUTE;
  const fix = world.commit('claude/dropped', { 'notes.txt': 'a fix\n' });
  world.pushRequest('dropped-2', 'claude/dropped', fix);
  await world.run();
  assert.equal(world.result('dropped-1').state, 'done');
  assert.equal(world.result('dropped-2').state, 'waiting');
  assert.equal(world.result('dropped-2').until, new Date(droppedAt + 10 * MINUTE).toISOString());
  assert.equal(world.onGitHub('claude/dropped'), other);
});

test('a push to a pull request with an empty description still leaves the local review record there', async (t) => {
  const world = await makeWorld(t);
  for (const [branch, body] of [
    ['claude/blank-null', null],
    ['claude/blank-empty', ''],
    ['claude/blank-spaces', ' \n\n '],
  ]) {
    const commit = world.commit(branch);
    world.openPull(branch);
    world.fake.pulls.at(-1).body = body;
    world.pushRequest(branch.slice('claude/'.length), branch, commit, { pullRequest: undefined });
  }

  await world.run();

  for (const pull of world.fake.pulls) {
    assert.match(pull.body, /^Local review: Codex reviewed commit [0-9a-f]{12}, result "clean" \(recorded by the push gate\)\.\n\nClaude, test thread 7$/);
  }
  assert.equal(world.fake.pulls.length, 3);
  assert.deepEqual(world.log().filter((line) => line.kind === 'description').map((line) => line.result), ['done', 'done', 'done']);
});

test("a token that can't be revoked is reported, not passed over", async (t) => {
  const world = await makeWorld(t);
  const REVOKE = (method, path) => method === 'DELETE' && path === '/installation/token';

  // One failed try is not a failure: the gate tries again.
  world.commentRequest('retry', { issue: 52 });
  world.fake.failNext(REVOKE, 500, { times: 2 });
  const quiet = await world.run();
  assert.deepEqual(world.fake.liveTokens(), []);
  assert.doesNotMatch(quiet.lines.join('\n'), /could not be revoked/);

  // Three failed tries: the request is done, and the live token is said out loud and written down.
  world.commentRequest('stuck', { issue: 52 });
  world.fake.failNext((method, path) => REVOKE(method, path) && world.fake.requests.filter((r) => r === 'POST /repos/CloudworkSystems/open-convo/issues/52/comments').length === 2, 500, { times: 3 });
  const { lines } = await world.run();
  assert.equal(world.result('stuck').state, 'done');
  assert.equal(world.fake.liveTokens().length, 1);
  const said = /^A token could not be revoked and works until November 16(,| at) 11:00 AM EST\. The owner can end it now by suspending the app's installation\.$/;
  assert.equal(lines.filter((line) => said.test(line)).length, 1);
  // It is in the request's own result, in one plain sentence.
  assert.match(world.result('stuck').sentence, /^Done: the comment is on #52 \(.*\)\. A token could not be revoked and works until November 16(,| at) 11:00 AM EST\. The owner can end it now by suspending the app's installation\.$/);
  assert.deepEqual(world.log().at(-1), { time: new Date(world.now()).toISOString(), kind: 'revoke', target: 'token', result: 'failed' });
  assert.match(world.status().lines.at(-1), said);
  assert.equal(world.everythingWritten().includes(world.fake.liveTokens()[0]), false);

  // Once the token has expired, status stops listing it as live; the request's result keeps its sentence.
  world.clock.ms += 61 * MINUTE;
  assert.equal(world.status().lines.filter((line) => line.startsWith('A token could not be revoked')).length, 0);
});

test("three tokens that can't be revoked within an hour stop every write until restart, as refusals do", async (t) => {
  const world = await makeWorld(t);
  for (const id of ['u-1', 'u-2', 'u-3', 'u-4']) world.commentRequest(id, { issue: 52 });
  // Every revoke after the reach check's own fails.
  let revokes = 0;
  world.fake.failNext((method, path) => method === 'DELETE' && path === '/installation/token' && (revokes += 1) > 1, 500, { times: 9 });

  await world.run();

  for (const id of ['u-1', 'u-2', 'u-3']) assert.match(world.result(id).sentence, /^Done: .* A token could not be revoked and works until /);
  assert.equal(world.result('u-4').state, 'waiting');
  assert.equal(world.result('u-4').sentence, 'Waiting: the push gate has stopped every write because GitHub refused 3 requests within an hour. The owner needs to restart it.');
  assert.equal(world.fake.comments.length, 3);
  assert.equal(world.log().filter((line) => line.kind === 'revoke' && line.result === 'failed').length, 3);

  await world.run({ restart: true });
  assert.equal(world.result('u-4').state, 'done');
});

test('a push GitHub accepted whose answer was lost is counted once in the write log, not zero or twice', async (t) => {
  const { runCommand } = await import('../src/git.mjs');
  const { createStore } = await import('../src/store.mjs');
  const world = await makeWorld(t);
  const counted = () => createStore({ home: world.home, shared: world.shared }).recentWriteTimes(world.now()).length;
  const pushes = () => world.log().filter((line) => line.kind === 'push');

  // The connection drops after GitHub has taken the push.
  const dropped = world.commit('claude/lost-answer');
  world.pushRequest('lost-1', 'claude/lost-answer', dropped, { pullRequest: undefined });
  const dropAfterPush = async (command, args, options) => {
    const out = await runCommand(command, args, options);
    return args.includes('push') ? { code: 128, stdout: '', stderr: "fatal: unable to access 'invented': Failed to connect to 127.0.0.1" } : out;
  };
  await world.run({ run: dropAfterPush });
  assert.equal(world.onGitHub('claude/lost-answer'), dropped);
  assert.deepEqual(pushes().map((line) => line.result), ['no connection']);
  assert.equal(counted(), 1, 'it counts toward the hourly cap while its outcome is unknown');
  await world.run();
  assert.equal(world.result('lost-1').state, 'done');
  assert.deepEqual(pushes().map((line) => [line.target, line.result]), [['claude/lost-answer', 'done']]);
  assert.equal(counted(), 1);
  assert.equal(world.fake.pushes, 1);

  // The run dies after GitHub has taken the push, before anything could be written down.
  const crashed = world.commit('claude/lost-run');
  world.pushRequest('lost-2', 'claude/lost-run', crashed, { pullRequest: undefined });
  const dieAfterPush = async (command, args, options) => {
    const out = await runCommand(command, args, options);
    if (args.includes('push')) throw new Error('invented crash');
    return out;
  };
  await assert.rejects(world.run({ run: dieAfterPush }), /invented crash/);
  assert.deepEqual(pushes().map((line) => line.result), ['done', 'started']);
  assert.equal(counted(), 2);
  await world.run();
  assert.equal(world.result('lost-2').state, 'done');
  assert.deepEqual(pushes().map((line) => [line.target, line.result]), [
    ['claude/lost-answer', 'done'],
    ['claude/lost-run', 'done'],
  ]);
  assert.equal(counted(), 2);
  assert.equal(world.fake.pushes, 2);
});

test('a comment GitHub accepted whose answer was lost is counted once in the write log, not zero or twice', async (t) => {
  const { createStore } = await import('../src/store.mjs');
  const world = await makeWorld(t);
  const counted = () => createStore({ home: world.home, shared: world.shared }).recentWriteTimes(world.now()).length;
  const posts = () => world.log().filter((line) => line.kind === 'comment');
  const afterPosting = (fail) => async (url, options) => {
    const response = await fetch(url, options);
    if (options.method === 'POST' && url.endsWith('/issues/52/comments')) fail();
    return response;
  };

  // The connection drops after GitHub has taken the comment.
  world.commentRequest('lost-comment', { issue: 52 });
  await world.run({
    fetchImpl: afterPosting(() => {
      throw new TypeError('fetch failed');
    }),
  });
  assert.equal(world.fake.comments.length, 1);
  assert.equal(world.result('lost-comment').state, 'waiting');
  assert.deepEqual(posts().map((line) => line.result), ['no connection']);
  assert.equal(counted(), 1);
  await world.run();
  assert.equal(world.result('lost-comment').state, 'done');
  assert.deepEqual(posts().map((line) => [line.target, line.result]), [['#52', 'done']]);
  assert.equal(counted(), 1);
  assert.equal(world.fake.comments.length, 1);

  // The run dies after GitHub has taken the comment.
  world.clock.ms += MINUTE;
  world.commentRequest('lost-comment-2', { issue: 52 });
  await assert.rejects(
    world.run({
      fetchImpl: afterPosting(() => {
        throw new Error('invented crash');
      }),
    }),
    /invented crash/,
  );
  assert.deepEqual(posts().map((line) => line.result), ['done', 'started']);
  assert.equal(counted(), 2);
  await world.run();
  assert.equal(world.result('lost-comment-2').state, 'done');
  assert.deepEqual(posts().map((line) => line.result), ['done', 'done']);
  assert.equal(counted(), 2);
  assert.equal(world.fake.comments.length, 2);
});

test('a write GitHub accepted before a crash counts toward the hourly cap on the next run', async (t) => {
  const world = await makeWorld(t);
  for (let i = 1; i <= 59; i += 1) world.commentRequest(`a-${String(i).padStart(2, '0')}`, { issue: 52 });
  await world.run();
  world.clock.ms += MINUTE;
  world.commentRequest('b-60', { issue: 52 });
  await assert.rejects(
    world.run({
      fetchImpl: async (url, options) => {
        const response = await fetch(url, options);
        if (options.method === 'POST' && url.endsWith('/issues/52/comments')) throw new Error('invented crash');
        return response;
      },
    }),
    /invented crash/,
  );
  assert.equal(world.fake.comments.length, 60);

  // The 60th write was never answered, but it is counted: the 61st waits.
  world.commentRequest('b-61', { issue: 52 });
  await world.run();
  assert.equal(world.result('b-60').state, 'done');
  assert.equal(world.result('b-61').state, 'waiting');
  assert.match(world.result('b-61').sentence, /^Waiting: the agents have made about 60 writes to GitHub in the last hour\./);
  assert.equal(world.fake.comments.length, 60);
  assert.equal(world.log().length, 60);
});

test("another run's lock keeps this run out, but not for more than 30 minutes", async (t) => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const world = await makeWorld(t);
  world.commentRequest('locked', { issue: 52 });
  // A lock held by a process that is alive and is not this one.
  mkdirSync(`${world.home}/work`, { recursive: true });
  writeFileSync(`${world.home}/work/lock`, JSON.stringify({ pid: process.ppid, at: world.now() }));

  const { lines } = await world.run();
  assert.deepEqual(lines, ['Another push gate run is going. This one did nothing.']);
  assert.equal(world.result('locked'), null);

  // The same lock half an hour on is left over from a run that died.
  world.clock.ms += 30 * MINUTE;
  await world.run();
  assert.equal(world.result('locked').state, 'done');
});

test('a request left in both the waiting folder and the working folder by a crash is handled once', async (t) => {
  const { existsSync, readdirSync: list } = await import('node:fs');
  const world = await makeWorld(t);
  const nowhere = { apiBase: 'http://127.0.0.1:1', gitUrl: 'http://127.0.0.1:1/git/open-convo.git' };
  const pull = world.openPull();
  world.fake.reviewComments.push({ id: 7001, pull, body: 'An invented finding.', user: { login: 'chatgpt-codex-connector[bot]' } });
  const commit = world.commit('claude/twice');
  const makers = {
    'twice-comment': () => world.commentRequest('twice-comment', { issue: 52 }),
    'twice-reply': () => world.request('twice-reply', { kind: 'reply', agent: 'claude', thread: world.thread, pull, inReplyTo: 7001, body: `Answered.\n\n${world.signOff()}` }),
    'twice-push': () => world.pushRequest('twice-push', 'claude/twice', commit),
  };
  for (const [id, make] of Object.entries(makers)) {
    // The gate takes the request on (GitHub can't be reached, so it stays in working)...
    make();
    await world.run(nowhere);
    assert.equal(existsSync(`${world.home}/work/working/${id}.json`), true, id);
    // ...and, as after a crash between saving the working copy and removing the file, the file is still in the waiting folder.
    make();
    await world.run();
    await world.run();
    assert.equal(world.result(id).state, 'done', id);
  }

  assert.equal(world.fake.comments.filter((c) => c.issue === 52).length, 1);
  assert.equal(world.fake.reviewComments.filter((c) => c.in_reply_to_id === 7001).length, 1);
  assert.equal(world.fake.pushes, 1);
  assert.equal(world.fake.pulls.length, 2);
  for (const id of ['twice-comment', 'twice-reply', 'twice-push']) assert.equal(world.result(id).state, 'done', id);
  assert.deepEqual(list(world.requests), []);
  assert.equal(existsSync(`${world.home}/work/working/twice-comment.json`), false);
});

test('a request whose outcome was reached just before a crash keeps that outcome and is not handled again', async (t) => {
  const { mkdirSync, readdirSync: list, writeFileSync } = await import('node:fs');
  const world = await makeWorld(t);
  // As left by a run that died after reaching each outcome and before writing the result files.
  mkdirSync(`${world.home}/work/working`, { recursive: true });
  const leftover = (id, finished) =>
    writeFileSync(
      `${world.home}/work/working/${id}.json`,
      JSON.stringify({ id, request: { kind: 'comment', agent: 'claude', thread: world.thread, target: { issue: 52 }, body: `Posted before.\n\n${world.signOff()}` }, step: 'posting', postingAt: world.now(), takenAt: world.now(), finished }),
    );
  leftover('was-done', { state: 'done', sentence: 'Done: the comment is on #52 (invented link).', issue: { number: 52 } });
  leftover('was-refused', { state: 'refused', sentence: 'Request "was-refused" was refused: GitHub answered "invented", so change the request to fit and send a new one.' });

  await world.run();

  assert.equal(world.result('was-done').sentence, 'Done: the comment is on #52 (invented link).');
  assert.equal(world.result('was-refused').state, 'refused');
  assert.deepEqual(list(`${world.home}/work/working`), []);
  // Nothing was sent, and no token was made.
  assert.deepEqual(world.fake.requests, []);
  assert.equal(world.seam.calls, 0);
});

test('a finished request leaves its outcome in the working copy until the result file is written', async (t) => {
  const { createStore } = await import('../src/store.mjs');
  const world = await makeWorld(t);
  world.commentRequest('ordered', { issue: 52 });
  const nowhere = { apiBase: 'http://127.0.0.1:1', gitUrl: 'http://127.0.0.1:1/git/open-convo.git' };
  await world.run(nowhere);
  const store = createStore({ home: world.home, shared: world.shared });
  store.markFinished('ordered', { state: 'done', sentence: 'Done: invented.' });
  assert.deepEqual(store.listWorking()[0].finished, { state: 'done', sentence: 'Done: invented.' });
  store.markFinished('not-there', { state: 'done', sentence: 'x' });
  assert.equal(store.listWorking().length, 1);
});
