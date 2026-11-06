// The review loop watchdog (docs/plans/review-loop-watchdog.md): halts a pull
// request that keeps cycling through Codex rounds with findings, and asks the
// owner to accept the findings, narrow the pull request or split it.
//
// decideReviewLoop() is pure: no network, easy to test. codex-approved.mjs
// reads the data, calls it, then applyReviewLoop() adds or removes the label
// and writes the comment it returns. It never changes the `codex-approved` status: the gate
// already blocks while findings are open, and a halt only stops more rounds.
//
// State lives in the watchdog's own comment on the pull request, in a hidden
// marker. Only a comment GitHub Actions wrote and alone edited is trusted. A
// state that can't be trusted is ignored, which counts rounds from the start:
// it can make a halt come sooner, never later.

import { CODEX_LOGIN, OWNER_LOGIN, acceptNoteFor, editedOnlyBy, evaluateCodexSignal, isOwnerEditor, ownerAcceptance } from './codex-signal.mjs';
import { ACTIONS_LOGIN, codexFindingReviews } from './codex-triage.mjs';

export const LABEL = 'needs-owner: review-loop';
export const LABEL_COLOR = 'b60205';
export const LABEL_DESCRIPTION = 'Stuck in review: waiting on the owner to accept, narrow or split (docs/plans/review-loop-watchdog.md)';
// Rounds with findings before a halt: two rounds plus four of carrying P1s
// to the build for a plan, more room for code. Change them here only.
export const PLAN_LIMIT = 6;
export const CODE_LIMIT = 8;
export const RESUME_WORD = 'loop-resume';

const MARKER = 'review-loop:v1';
const STATE = /<!--\s*review-loop:v1\s+(\{.*?\})\s*-->/s;
const ACTIONS_BOT_LOGIN = 'github-actions';
const isActionsEditor = (actor) => Boolean(actor) && actor.__typename === 'Bot' && actor.login === ACTIONS_BOT_LOGIN;
const time = (value) => Date.parse(value ?? '') || 0;
const iso = (ms) => new Date(ms).toISOString();

/** A plan pull request: every file under docs/, or PLAN.md or STATUS.md. Unknown files: code. */
export function isPlanPullRequest(files, complete = true) {
  if (!complete || !Array.isArray(files) || files.length === 0) return false;
  return files.every((f) => f.startsWith('docs/') || f === 'PLAN.md' || f === 'STATUS.md');
}

/** Distinct commits Codex left findings on, counting only reviews after `since` (ms). */
export function roundsSince({ reviews = [], dismissals = [], since = 0 } = {}) {
  const counted = codexFindingReviews(reviews, dismissals).filter((r) => time(r.submitted_at) > since);
  return new Set(counted.map((r) => r.commit_id)).size;
}

/** The watchdog's trusted comment and the state it records, or null. */
export function readState(comments = []) {
  const trusted = comments
    .filter((c) => c?.user?.login === ACTIONS_LOGIN && (c.body ?? '').includes(MARKER))
    .filter((c) => c.edit_history !== undefined && editedOnlyBy(c, isActionsEditor))
    .map((c) => {
      const m = (c.body ?? '').match(STATE);
      if (!m) return null;
      try {
        const state = JSON.parse(m[1]);
        return state && typeof state === 'object' ? { comment: c, state } : null;
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => time(a.comment.created_at) - time(b.comment.created_at) || (a.comment.id ?? 0) - (b.comment.id ?? 0));
  // The oldest trusted comment is the one record. Two runs that overlap may
  // each post one; applyReviewLoop then folds the newer into the oldest.
  return trusted[0] ?? null;
}

/** The newest `labeled` or `unlabeled` timeline event for the watchdog's label. */
function lastLabelEvent(timeline, kind) {
  return timeline
    .filter((e) => e?.event === kind && e.label?.name === LABEL)
    .sort((a, b) => time(a.created_at) - time(b.created_at))
    .at(-1) ?? null;
}

/**
 * The owner's `loop-resume` comment after `after` (ms): his account, the
 * whole comment exactly the word, and an edit record that was read and shows
 * no editor but him (fails closed, the same reading as the owner's accept note).
 */
export function ownerResume({ comments = [], after = 0 } = {}) {
  const found = comments.filter((c) => c?.user?.login === OWNER_LOGIN && c.user.type === 'User')
    .filter((c) => c.edit_history !== undefined && editedOnlyBy(c, isOwnerEditor))
    .filter((c) => (c.body ?? '').trim() === RESUME_WORD && time(c.created_at) > after)
    .map((c) => time(c.created_at));
  return found.length ? Math.max(...found) : 0;
}

/**
 * Decides what the watchdog does for one pull request on this run.
 *
 * @param {object} input
 * @param {object} input.pr { number, state, draft, base: { ref }, head: { sha }, user: { login }, html_url }
 * @param {string} input.defaultBranch
 * @param {string[]} input.files changed file paths
 * @param {boolean} input.filesComplete whether `files` lists every changed file
 * @param {string[]} input.labels label names on the pull request
 * @param {Array} input.comments issue comments, each with `edit_history`
 * @param {Array} input.reviews pull request reviews
 * @param {Array} input.reactions reactions on the pull request
 * @param {Array} input.dismissals `review_dismissed` issue events
 * @param {Array|null|undefined} input.timeline issue timeline events; null when it couldn't be read
 * @param {number} input.now current time in milliseconds
 * @returns {{ skip?: string, error?: string, needsTimeline?: boolean, halted: boolean,
 *   addLabel: boolean, removeLabel: boolean, comment: string|null, existingCommentId: number|null,
 *   rounds: number, limit: number, log: string }}
 */
export function decideReviewLoop({ pr, defaultBranch, files = [], filesComplete = true, labels = [], comments = [], reviews = [], reactions = [], dismissals = [], timeline, now = Date.now() } = {}) {
  const noop = (extra) => ({ halted: false, addLabel: false, removeLabel: false, comment: null, existingCommentId: null, rounds: 0, limit: 0, log: '', ...extra });
  const headSha = pr?.head?.sha;
  if (!pr || pr.state !== 'open' || !/^[0-9a-f]{40}$/i.test(headSha ?? '')) return noop({ skip: 'not an open pull request with a head commit' });

  const prior = readState(comments);
  const state = { halted: false, since: null, liftedAt: null, haltedAt: null, pushed: [], ...(prior?.state ?? {}) };
  if (!Array.isArray(state.pushed)) state.pushed = [];
  const labelOn = labels.includes(LABEL);
  const plan = isPlanPullRequest(files, filesComplete);
  const limit = plan ? PLAN_LIMIT : CODE_LIMIT;
  const notes = [];
  let addLabel = false;
  let removeLabel = false;
  let changed = false;
  let lifted = null;
  let orphanLabel = false;

  // Who added or removed the label comes only from GitHub's timeline. Without
  // it: no halt and no lift this run.
  if (labelOn || state.halted) {
    if (timeline === undefined) return noop({ needsTimeline: true });
    if (!Array.isArray(timeline)) return noop({ error: 'timeline unreadable: no halt and no lift this run' });
  }

  const lift = (reason, at) => {
    lifted = reason;
    state.halted = false;
    state.since = iso(Math.max(at || now, time(state.since)));
    state.liftedAt = iso(now);
    state.liftReason = reason;
    // Pushes made during the halt stay on record in the lifted comment.
    state.pushedBeforeLift = state.pushed;
    state.pushed = [];
    removeLabel = labelOn;
    // A lift wins over a label put back earlier in this run.
    addLabel = false;
    changed = true;
  };
  const halt = (reason) => {
    state.halted = true;
    state.haltedAt = iso(now);
    state.haltedHead = headSha;
    state.haltReason = reason;
    state.pushed = [];
    state.pushedBeforeLift = [];
    addLabel = !labelOn;
    changed = true;
  };

  // A push while halted is recorded first, so a lift in the same run keeps it.
  if (state.halted && headSha !== state.haltedHead && !state.pushed.includes(headSha)) {
    state.pushed.push(headSha);
    changed = true;
  }

  // 1. Line the label up with the recorded state.
  if (state.halted && !labelOn) {
    const removed = lastLabelEvent(timeline, 'unlabeled');
    if (removed && removed.actor?.login === OWNER_LOGIN && time(removed.created_at) >= time(state.haltedAt)) {
      lift('the owner removed the label', time(removed.created_at));
    } else {
      addLabel = true;
      notes.push(`The label was removed by ${removed?.actor?.login ?? 'someone the timeline does not name'}, not the owner, so it was put back.`);
      changed = true;
    }
  } else if (!state.halted && labelOn) {
    const added = lastLabelEvent(timeline, 'labeled');
    const fresh = added && time(added.created_at) > time(state.liftedAt);
    if (fresh && added.actor?.login === OWNER_LOGIN) {
      halt('the owner added the label');
    } else if (fresh && added.actor?.login === ACTIONS_LOGIN) {
      // The watchdog's own label from a run whose comment didn't get written.
      // Step 3 decides afresh whether the halt still holds; if not, it comes off.
      orphanLabel = true;
    } else if (fresh) {
      removeLabel = true;
      notes.push(`The label was added by ${added.actor?.login ?? 'someone the timeline does not name'}, not the owner, so it was taken off.`);
      changed = Boolean(prior);
    } else {
      // Left over from a lift whose label removal didn't go through.
      removeLabel = true;
    }
  }

  const sinceMs = time(state.since);
  const rounds = roundsSince({ reviews, dismissals, since: sinceMs });
  // Clean in any form the gate counts, read by the gate's own function. The
  // owner's accept line is checked on its own below, so it's left out here.
  const codexClean = evaluateCodexSignal({ headSha, prAuthor: null, comments, reviews, reactions, dismissals, now }).approved;
  const accepted = ownerAcceptance({ headSha, prAuthor: pr.user?.login, comments });

  // 2. A halt lifts on the owner's word or a clean head.
  if (state.halted) {
    const resumed = ownerResume({ comments, after: time(state.haltedAt) });
    if (accepted) lift('the owner accepted the findings on the head', now);
    else if (resumed) lift(`the owner commented ${RESUME_WORD}`, resumed);
    else if (codexClean) lift('Codex came back clean on the head', now);
  }

  // 3. Otherwise, halt a pull request that reached its limit.
  if (!state.halted && !lifted) {
    const eligible = !pr.draft && pr.base?.ref === defaultBranch && pr.user?.login && pr.user.login !== OWNER_LOGIN;
    if (eligible && !codexClean && !accepted && newestHasFindings({ headSha, reviews, dismissals }) && rounds >= limit) halt(`${rounds} Codex rounds with findings`);
    if (orphanLabel && !state.halted) {
      removeLabel = true;
      notes.push('A label left by an earlier watchdog run was taken off: the halt no longer holds.');
      changed = Boolean(prior);
    }
  }

  state.rounds = state.halted ? Math.max(rounds, state.rounds ?? 0) : rounds;
  state.limit = limit;
  state.plan = plan;
  const recordedRounds = prior?.state?.rounds;
  if (prior && state.halted && recordedRounds !== state.rounds) changed = true;
  // A comment is written only once a pull request has halted, then kept up to date.
  const comment = changed && (prior || state.halted || lifted)
    ? commentBody({ pr, state, notes, lifted, newest: newestCodexReview(reviews) })
    : null;
  return {
    halted: state.halted,
    addLabel,
    removeLabel,
    comment,
    existingCommentId: prior?.comment?.id ?? null,
    rounds: state.rounds,
    limit,
    log: state.halted ? `halted (${state.haltReason})` : lifted ? `lifted (${lifted})` : `${rounds}/${limit} rounds`,
  };
}

/**
 * The plan's third condition: Codex's newest review of the head has findings,
 * or the head has no Codex review yet and the newest review of any commit
 * had findings. An approval, or a review the owner dismissed, has none.
 */
export function newestHasFindings({ headSha, reviews = [], dismissals = [] } = {}) {
  const codexReviews = reviews.filter((r) => r?.user?.login === CODEX_LOGIN);
  const newest = newestCodexReview(codexReviews);
  if (!newest) return false;
  // The newest review is of an older commit (reviews finished out of order)
  // while the head has a review already: not the plan's case, so no halt.
  if (newest.commit_id !== headSha && codexReviews.some((r) => r.commit_id === headSha)) return false;
  return codexFindingReviews([newest], dismissals).length === 1;
}

function newestCodexReview(reviews) {
  return reviews.filter((r) => r?.user?.login === CODEX_LOGIN)
    .sort((a, b) => time(a.submitted_at) - time(b.submitted_at))
    .at(-1) ?? null;
}

/** The watchdog's comment: plain words for the owner, the state in a hidden marker. */
export function commentBody({ pr, state, notes = [], lifted = null, newest = null }) {
  const head = pr.head.sha;
  const kind = state.plan ? 'plan' : 'code';
  const since = state.since ? `since ${state.since.slice(0, 16).replace('T', ' ')} UTC` : 'since it opened';
  const lines = [];
  if (state.halted) {
    const plan = pr.base?.repo?.html_url ? `[review loop watchdog](${pr.base.repo.html_url}/blob/main/docs/plans/review-loop-watchdog.md)` : 'docs/plans/review-loop-watchdog.md';
    lines.push(
      state.haltReason === 'the owner added the label'
        ? `**Stuck in review.** The owner halted this pull request by adding the \`${LABEL}\` label. Codex has left findings on ${state.rounds} commits of it ${since} (${plan}).`
        : `**Stuck in review.** Codex has left findings on ${state.rounds} commits of this pull request ${since}, which reaches the limit of ${state.limit} for a ${kind} pull request (${plan}).`,
      '',
      'Until the owner lifts this halt, no agent pushes to this pull request, relays findings to it or asks for a new review. Builders may still answer review threads in words.',
      '',
    );
    if (newest?.html_url) lines.push(`Newest Codex review: ${newest.html_url}`, '');
    lines.push(
      'The owner\'s choices:',
      `1. **Accept the findings:** post \`${acceptNoteFor(head)}\` on this pull request.`,
      `2. **Narrow it:** tell the building thread what this pull request should stop promising, then remove the \`${LABEL}\` label (or comment \`${RESUME_WORD}\`) so the builder can push.`,
      '3. **Split it:** tell the building thread how to split it. The builder opens the new pull requests and closes this one.',
    );
    if (state.pushed.length) {
      lines.push('', `**Pushed while halted:** ${state.pushed.map((sha) => `\`${sha.slice(0, 7)}\``).join(', ')}`);
    }
  } else {
    const reason = lifted ?? state.liftReason ?? 'lifted';
    lines.push(
      `**Review loop halt lifted:** ${reason}${state.liftedAt ? ` (${state.liftedAt.slice(0, 16).replace('T', ' ')} UTC)` : ''}.`,
      '',
      `The count starts again. The watchdog halts this pull request again only after another ${state.limit} Codex rounds with findings.`,
    );
    if (Array.isArray(state.pushedBeforeLift) && state.pushedBeforeLift.length) {
      lines.push('', `**Pushed while halted:** ${state.pushedBeforeLift.map((sha) => `\`${sha.slice(0, 7)}\``).join(', ')} (before this lift)`);
    }
  }
  if (notes.length) lines.push('', ...notes);
  lines.push('', `<!-- ${MARKER} ${JSON.stringify(state)} -->`);
  return lines.join('\n');
}

/**
 * The round count an owner-queue listing shows, from the newest watchdog
 * comment by GitHub Actions. Display only: owner-queue doesn't read edit
 * records, and the label, not this, decides what it lists.
 */
export function haltSummary(comments = []) {
  const found = comments
    .filter((c) => c?.user?.login === ACTIONS_LOGIN)
    .map((c) => ({ c, m: (c.body ?? '').match(STATE) }))
    .filter(({ m }) => m)
    .sort((a, b) => time(a.c.created_at) - time(b.c.created_at))
    .at(-1);
  if (!found) return null;
  try {
    const state = JSON.parse(found.m[1]);
    return { rounds: Number.isInteger(state?.rounds) ? state.rounds : null, limit: Number.isInteger(state?.limit) ? state.limit : null, pushed: Array.isArray(state?.pushed) ? state.pushed.length : 0 };
  } catch { return null; }
}

/**
 * Makes sure the label exists in the repository: read it, and create it on a
 * 404, so a halt never fails on a missing label. `cache.ready` skips the read
 * after the first success in a run.
 */
export async function ensureLabel({ gh, repoBase, cache = {} }) {
  if (cache.ready) return;
  try {
    await gh.get(`${repoBase}/labels/${encodeURIComponent(LABEL)}`);
  } catch (error) {
    if (!/ failed: 404 /.test(error.message ?? '')) throw error;
    await gh.post(`${repoBase}/labels`, { name: LABEL, color: LABEL_COLOR, description: LABEL_DESCRIPTION });
  }
  cache.ready = true;
}

/**
 * Carries out a decision. Halting: the label first, then the comment.
 * Lifting: the comment first, then the label. A run that fails halfway
 * leaves what the next run needs to finish the other half.
 */
export async function applyReviewLoop({ gh, repoBase, number, decision, labelCache = {}, reloadComments = null }) {
  if (decision.addLabel) {
    await ensureLabel({ gh, repoBase, cache: labelCache });
    await gh.post(`${repoBase}/issues/${number}/labels`, { labels: [LABEL] });
  }
  if (decision.comment) {
    let target = decision.existingCommentId;
    // Another run may have posted the record since this one read the comments.
    if (!target && reloadComments) target = readState(await reloadComments())?.comment?.id ?? null;
    if (target) {
      await gh.patch(`${repoBase}/issues/comments/${target}`, { body: decision.comment });
    } else {
      const posted = await gh.post(`${repoBase}/issues/${number}/comments`, { body: decision.comment });
      // Two overlapping runs can both post. The oldest record stays; a newer
      // one of ours is folded into it and deleted, so one comment remains.
      if (reloadComments && posted?.id != null) {
        const record = readState(await reloadComments())?.comment;
        if (record?.id != null && record.id !== posted.id) {
          await gh.patch(`${repoBase}/issues/comments/${record.id}`, { body: decision.comment });
          await gh.delete(`${repoBase}/issues/comments/${posted.id}`);
        }
      }
    }
  }
  if (decision.removeLabel) {
    try {
      await gh.delete(`${repoBase}/issues/${number}/labels/${encodeURIComponent(LABEL)}`);
    } catch (error) {
      if (!/ failed: 404 /.test(error.message ?? '')) throw error;
    }
  }
}
