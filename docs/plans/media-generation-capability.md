# Media Generation, The First Capability With Paid Routes (PRD)

Status: Draft (Nov 2, 2026): plan only, waiting on the owner's yes; nothing is built.

Written November 2, 2026 by a Claude session (project "261024 OC
Steering", thread "Plan media generation as a portable capability"), from
the owner's handoff of the same day out of the websites project. Session
name: `OC-261102-media-capability`. Umbrella: Creator, used by Business
(Site Engine). **Builder:** parts 1 to 3 stand on their own and can go to an
outside builder (AGENTS.md "Outside Builders") or a Claude building session;
parts 4 to 6 touch the Mac app and go to a Claude building session, label
`agent: claude`. **Reviewers:** Codex on every commit, plus the usual
independent review (GrokBot, or a fresh Claude review that didn't build it).
**Finish line:** the owner trial in part 6 passes in True Convo Test.

Background: [portable-capability-layer.md](../design-notes/portable-capability-layer.md),
[capabilities-and-primitives.md](../design-notes/capabilities-and-primitives.md),
[site-engine.md](../design-notes/site-engine.md),
[verified-owner-yes.md](../design-notes/verified-owner-yes.md) and
foundations principles 1, 6, 12, 14, 16 and 18.

## What The Owner Decided (November 2, 2026)

1. **Paid media is never mandatory.** Making an image or a video is one
   capability with several routes, and the person picks one: their own
   pay-as-you-go key (for example fal, kie or Replicate), sign-in with the
   provider only where the provider's terms allow it, a free local model on
   their own machine (for example Wan or LTX-Video), or uploading a clip they
   made themselves.
2. **It is not a Claude-only skill.** It lives in the portable capability
   layer, so any model running in True Convo, including a local one, can use
   it the same way.
3. **The website project's paid clips are separate.** The websites repo may
   spend a little on a few clips for the site that sells True Convo, through a
   one-off script with a hard cap. That is not the product path, and nothing
   in this plan copies it.

## Answers To The Four Steering Questions

### 1. Where the layer sits, and what a capability declares

The layer is ordinary code on the person's own machine, in
`packages/capabilities` (the planned home of True Convo's
`tools/capability-adapter`; PLAN.md "Bring with step 6"). It is not a model,
a prompt or a skill. Models reach each capability as one tool, through the
same tools-only MCP server and JSON command the adapter already uses, so a
local model, Claude or ChatGPT all call it the same way. The code, not the
model, picks up the route the person chose, checks the cap, asks for
approval, runs the job, keeps the receipt and writes the log (principle 18;
"Guardrails never move into a model").

Each capability ships a `capability.json` record. Today's record for skills
(`docs/skills/*/capability.json`) gains the fields below; one format serves
both, so a skill that grows a runner doesn't change shape.

| Field | What it says |
|---|---|
| `id`, `version`, `status`, `title` | As today |
| `inputs` | Typed fields, for example `kind` (image or video), `prompt`, `seconds`, `width`, `height`, `reference_files`. Each has a limit. |
| `outputs` | What comes back and where it lands: a file in the person's media folder plus a receipt (below). |
| `routes` | The ways it can run. Each route declares the fields in the next table. |
| `recipe` | Optional `SKILL.md` that helps a model fill the inputs well (prompt writing, shot length). The recipe never runs anything. |
| `actions_needing_approval`, `models_passed`, `not_proven`, `install_gate`, `credit` | As today |

Each route declares:

| Field | What it says |
|---|---|
| `kind` | `upload`, `local`, `own_key` or `sign_in` |
| `provider`, `model` | Who runs it, and which model |
| `hosts` | Every outside host it contacts. Empty for `upload` and `local`. A host here is held by the risk review like any other ([risk-review.md](risk-review.md)). |
| `leaves_machine` | Plain words on exactly what is sent (for example "your prompt text and the one reference picture you attach"). `nothing` for `upload` and `local`. |
| `cost` | How the price is worked out (per second, per image, per credit), the price used, its source and the date it was checked, and a `max_per_run` the code computes before running. The recorded price is only for showing a rough figure in settings; it never authorizes a run (see "The price is checked again" below). `free` for `upload` and `local`. |
| `needs` | What the machine needs (memory, disk, model files to download, a local server such as ComfyUI) |
| `terms` | For `sign_in` only: a link to the provider's terms that allow third-party apps to use the sign-in this way, and the date checked. No link, no route. |
| `license` | For `local` only: the model's license, checked before adoption, and whether it allows the person's intended use |

`upload` is always present and always works. It is the floor that makes
paid media optional in fact, not just in name.

### 2. Seeing the cost first, and a cap no model can raise

**Before a paid run** the person sees one card, drawn by the app from the
request itself, never from words a model supplies: what will be made, which
route, what leaves the machine, the most it can cost ("up to $0.40"), what is
left under the cap after it, and the free routes as other choices. A batch is
one card covering the exact batch and its total maximum. Nothing paid runs
without this card and its yes (principle 1: spending always stops).

**The cap** has three levels, all in the person's own currency:

- a most-per-run,
- a monthly limit per capability,
- one monthly limit across all paid capabilities.

The starting value of every cap is **$0**, so every paid route is off until
the person sets a cap. Lowering a cap or pausing paid routes takes effect at
once and needs nothing more.

**Raising a cap needs the person, proven, not just a message.** The cap is
kept as a small record on the Mac, signed by a key the Mac keeps in its
Secure Enclave that only signs after the person's own Mac password, Touch ID
or Face ID (a system prompt the app can't fill in). The capability runner
reads the record and refuses any cap whose signature doesn't check out. So:

- a model, a skill or an agent with shell access can't raise the cap: it can't
  make the signature, and an edited record fails the check;
- a deleted or broken record means a $0 cap (fail closed, principle 7);
- later, the iPhone yes in [verified-owner-yes.md](../design-notes/verified-owner-yes.md)
  can sign a raise too, using the same check.

This is called *enforced* only once part 2 ships a test showing that an
agent running as the same user can't raise the cap, and can't reset the
ledger below (principle 12). Until then it is described as designed, not
enforced.

**The price is checked again just before each paid run.** A price recorded
in the route can go stale. So a paid route runs only when, immediately
before sending, the runner can get a maximum that holds for this request
from the provider itself: a quote for this exact request, or a request
field that tells the provider to refuse or stop anything above a set amount.
That maximum is what the card shows, what the ledger reserves, and what is
sent with the request. If the runner can't get one, the route isn't offered
for paid runs. If a provider later bills more than the approved maximum, the
receipt says so in plain words, the route is switched off until the person
looks, and the extra counts against the cap.

**The ledger.** Before each paid run the runner reserves the run's maximum
against the caps, and refuses if it doesn't fit. After the run it records
the actual cost when the provider reports it, or keeps the estimate marked
"estimated" when it doesn't. Unknown stays unknown on screen (principle 2).
The ledger and caps live on the device, travel with export, and never depend
on GitHub or any True Convo server.

**The ledger can't be wound back.** Each entry is chained to the one before
by a hash, and the latest chain head and entry count are kept in a Keychain
item that only the signed capability runner may change (the Keychain's
per-app access list). A ledger that is missing, edited, or older than that
head is treated as fully spent for the month: paid routes stop and the
person is told why, until they confirm a reset with the same Mac password
prompt used to raise a cap. Part 2's bypass test covers deleting, editing
and restoring an older ledger, as well as editing the cap. Where the
provider reports usage for the key, the runner also compares the month's
total with it and takes the higher figure.

**A second wall at the provider.** Key setup recommends the provider's own
protection: prepaid credit with auto-reload off, or the provider's spending
limit where it has one. Our cap protects against our mistakes; theirs
protects against everything else.

**Keys** live in the Keychain, readable only by the capability runner, never
handed to a model (principle 6, "keys live in the system keychain").

### 3. Visible cloud: the same rule, plus a yes for each spend

Yes, the chat rule applies unchanged: each cloud host is approved once, with
what will leave the machine shown first (principle 6, and
agent-profiles-and-adapters.md "nothing is sent ... until the owner has
approved that model and host once"). Media adds one thing chat doesn't have:
every paid run also gets its own yes on the cost card above, because
spending always stops for the owner (principle 1). A host approval is never a
spending approval.

The card's buttons are "Make it (up to $0.40)" and "Not now", with the free
routes listed beside them. There is no "always allow" for paid runs; a
standing rule can cover only free routes (principle 1, routine low-risk
actions).

`local` and `upload` routes send nothing, so they need no host approval.
A local model that downloads its files does so once, as its own approved
step, showing the size and where they come from.

### 4. Is Site Engine the first user, and does it drive the layer?

Site Engine is the first module that will **use** media. It should not
**shape** the layer. The websites project's own lessons
(cloudwork-sites `docs/site-engine-lessons.md`, on its branch
`claude/project-thread-uqecyb`, not merged yet) found that for a product
site, drawn screens beat stock or AI footage, and video earns its place only
for atmosphere. So Site Engine needs media the least of the modules that will
want it (Convo Engine and creator work need it more). And the layer's shape
comes from what every capability needs: a contract, routes, a cost check, a
cap and a receipt. Media is the right first capability because it is the
first with paid routes, which forces the cap and ledger to be real.

When to build it: see "When To Build" below.

## What It Does

```
make_media(kind, prompt, seconds?, width?, height?, reference_files?, route?)
  -> { file, receipt }
```

- With no `route`, the runner offers the routes the person has set up,
  free ones first, and the person picks. A model can suggest a route; it can
  never pick a paid one by itself.
- **Upload:** the person picks a file they made. The runner checks its type
  and size, copies it to the media folder and writes a receipt.
- **Local:** the runner sends the job to a local server on the same machine
  (ComfyUI first, since Wan and LTX-Video both run there), shows progress and
  a time estimate, and can be cancelled.
- **Own key:** the cost card, then the call, then the receipt with the actual
  cost.
- **Sign-in:** only for a provider whose terms allow it (route field `terms`).
  None is known yet, so this route ships empty.

**The receipt**, saved beside each file: route, provider and model, the
prompt, what left the machine, the cost (actual or estimated), the time, and
"made by AI" for every route except upload. Site Engine's honesty gate reads
that label, so AI footage on a person's site is never passed off as filmed.

## Not In This Plan

- The websites repo's one-off paid clip script (owner decision 3).
- Audio, voice and music. Voice belongs to Convo Engine.
- Editing, cutting or joining clips.
- Picking a default paid provider for anyone.
- Sharing or publishing media; Publish keeps its own approval.

## The Parts

1. **Capability contract.** `packages/capabilities`: the `capability.json`
   schema above, a validator, and tests on invented records. The existing
   `first-principles-decision` record must still validate. Stands alone.
2. **Cap and ledger.** Signed cap records, the three cap levels, reserve and
   settle, $0 when missing or broken, and the bypass test from question 2
   (signing is faked with a test key here; the real Secure Enclave key comes
   in part 4). Stands alone.
3. **`make_media` with `upload` and `local` routes.** The runner, receipts,
   and a ComfyUI route tested against a fake local server. No outside host.
   Stands alone.
4. **Mac: cap settings, Secure Enclave signing, cost card and route picker.**
   Touches Keychain and key code, so it needs the owner's approval on GitHub
   (`.github/CODEOWNERS`).
5. **One `own_key` route,** for a provider the owner picks when this part
   starts. Adds an outside host, so the risk review holds it for the owner.
   Off until the person sets a cap.
6. **Owner trial** (below).

## When It Goes Wrong

The screens are the route picker, the cost card and the cap settings
([when-it-goes-wrong.md](when-it-goes-wrong.md)).

1. **No connection.** A paid route offline says so before any charge and
   offers the local and upload routes. A local server that isn't running says
   which one and how to start it. Nothing is retried in the background.
2. **Interrupted.** A paid run in flight when the app quits keeps its
   reservation and its provider job number. On the next launch the runner
   asks the provider for that job's result once, never sends it again, and
   says plainly whether a file came back and what was charged. A local run is
   simply marked stopped.
3. **Empty or first run.** With nothing set up, the picker shows Upload (ready)
   and two set-up choices: a local model, or your own key. Paid routes show
   "Set a cap first" while the cap is $0.
4. **Denied or stuck.** If the password or Touch ID prompt for raising a cap
   is refused or closed, the old cap stays and the screen closes normally.
   When a cap is reached, the card says how much is used, offers the free
   routes, and says raising it needs your Mac password.
5. **The error message.** Plain words for what happened, what was charged
   (or "nothing was charged"), and the next step, for example "Your fal key
   was refused. Nothing was charged. Check the key in Settings, or make it on
   this Mac instead."

## Owner Trial (Part 6)

In True Convo Test, with invented prompts:

1. Make a short clip by upload; the receipt shows no cost and no AI label.
2. Make a short clip with a local model; nothing leaves the Mac (checked with
   the app's network log), and the receipt says "made by AI".
3. With the cap at $0, the paid route shows "Set a cap first".
4. Set a $1 monthly cap (the Mac password prompt appears). Make one paid clip:
   the card shows the most it can cost first, and the receipt shows the cost.
5. Ask a model in a conversation to raise the cap: it can't, and says why.
6. A paid run that would go over the cap is refused before anything is sent.
7. Quit mid-run on a paid clip; the next launch says what came back and what
   was charged, and doesn't charge twice.
8. Turn the network off; the paid route says so and offers the free ones.
9. With the local server not running, the local route names it and says how
   to start it.
10. Quit mid-run on a local clip; the next launch marks it stopped.
11. With nothing set up (a fresh test profile), the picker shows Upload as
    ready and the two set-up choices, and the paid route says "Set a cap
    first".
12. Start raising the cap and cancel the password prompt; the old cap stays
    and the screen closes normally.
13. Reach the cap; the card says how much is used, offers the free routes,
    and says raising it needs your Mac password.
14. Use a refused key (an invented one); the message says what happened,
    "Nothing was charged", and the next step.
15. Replace the ledger file with an older copy; paid routes stop and say
    why.

## When To Build

Parts 1 to 3 stand on their own and start now, beside the main build. Step 6
is still several steps away (steps 2 and 3 are in their owner trials, then
the Claude Code adapter, Canvas, steps 4 and 5), and the cap and ledger are
needed by step 6's paid judge anyway. The owner leaned this way on November
2 in this thread; the PLAN.md line in this pull request records it and
needs his approval on GitHub. Parts 4 to 6 wait for the Mac work in step 6.
