// Follow-ups to the push gate's first review (pull request 322): one test
// for each finding the owner accepted for later. Each fails without its fix.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { GitHubRefused, LocalFailure, NoConnection } from '../src/errors.mjs';
import { NOTHING_WAITING } from '../src/gate.mjs';
import { createGit, runCommand } from '../src/git.mjs';
import { makeWorld, MINUTE } from './helpers/world.mjs';

const POSTS_ON_52 = (url, options) => options.method === 'POST' && url.endsWith('/issues/52/comments');

// A git that answers every read from and push to GitHub with `stderr`.
const answering = (world, stderr) => (command, args, options) =>
  args.some((arg) => ['push', 'fetch', 'ls-remote'].includes(arg)) && args.includes(world.fake.gitUrl) ? Promise.resolve({ code: 128, stdout: '', stderr }) : runCommand(command, args, options);

function cli(world, argv, extra = {}) {
  const shown = [];
  const options = {
    loadSeam: async () => world.seam,
    env: { ...process.env, PUSH_GATE_HOME: world.home, PUSH_GATE_SHARED: world.shared },
    out: (line) => shown.push(line),
    err: (line) => shown.push(line),
    now: world.now,
    apiBase: world.fake.apiBase,
    gitUrl: world.fake.gitUrl,
    ...extra,
  };
  return main(argv, options).then((code) => ({ code, shown }));
}

test('two requests with the same text: the second, interrupted mid-post, is still posted, and each is on GitHub exactly once', async (t) => {
  const world = await makeWorld(t);
  const body = `The same words, asked for twice.\n\n${world.signOff()}`;
  const same = () => world.fake.comments.filter((c) => c.issue === 52 && c.body === body).length;

  world.commentRequest('same-1', { issue: 52 }, { body });
  await world.run();
  assert.equal(world.result('same-1').state, 'done');
  assert.equal(same(), 1);

  // The connection fails before GitHub takes the second request's comment.
  world.commentRequest('same-2', { issue: 52 }, { body });
  await world.run({
    fetchImpl: async (url, options) => {
      if (POSTS_ON_52(url, options)) throw new TypeError('fetch failed');
      return fetch(url, options);
    },
  });
  assert.equal(world.result('same-2').state, 'waiting');
  assert.equal(same(), 1);
  // The first request's comment is not taken for the second's: it is posted now.
  await world.run();
  assert.equal(world.result('same-2').state, 'done');
  assert.equal(same(), 2);

  // The connection fails after GitHub took a third request's comment: that one is found, not posted again.
  world.commentRequest('same-3', { issue: 52 }, { body });
  await world.run({
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (POSTS_ON_52(url, options)) throw new TypeError('fetch failed');
      return response;
    },
  });
  assert.equal(world.result('same-3').state, 'waiting');
  assert.equal(same(), 3);
  await world.run();
  await world.run();
  assert.equal(world.result('same-3').state, 'done');
  assert.equal(same(), 3);
  // The text that went up is the request's own, unchanged.
  assert.deepEqual([...new Set(world.fake.comments.map((c) => c.body))], [body]);
});

const DROPPED = [
  "fatal: unable to access 'invented': Recv failure: Connection reset by peer",
  'error: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: the remote end hung up unexpectedly',
  "fatal: unable to access 'invented': LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to invented:443",
  'error: RPC failed; HTTP 408 curl 22 The requested URL returned error: 408\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly',
];

test('F1: a connection that drops during a read or a push is no connection, not a refusal from GitHub', async (t) => {
  const world = await makeWorld(t);
  const sha = 'a'.repeat(40);
  for (const stderr of DROPPED) {
    const git = createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, stderr) });
    await git.ensureRepo();
    await assert.rejects(git.push(sha, 'claude/invented', 'an-invented-token'), NoConnection, stderr);
    await assert.rejects(git.fetchMain(), NoConnection, stderr);
    await assert.rejects(git.remoteBranch('claude/invented'), NoConnection, stderr);
  }
  // GitHub's own refusals stay refusals.
  for (const stderr of [
    "remote: Permission to invented denied.\nfatal: unable to access 'invented': The requested URL returned error: 403",
    ' ! [remote rejected] aaaa -> claude/invented (pre-receive hook declined)\nerror: failed to push some refs',
    'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413\nfatal: the remote end hung up unexpectedly',
    "fatal: couldn't find remote ref refs/heads/main",
  ]) {
    const git = createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, stderr) });
    await assert.rejects(git.push(sha, 'claude/invented', 'an-invented-token'), GitHubRefused, stderr);
  }
});

test('F1: four dropped connections in an hour leave the request waiting and the gate running, and nothing is lost', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/dropped');
  world.pushRequest('dropped-1', 'claude/dropped', commit);

  for (const stderr of DROPPED) {
    await world.run({ run: answering(world, stderr) });
    assert.equal(world.result('dropped-1').state, 'waiting', stderr);
    assert.match(world.result('dropped-1').sentence, /^Waiting: GitHub can't be reached\./);
    world.clock.ms += MINUTE;
  }
  assert.doesNotMatch(world.status().lines.join('\n'), /stopped every write/);

  await world.run();
  assert.equal(world.result('dropped-1').state, 'done');
  assert.equal(world.onGitHub('claude/dropped'), commit);
  assert.equal(world.fake.pushes, 1);
});

test("F2: git failing on the gate's own Mac, such as a full disk, is a local failure: requests wait and no refusal is counted", async (t) => {
  const world = await makeWorld(t);
  const full = 'fatal: unable to write new index file: No space left on device';
  const git = createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, full) });
  await git.ensureRepo();
  await assert.rejects(git.fetchMain(), LocalFailure);
  await assert.rejects(git.push('a'.repeat(40), 'claude/invented', 'an-invented-token'), LocalFailure);

  const commit = world.commit('claude/full-disk');
  world.pushRequest('full-1', 'claude/full-disk', commit);
  world.commentRequest('behind-it', { issue: 52 });
  for (let i = 0; i < 4; i += 1) {
    await world.run({ run: answering(world, full) });
    for (const id of ['full-1', 'behind-it']) {
      assert.equal(world.result(id).state, 'waiting');
      assert.match(world.result(id).sentence, /^Waiting: git failed on the gate's own Mac during the read of main \("unable to write new index file: No space left on device"\)\. GitHub refused nothing\./);
    }
    world.clock.ms += MINUTE;
  }
  assert.doesNotMatch(world.status().lines.join('\n'), /stopped every write/);
  assert.deepEqual(world.fake.writes, []);

  await world.run();
  assert.equal(world.result('full-1').state, 'done');
  assert.equal(world.result('behind-it').state, 'done');
});

test('F3: an unexpected error leaves a "failed" result that status shows, with no stack trace, and the request goes on the next run', async (t) => {
  const world = await makeWorld(t);
  world.commentRequest('odd-1', { issue: 52 });
  world.commentRequest('odd-2', { issue: 52 });
  const unexpected = async (url, options) => {
    if (POSTS_ON_52(url, options)) throw new RangeError('an invented fault');
    return fetch(url, options);
  };

  const { code, shown } = await cli(world, ['run-once'], { fetchImpl: unexpected });

  assert.equal(code, 1);
  assert.equal(shown.at(-1), 'The push gate run stopped on an unexpected error (an invented fault). Run push-gate status to see which request it was.');
  assert.doesNotMatch(shown.join('\n'), /\n\s+at /);
  const result = world.result('odd-1');
  assert.equal(result.state, 'failed');
  assert.match(result.sentence, /^Failed: the push gate stopped on an unexpected error while handling request "odd-1" \(an invented fault\)\. /);
  const { lines } = world.status();
  assert.ok(lines.includes(`odd-1: ${result.sentence}`));
  assert.ok(!lines.includes(NOTHING_WAITING));
  assert.deepEqual(world.fake.liveTokens(), []);

  await world.run();
  assert.equal(world.result('odd-1').state, 'done');
  assert.equal(world.result('odd-2').state, 'done');
  assert.equal(world.fake.comments.length, 2);
});

test("F4: a named pipe or a folder in the requests folder is passed over and doesn't hold the run", async (t) => {
  const world = await makeWorld(t);
  const old = (world.clock.ms - 10 * MINUTE) / 1000;
  const pipe = join(world.requests, 'a-pipe.json');
  execFileSync('mkfifo', [pipe]);
  utimesSync(pipe, old, old);
  // Something holds the pipe's other end, so even a waiting open would return.
  const held = openSync(pipe, constants.O_RDWR | constants.O_NONBLOCK);
  t.after(() => closeSync(held));
  mkdirSync(join(world.requests, 'a-folder.json'));
  utimesSync(join(world.requests, 'a-folder.json'), old, old);
  world.commentRequest('real-one', { issue: 52 });

  await world.run();

  assert.equal(world.result('real-one').state, 'done');
  assert.equal(world.result('a-pipe'), null);
  assert.equal(world.result('a-folder'), null);
  assert.deepEqual(readdirSync(world.requests).sort(), ['a-folder.json', 'a-pipe.json']);
  assert.deepEqual(world.status().lines.filter((line) => /a-pipe|a-folder/.test(line)), []);
});

test("F4: a request whose bundle is a named pipe nobody writes to is refused at once, not waited on", async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/piped');
  execFileSync('mkfifo', [join(world.requests, 'piped.bundle')]);
  world.pushRequest('piped-1', 'claude/piped', commit, { bundle: 'piped.bundle' });

  await world.run();

  assert.match(world.result('piped-1').sentence, /^Request "piped-1" was refused: its bundle file "piped.bundle" isn't in the waiting folder as a plain file/);
  assert.equal(world.onGitHub('claude/piped'), null);
});

test('F5: the background job runs with --quiet, and an idle run then prints nothing and writes nothing', async (t) => {
  const world = await makeWorld(t);
  const before = world.snapshot();

  const quiet = await cli(world, ['run-once', '--quiet']);
  assert.deepEqual(quiet, { code: 0, shown: [] });
  assert.deepEqual(world.snapshot(), before);
  // Attended, the same run still says so.
  assert.deepEqual(await cli(world, ['run-once']), { code: 0, shown: [NOTHING_WAITING] });

  // With work to do, --quiet still shows it.
  world.commentRequest('said', { issue: 52 });
  const busy = await cli(world, ['run-once', '--quiet']);
  assert.ok(busy.shown.some((line) => line.startsWith('said: Done: the comment is on #52')));

  const job = readFileSync(new URL('../../../scripts/push-gate/com.cloudworksystems.push-gate.plist', import.meta.url), 'utf8');
  const args = [...job.split('<key>ProgramArguments</key>')[1].split('</array>')[0].matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepEqual(args.slice(-2), ['run-once', '--quiet']);
});

test('F6: push-gate token --permissions takes only contents, pull_requests and issues', async (t) => {
  const world = await makeWorld(t);
  const note = join(world.dir, 'note.json');
  const command = ['--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(note)}, 'ran')`];

  for (const asked of ['statuses:write', 'checks:write', 'actions:write', 'actions:read', 'metadata:read', 'contents:write,statuses:write']) {
    const { code, shown } = await cli(world, ['token', '--permissions', asked, ...command]);
    assert.equal(code, 2, asked);
    assert.match(shown.join('\n'), /^Usage:/, asked);
  }
  assert.equal(world.fake.tokens.size, 0);
  assert.equal(world.seam.calls, 0);
  assert.equal(existsSync(note), false);

  const allowed = await cli(world, ['token', '--permissions', 'contents:write,pull_requests:write,issues:write', ...command]);
  assert.equal(allowed.code, 0);
  assert.equal(readFileSync(note, 'utf8'), 'ran');
  assert.deepEqual([...world.fake.tokens.values()].at(-1).permissions, { contents: 'write', pull_requests: 'write', issues: 'write' });
  assert.deepEqual(world.fake.liveTokens(), []);
});

// Codex on pull request 325: a transfer that breaks off after GitHub's 200.
const BROKEN_OFF = [
  'error: RPC failed; HTTP 200 curl 18 transfer closed with outstanding read data remaining',
  'error: RPC failed; HTTP 200 curl 18 transfer closed with outstanding read data remaining\nfatal: early EOF',
  'fatal: early EOF',
];

test('F1: a transfer that breaks off after an HTTP 200 is no connection for a fetch and for a push, and four in an hour leave the gate running', async (t) => {
  const world = await makeWorld(t);
  const sha = 'a'.repeat(40);
  for (const stderr of BROKEN_OFF) {
    const git = createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, stderr) });
    await git.ensureRepo();
    await assert.rejects(git.fetchMain(), NoConnection, stderr);
    await assert.rejects(git.push(sha, 'claude/invented', 'an-invented-token'), NoConnection, stderr);
    await assert.rejects(git.remoteBranch('claude/invented'), NoConnection, stderr);
  }
  // A status below 400 with nothing else in it is not GitHub saying no either: git failed here.
  const local = createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, 'error: RPC failed; HTTP 200 curl 23 Failure writing output to destination') });
  await assert.rejects(local.fetchMain(), (error) => error instanceof NoConnection || error instanceof LocalFailure);
  // 408 stays no connection, and other 4xx stay refusals.
  const late = createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, 'error: RPC failed; HTTP 408 curl 22 The requested URL returned error: 408') });
  await assert.rejects(late.push(sha, 'claude/invented', 'an-invented-token'), NoConnection);
  const large = createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, 'error: RPC failed; HTTP 413 curl 22 The requested URL returned error: 413') });
  await assert.rejects(large.push(sha, 'claude/invented', 'an-invented-token'), GitHubRefused);

  // Four in an hour: the request waits each time, the gate keeps running, and the push then goes up once.
  const commit = world.commit('claude/broken-off');
  world.pushRequest('broken-1', 'claude/broken-off', commit);
  const text = BROKEN_OFF[0];
  for (let i = 0; i < 4; i += 1) {
    await world.run({ run: answering(world, text) });
    assert.equal(world.result('broken-1').state, 'waiting');
    assert.match(world.result('broken-1').sentence, /^Waiting: GitHub can't be reached\./);
    world.clock.ms += MINUTE;
  }
  // The read works and the push itself breaks off: still no connection.
  const pushBreaks = (command, args, options) => (args.includes('push') ? Promise.resolve({ code: 128, stdout: '', stderr: text }) : runCommand(command, args, options));
  for (let i = 0; i < 4; i += 1) {
    await world.run({ run: pushBreaks });
    assert.equal(world.result('broken-1').state, 'waiting');
    assert.match(world.result('broken-1').sentence, /^Waiting: GitHub can't be reached\./);
    world.clock.ms += MINUTE;
  }
  assert.doesNotMatch(world.status().lines.join('\n'), /stopped every write/);

  await world.run();
  assert.equal(world.result('broken-1').state, 'done');
  assert.equal(world.onGitHub('claude/broken-off'), commit);
  assert.equal(world.fake.pushes, 1);
});

// Codex on pull request 325, second round: GitHub's progress lines are not GitHub saying no.
const PROGRESS_THEN_DROP = 'remote: Enumerating objects: 42, done.\nerror: RPC failed; HTTP 200 curl 18 transfer closed';

test("F1: GitHub's progress lines before a transfer breaks off don't make it a refusal, for a fetch and for a push, and four in an hour leave the gate running", async (t) => {
  const world = await makeWorld(t);
  const sha = 'a'.repeat(40);
  const gitAnswering = (stderr) => createGit({ dir: `${world.dir}/unit-checkout`, gitUrl: world.fake.gitUrl, run: answering(world, stderr) });
  for (const stderr of [
    PROGRESS_THEN_DROP,
    'remote: Enumerating objects: 42, done.\nremote: Counting objects: 100% (42/42), done.\nremote: Compressing objects: 100% (30/30), done.\nremote: Total 42 (delta 3), reused 40 (delta 2), pack-reused 0\nerror: RPC failed; curl 56 Recv failure: Connection reset by peer\nfatal: early EOF',
    'remote: Resolving deltas: 100% (3/3), completed with 2 local objects.\nsend-pack: unexpected disconnect while reading sideband packet\nfatal: the remote end hung up unexpectedly',
  ]) {
    const git = gitAnswering(stderr);
    await git.ensureRepo();
    await assert.rejects(git.fetchMain(), NoConnection, stderr);
    await assert.rejects(git.push(sha, 'claude/invented', 'an-invented-token'), NoConnection, stderr);
  }
  // Progress lines before git fails on the gate's own Mac: a local failure, not a refusal.
  await assert.rejects(gitAnswering('remote: Enumerating objects: 42, done.\nfatal: write error: No space left on device').fetchMain(), LocalFailure);

  // GitHub saying no stays a refusal, with or without progress lines before it.
  for (const stderr of [
    'remote: Resolving deltas: 100% (3/3), completed with 2 local objects.\n ! [remote rejected] aaaa -> claude/invented (pre-receive hook declined)\nerror: failed to push some refs',
    'remote: Resolving deltas: 100% (3/3), done.\nremote: error: GH006: Protected branch update failed for refs/heads/claude/invented.\nerror: failed to push some refs',
    'remote: Enumerating objects: 42, done.\nremote: error: GH013: Repository rule violations found for refs/heads/claude/invented.\nerror: RPC failed; HTTP 200 curl 18 transfer closed',
    "remote: Permission to invented denied.\nfatal: unable to access 'invented': The requested URL returned error: 403",
    'remote: Repository not found.\nfatal: repository invented not found',
  ]) {
    await assert.rejects(gitAnswering(stderr).push(sha, 'claude/invented', 'an-invented-token'), GitHubRefused, stderr);
  }

  // Four broken-off reads and four broken-off pushes in an hour: the request waits, the gate keeps running.
  const commit = world.commit('claude/progress-drop');
  world.pushRequest('progress-1', 'claude/progress-drop', commit);
  const pushBreaks = (command, args, options) => (args.includes('push') ? Promise.resolve({ code: 128, stdout: '', stderr: PROGRESS_THEN_DROP }) : runCommand(command, args, options));
  for (const run of [answering(world, PROGRESS_THEN_DROP), pushBreaks]) {
    for (let i = 0; i < 4; i += 1) {
      await world.run({ run });
      assert.equal(world.result('progress-1').state, 'waiting');
      assert.match(world.result('progress-1').sentence, /^Waiting: GitHub can't be reached\./);
      world.clock.ms += MINUTE;
    }
  }
  assert.doesNotMatch(world.status().lines.join('\n'), /stopped every write/);

  await world.run();
  assert.equal(world.result('progress-1').state, 'done');
  assert.equal(world.onGitHub('claude/progress-drop'), commit);
  assert.equal(world.fake.pushes, 1);
});
