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
  world.fake.failNext((method) => method === 'PUSH', 403);
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
