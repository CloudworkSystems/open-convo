// The push gate's one run (docs/plans/push-gate.md, "What It Does").
//
// `runOnce` handles every waiting request: it checks each against the
// rules, holds it when a pace limit says so, then writes to GitHub as
// Cloudwork Agents with a token made for that one request, and writes back
// a plain result. Each request moves from waiting to working to done or
// refused, saved to disk before each step.

import { AGENTS, API_BASE, APP_LOGIN, FULL_NAME, GIT_URL, HOUR, LIMITS, OWNER, REPORT_ISSUE } from './constants.mjs';
import { createSession } from './app-token.mjs';
import { checkRequest, checkText, REQUEST_ID } from './checks.mjs';
import { CheckFailed, GitHubRefused, KeyUnavailable, NoConnection, RateLimited, SignInFailed, WrongReach, scrub } from './errors.mjs';
import { createGit, runCommand } from './git.mjs';
import { capUntil, pushGapUntil, quietUntil, sayTime } from './pace.mjs';
import { createStore } from './store.mjs';

const REPO_PATH = `/repos/${FULL_NAME}`;
const REVIEW_LINE = /^Local review: .*\(recorded by the push gate\)\.$/m;

export const NOTHING_WAITING = 'Nothing waiting.';
const KEY_SENTENCE = "Waiting: the push gate can't open its key. The owner needs to check 1Password.";
const CONNECTION_SENTENCE = "Waiting: GitHub can't be reached. The gate tries again on its next run.";

const unrevokedLine = (expiresAt) =>
  `A token could not be revoked and works until ${sayTime(Date.parse(expiresAt))}. The owner can end it now by suspending the app's installation.`;
const refusedSentence = (id, why) => `Request "${id}" was refused: ${why}.`;
const short = (sha) => sha.slice(0, 12);

/** The description with the local review recorded just above the sign-off line. */
export function withReviewLine(body, review, signOffLine) {
  const line = `Local review: ${AGENTS[review.reviewer]} reviewed commit ${short(review.commit)}, result "${review.result}" (recorded by the push gate).`;
  // A pull request with no description gets the record and the sign-off line.
  if (typeof body !== 'string' || !body.trim()) return `${line}\n\n${signOffLine}`;
  if (REVIEW_LINE.test(body)) return body.replace(REVIEW_LINE, line);
  const lines = body.trimEnd().split('\n');
  const signOff = lines.pop();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return [...lines, '', line, '', signOff].join('\n');
}

// How many writes a request may make, for the hourly cap.
function writesNeeded(request) {
  if (request.kind !== 'push') return 1;
  return request.pullRequest ? 3 : 2; // push, then open and label, or a description update
}

function permissionsFor(request) {
  if (request.kind === 'push') return { contents: 'write', pull_requests: 'write' };
  if (request.kind === 'comment' && request.target.issue) return { issues: 'write' };
  return { pull_requests: 'write' };
}

/**
 * Handles every waiting request once.
 *
 * @param {object} options
 * @param {string} options.home    the gate's own folder (work files, checkout)
 * @param {string} options.shared  the folder holding requests/ and results/
 * @param {{readAppKey: () => Promise<string>}} options.seam  how the app's key is read
 * @param {boolean} [options.restart]  the owner's restart: clears a stop
 * @param {(line: string) => void} [options.say]  where attended runs show progress
 * @returns {Promise<{handled: number, lines: string[]}>}
 */
export async function runOnce({ home, shared, seam, restart = false, say = () => {}, now = Date.now, apiBase = API_BASE, gitUrl = GIT_URL, fetchImpl = fetch, run = runCommand }) {
  const store = createStore({ home, shared });
  const lines = [];
  const tell = (line) => {
    lines.push(line);
    say(line);
  };

  // Nothing waiting: do nothing and write nothing.
  const before = store.loadState();
  const noteDue = before.noteOwed && now() >= before.pausedUntil && !quietUntil(now());
  const clearing = restart && before.stopped;
  if (!store.listWaiting().length && !store.listWorking().length && !noteDue && !clearing) {
    tell(NOTHING_WAITING);
    return { handled: 0, lines };
  }

  if (!store.lock(now())) {
    tell('Another push gate run is going. This one did nothing.');
    return { handled: 0, lines };
  }
  try {
    return await runLocked();
  } finally {
    store.unlock();
  }

  async function runLocked() {
    const state = store.loadState();
    const session = createSession({
      seam,
      apiBase,
      fetchImpl,
      now,
      say: tell,
      // A token that couldn't be revoked is written down and shown until it expires.
      // It counts as the plan's other refusals do: three in an hour stop every write.
      onUnrevoked(expiresAt) {
        state.unrevoked = [...(state.unrevoked ?? []).filter((t) => Date.parse(t) > now()), expiresAt];
        state.refusals = [...state.refusals.filter((t) => t > now() - HOUR), now()];
        if (state.refusals.length >= LIMITS.refusalsBeforeStop && !state.stopped) {
          state.stopped = { reason: `GitHub refused ${LIMITS.refusalsBeforeStop} requests within an hour`, at: new Date(now()).toISOString() };
        }
        store.saveState(state);
        store.logWrite({ kind: 'revoke', target: 'token', result: 'failed' }, now());
        unrevokedNote = unrevokedLine(expiresAt);
        tell(unrevokedNote);
      },
    });
    const git = createGit({ dir: store.checkoutDir, gitUrl, run });
    let handled = 0;
    let unrevokedNote = null;

    const result = (id, value) => {
      // A token that couldn't be revoked is said in the result of the request it was made for.
      if (unrevokedNote && value.state !== 'waiting') {
        value = { ...value, sentence: `${value.sentence} ${unrevokedNote}` };
        unrevokedNote = null;
      }
      store.writeResult(id, value, now());
      tell(`${id}: ${value.sentence}`);
    };
    const refuse = (id, why) => result(id, { state: 'refused', sentence: refusedSentence(id, why) });
    const wait = (id, sentence, until) => result(id, { state: 'waiting', sentence, ...(until ? { until: new Date(until).toISOString() } : {}) });

    // One write to GitHub: counted, and logged whatever happens.
    async function write(kind, target, work) {
      try {
        const value = await work();
        store.logWrite({ kind, target, result: 'done' }, now());
        return value;
      } catch (error) {
        const outcome =
          error instanceof NoConnection ? 'no connection' : error instanceof RateLimited ? 'rate limited' : error instanceof SignInFailed ? 'sign-in failed' : error instanceof GitHubRefused ? `refused (${error.status})` : 'failed';
        store.logWrite({ kind, target, result: outcome }, now());
        throw error;
      }
    }

    if (restart && state.stopped) {
      state.stopped = null;
      state.refusals = [];
      store.saveState(state);
      tell('The push gate was restarted. Writes are on again.');
    }
    store.pruneResults(now());

    // ---- What is there to do: unfinished work first, then the waiting folder.
    const items = store.listWorking().map((item) => ({ item }));
    const waiting = store.listWaiting();

    // A bundle file is removed with its request, unless another waiting
    // request names the same file.
    const read = waiting.map((entry) => ({ entry, ...store.readWaiting(entry) }));
    const bundleUses = new Map();
    for (const { raw } of read) if (typeof raw?.bundle === 'string') bundleUses.set(raw.bundle, (bundleUses.get(raw.bundle) ?? 0) + 1);
    const drop = (entry, bundle) => {
      const uses = bundleUses.get(bundle) ?? 0;
      if (uses > 1) bundleUses.set(bundle, uses - 1);
      store.dropWaiting(entry, uses > 1 ? undefined : bundle);
    };

    const valid = [];
    for (const { entry, raw, unreadable } of read) {
      if (unreadable) {
        // A file still being written is left for the next run.
        if (Date.now() - entry.mtimeMs < 5000) continue;
        store.dropWaiting(entry);
        refuse(entry.id, "the request file can't be read as a request, so write it again as the README shows");
        handled += 1;
        continue;
      }
      const checked = checkRequest(raw);
      if (checked.why) {
        drop(entry, raw?.bundle);
        refuse(entry.id, checked.why);
        handled += 1;
        continue;
      }
      valid.push({ entry, request: checked.request });
    }
    // A newer push request for a branch replaces an older one still waiting,
    // so fixes go up as one push.
    const newestForBranch = new Map();
    for (const one of valid) if (one.request.kind === 'push') newestForBranch.set(one.request.branch, one.entry.id);
    for (const one of valid) {
      const newest = one.request.kind === 'push' ? newestForBranch.get(one.request.branch) : one.entry.id;
      if (newest !== one.entry.id) {
        drop(one.entry, one.request.bundle);
        refuse(one.entry.id, `the newer request "${newest}" for the same branch replaced it, so there is nothing to change`);
        handled += 1;
        continue;
      }
      items.push(one);
    }

    // ---- Stops that hold every request.
    const idOf = (one) => one.item?.id ?? one.entry.id;
    const holdAll = (from, sentence, until) => {
      for (const one of from) wait(idOf(one), sentence, until);
    };
    if (state.stopped) {
      holdAll(items, `Waiting: the push gate has stopped every write because ${state.stopped.reason}. The owner needs to restart it.`);
      return { handled, lines };
    }
    if (now() < state.pausedUntil) {
      holdAll(items, `Waiting: GitHub asked the push gate to slow down. Writes start again ${sayTime(state.pausedUntil)}.`, state.pausedUntil);
      return { handled, lines };
    }

    // What a failure means for the request it happened on and for the rest.
    // Returns true when the run must stop here.
    function settle(error, id, rest) {
      if (error instanceof KeyUnavailable) {
        holdAll(rest, KEY_SENTENCE);
        return true;
      }
      if (error instanceof NoConnection) {
        holdAll(rest, CONNECTION_SENTENCE);
        return true;
      }
      if (error instanceof RateLimited) {
        state.pausedAt = now();
        state.pausedUntil = now() + Math.max(error.waitMs, LIMITS.rateLimitPauseMs);
        state.noteOwed = true;
        store.saveState(state);
        holdAll(rest, `Waiting: GitHub asked the push gate to slow down. Writes start again ${sayTime(state.pausedUntil)}.`, state.pausedUntil);
        return true;
      }
      if (error instanceof SignInFailed || error instanceof WrongReach) {
        const reason = error instanceof WrongReach ? error.message : "GitHub didn't accept the app's sign-in";
        state.stopped = { reason, at: new Date(now()).toISOString() };
        store.saveState(state);
        holdAll(rest, `Waiting: the push gate has stopped every write because ${reason}. The owner needs to restart it.`);
        return true;
      }
      if (error instanceof GitHubRefused) {
        state.refusals = [...state.refusals.filter((t) => t > now() - HOUR), now()];
        const stop = state.refusals.length >= LIMITS.refusalsBeforeStop;
        if (stop) state.stopped = { reason: `GitHub refused ${LIMITS.refusalsBeforeStop} requests within an hour`, at: new Date(now()).toISOString() };
        store.saveState(state);
        if (id) {
          store.finishWorking(id);
          refuse(id, `${scrub(error.message)}, so change the request to fit and send a new one`);
        }
        if (stop) {
          holdAll(rest.filter((one) => idOf(one) !== id), `Waiting: the push gate has stopped every write because ${state.stopped.reason}. The owner needs to restart it.`);
        }
        return stop;
      }
      throw error;
    }

    // ---- The one note on #52 once writes resume after a rate-limit stop.
    if (state.noteOwed && !quietUntil(now())) {
      const body = `The push gate stopped every write ${sayTime(state.pausedAt)} because GitHub answered with a rate limit. Writes started again ${sayTime(now())}.\n\nPush gate, on the Studio`;
      try {
        await session.withToken({ issues: 'write' }, (token) =>
          write('note', `#${REPORT_ISSUE}`, () => session.call('POST', `${REPO_PATH}/issues/${REPORT_ISSUE}/comments`, token, { body })),
        );
        state.noteOwed = false;
        store.saveState(state);
      } catch (error) {
        if (settle(error, null, items)) return { handled, lines };
      }
    }

    // ---- Each request in turn.
    for (let index = 0; index < items.length; index += 1) {
      const one = items[index];
      const id = idOf(one);
      const request = one.item?.request ?? one.request;
      const rest = items.slice(index);
      // A stop set while the last request was handled (tokens that couldn't be revoked) holds the rest.
      if (state.stopped) {
        holdAll(rest, `Waiting: the push gate has stopped every write because ${state.stopped.reason}. The owner needs to restart it.`);
        return { handled, lines };
      }

      // Pace limits.
      const quiet = quietUntil(now());
      if (quiet && !store.isAllowed(id)) {
        wait(id, `Waiting: quiet hours, 11 PM to 6 AM New York time. It goes at ${sayTime(quiet)}, or sooner if the owner runs push-gate allow ${id}.`, quiet);
        continue;
      }
      const cap = capUntil(store.recentWriteTimes(now()), now(), writesNeeded(request));
      if (cap) {
        wait(id, `Waiting: the agents have made about ${LIMITS.writesPerHour} writes to GitHub in the last hour. It goes after ${sayTime(cap)}.`, cap);
        continue;
      }
      // A request whose own push already went up (a run was interrupted after
      // it) only has its pull request left to finish, so the gap doesn't apply.
      // The same goes for a request finishing its own interrupted push.
      const ownPush = one.item?.step === 'pushing' && state.lastPush[request.branch] === one.item.pushingAt;
      const alreadyPushed = ['pushed', 'opened'].includes(one.item?.step) || ownPush;
      if (request.kind === 'push' && !alreadyPushed) {
        const gap = pushGapUntil(state.lastPush[request.branch], now());
        if (gap) {
          wait(id, `Waiting: branch ${request.branch} was pushed less than 10 minutes ago. It goes after ${sayTime(gap)}.`, gap);
          continue;
        }
      }

      // Waiting to working.
      let item = one.item;
      if (!item) {
        try {
          item = store.take(one.entry, request, now());
        } catch (error) {
          store.dropWaiting(one.entry, request.bundle);
          refuse(
            id,
            error.message === 'bundle too large'
              ? 'its bundle is 50 MB or more, so split the work into smaller pushes'
              : `its bundle file "${request.bundle}" isn't in the waiting folder as a plain file, so put it beside the request`,
          );
          handled += 1;
          continue;
        }
        one.item = item;
      }

      try {
        const done = request.kind === 'push' ? await handlePush(item) : await handlePost(item);
        store.finishWorking(id);
        result(id, { state: 'done', ...done });
        handled += 1;
      } catch (error) {
        if (error instanceof CheckFailed) {
          store.finishWorking(id);
          refuse(id, error.message);
          handled += 1;
          continue;
        }
        const stop = settle(error, id, rest);
        if (error instanceof GitHubRefused) handled += 1;
        if (stop) return { handled, lines };
      }
    }
    return { handled, lines };

    // ---------------------------------------------------------------- push

    async function handlePush(item) {
      const { id, request } = item;
      const { branch, commit } = request;
      const bundle = store.workingBundle(id);

      await git.ensureRepo();
      await git.fetchMain();

      // The commit in the bundle is exactly the one named.
      const heads = await git.bundleHeads(bundle);
      if (heads.length !== 1 || heads[0].sha !== commit) {
        throw new CheckFailed(`its bundle doesn't hold exactly the named commit ${short(commit)}, so make the bundle from that one commit and name the same commit`);
      }
      await git.fetchBundle(bundle, heads[0].ref, id);
      if ((await git.revParse(`refs/gate/request/${id}`)) !== commit) {
        throw new CheckFailed(`its bundle doesn't hold exactly the named commit ${short(commit)}, so make the bundle from that one commit and name the same commit`);
      }
      try {
        // It builds on the current main.
        if (!(await git.isAncestor('refs/gate/main', commit))) {
          throw new CheckFailed("its commit doesn't build on the current main, so bring the branch up to date with main and send the new commit");
        }
        // Workflow changes are refused up front: the app can't push them.
        const workflows = await git.changedUnder('refs/gate/main', commit, '.github/workflows/');
        if (workflows.length) {
          throw new CheckFailed(`it changes ${workflows[0]}, and the agents' app has no permission to push workflow files, so leave .github/workflows/ out`);
        }
        // Forward only: no force push, ever.
        const onGitHub = await git.remoteBranch(branch);
        if (onGitHub && onGitHub !== commit) {
          await git.fetchRemoteBranch(branch, id);
          if (!(await git.isAncestor(onGitHub, commit))) {
            throw new CheckFailed(`it would replace commits already on branch ${branch} (a force push), so build on the branch as it is on GitHub`);
          }
        }

        return await session.withToken(permissionsFor(request), async (token) => {
          if (onGitHub !== commit) {
            // The push's time is saved before the push is sent. If the run dies
            // or the connection drops after GitHub has accepted it, the 10
            // minutes for this branch still count from here.
            item.step = 'pushing';
            item.pushingAt = now();
            store.saveWorking(item);
            state.lastPush[branch] = item.pushingAt;
            store.saveState(state);
            await write('push', branch, () => git.push(commit, branch, token));
          }
          item.step = 'pushed';
          store.saveWorking(item);

          // The pull request: open it, or record the review on the one already open.
          const found = await session.call('GET', `${REPO_PATH}/pulls?state=open&head=${encodeURIComponent(`${OWNER}:${branch}`)}&per_page=5`, token);
          let pull = (found.data ?? []).find((pr) => pr.head?.ref === branch) ?? null;
          let unrecorded = false;
          if (!pull && request.pullRequest) {
            const body = withReviewLine(request.pullRequest.body, request.review, `${AGENTS[request.agent]}, ${request.thread}`);
            const why = checkText(body, { ...request, what: 'pull request description' });
            if (why) throw new CheckFailed(why);
            pull = (
              await write('pull request', branch, () =>
                session.call('POST', `${REPO_PATH}/pulls`, token, { title: request.pullRequest.title, head: branch, base: 'main', body, draft: false }),
              )
            ).data;
            item.step = 'opened';
            store.saveWorking(item);
          } else if (pull) {
            // Every push to an open pull request leaves its review record there,
            // whatever the description held before (even nothing).
            const body = withReviewLine(pull.body, request.review, `${AGENTS[request.agent]}, ${request.thread}`);
            if (body.length >= LIMITS.textChars) unrecorded = true;
            else if (body !== pull.body) {
              await write('description', `#${pull.number}`, () => session.call('PATCH', `${REPO_PATH}/pulls/${pull.number}`, token, { body }));
            }
          }
          if (pull && request.pullRequest) {
            const label = `agent: ${request.agent}`;
            const has = (pull.labels ?? []).some((l) => l.name === label);
            if (!has) await write('label', `#${pull.number}`, () => session.call('POST', `${REPO_PATH}/issues/${pull.number}/labels`, token, { labels: [label] }));
          }
          return pull
            ? {
                sentence: `Done: commit ${short(commit)} is on branch ${branch}, pull request #${pull.number} (${pull.html_url}).${unrecorded ? " Its description is at GitHub's length limit, so the local review record could not be added: shorten the description and push again." : ''}`,
                commit,
                branch,
                pullRequest: { number: pull.number, url: pull.html_url },
              }
            : { sentence: `Done: commit ${short(commit)} is on branch ${branch}. No pull request was asked for.`, commit, branch };
        });
      } finally {
        await git.forget(id);
      }
    }

    // ------------------------------------------------- comment and reply

    async function handlePost(item) {
      const { id, request } = item;
      const number = request.kind === 'reply' ? request.pull : (request.target.pull ?? request.target.issue);
      const onPull = request.kind === 'reply' || Boolean(request.target.pull);
      const listPath = request.kind === 'reply' ? `${REPO_PATH}/pulls/${number}/comments` : `${REPO_PATH}/issues/${number}/comments`;
      const what = request.kind === 'reply' ? 'reply' : 'comment';

      return session.withToken(permissionsFor(request), async (token) => {
        if (onPull) {
          let pull;
          try {
            pull = (await session.call('GET', `${REPO_PATH}/pulls/${number}`, token)).data;
          } catch (error) {
            if (error instanceof GitHubRefused && error.status === 404) throw new CheckFailed(`#${number} isn't a pull request, so name an open pull request`);
            throw error;
          }
          if (pull?.state !== 'open') throw new CheckFailed(`pull request #${number} isn't open, so name an open pull request`);
        }

        // Left in "working" by a crash: look before posting, so nothing is posted twice.
        let posted = null;
        if (item.step === 'posting') {
          const since = new Date(item.postingAt - 60000).toISOString();
          const recent = (await session.call('GET', `${listPath}?since=${encodeURIComponent(since)}&per_page=100`, token)).data ?? [];
          posted =
            recent.find(
              (c) => c.user?.login === APP_LOGIN && c.body === request.body && (request.kind !== 'reply' || c.in_reply_to_id === request.inReplyTo),
            ) ?? null;
        }
        if (!posted) {
          item.step = 'posting';
          item.postingAt = now();
          store.saveWorking(item);
          const path = request.kind === 'reply' ? `${REPO_PATH}/pulls/${number}/comments/${request.inReplyTo}/replies` : `${REPO_PATH}/issues/${number}/comments`;
          posted = (await write(what, `#${number}`, () => session.call('POST', path, token, { body: request.body }))).data;
        }
        return { sentence: `Done: the ${what} is on #${number} (${posted?.html_url ?? `${what} ${posted?.id ?? ''}`.trim()}).`, [onPull ? 'pullRequest' : 'issue']: { number }, url: posted?.html_url };
      });
    }
  }
}

/** The result of every request, for any agent session to read and pass on. */
export function status({ home, shared, now = Date.now }) {
  const store = createStore({ home, shared });
  const results = store.listResults();
  const known = new Set(results.map((r) => r.id));
  const lines = [];
  const fresh = store.listWaiting().filter((entry) => !known.has(entry.id));
  const waiting = results.filter((r) => r.state === 'waiting');
  if (!waiting.length && !fresh.length) lines.push(NOTHING_WAITING);
  for (const entry of fresh) lines.push(`${entry.id}: Waiting: the gate hasn't looked at it yet. It will on its next run.`);
  for (const r of waiting) lines.push(`${r.id}: ${r.sentence}`);
  for (const r of results.filter((x) => x.state !== 'waiting')) lines.push(`${r.id}: ${r.sentence}`);
  const state = store.loadState();
  if (state.stopped) lines.push(`The push gate has stopped every write because ${state.stopped.reason}. The owner needs to restart it.`);
  for (const expiresAt of state.unrevoked ?? []) if (Date.parse(expiresAt) > now()) lines.push(unrevokedLine(expiresAt));
  return { lines, results };
}

/** The owner lets one request through quiet hours. */
export function allow({ home, shared }, id) {
  if (!REQUEST_ID.test(id ?? '')) return { ok: false, line: 'Name the request to let through, as push-gate status shows it.' };
  const store = createStore({ home, shared });
  const there = store.listWaiting().some((entry) => entry.id === id) || store.listWorking().some((item) => item.id === id);
  if (!there) return { ok: false, line: `No waiting request is named "${id}". Run push-gate status to see the names.` };
  store.allow(id);
  return { ok: true, line: `Request "${id}" may go during quiet hours. It still passes every check and the other pace limits.` };
}
