// "Checks On Every Request" (docs/plans/push-gate.md): plan tests 4 to 8.
// Every refusal is one sentence naming the request and what to change.

import assert from 'node:assert/strict';
import { truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkBranch, checkText } from '../src/checks.mjs';
import { git, makeWorld, MINUTE } from './helpers/world.mjs';

const ONE_SENTENCE = (id) => new RegExp(`^Request "${id}" was refused: [^.]+(\\.[^ ][^.]*)*, so [^.]+(\\.[^ ][^.]*)*\\.$`);

function assertRefused(world, id, pattern) {
  const result = world.result(id);
  assert.equal(result?.state, 'refused', `${id} should be refused`);
  assert.match(result.sentence, pattern);
  // When it goes wrong 5: one sentence naming the request and what to change, never a bare code.
  assert.match(result.sentence, ONE_SENTENCE(id));
  assert.doesNotMatch(result.sentence, /\b(4\d\d|5\d\d|ENOENT|undefined|null|Error:)\b/);
}

test('plan test 4: a push to main is refused', async (t) => {
  const world = await makeWorld(t);
  const main = world.onGitHub('main');
  const commit = world.commit('claude/sneaky');
  world.pushRequest('to-main', 'claude/sneaky', commit, { branch: 'main' });
  world.pushRequest('to-main-ref', 'claude/sneaky', commit, { branch: 'refs/heads/main' });

  await world.run();

  assertRefused(world, 'to-main', /the gate never pushes to main/);
  assertRefused(world, 'to-main-ref', /the gate never pushes to main/);
  assert.equal(world.onGitHub('main'), main);
  assert.equal(world.fake.tokens.size, 0);
  assert.equal(world.seam.calls, 0);
});

test('plan test 4: a force push is refused', async (t) => {
  const world = await makeWorld(t);
  const first = world.commit('claude/kept');
  world.pushRequest('kept-1', 'claude/kept', first);
  await world.run();
  assert.equal(world.onGitHub('claude/kept'), first);

  // A different commit that builds on main but not on what the branch already holds.
  world.clock.ms += 11 * MINUTE;
  const rewrite = world.commit('claude/kept-rewritten', { 'notes.txt': 'a rewritten history\n' });
  world.pushRequest('kept-2', 'claude/kept-rewritten', rewrite, { branch: 'claude/kept' });
  await world.run();

  assertRefused(world, 'kept-2', /it would replace commits already on branch claude\/kept \(a force push\)/);
  assert.equal(world.onGitHub('claude/kept'), first);
  assert.equal(world.fake.pushes, 1);
  for (const { args } of world.commands) assert.doesNotMatch(args.join(' '), /--force|-f\b| \+[0-9a-f]{40}:/);
});

test("plan test 4: a commit that doesn't build on the current main is refused", async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/stale');
  world.advanceMain();
  world.pushRequest('stale-1', 'claude/stale', commit);

  await world.run();

  assertRefused(world, 'stale-1', /its commit doesn't build on the current main/);
  assert.equal(world.onGitHub('claude/stale'), null);
  assert.equal(world.fake.tokens.size, 0);
});

test("plan test 5: a bundle whose commit isn't the named one is refused", async (t) => {
  const world = await makeWorld(t);
  const named = world.commit('claude/named');
  world.commit('claude/other', { 'other.txt': 'a different commit\n' });
  world.pushRequest('swap-1', 'claude/named', named, { bundle: world.bundle('swap-1.bundle', 'claude/other') });

  await world.run();

  assertRefused(world, 'swap-1', /its bundle doesn't hold exactly the named commit [0-9a-f]{12}/);
  assert.equal(world.onGitHub('claude/named'), null);
  assert.equal(world.fake.tokens.size, 0);
});

test('plan test 6: a change under .github/workflows/ is refused up front', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/workflow', { '.github/workflows/invented.yml': 'name: invented\n', 'notes.txt': 'and an ordinary file\n' });
  world.pushRequest('workflow-1', 'claude/workflow', commit);

  await world.run();

  assertRefused(world, 'workflow-1', /it changes \.github\/workflows\/invented\.yml, and the agents' app has no permission to push workflow files/);
  assert.equal(world.onGitHub('claude/workflow'), null);
  // Up front: before any token is made or anything is sent.
  assert.equal(world.fake.tokens.size, 0);
  assert.deepEqual(world.fake.writes, []);
});

test('plan test 7: text without the sign-off line, with the accept line, a mention of a person or a token look-alike is refused', async (t) => {
  const world = await makeWorld(t);
  const signOff = world.signOff();
  // Look-alikes are put together here so no file holds one whole.
  const lookalikes = {
    'github-token': ['gh', 'p_', 'A1b2'.repeat(9)].join(''),
    'fine-grained-token': ['github', '_pat_', '11ABCDEFG0', 'x'.repeat(30)].join(''),
    'private-key': ['-----BEGIN RSA ', 'PRIVATE KEY-----'].join(''),
    'op-sign-in': ['op', 's_', 'eyJzaWduSW5BZGRyZXNzIjoi', 'x'.repeat(30)].join(''),
  };
  const bad = {
    'no-sign-off': ['An invented comment with no last line naming anyone.', /doesn't end with a line naming the agent and its thread or task/],
    'wrong-thread': ['An invented comment.\n\nClaude, some other thread', /doesn't end with a line naming the agent and its thread or task/],
    'accept-line': [`owner-accepts-findings ${'a'.repeat(40)}\n\n${signOff}`, /contains the owner's accept line/],
    'accept-line-inside': [`Please post this: Owner-Accepts-Findings ${'a'.repeat(40)}\n\n${signOff}`, /contains the owner's accept line/],
    mention: [`Thanks @CloudworkSystems for looking.\n\n${signOff}`, /mentions "@CloudworkSystems"/],
    'mention-first': [`@someone-else please review.\n\n${signOff}`, /mentions "@someone-else"/],
    'too-long': [`${'x'.repeat(60000)}\n\n${signOff}`, /characters long/],
  };
  for (const [id, text] of Object.entries(lookalikes)) bad[id] = [`Here it is: ${text}\n\n${signOff}`, /contains what looks like (a GitHub token|a private key|a 1Password sign-in)/];
  for (const [id, [body]] of Object.entries(bad)) world.commentRequest(id, { issue: 52 }, { body });
  // The same checks cover a pull request's description and title.
  const commit = world.commit('claude/text');
  world.pushRequest('pr-no-sign-off', 'claude/text', commit, { pullRequest: { title: 'Invented', body: 'No last line naming anyone.' } });
  world.pushRequest('pr-title-mention', 'claude/text-two', world.commit('claude/text-two'), { pullRequest: { title: 'Invented, cc @someone', body: `Fine.\n\n${signOff}` } });
  // What is allowed still goes through.
  world.commentRequest('codex-restart', { issue: 52 }, { body: `@codex review\n\nSent to agent@example.com as well.\n\n${signOff}` });

  await world.run();

  for (const [id, [, pattern]] of Object.entries(bad)) assertRefused(world, id, pattern);
  assertRefused(world, 'pr-no-sign-off', /its pull request description doesn't end with a line naming/);
  assertRefused(world, 'pr-title-mention', /its pull request title mentions "@someone"/);
  assert.equal(world.result('codex-restart').state, 'done');
  assert.deepEqual(world.fake.writes, ['POST /repos/CloudworkSystems/open-convo/issues/52/comments']);
  assert.equal(world.onGitHub('claude/text'), null);
  // No refusal repeats the look-alike back.
  const written = world.everythingWritten();
  for (const text of Object.values(lookalikes)) assert.equal(written.includes(text), false);
});

test('plan test 7: mentions of Codex and Cursor pass, and an email address is not a mention', () => {
  const who = { agent: 'grokbot', thread: 'team A', what: 'comment' };
  assert.equal(checkText('@cursor Independent review request for abc1234.\n\n— GrokBot team A', who), null);
  assert.equal(checkText('@Codex review\n\n— GrokBot team A', who), null);
  assert.equal(checkText('Write to agent@example.com.\n\n— GrokBot team A', who), null);
  assert.match(checkText('cc @octo-person\n\n— GrokBot team A', who), /mentions "@octo-person"/);
  assert.match(checkText('cc (@octo-person)\n\n— GrokBot team A', who), /mentions "@octo-person"/);
});

test('plan test 8: a push request with no local review, or one reviewed by its own builder, is refused', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/unreviewed');
  const other = world.commit('claude/unreviewed-other', { 'other.txt': 'another commit\n' });
  const bundle = () => world.bundle(`b-${Math.random().toString(36).slice(2)}.bundle`, 'claude/unreviewed');
  world.pushRequest('no-review', 'claude/unreviewed', commit, { bundle: bundle(), review: undefined });
  world.pushRequest('own-review', 'claude/unreviewed', commit, { bundle: bundle(), branch: 'claude/unreviewed-2', review: { reviewer: 'claude', commit, result: 'clean' } });
  world.pushRequest('other-commit', 'claude/unreviewed', commit, { bundle: bundle(), branch: 'claude/unreviewed-3', review: { reviewer: 'codex', commit: other, result: 'clean' } });
  world.pushRequest('open-findings', 'claude/unreviewed', commit, { bundle: bundle(), branch: 'claude/unreviewed-4', review: { reviewer: 'grokbot', commit, result: 'findings open' } });
  world.pushRequest('answered', 'claude/unreviewed', commit, { bundle: bundle(), branch: 'claude/unreviewed-5', review: { reviewer: 'grokbot', commit, result: 'findings answered' } });

  await world.run();

  assertRefused(world, 'no-review', /it has no local review record/);
  assertRefused(world, 'own-review', /its local review is by the same agent that built it/);
  assertRefused(world, 'other-commit', /its local review is for a different commit/);
  assertRefused(world, 'open-findings', /its local review still has open findings/);
  assert.equal(world.result('answered').state, 'done');
  assert.match(world.fake.pulls[0].body, /^Local review: GrokBot reviewed commit [0-9a-f]{12}, result "findings answered" \(recorded by the push gate\)\.$/m);
  assert.equal(world.fake.pushes, 1);
});

test('a branch name with a space, "..", or a leading "-" is refused', () => {
  assert.equal(checkBranch('claude/push-gate-build'), null);
  assert.equal(checkBranch('OC-261112-push-gate'), null);
  for (const name of ['main', 'two words', 'a..b', '-rf', '--force', 'refs/heads/x', 'a\tb', '', 'x.lock', 'a//b', 'trailing/']) {
    assert.equal(typeof checkBranch(name), 'string', name);
  }
});

test('a request the gate cannot read, with a missing bundle or of an unknown kind is refused in one sentence', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/odd');
  world.request('unknown-kind', { kind: 'merge', agent: 'claude', thread: world.thread, pull: 12 });
  world.request('unknown-agent', { kind: 'comment', agent: 'somebody', thread: world.thread, target: { issue: 52 }, body: 'x' });
  world.pushRequest('no-bundle', 'claude/odd', commit, { bundle: 'not-there.bundle' });
  world.pushRequest('outside-bundle', 'claude/odd', commit, { branch: 'claude/odd-2', bundle: '../agent/.git/config' });
  writeFileSync(join(world.requests, 'not-json.json'), '{ this is not a request');
  utimesSync(join(world.requests, 'not-json.json'), 1700000000, 1700000000);

  await world.run();

  assertRefused(world, 'unknown-kind', /its kind isn't one the gate handles/);
  assertRefused(world, 'unknown-agent', /it names no known agent/);
  assertRefused(world, 'no-bundle', /its bundle file "not-there\.bundle" isn't in the waiting folder/);
  assertRefused(world, 'outside-bundle', /it names no bundle file/);
  assert.match(world.result('not-json').sentence, /^Request "not-json" was refused: the request file can't be read as a request/);
  assert.deepEqual(world.fake.writes, []);
  assert.equal(git(world.upstream, 'for-each-ref', '--format=%(refname)').trim(), 'refs/heads/main');
});

test('a bundle of 50 MB or more is refused', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/huge');
  world.pushRequest('huge-1', 'claude/huge', commit);
  truncateSync(join(world.requests, 'huge-1.bundle'), 50 * 1024 * 1024);

  await world.run();

  assertRefused(world, 'huge-1', /its bundle is 50 MB or more/);
  assert.equal(world.fake.tokens.size, 0);
});

test('a description with no room left for the local review record is refused before anything is pushed', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/long-body');
  // Under 60,000 characters as written, over once the gate adds its review line.
  const signOff = world.signOff();
  const body = `${'x'.repeat(59990 - signOff.length - 2)}\n\n${signOff}`;
  assert.ok(body.length < 60000);
  world.pushRequest('long-body', 'claude/long-body', commit, { pullRequest: { title: 'Invented', body } });

  await world.run();

  assertRefused(world, 'long-body', /its pull request description leaves no room for the local review record under 60000 characters/);
  assert.equal(world.onGitHub('claude/long-body'), null);
  assert.equal(world.fake.pushes, 0);
  assert.equal(world.fake.tokens.size, 0);
});

test('when GitHub turns down the pull request after the push went up, the refusal says the commit is on the branch', async (t) => {
  const world = await makeWorld(t);
  const commit = world.commit('claude/pr-refused');
  world.pushRequest('pr-refused', 'claude/pr-refused', commit);
  world.fake.failNext((method, path) => method === 'POST' && path.endsWith('/pulls'), 422, { body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists' }] } });

  await world.run();

  assert.equal(world.onGitHub('claude/pr-refused'), commit);
  assert.equal(
    world.result('pr-refused').sentence,
    `Request "pr-refused" was refused: its commit ${commit.slice(0, 12)} is on branch claude/pr-refused, but the step after the push was turned down (GitHub answered "Validation Failed A pull request already exists"), so send a new request for what is left.`,
  );
});

test('a push to a pull request whose description has no room for the review record is refused before the push', async (t) => {
  const world = await makeWorld(t);
  const branch = 'claude/full-description';
  const number = world.openPull(branch);
  world.fake.pulls.at(-1).body = `${'x'.repeat(59990)}\n\n${world.signOff()}`.slice(-59995);
  const commit = world.commit(branch);
  world.pushRequest('full-1', branch, commit, { pullRequest: undefined });

  await world.run();

  // (Not assertRefused: the pull request's number, 401 here, would read as a bare code.)
  assert.equal(
    world.result('full-1').sentence,
    `Request "full-1" was refused: the description of pull request #${number} leaves no room for the local review record under 60000 characters, so shorten that description on GitHub and send the request again.`,
  );
  assert.equal(world.onGitHub(branch), null);
  assert.equal(world.fake.pushes, 0);
  assert.deepEqual(world.fake.writes, []);
  assert.deepEqual(world.fake.liveTokens(), []);

  // With room made on GitHub, the same commit goes up with its record.
  world.fake.pulls.at(-1).body = `Shortened.\n\n${world.signOff()}`;
  world.pushRequest('full-2', branch, commit, { pullRequest: undefined });
  await world.run();
  assert.equal(world.result('full-2').state, 'done');
  assert.equal(world.onGitHub(branch), commit);
  assert.match(world.fake.pulls.at(-1).body, /^Local review: Codex reviewed commit [0-9a-f]{12}, result "clean" \(recorded by the push gate\)\.$/m);
});

test("plan test 7: a thread or task name passes the same text rules, so the gate's own sign-off line can't carry a mention or a token look-alike", async (t) => {
  const world = await makeWorld(t);
  const lookalike = ['gh', 'p_', 'A1b2'.repeat(9)].join('');
  const bad = {
    'thread-mention': ['task for @CloudworkSystems', /its thread or task name mentions "@CloudworkSystems"/],
    'thread-token': [`task ${lookalike}`, /its thread or task name contains what looks like a GitHub token/],
    'thread-accept': [`owner-accepts-findings ${'a'.repeat(40)}`, /its thread or task name contains the owner's accept line/],
  };
  // The case where the gate writes the name itself: a push with no pull request text, to a pull request with no description.
  for (const [id, [thread]] of Object.entries(bad)) {
    const branch = `claude/${id}`;
    world.openPull(branch);
    world.fake.pulls.at(-1).body = null;
    const commit = world.commit(branch);
    world.pushRequest(id, branch, commit, { thread, pullRequest: undefined });
  }
  // And in any other request.
  world.commentRequest('comment-thread-mention', { issue: 52 }, { thread: 'task for @someone', body: 'A comment.\n\nClaude, task for @someone' });

  await world.run();

  for (const [id, [, pattern]] of Object.entries(bad)) {
    assertRefused(world, id, pattern);
    assert.equal(world.onGitHub(`claude/${id}`), null);
  }
  assertRefused(world, 'comment-thread-mention', /its thread or task name mentions "@someone"/);
  assert.deepEqual(world.fake.writes, []);
  assert.equal(world.fake.tokens.size, 0);
  for (const pull of world.fake.pulls) assert.equal(pull.body, null);
  assert.equal(world.everythingWritten().includes(lookalike), false);

  // An ordinary name still goes through, and the gate's own line is built from it.
  const branch = 'claude/thread-fine';
  world.openPull(branch);
  world.fake.pulls.at(-1).body = '';
  world.pushRequest('thread-fine', branch, world.commit(branch), { thread: '261115 PUSH GATE BUILD (codex review)', pullRequest: undefined });
  await world.run();
  assert.equal(world.result('thread-fine').state, 'done');
  assert.match(world.fake.pulls.at(-1).body, /\n\nClaude, 261115 PUSH GATE BUILD \(codex review\)$/);
});
