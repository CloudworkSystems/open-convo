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
import { CapReached, CheckFailed, GitHubRefused, KeyUnavailable, NoConnection, RateLimited, SignInFailed, WrongReach, scrub } from './errors.mjs';
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
const capSentence = (until) => `Waiting: the agents have made about ${LIMITS.writesPerHour} writes to GitHub in the last hour. It goes after ${sayTime(until)}.`;
const replacedSentence = (newest) => `the newer request "${newest}" for the same branch replaced it, so there is nothing to change`;
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
      // GitHub answered the revoke with a rate limit: every write stops, as
      // for a rate limit on any other call, and the note on #52 is owed.
      onRevokeRateLimited(waitMs) {
        state.pausedAt = now();
        state.pausedUntil = Math.max(state.pausedUntil, now() + Math.max(waitMs, LIMITS.rateLimitPauseMs));
        state.noteOwed = true;
        state.noteStartedAt = 0;
        state.noteWrite = null;
        store.saveState(state);
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
    // The line is written, and counted toward the hourly cap, before the
    // write is sent, and its outcome is filled in afterward. So a write
    // GitHub accepted just before a crash or a dropped connection is still
    // counted. `item` remembers the line, so a later run that finds the
    // write on GitHub marks that same line done (`foundOnGitHub`).
    //
    // The hourly cap is checked here too, right before every write, whatever
    // led to it: a retry after a lost answer, or the gate's own note on #52.
    // So no write can be the 61st in an hour.
    async function write(kind, target, work, item, onLogged) {
      const full = capUntil(store.recentWriteTimes(now()), now(), 1);
      if (full) {
        // An interrupted write that wasn't on GitHub after all keeps its line
        // in the log, counted. The retry waits for room like any other write.
        if (item?.lastWrite) {
          delete item.lastWrite;
          store.saveWorking(item);
        }
        throw new CapReached(full);
      }
      const entry = store.logWrite({ kind, target, result: 'started' }, now());
      onLogged?.(entry);
      if (item) {
        item.lastWrite = entry;
        store.saveWorking(item);
      }
      try {
        const value = await work();
        store.settleWrite(entry, 'done');
        if (item) delete item.lastWrite;
        return value;
      } catch (error) {
        if (error instanceof NoConnection) {
          // GitHub may have accepted it: the line stays counted, and the next run looks.
          store.settleWrite(entry, 'no connection');
        } else if (error instanceof RateLimited || error instanceof SignInFailed || error instanceof GitHubRefused) {
          store.settleWrite(entry, error instanceof RateLimited ? 'rate limited' : error instanceof SignInFailed ? 'sign-in failed' : `refused (${error.status})`);
          if (item) delete item.lastWrite;
        }
        // Anything else is an interrupted run: the line stays "started".
        throw error;
      }
    }

    // A write left open by an interrupted run turned out to be on GitHub.
    function foundOnGitHub(item, kind) {
      if (item.lastWrite?.kind !== kind) return;
      store.settleWrite(item.lastWrite, 'done', ['started', 'no connection']);
      delete item.lastWrite;
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
    // so fixes go up as one push. "Still waiting" includes a request the gate
    // had already taken on but whose push hasn't gone up for certain (held by
    // an outage or by the key): it is older than anything in the waiting folder.
    const unpushed = (item) => item.request.kind === 'push' && ['taken', 'pushing'].includes(item.step);
    const newestForBranch = new Map();
    const replacedBy = new Map();
    for (const { item } of items) if (unpushed(item)) newestForBranch.set(item.request.branch, item.id);
    for (const one of valid) if (one.request.kind === 'push') newestForBranch.set(one.request.branch, one.entry.id);
    for (let i = items.length - 1; i >= 0; i -= 1) {
      const { item } = items[i];
      const newest = unpushed(item) ? newestForBranch.get(item.request.branch) : item.id;
      if (newest === item.id) continue;
      if (item.step === 'pushing') {
        // Its push was interrupted and may be on GitHub. That is looked up
        // first (handlePush): if it is there the request is finished, and if
        // not, it is replaced there instead of being sent again.
        replacedBy.set(item.id, newest);
        continue;
      }
      store.finishWorking(item.id);
      refuse(item.id, replacedSentence(newest));
      handled += 1;
      items.splice(i, 1);
    }
    for (const one of valid) {
      const newest = one.request.kind === 'push' ? newestForBranch.get(one.request.branch) : one.entry.id;
      if (newest !== one.entry.id) {
        drop(one.entry, one.request.bundle);
        refuse(one.entry.id, replacedSentence(newest));
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
        state.pausedUntil = Math.max(state.pausedUntil, now() + Math.max(error.waitMs, LIMITS.rateLimitPauseMs));
        state.noteOwed = true;
        state.noteStartedAt = 0;
        state.noteWrite = null;
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
          // If the request's commit is already up, the refusal says so: only what came after it was turned down.
          const sent = items.find((one) => idOf(one) === id)?.item;
          const pushed = sent?.request.kind === 'push' && ['pushed', 'opened'].includes(sent.step);
          store.finishWorking(id);
          refuse(
            id,
            pushed
              ? `its commit ${short(sent.request.commit)} is on branch ${sent.request.branch}, but the step after the push was turned down (${scrub(error.message)}), so send a new request for what is left`
              : `${scrub(error.message)}, so change the request to fit and send a new one`,
          );
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
      const opening = `The push gate stopped every write ${sayTime(state.pausedAt)} because GitHub answered with a rate limit.`;
      const body = `${opening} Writes started again ${sayTime(now())}.\n\nPush gate, on the Studio`;
      const listPath = `${REPO_PATH}/issues/${REPORT_ISSUE}/comments`;
      try {
        await session.withToken({ issues: 'write' }, async (token) => {
          // An earlier run may have posted it and lost the answer, or died
          // right after: look before posting, so there is one note, not two.
          if (state.noteStartedAt) {
            const since = new Date(state.noteStartedAt - 60000).toISOString();
            const recent = (await session.call('GET', `${listPath}?since=${encodeURIComponent(since)}&per_page=100`, token)).data ?? [];
            if (recent.some((c) => c.user?.login === APP_LOGIN && typeof c.body === 'string' && c.body.startsWith(opening))) {
              if (state.noteWrite) store.settleWrite(state.noteWrite, 'done', ['started', 'no connection']);
              return;
            }
          }
          state.noteStartedAt = now();
          store.saveState(state);
          await write('note', `#${REPORT_ISSUE}`, () => session.call('POST', listPath, token, { body }), null, (entry) => {
            state.noteWrite = entry;
            store.saveState(state);
          });
        });
        state.noteOwed = false;
        state.noteStartedAt = 0;
        state.noteWrite = null;
        store.saveState(state);
      } catch (error) {
        // With the hourly cap used up, the note stays owed for a later run.
        if (!(error instanceof CapReached) && settle(error, null, items)) return { handled, lines };
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
      // So does a rate limit GitHub gave when the last request's token was revoked.
      if (now() < state.pausedUntil) {
        holdAll(rest, `Waiting: GitHub asked the push gate to slow down. Writes start again ${sayTime(state.pausedUntil)}.`, state.pausedUntil);
        return { handled, lines };
      }

      // Pace limits.
      const quiet = quietUntil(now());
      if (quiet && !store.isAllowed(id)) {
        wait(id, `Waiting: quiet hours, 11 PM to 6 AM New York time. It goes at ${sayTime(quiet)}, or sooner if the owner runs push-gate allow ${id}.`, quiet);
        continue;
      }
      // A request with an interrupted write first has to look whether GitHub
      // has it, which sends nothing. If it doesn't, the retry meets the cap
      // in write(), so it is never counted as room already used.
      const cap = one.item?.lastWrite ? null : capUntil(store.recentWriteTimes(now()), now(), writesNeeded(request));
      if (cap) {
        wait(id, capSentence(cap), cap);
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
        if (error instanceof CapReached) {
          wait(id, capSentence(error.until), error.until);
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

        // The description as it will be sent, with the review record added, is
        // checked before anything goes to GitHub, so a request is never
        // refused for it after its commit is already up.
        const newBody = request.pullRequest ? withReviewLine(request.pullRequest.body, request.review, `${AGENTS[request.agent]}, ${request.thread}`) : null;
        if (newBody !== null) {
          const why = checkText(newBody, { ...request, what: 'pull request description' });
          if (why) throw new CheckFailed(newBody.length >= LIMITS.textChars ? `its pull request description leaves no room for the local review record under ${LIMITS.textChars} characters, so shorten it by a few lines` : why);
        }

        // An interrupted push that isn't on GitHub, with a newer request for
        // the branch waiting, is not sent again: the newer one goes instead.
        if (onGitHub !== commit && replacedBy.has(id)) throw new CheckFailed(replacedSentence(replacedBy.get(id)));

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
            await write('push', branch, () => git.push(commit, branch, token), item);
          } else {
            foundOnGitHub(item, 'push');
          }
          item.step = 'pushed';
          store.saveWorking(item);

          // The pull request: open it, or record the review on the one already open.
          const found = await session.call('GET', `${REPO_PATH}/pulls?state=open&head=${encodeURIComponent(`${OWNER}:${branch}`)}&per_page=5`, token);
          let pull = (found.data ?? []).find((pr) => pr.head?.ref === branch) ?? null;
          let unrecorded = false;
          if (pull) foundOnGitHub(item, 'pull request');
          if (!pull && request.pullRequest) {
            const body = newBody;
            pull = (
              await write(
                'pull request',
                branch,
                () => session.call('POST', `${REPO_PATH}/pulls`, token, { title: request.pullRequest.title, head: branch, base: 'main', body, draft: false }),
                item,
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
              await write('description', `#${pull.number}`, () => session.call('PATCH', `${REPO_PATH}/pulls/${pull.number}`, token, { body }), item);
            } else foundOnGitHub(item, 'description');
          }
          if (pull && request.pullRequest) {
            const label = `agent: ${request.agent}`;
            const has = (pull.labels ?? []).some((l) => l.name === label);
            if (has) foundOnGitHub(item, 'label');
            else await write('label', `#${pull.number}`, () => session.call('POST', `${REPO_PATH}/issues/${pull.number}/labels`, token, { labels: [label] }), item);
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
          posted = (await write(what, `#${number}`, () => session.call('POST', path, token, { body: request.body }), item)).data;
        } else {
          foundOnGitHub(item, what);
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
