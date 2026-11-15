// The token helper (docs/plans/push-gate.md, "The Token Helper"): plan
// tests 1, 2 and 3.

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from '../src/cli.mjs';
import { makeWorld } from './helpers/world.mjs';

const HAND_OVER = /^Cloudwork Agents token: App ID 5665711, installation 179798275, CloudworkSystems\/open-convo, expires \d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

function cli(world, argv, extra = {}) {
  const shown = [];
  const options = {
    loadSeam: async () => world.seam,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', PUSH_GATE_HOME: world.home, PUSH_GATE_SHARED: world.shared, ...extra },
    out: (line) => shown.push(line),
    err: (line) => shown.push(line),
    now: world.now,
    apiBase: world.fake.apiBase,
    gitUrl: world.fake.gitUrl,
  };
  return main(argv, options).then((code) => ({ code, shown }));
}

// A command that writes down what it was started with.
const NOTE_WHAT_I_GOT = `require('node:fs').writeFileSync(process.env.NOTE, JSON.stringify({ argv: process.argv, token: process.env.GH_TOKEN ?? null }))`;

test('plan test 1: the signed request names App ID 5665711 and expires within 10 minutes', async (t) => {
  const world = await makeWorld(t);
  world.commentRequest('one', { issue: 52 });

  await world.run();

  assert.ok(world.fake.appRequests.length >= 1);
  for (const claims of world.fake.appRequests) {
    assert.equal(claims.iss, '5665711');
    const left = claims.exp - Math.floor(world.now() / 1000);
    assert.ok(left > 0 && left <= 600, `expires in ${left} seconds`);
  }
  // Each token is asked for this repo only, with only what the action needs.
  assert.deepEqual([...world.fake.tokens.values()].map((token) => [token.scoped, token.permissions]), [
    [false, { metadata: 'read' }],
    [true, { issues: 'write' }],
  ]);
});

for (const [what, reach] of [
  ['another repo', ['CloudworkSystems/another-repo']],
  ['more than one repo', ['CloudworkSystems/open-convo', 'CloudworkSystems/another-repo']],
]) {
  test(`plan test 2: a token for an installation that reaches ${what} is refused`, async (t) => {
    const world = await makeWorld(t);
    world.fake.reach = reach;
    const note = join(world.dir, 'note.json');

    // The token command hands nothing over and never runs the command.
    const { code, shown } = await cli(world, ['token', '--', process.execPath, '-e', NOTE_WHAT_I_GOT], { NOTE: note });
    assert.equal(code, 1);
    assert.equal(existsSync(note), false);
    assert.match(shown.join('\n'), /No token was handed over: the agents' app installation reaches something other than CloudworkSystems\/open-convo alone/);
    assert.doesNotMatch(shown.join('\n'), /Cloudwork Agents token:/);

    // The gate writes nothing and stops until the owner restarts it.
    world.commentRequest('held', { issue: 52 });
    await world.run();
    assert.equal(world.result('held').state, 'waiting');
    assert.match(world.result('held').sentence, /stopped every write because the agents' app installation reaches something other than/);
    assert.deepEqual(world.fake.writes, []);
    assert.deepEqual(world.fake.liveTokens(), []);
  });
}

test('plan test 3: the token never appears in the write log, results, error text or command arguments, and is revoked', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/secret-check');
  world.pushRequest('goes-up', 'claude/secret-check', commit);
  world.commentRequest('turned-down', { issue: 52 });
  // GitHub's refusal repeats the token back, as the worst case for error text.
  world.fake.failNext((method, path) => method === 'POST' && path.endsWith('/issues/52/comments'), 422, { body: { message: 'Validation Failed' } });
  const realFetch = fetch;
  const echoingFetch = async (url, options) => {
    const response = await realFetch(url, options);
    if (response.status !== 422) return response;
    return new Response(JSON.stringify({ message: `Validation Failed for ${options.headers.authorization}` }), { status: 422 });
  };

  const { lines } = await world.run({ fetchImpl: echoingFetch });

  assert.equal(world.result('goes-up').state, 'done');
  assert.equal(world.result('turned-down').state, 'refused');
  assert.match(world.result('turned-down').sentence, /^Request "turned-down" was refused: GitHub answered "Validation Failed for Bearer \[hidden\]", so change the request to fit and send a new one\.$/);
  const tokens = [...world.fake.tokens.keys()];
  assert.ok(tokens.length >= 3);
  const written = world.everythingWritten();
  const shown = lines.join('\n');
  for (const token of tokens) {
    assert.equal(written.includes(token), false, 'a token is in a file the gate wrote');
    assert.equal(shown.includes(token), false, 'a token is in what the gate showed');
    for (const { args } of world.commands) assert.equal(args.join(' ').includes(token), false, 'a token is in a command argument');
  }
  assert.equal(written.includes(world.privateKey.split('\n')[1]), false, 'the key is in a file the gate wrote');
  // The token reached git only through the one push command's environment and sign-in helper.
  const withToken = world.commands.filter(({ env }) => env.GH_TOKEN);
  assert.equal(withToken.length, 1);
  assert.ok(withToken[0].args.includes('push'));
  assert.deepEqual(world.fake.pushPasswords, [withToken[0].env.GH_TOKEN]);
  assert.doesNotMatch(readFileSync(join(world.home, 'checkout', 'repo.git', 'config'), 'utf8'), /credential|url|127\.0\.0\.1/);
  // Revoked after the command, and the hand-over is said in the one line.
  assert.deepEqual(world.fake.liveTokens(), []);
  assert.ok(lines.filter((line) => HAND_OVER.test(line)).length >= 2);
});

test('plan test 3: push-gate token hands the token to one command through its environment and revokes it after', async (t) => {
  const world = await makeWorld(t);
  const note = join(world.dir, 'note.json');

  const { code, shown } = await cli(world, ['token', '--permissions', 'contents:write', '--', process.execPath, '-e', NOTE_WHAT_I_GOT, 'an-argument'], { NOTE: note });

  assert.equal(code, 0);
  const got = JSON.parse(readFileSync(note, 'utf8'));
  assert.ok(world.fake.tokens.has(got.token), 'the command got the token in its environment');
  assert.equal(got.argv.join(' ').includes(got.token), false);
  assert.deepEqual(got.argv.slice(1), ['an-argument']);
  assert.equal(shown.length, 1);
  assert.match(shown[0], HAND_OVER);
  assert.equal(shown[0].includes(got.token), false);
  assert.deepEqual(world.fake.tokens.get(got.token).permissions, { contents: 'write' });
  assert.deepEqual(world.fake.liveTokens(), []);
});

test('push-gate token lets git push with no token in its arguments, settings or remote address', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/by-hand');

  const { code } = await cli(world, ['token', '--', 'git', '-C', world.agent, 'push', '-q', world.fake.gitUrl, `${commit}:refs/heads/claude/by-hand`]);

  assert.equal(code, 0);
  assert.equal(world.onGitHub('claude/by-hand'), commit);
  assert.equal(world.fake.pushes, 1);
  assert.doesNotMatch(readFileSync(join(world.agent, '.git', 'config'), 'utf8'), /credential|remote|127\.0\.0\.1/);
  assert.deepEqual(world.fake.liveTokens(), []);

  // The command's own exit code comes back, and the token is still revoked.
  const failed = await cli(world, ['token', '--', process.execPath, '-e', 'process.exit(7)']);
  assert.equal(failed.code, 7);
  assert.deepEqual(world.fake.liveTokens(), []);
});

test("push-gate token says so in one sentence when the key can't be opened", async (t) => {
  const world = await makeWorld(t);
  world.seam.fail = true;
  const { code, shown } = await cli(world, ['token', '--', process.execPath, '-e', '0']);
  assert.equal(code, 1);
  assert.deepEqual(shown, ["The push gate can't open its key. The owner needs to check 1Password."]);
});
