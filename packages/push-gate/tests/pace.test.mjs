// "Pace Limits" (docs/plans/push-gate.md): plan tests 9 to 12.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { capUntil, quietUntil } from '../src/pace.mjs';
import { makeWorld, MINUTE } from './helpers/world.mjs';

const HOUR = 60 * MINUTE;
const at = (text) => Date.parse(text);
const iso = (ms) => new Date(ms).toISOString();
const ISSUE_COMMENTS = (method, path) => method === 'POST' && path.endsWith('/issues/52/comments');
const notes = (world) => world.fake.comments.filter((c) => c.body.startsWith('The push gate stopped every write'));

test('plan test 9: a second push to one pull request within 10 minutes waits, and a newer request replaces an older waiting one', async (t) => {
  const world = await makeWorld(t);
  const branch = 'claude/paced';
  const start = world.now();
  const first = world.commit(branch);
  world.pushRequest('paced-1', branch, first);
  await world.run();
  assert.equal(world.onGitHub(branch), first);

  // One minute later a fix arrives: it waits for the 10 minutes.
  world.clock.ms = start + MINUTE;
  const second = world.commit(branch, { 'notes.txt': 'a first fix\n' });
  world.pushRequest('paced-2', branch, second);
  await world.run();
  assert.equal(world.result('paced-2').state, 'waiting');
  assert.match(world.result('paced-2').sentence, /^Waiting: branch claude\/paced was pushed less than 10 minutes ago\./);
  assert.equal(world.result('paced-2').until, iso(start + 10 * MINUTE));
  assert.equal(world.onGitHub(branch), first);

  // A newer request for the same branch replaces the one still waiting.
  world.clock.ms = start + 2 * MINUTE;
  const third = world.commit(branch, { 'notes.txt': 'a second fix\n' });
  world.pushRequest('paced-3', branch, third);
  await world.run();
  assert.equal(world.result('paced-2').state, 'refused');
  assert.match(world.result('paced-2').sentence, /the newer request "paced-3" for the same branch replaced it/);
  assert.equal(world.result('paced-3').state, 'waiting');

  world.clock.ms = start + 10 * MINUTE - 1000;
  await world.run();
  assert.equal(world.onGitHub(branch), first);

  // At 10 minutes the fixes go up as one push, to the same pull request.
  world.clock.ms = start + 10 * MINUTE;
  await world.run();
  assert.equal(world.result('paced-3').state, 'done');
  assert.equal(world.onGitHub(branch), third);
  assert.equal(world.fake.pushes, 2);
  assert.equal(world.fake.pulls.length, 1);
  assert.match(world.fake.pulls[0].body, new RegExp(`^Local review: Codex reviewed commit ${third.slice(0, 12)},`, 'm'));
  assert.equal(world.fake.pulls[0].body.match(/^Local review:/gm).length, 1);
});

test('plan test 10: quiet hours hold requests until 6 AM New York time, across a daylight saving change', async (t) => {
  // The night the clocks go back (November 1, 2026): 11:30 PM daylight time on October 31.
  const world = await makeWorld(t, { startMs: at('2026-11-01T03:30:00Z') });
  world.commentRequest('night', { issue: 52 });
  await world.run();
  assert.equal(world.result('night').state, 'waiting');
  assert.match(world.result('night').sentence, /^Waiting: quiet hours, 11 PM to 6 AM New York time\. It goes at November 1(,| at) 6:00 AM EST/);
  // 6 AM standard time is 11:00 UTC, not the 10:00 UTC it was the day before.
  assert.equal(world.result('night').until, '2026-11-01T11:00:00.000Z');
  assert.deepEqual(world.fake.requests, []);

  world.clock.ms = at('2026-11-01T10:59:59Z');
  await world.run();
  assert.equal(world.result('night').state, 'waiting');
  assert.deepEqual(world.fake.writes, []);

  world.clock.ms = at('2026-11-01T11:00:00Z');
  await world.run();
  assert.equal(world.result('night').state, 'done');
});

test('plan test 10: quiet hours start at 11 PM and end at 6 AM in New York, winter and summer', () => {
  // Winter (EST, UTC-5).
  assert.equal(quietUntil(at('2026-11-17T03:59:59Z')), null); // 10:59:59 PM
  assert.equal(quietUntil(at('2026-11-17T04:00:00Z')), at('2026-11-17T11:00:00Z')); // 11 PM
  assert.equal(quietUntil(at('2026-11-17T10:59:59Z')), at('2026-11-17T11:00:00Z')); // 5:59:59 AM
  assert.equal(quietUntil(at('2026-11-17T11:00:00Z')), null); // 6 AM
  assert.equal(quietUntil(at('2026-11-16T15:00:00Z')), null); // 10 AM
  // Summer (EDT, UTC-4).
  assert.equal(quietUntil(at('2026-07-15T02:59:59Z')), null); // 10:59:59 PM
  assert.equal(quietUntil(at('2026-07-15T03:00:00Z')), at('2026-07-15T10:00:00Z')); // 11 PM
  assert.equal(quietUntil(at('2026-07-15T10:00:00Z')), null); // 6 AM
  // The night the clocks go forward (March 14, 2027): 11:30 PM standard time, 6 AM daylight time.
  assert.equal(quietUntil(at('2027-03-14T04:30:00Z')), at('2027-03-14T10:00:00Z'));
  // And after 2 AM that night, when it is already daylight time.
  assert.equal(quietUntil(at('2027-03-14T07:30:00Z')), at('2027-03-14T10:00:00Z'));
  // The night the clocks go back, after the repeated hour.
  assert.equal(quietUntil(at('2026-11-01T06:30:00Z')), at('2026-11-01T11:00:00Z'));
});

test('plan test 10: the owner can let one request through quiet hours with push-gate allow', async (t) => {
  const world = await makeWorld(t, { startMs: at('2026-11-17T07:00:00Z') }); // 2 AM
  world.commentRequest('let-through', { issue: 52 });
  world.commentRequest('still-held', { issue: 52 });
  await world.run();
  assert.equal(world.result('let-through').state, 'waiting');

  const env = { PUSH_GATE_HOME: world.home, PUSH_GATE_SHARED: world.shared };
  const said = [];
  assert.equal(await main(['allow', 'let-through'], { env, out: (line) => said.push(line), err: (line) => said.push(line) }), 0);
  assert.equal(await main(['allow', 'no-such-request'], { env, out: (line) => said.push(line), err: (line) => said.push(line) }), 1);
  assert.match(said[1], /^No waiting request is named "no-such-request"\./);
  await world.run();

  assert.equal(world.result('let-through').state, 'done');
  assert.equal(world.result('still-held').state, 'waiting');
  assert.equal(world.fake.comments.length, 1);
});

test('plan test 11: the 61st write in an hour waits', async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  for (let i = 1; i <= 61; i += 1) world.commentRequest(`w-${String(i).padStart(2, '0')}`, { issue: 52 });

  await world.run();

  assert.equal(world.fake.comments.length, 60);
  assert.equal(world.log().length, 60);
  assert.equal(world.result('w-60').state, 'done');
  const held = world.result('w-61');
  assert.equal(held.state, 'waiting');
  assert.match(held.sentence, /^Waiting: the agents have made about 60 writes to GitHub in the last hour\./);
  assert.equal(held.until, iso(start + HOUR));

  world.clock.ms = start + HOUR - 1000;
  await world.run();
  assert.equal(world.fake.comments.length, 60);

  world.clock.ms = start + HOUR;
  await world.run();
  assert.equal(world.result('w-61').state, 'done');
  assert.equal(world.fake.comments.length, 61);
});

test('plan test 11: a push that needs three writes waits when only two are left in the hour', () => {
  const now = at('2026-11-16T15:00:00Z');
  const writes = Array.from({ length: 58 }, (_, i) => now - 50 * MINUTE + i * 1000);
  assert.equal(capUntil(writes, now, 2), null);
  assert.equal(capUntil(writes, now, 3), writes[0] + HOUR);
  assert.equal(capUntil([], now, 3), null);
});

test("plan test 12: a 429 stops every write for the longer of GitHub's wait or an hour, then one note goes on #52", async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  for (const id of ['r-1', 'r-2', 'r-3']) world.commentRequest(id, { issue: 52 });
  // GitHub names a two-hour wait.
  world.fake.failNext(ISSUE_COMMENTS, 429, { headers: { 'retry-after': '7200' }, body: { message: 'Too Many Requests' } });

  await world.run();

  for (const id of ['r-1', 'r-2', 'r-3']) {
    assert.equal(world.result(id).state, 'waiting');
    assert.match(world.result(id).sentence, /^Waiting: GitHub asked the push gate to slow down\. Writes start again /);
    assert.equal(world.result(id).until, iso(start + 2 * HOUR));
  }
  assert.deepEqual(world.fake.writes, []);

  // An hour and a half later it is still stopped: the gate doesn't even call GitHub.
  world.clock.ms = start + 90 * MINUTE;
  const calls = world.fake.requests.length;
  await world.run();
  assert.equal(world.fake.requests.length, calls);

  // After GitHub's wait, writes resume and one note is posted on #52.
  world.clock.ms = start + 2 * HOUR;
  await world.run();
  for (const id of ['r-1', 'r-2', 'r-3']) assert.equal(world.result(id).state, 'done');
  assert.equal(notes(world).length, 1);
  assert.equal(world.fake.comments.length, 4);
  world.commentRequest('r-4', { issue: 52 });
  await world.run();
  assert.equal(notes(world).length, 1);
});

for (const [what, status, extra, waitMs] of [
  ['a 429 naming a one-minute wait', 429, { headers: { 'retry-after': '60' } }, HOUR],
  ['a 429 naming no wait', 429, {}, HOUR],
  ['a "secondary rate limit" 403', 403, { body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } }, HOUR],
  ['a used-up rate limit that resets in three hours', 403, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((at('2026-11-16T15:00:00Z') + 3 * HOUR) / 1000) }, body: { message: 'API rate limit exceeded' } }, 3 * HOUR],
]) {
  test(`plan test 12: ${what} stops every write for at least an hour`, async (t) => {
    const world = await makeWorld(t);
    const start = world.now();
    world.commentRequest('limited', { issue: 52 });
    world.fake.failNext(ISSUE_COMMENTS, status, extra);

    await world.run();
    assert.equal(world.result('limited').until, iso(start + waitMs));

    world.clock.ms = start + waitMs - 1000;
    await world.run();
    assert.deepEqual(world.fake.writes, []);

    world.clock.ms = start + waitMs;
    await world.run();
    assert.equal(world.result('limited').state, 'done');
    assert.equal(notes(world).length, 1);
  });
}

test('plan test 12: a 401 stops every write until the owner restarts the gate', async (t) => {
  const world = await makeWorld(t);
  world.commentRequest('s-1', { issue: 52 });
  world.commentRequest('s-2', { issue: 52 });
  world.fake.failNext(ISSUE_COMMENTS, 401, { body: { message: 'Bad credentials' } });

  await world.run();

  for (const id of ['s-1', 's-2']) {
    assert.equal(world.result(id).state, 'waiting');
    assert.equal(world.result(id).sentence, "Waiting: the push gate has stopped every write because GitHub didn't accept the app's sign-in. The owner needs to restart it.");
  }
  // A day later it is still stopped, and nothing is sent.
  world.clock.ms += 24 * HOUR;
  const calls = world.fake.requests.length;
  await world.run();
  assert.equal(world.fake.requests.length, calls);
  assert.deepEqual(world.fake.writes, []);
  assert.match(world.status().lines.at(-1), /^The push gate has stopped every write because GitHub didn't accept the app's sign-in\./);

  await world.run({ restart: true });
  assert.equal(world.result('s-1').state, 'done');
  assert.equal(world.result('s-2').state, 'done');
});

test('plan test 12: three other refusals in an hour stop every write until restart', async (t) => {
  const world = await makeWorld(t);
  for (const id of ['x-1', 'x-2', 'x-3', 'x-4']) world.commentRequest(id, { issue: 52 });
  world.fake.failNext(ISSUE_COMMENTS, 422, { body: { message: 'Validation Failed', errors: [{ message: 'body is too long' }] } });
  world.fake.failNext(ISSUE_COMMENTS, 403, { body: { message: 'Resource not accessible by integration' } });
  world.fake.failNext(ISSUE_COMMENTS, 404, { body: {} });

  await world.run();

  // Each refusal gives GitHub's reason in plain words, never a bare code.
  assert.equal(world.result('x-1').sentence, 'Request "x-1" was refused: GitHub answered "Validation Failed body is too long", so change the request to fit and send a new one.');
  assert.equal(world.result('x-2').sentence, 'Request "x-2" was refused: GitHub answered "Resource not accessible by integration", so change the request to fit and send a new one.');
  assert.equal(world.result('x-3').sentence, "Request \"x-3\" was refused: GitHub couldn't find what the request names, so change the request to fit and send a new one.");
  assert.equal(world.result('x-4').state, 'waiting');
  assert.equal(world.result('x-4').sentence, 'Waiting: the push gate has stopped every write because GitHub refused 3 requests within an hour. The owner needs to restart it.');
  assert.deepEqual(world.fake.writes, []);

  world.clock.ms += 5 * HOUR;
  await world.run();
  assert.equal(world.result('x-4').state, 'waiting');

  await world.run({ restart: true });
  assert.equal(world.result('x-4').state, 'done');
});

test('plan test 12: two refusals an hour apart do not stop the gate, and a refused push is not retried', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/refused-push');
  world.pushRequest('p-refused', 'claude/refused-push', commit);
  world.fake.failNext((method) => method === 'PUSH-START', 403, { body: { message: 'Permission to CloudworkSystems/open-convo.git denied to cloudwork-agents[bot].' } });
  await world.run();
  assert.equal(world.result('p-refused').state, 'refused');
  assert.match(world.result('p-refused').sentence, /^Request "p-refused" was refused: GitHub turned the push down/);
  assert.equal(world.onGitHub('claude/refused-push'), null);

  world.clock.ms += 61 * MINUTE;
  world.commentRequest('y-1', { issue: 52 });
  world.commentRequest('y-2', { issue: 52 });
  world.commentRequest('y-3', { issue: 52 });
  world.fake.failNext(ISSUE_COMMENTS, 422, { times: 2 });
  await world.run();
  assert.equal(world.result('y-1').state, 'refused');
  assert.equal(world.result('y-2').state, 'refused');
  assert.equal(world.result('y-3').state, 'done');
  await world.run();
  assert.equal(world.onGitHub('claude/refused-push'), null);
});

test('the write log has one line per write, with no comment text, and keeps 30 days', async (t) => {
  const world = await makeWorld(t);
  world.commentRequest('old', { issue: 52 }, { body: `A very particular phrase.\n\n${world.signOff()}` });
  await world.run();
  assert.deepEqual(world.log(), [{ time: iso(world.now()), kind: 'comment', target: '#52', result: 'done' }]);
  assert.equal(world.everythingWritten().includes('A very particular phrase'), false);

  world.clock.ms += 31 * 24 * HOUR;
  world.commentRequest('new', { issue: 52 });
  await world.run();
  assert.deepEqual(world.log().map((line) => line.time), [iso(world.now())]);
});

test('a replaced request that shares its bundle file with the newer one does not take the file with it', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/shared-bundle');
  const bundle = world.bundle('shared.bundle', 'claude/shared-bundle');
  world.pushRequest('shared-1', 'claude/shared-bundle', commit, { bundle });
  world.pushRequest('shared-2', 'claude/shared-bundle', commit, { bundle });

  await world.run();

  assert.equal(world.result('shared-1').state, 'refused');
  assert.equal(world.result('shared-2').state, 'done');
  assert.equal(world.onGitHub('claude/shared-bundle'), commit);
});

const REVOKES = (world) => world.fake.requests.filter((r) => r === 'DELETE /installation/token').length;
// Fails the revoke of a request's own token (the first revoke of a run is the reach check's).
function failRequestRevoke(world, status, extra) {
  let seen = 0;
  world.fake.failNext((method, path) => method === 'DELETE' && path === '/installation/token' && (seen += 1) > 1, status, extra);
}

for (const [what, status, extra, waitMs] of [
  ['a 429 naming a two-hour wait', 429, { headers: { 'retry-after': '7200' }, body: { message: 'Too Many Requests' } }, 2 * HOUR],
  ['a 429 naming no wait', 429, {}, HOUR],
  ['a "secondary rate limit" 403', 403, { body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } }, HOUR],
]) {
  test(`plan test 12: ${what} on the token revoke stops every write, records the token and is not retried`, async (t) => {
    const world = await makeWorld(t);
    const start = world.now();
    for (const id of ['v-1', 'v-2', 'v-3']) world.commentRequest(id, { issue: 52 });
    failRequestRevoke(world, status, extra);

    await world.run();

    // The first request's comment was already posted. Its result says the token is still alive.
    assert.equal(world.result('v-1').state, 'done');
    assert.match(world.result('v-1').sentence, / A token could not be revoked and works until November 16(,| at) 11:00 AM EST\./);
    // One try at the revoke, not three: the reach check's and this one.
    assert.equal(REVOKES(world), 2);
    assert.equal(world.fake.liveTokens().length, 1);
    assert.deepEqual(world.log().map((line) => [line.kind, line.result]), [
      ['comment', 'done'],
      ['revoke', 'failed'],
    ]);
    assert.ok(world.status().lines.some((line) => line.startsWith('A token could not be revoked and works until ')));
    // Every other write waits for the longer of GitHub's wait or an hour.
    for (const id of ['v-2', 'v-3']) {
      assert.equal(world.result(id).state, 'waiting');
      assert.match(world.result(id).sentence, /^Waiting: GitHub asked the push gate to slow down\. Writes start again /);
      assert.equal(world.result(id).until, iso(start + waitMs));
    }
    assert.equal(world.fake.comments.length, 1);

    // During the pause nothing is sent: no write, no token, no further revoke.
    const calls = world.fake.requests.length;
    for (const later of [MINUTE, 30 * MINUTE, waitMs - 1000]) {
      world.clock.ms = start + later;
      await world.run();
    }
    assert.equal(world.fake.requests.length, calls);
    assert.equal(REVOKES(world), 2);

    // After it, the one note goes on #52 and the rest go up.
    world.clock.ms = start + waitMs;
    await world.run();
    assert.equal(world.result('v-2').state, 'done');
    assert.equal(world.result('v-3').state, 'done');
    assert.equal(notes(world).length, 1);
  });
}

test('plan test 12: a rate limit on the revoke of the reach-check token stops the run before anything is written', async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  world.commentRequest('early', { issue: 52 });
  world.fake.failNext((method, path) => method === 'DELETE' && path === '/installation/token', 429, { headers: { 'retry-after': '5400' } });

  await world.run();

  assert.equal(world.result('early').state, 'waiting');
  assert.equal(world.result('early').until, iso(start + 90 * MINUTE));
  assert.deepEqual(world.fake.writes, []);
  assert.equal(REVOKES(world), 1);
  assert.equal(world.fake.liveTokens().length, 1);
  assert.ok(world.status().lines.some((line) => line.startsWith('A token could not be revoked and works until ')));

  world.clock.ms = start + 90 * MINUTE;
  await world.run();
  assert.equal(world.result('early').state, 'done');
  assert.equal(world.fake.comments.filter((c) => !c.body.startsWith('The push gate stopped')).length, 1);
  assert.equal(notes(world).length, 1);
});

test("plan test 12: a git push answered with a secondary-rate-limit 403 stops every write, as an API answer does", async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  const commit = world.commit('claude/limited-push');
  world.pushRequest('limited-push', 'claude/limited-push', commit);
  world.commentRequest('behind-it', { issue: 52 });
  world.fake.failNext((method) => method === 'PUSH-START', 403, { body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' } });

  await world.run();

  // Not a refusal of that one request: every write waits at least an hour.
  for (const id of ['limited-push', 'behind-it']) {
    assert.equal(world.result(id).state, 'waiting', id);
    assert.match(world.result(id).sentence, /^Waiting: GitHub asked the push gate to slow down\. Writes start again /);
    assert.equal(world.result(id).until, iso(start + HOUR));
  }
  assert.equal(world.onGitHub('claude/limited-push'), null);
  assert.deepEqual(world.log().map((line) => [line.kind, line.result]), [['push', 'rate limited']]);

  world.clock.ms = start + HOUR - 1000;
  const calls = world.fake.requests.length;
  await world.run();
  assert.equal(world.fake.requests.length, calls);
  assert.deepEqual(world.fake.writes, []);

  world.clock.ms = start + HOUR;
  await world.run();
  assert.equal(world.result('limited-push').state, 'done');
  assert.equal(world.result('behind-it').state, 'done');
  assert.equal(world.onGitHub('claude/limited-push'), commit);
  assert.equal(notes(world).length, 1);
});

test('plan test 12: git answers that name a rate limit pause the gate, and a plain 403 is still one refusal', async (t) => {
  const { createGit, runCommand } = await import('../src/git.mjs');
  const { GitHubRefused, RateLimited } = await import('../src/errors.mjs');
  const world = await makeWorld(t);
  const answering = (stderr) =>
    createGit({
      dir: `${world.dir}/unit-checkout`,
      gitUrl: world.fake.gitUrl,
      run: (command, args, options) => (args.some((arg) => ['push', 'fetch', 'ls-remote'].includes(arg)) ? Promise.resolve({ code: 128, stdout: '', stderr }) : runCommand(command, args, options)),
    });
  const sha = 'a'.repeat(40);
  const limited = [
    "remote: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.\nfatal: unable to access 'invented': The requested URL returned error: 403",
    "remote: API rate limit exceeded for installation.\nfatal: unable to access 'invented': The requested URL returned error: 403",
    "fatal: unable to access 'invented': The requested URL returned error: 429",
  ];
  for (const stderr of limited) {
    const git = answering(stderr);
    await git.ensureRepo();
    await assert.rejects(git.push(sha, 'claude/invented', 'an-invented-token'), RateLimited, stderr);
    await assert.rejects(git.fetchMain(), RateLimited, stderr);
    await assert.rejects(git.remoteBranch('claude/invented'), RateLimited, stderr);
  }
  const plain = answering("remote: Permission to invented denied.\nfatal: unable to access 'invented': The requested URL returned error: 403");
  await assert.rejects(plain.push(sha, 'claude/invented', 'an-invented-token'), GitHubRefused);
  // A 403 with no words from GitHub can't be told from a rate limit, so it pauses too.
  const bare = answering('error: RPC failed; HTTP 403 curl 22 The requested URL returned error: 403\nfatal: the remote end hung up unexpectedly');
  await assert.rejects(bare.push(sha, 'claude/invented', 'an-invented-token'), RateLimited);
});

test('plan test 11: the retry of a write whose answer was lost is never the 61st write in an hour', async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  for (let i = 1; i <= 59; i += 1) world.commentRequest(`a-${String(i).padStart(2, '0')}`, { issue: 52 });
  await world.run();
  assert.equal(world.fake.comments.length, 59);

  // The 60th write is logged, then the run dies before GitHub gets it.
  world.clock.ms = start + MINUTE;
  world.commentRequest('b-60', { issue: 52 });
  await assert.rejects(
    world.run({
      fetchImpl: async (url, options) => {
        if (options.method === 'POST' && url.endsWith('/issues/52/comments')) throw new Error('invented crash');
        return fetch(url, options);
      },
    }),
    /invented crash/,
  );
  assert.equal(world.fake.comments.length, 59);
  assert.equal(world.log().length, 60);

  // The next run looks, finds the comment isn't on GitHub, and may not send it again yet:
  // its lost attempt already used the hour's last place.
  world.clock.ms = start + 2 * MINUTE;
  await world.run();
  assert.equal(world.result('b-60').state, 'waiting');
  assert.match(world.result('b-60').sentence, /^Waiting: the agents have made about 60 writes to GitHub in the last hour\./);
  assert.equal(world.result('b-60').until, iso(start + HOUR));
  assert.equal(world.fake.comments.length, 59);
  assert.equal(world.log().length, 60);
  const writesSent = world.fake.writes.length;
  world.clock.ms = start + HOUR - 1000;
  await world.run();
  assert.equal(world.fake.writes.length, writesSent);

  // Once the first hour's writes are an hour old, it goes, and is posted once.
  world.clock.ms = start + HOUR;
  await world.run();
  assert.equal(world.result('b-60').state, 'done');
  assert.equal(world.fake.comments.length, 60);
  for (let at = start; at <= world.now(); at += MINUTE) {
    const inHour = world.log().filter((line) => Date.parse(line.time) > at - HOUR && Date.parse(line.time) <= at).length;
    assert.ok(inHour <= 60, `${inHour} writes in the hour ending ${iso(at)}`);
  }
});

test("plan test 11: the gate's own note on #52 waits when the hourly cap is used up", async (t) => {
  const { createStore } = await import('../src/store.mjs');
  const world = await makeWorld(t);
  const start = world.now();
  world.commentRequest('first', { issue: 52 });
  world.fake.failNext(ISSUE_COMMENTS, 429, { headers: { 'retry-after': '60' } });
  await world.run();
  // While it is paused, the log fills up (as writes logged by an earlier run would).
  const store = createStore({ home: world.home, shared: world.shared });
  for (let i = 0; i < 60; i += 1) store.logWrite({ kind: 'comment', target: '#52', result: 'done' }, start + 30 * MINUTE);

  world.clock.ms = start + HOUR;
  await world.run();
  assert.equal(notes(world).length, 0);
  assert.equal(world.result('first').state, 'waiting');
  assert.deepEqual(world.fake.writes, []);

  world.clock.ms = start + 91 * MINUTE;
  await world.run();
  assert.equal(notes(world).length, 1);
  assert.equal(world.result('first').state, 'done');
});

test('plan test 12: a 403 during the upload of a push, which git reports with no reason, pauses every write', async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  const commit = world.commit('claude/bare-403');
  world.pushRequest('bare-403', 'claude/bare-403', commit);
  world.fake.failNext((method) => method === 'PUSH', 403);

  await world.run();

  assert.equal(world.result('bare-403').state, 'waiting');
  assert.equal(world.result('bare-403').until, iso(start + HOUR));
  world.clock.ms = start + HOUR;
  await world.run();
  assert.equal(world.result('bare-403').state, 'done');
  assert.equal(world.onGitHub('claude/bare-403'), commit);
});

test('plan test 9: a newer request also replaces an older one the gate had taken on but not pushed', async (t) => {
  const world = await makeWorld(t);
  const branch = 'claude/outage';
  const nowhere = { apiBase: 'http://127.0.0.1:1', gitUrl: 'http://127.0.0.1:1/git/open-convo.git' };

  // GitHub can't be reached: the first request is taken on and held.
  const first = world.commit(branch);
  world.pushRequest('outage-1', branch, first);
  await world.run(nowhere);
  assert.equal(world.result('outage-1').state, 'waiting');

  // A fix arrives during the outage, then a second one.
  world.clock.ms += MINUTE;
  const second = world.commit(branch, { 'notes.txt': 'a first fix\n' });
  world.pushRequest('outage-2', branch, second);
  await world.run(nowhere);
  assert.equal(world.result('outage-1').state, 'refused');
  assert.match(world.result('outage-1').sentence, /the newer request "outage-2" for the same branch replaced it/);
  assert.equal(world.result('outage-2').state, 'waiting');
  world.clock.ms += MINUTE;
  const third = world.commit(branch, { 'notes.txt': 'a second fix\n' });
  world.pushRequest('outage-3', branch, third);
  // A request for another branch, held the same way, is left alone.
  const other = world.commit('claude/outage-other');
  world.pushRequest('outage-other', 'claude/outage-other', other);
  await world.run(nowhere);
  assert.equal(world.result('outage-2').state, 'refused');
  assert.equal(world.result('outage-other').state, 'waiting');

  // When GitHub is back, only the newest commit goes up, as one push.
  world.clock.ms += MINUTE;
  await world.run();
  assert.equal(world.result('outage-3').state, 'done');
  assert.equal(world.result('outage-other').state, 'done');
  assert.equal(world.onGitHub(branch), third);
  assert.equal(world.onGitHub('claude/outage-other'), other);
  assert.equal(world.fake.pushes, 2);
  assert.equal(world.fake.pulls.length, 2);
});

test('plan test 9: a request whose push already went up is finished, not replaced, and the newer one waits its 10 minutes', async (t) => {
  const { runCommand } = await import('../src/git.mjs');
  const world = await makeWorld(t);
  const branch = 'claude/half-done';
  const start = world.now();
  const first = world.commit(branch);
  world.pushRequest('half-1', branch, first);
  // The run dies after the push is confirmed, before the pull request is opened.
  // (The first look for an open pull request comes before the push; the second, after it.)
  let lookups = 0;
  const dieAfterOpeningLookup = async (url, options) => {
    if (options.method === 'GET' && url.includes('/pulls?') && (lookups += 1) === 2) throw new Error('invented crash');
    return fetch(url, options);
  };
  await assert.rejects(world.run({ fetchImpl: dieAfterOpeningLookup, run: runCommand }), /invented crash/);
  assert.equal(world.onGitHub(branch), first);

  world.clock.ms = start + MINUTE;
  const second = world.commit(branch, { 'notes.txt': 'a fix\n' });
  world.pushRequest('half-2', branch, second);
  await world.run();

  assert.equal(world.result('half-1').state, 'done');
  assert.equal(world.fake.pulls.length, 1);
  assert.equal(world.result('half-2').state, 'waiting');
  assert.equal(world.result('half-2').until, iso(start + 10 * MINUTE));
  assert.equal(world.onGitHub(branch), first);
});

test('plan test 9: an interrupted push that never reached GitHub is replaced by a newer request instead of being sent again', async (t) => {
  const { runCommand } = await import('../src/git.mjs');
  const world = await makeWorld(t);
  const branch = 'claude/never-landed';
  const first = world.commit(branch);
  world.pushRequest('never-1', branch, first);
  // The connection drops before GitHub gets the push.
  const dropBeforePush = (command, args, options) =>
    args.includes('push') ? Promise.resolve({ code: 128, stdout: '', stderr: "fatal: unable to access 'invented': Failed to connect to 127.0.0.1" }) : runCommand(command, args, options);
  await world.run({ run: dropBeforePush });
  assert.equal(world.result('never-1').state, 'waiting');
  assert.equal(world.onGitHub(branch), null);

  world.clock.ms += MINUTE;
  const second = world.commit(branch, { 'notes.txt': 'a fix\n' });
  world.pushRequest('never-2', branch, second);
  await world.run();
  assert.equal(world.result('never-1').state, 'refused');
  assert.match(world.result('never-1').sentence, /the newer request "never-2" for the same branch replaced it/);
  // The newer one still keeps the 10 minutes from the interrupted try.
  assert.equal(world.result('never-2').state, 'waiting');
  assert.equal(world.onGitHub(branch), null);

  world.clock.ms += 10 * MINUTE;
  await world.run();
  assert.equal(world.result('never-2').state, 'done');
  assert.equal(world.onGitHub(branch), second);
  assert.equal(world.fake.pushes, 1);
});

for (const [what, lose] of [
  ['its answer is lost', () => new TypeError('fetch failed')],
  ['the run dies', () => new Error('invented crash')],
]) {
  test(`plan test 12: the note on #52 is posted once even when ${what} right after GitHub takes it`, async (t) => {
    const world = await makeWorld(t);
    const start = world.now();
    world.commentRequest('held', { issue: 52 });
    world.fake.failNext(ISSUE_COMMENTS, 429, { headers: { 'retry-after': '60' } });
    await world.run();

    // Writes resume: GitHub takes the note, and then things go wrong.
    world.clock.ms = start + HOUR;
    const afterNote = async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'POST' && url.endsWith('/issues/52/comments') && String(options.body).includes('The push gate stopped every write')) throw lose();
      return response;
    };
    await world.run({ fetchImpl: afterNote }).catch((error) => assert.match(error.message, /invented crash/));
    assert.equal(notes(world).length, 1);

    // The next runs find the note there and don't post it again.
    world.clock.ms += MINUTE;
    await world.run();
    world.commentRequest('later', { issue: 52 });
    await world.run();
    assert.equal(notes(world).length, 1);
    assert.equal(world.result('held').state, 'done');
    assert.equal(world.result('later').state, 'done');
    assert.deepEqual(world.log().filter((line) => line.kind === 'note').map((line) => line.result), ['done']);
  });
}

test("plan test 12: a note that never reached GitHub is posted on the next run", async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  world.commentRequest('held', { issue: 52 });
  world.fake.failNext(ISSUE_COMMENTS, 429, { headers: { 'retry-after': '60' } });
  await world.run();

  world.clock.ms = start + HOUR;
  const beforeNote = async (url, options) => {
    if (options.method === 'POST' && url.endsWith('/issues/52/comments')) throw new TypeError('fetch failed');
    return fetch(url, options);
  };
  await world.run({ fetchImpl: beforeNote });
  assert.equal(notes(world).length, 0);

  world.clock.ms += MINUTE;
  await world.run();
  assert.equal(notes(world).length, 1);
  assert.equal(world.result('held').state, 'done');
});

test('plan test 12: a rate limit on the cleanup of the pause note starts a new pause that gets its own note', async (t) => {
  const world = await makeWorld(t);
  const start = world.now();
  world.commentRequest('waiting-out', { issue: 52 });
  world.fake.failNext(ISSUE_COMMENTS, 429, { headers: { 'retry-after': '60' } });
  await world.run();

  // Writes resume: the note is posted, and GitHub rate-limits the revoke of the note's token.
  world.clock.ms = start + HOUR;
  failRequestRevoke(world, 429, { headers: { 'retry-after': '5400' } });
  await world.run();
  assert.equal(notes(world).length, 1);
  assert.equal(world.result('waiting-out').state, 'waiting');
  assert.equal(world.result('waiting-out').until, iso(start + HOUR + 90 * MINUTE));

  // Nothing more is sent during the new pause.
  world.clock.ms = start + 2 * HOUR;
  const calls = world.fake.requests.length;
  await world.run();
  assert.equal(world.fake.requests.length, calls);

  // When it ends, the second pause is reported too, once, and the request goes up.
  world.clock.ms = start + HOUR + 90 * MINUTE;
  await world.run();
  await world.run();
  assert.equal(notes(world).length, 2);
  assert.equal(new Set(notes(world).map((c) => c.body.split(' because ')[0])).size, 2);
  assert.equal(world.result('waiting-out').state, 'done');
});

test('plan test 12: requests naming pull requests that are not there count as refusals, and three in an hour stop every write', async (t) => {
  const world = await makeWorld(t);
  world.commentRequest('missing-1', { pull: 9001 });
  world.request('missing-2', { kind: 'reply', agent: 'claude', thread: world.thread, pull: 9002, inReplyTo: 7001, body: `Answered.\n\n${world.signOff()}` });
  world.commentRequest('missing-3', { pull: 9003 });
  world.commentRequest('behind', { issue: 52 });

  await world.run();

  // Each keeps its plain sentence.
  assert.equal(world.result('missing-1').sentence, 'Request "missing-1" was refused: #9001 isn\'t a pull request on GitHub, so name an open pull request.');
  assert.equal(world.result('missing-2').sentence, 'Request "missing-2" was refused: #9002 isn\'t a pull request on GitHub, so name an open pull request.');
  assert.equal(world.result('missing-3').state, 'refused');
  // And the third stops every write until the owner restarts the gate.
  assert.equal(world.result('behind').state, 'waiting');
  assert.equal(world.result('behind').sentence, 'Waiting: the push gate has stopped every write because GitHub refused 3 requests within an hour. The owner needs to restart it.');
  assert.deepEqual(world.fake.writes, []);

  await world.run({ restart: true });
  assert.equal(world.result('behind').state, 'done');
});

test('plan test 12: a closed pull request is refused by the gate itself and does not count as a refusal from GitHub', async (t) => {
  const world = await makeWorld(t);
  for (const id of ['closed-1', 'closed-2', 'closed-3']) {
    const pull = world.openPull(`claude/${id}`);
    world.fake.pulls.at(-1).state = 'closed';
    world.commentRequest(id, { pull });
  }
  world.commentRequest('after', { issue: 52 });

  await world.run();

  for (const id of ['closed-1', 'closed-2', 'closed-3']) assert.match(world.result(id).sentence, /isn't open, so name an open pull request\.$/);
  assert.equal(world.result('after').state, 'done');
});
