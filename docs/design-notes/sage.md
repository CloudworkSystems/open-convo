# Design Note: Sage, A Self-Improving Loop With An Independent Checker

Written October 13, 2026 by the planning session, from a conversation with the
owner. Status: direction, built after step 6 (agents that run on a schedule).
"Sage" is a working name. Sage's partner, the checker, gets a name once both
are built.

## What Sage Was

In the old workspace (`cloudwork_systems/sage`), Sage was a scheduled steward
that read a project's recent commits, pulled out **decision events** (a fork
chosen or reversed, a detour and its cost, an abandoned start, a verified win),
filed each as a cited catalog entry, rewrote matching sections of a running
guide, and left a receipt per run. It ran about 40 times between July and
September 2026 and built a catalog of roughly 300 entries.

## Owner Decisions

- **Sage is an OS feature, not a business product.** It is a durable agent built
  on the Review, Remember and Research primitives
  ([capabilities-and-primitives.md](capabilities-and-primitives.md)), and any
  True Convo user can run it on their own projects.
- **Sage never grades itself.** It always works with a partner agent, the
  checker, as it was always meant to.
- **The first loop is tests built from past mistakes**, because they give every
  later change a measure.
- **Sources: project history only for now.** Conversations and dictation history
  are not Sage sources until a later owner decision, which will rest on protected
  storage (step 2) and chosen memory (step 5).
- **Jev, the Decisions API and Jeff are part of the loop** in the roles below.
- **Naming waits** until Sage and the checker are both built.

## What Moves From The Old Sage, And What Stays

- **Moves (as method, rewritten):** the harvest cycle (scope a window of history,
  extract decision events, match or create entries, never delete, mark uncited
  claims "(inference)", write a receipt), the entry template, and the bounds
  (a capped window per run, no commits without approval).
- **Stays behind:** the catalog and receipts (True Convo's private decision
  history, with internal plans, commit IDs and the owner's name) and the
  guide the old Sage generated.
- **Used locally as seed data:** the existing catalog may seed the first loop's
  tests and lessons **on the owner's Mac only**. It never enters this repo.

## Roles

- **Sage, the harvester.** Reads history and proposes lessons, rules and new
  tests. It never sees the hidden tests and never approves its own proposals.
- **The checker.** Runs on a different model from Sage so they do not share
  blind spots. Reviews each proposal against its cited evidence without seeing
  Sage's reasoning. Writes and holds the hidden test set, and decides whether a
  change made things better or worse.
- **The judge.** Answers cheap typed questions (yes or no, pick one, rate) for
  both: does this commit contain a decision, which fork does this match, does
  the evidence support the lesson, did the agent pick the option that worked.
  Provider: Jev or the OpenAI Decisions API under the existing capped `judge`
  capability, or a local model. A third vendor helps keep the three
  independent.
- **Jeff.** Its action check guards the loop: before Sage or the checker writes
  a rule or changes a profile, Jeff's local rules check the action. Its
  scoreboard design is the model for the test harness (below). "Jeff adapted"
  may later take over the judge role locally, after its legal review.
- **The owner.** Approves every promotion.

## The Loop

1. An agent acts and leaves a receipt.
2. Sage harvests the receipt and history, and proposes a lesson, a rule or a new
   test.
3. The checker reviews the proposal against the evidence; the judge answers its
   typed questions.
4. The owner approves or declines.
5. The change is applied with a version number.
6. The hidden tests run. If nothing got worse, the change stays; if something
   did, it rolls back.

## Five Uses Of Harvested Data, In Order

1. **Tests built from past mistakes (first).** Each fork becomes a test: given
   this situation, does the agent pick the option that worked?
2. **Lessons at decision time.** Matching entries are found with `search_local`
   (EmbeddingGemma) and handed to the agent before it chooses. Works with any
   model, including ones that cannot be retrained.
3. **Promoted rules.** A lesson that recurs becomes a proposed standing rule in
   an agent profile or the dispatcher, with owner approval.
4. **Routing.** Receipts show which route handled which kind of task and how it
   went; that tunes the dispatcher.
5. **Fine-tuning a local model (later).** Gated on enough data, the training
   filter below, and a terms check. Not before.

## Test Harness, Modeled On Jeff's Scoreboard

Jeff's Stage 1 scoreboard already had the right shape and is the template:

- Pass marks are locked before any candidate is scored.
- The hidden question set is written and held by a different agent from the one
  being built.
- Sources are fingerprinted; a missing or changed file makes the check refuse,
  never regenerate hashes or rewrite answers to pass.
- Tests used to teach and tests used to judge are kept apart.

## Records, Tags And The Training Filter

- **Every record carries a source tag:** Jev, OpenAI, Claude, a named local
  model, or the owner.
- **Jev's answers are live advice only.** The catalog records the checker's or
  owner's decision and that Jev advised, not Jev's answer text. This keeps True
  Convo's rule that Jeff never stores, learns from or copies Jev answers.
- **Training filter.** Anything used to train Jeff or a local model may contain
  only owner decisions and owner-approved local-model outputs. Jev, OpenAI and
  Claude outputs are excluded, because their terms may restrict training on
  them.
- This tagging and the "advice only" reading are the planning session's reading
  of the rule. They go into Jeff's legal review rather than being treated as
  settled.

## Fork Format

Entries keep the old template's sections (the fork, what we tried, what
happened, cost of the detour, current recommendation, sources) and add explicit
fields for the **chosen option**, the **rejected options** and the **reason**,
so every entry is ready for tests now and for preference-style training later.

## Guardrails

- Only lessons with cited evidence can be promoted; "(inference)" entries never
  are.
- Every promoted rule, test change and model change is versioned, listed where
  the owner can see it, and can be rolled back.
- Sage runs on a local model by default; the judge's paid providers stay capped
  and owner-approved, never a silent fallback.
- **Jeff stays private.** Until its legal review, Jeff lives on the subscription
  side. Open Convo's core loop must work without it, using local rules or a
  local model as the judge, with Jeff added on top for subscribers.
- No model trained on Sage data ships to other people before a terms check.

## Open Questions (Later)

- When conversations and dictation history may become Sage sources, and how the
  owner approves each one.
- Which local model fills the checker role on smaller Macs.
- How many entries are enough before fine-tuning is worth trying.
