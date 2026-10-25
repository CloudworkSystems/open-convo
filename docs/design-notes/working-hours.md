# Design Note: Learning The Owner's Working Hours

Written October 25, 2026 at the owner's request. Status: idea, not planned
or built. A plan in `docs/plans/` comes first if the owner wants it built.

## Why This Note Exists

On a weekend with an unusual schedule, the owner asked whether the way Claude
noticed he had replied could also help True Convo work out his preferred
working hours. He suggested making it one of the findings in CONTINUITY (the
Desk's memory view, `apps/desk/src/features/Navigation.tsx`, with its records
in `apps/desk/src/domain/types.ts`) or a similar memory layer.

Claude didn't detect anything clever. The owner's GitHub approval reached it
as an event with a time on it, and every chat message arrives with a note
saying how long ago he last wrote. The signal is simply **when the owner
acts**. True Convo sees the same kind of signal: messages sent, approvals,
Desk use and dictation sessions.

## What It Would Do

1. **Count, don't record.** For each action the owner takes, add one to a
   counter for that hour of that day. Nothing about what the action was is
   kept: no text, no app name, no recipient. The last 14 days stay as one row
   of 24 hourly counts per date, so a recent stretch can still be taken out.
   When a day is 14 days old and wasn't marked away, it is folded into 168
   hour-of-week counters (7 days × 24 hours) and its own row is deleted.
   Recent weeks count more than older ones, and anything older than about
   eight weeks has faded out.
2. **Propose a finding.** Once there are a few weeks of counts, True Convo
   shows a proposal in CONTINUITY, for example: "You usually work 9 AM–1 PM
   and 8–11 PM on weekdays; weekends vary." It comes with a confidence. It is
   labeled as an AI interpretation, not as a fact the owner approved.
3. **The owner decides.** Following the foundations' "explicit save first"
   rule, the proposal is not a memory until the owner saves it. He can edit it
   ("mornings are for errands, not work"), keep it view-only, or forget it.
   It uses the same remember, correct, forget and undo history as other
   CONTINUITY memories.
4. **Notice unusual stretches, don't absorb them.** When a few days look
   nothing like the saved pattern, as on a trip, True Convo doesn't quietly
   rewrite the pattern. It asks once ("Away this week?"), within the 14 days
   while those dates still have their own rows, or the owner marks the days as
   away. Away days' rows are deleted and never folded in. A day that wasn't
   answered within the 14 days is folded in like any other.
5. **Use it gently.** A saved working-hours memory is a soft guide for timing.
   It can decide when to send the daily list, when to ask for an approval, and
   when to hold a non-urgent message until morning. It never blocks anything
   and never delays urgent items. The owner can always override it.

## Rules It Must Keep

- **Off until switched on.** Collecting the counts is an opt-in setting, as
  the foundations require for any automatic filing.
- **Only the counters.** The counts (at most 14 daily rows and the 168
  weekly counters) live in the owner's Personal memory space
  on his own devices, with nothing about his actions beyond their hour. They
  never go into a business space, a shared space or a model's context, except
  as the one saved sentence when a context package needs it.
- **Code, not a model.** The counting and the weighting are plain code. A
  model may only phrase the proposal, so the result is the same on a small
  local model.
- **Visible and removable.** CONTINUITY shows what is counted, and one
  "forget my hours" clears the counters along with the memory.

## Open Questions For The Owner

- Which actions count: only messages and approvals, or also Desk and
  dictation use?
- Should an agent working for him overnight be allowed to hold a non-urgent
  question until his next working hour, or always ask right away?
- One pattern, or one per memory space (Personal versus each business)?
