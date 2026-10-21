# Foundations

## Why We Build This

**I built True Convo to put myself in the driver's seat of my own AI. Open
Convo is here to help you build your version.**

**The tool fits the person.** True Convo bends to how its owner works, not the
other way around. It augments people rather than replacing them: AI does the
work, the owner supplies the why.

*(Ideas from Douglas Engelbart's "Augmenting Human Intellect" and Gerald
Weinberg's tailor story in "The Psychology of Computer Programming", by way of
Jake Van Cleef's "What Do We Build Now That AI Can Do the Work?")*

## About This File

Written October 15, 2026 by the planning session, after the owner reviewed
every concept from earlier True Convo planning and decided what to keep. These
are the rules every module is built on. Plans in `docs/plans/` and notes in
`docs/design-notes/` must agree with this file; where one doesn't, this file
wins until the owner changes it.

"The owner" means the person whose True Convo it is. In a shared or
white-labeled install, each member is the owner of their own data.

## Principles

1. **Approval gates.** An approval covers exactly what it names. Spending,
   publishing, deploying, credentials, customer-facing changes, deletion and
   anything irreversible always stop for the owner. Silence is never consent.
   Routine low-risk actions (for example "lights off at night") can be approved
   once as a standing rule the owner can see and switch off.
2. **Truthful status words.** Planned, saved, built, checked, reviewed, tried
   and live are different claims. "Unknown" is said out loud, never rounded up.
   A green button or passing test isn't proof the work is done.
3. **Worker, checker, owner.** A worker's "done" is a claim. A separate checker
   verifies it and only the owner accepts. No agent holds two of these roles on
   the same piece of work.
4. **One authority per thing.** Every record has one source of truth (Git for
   code, the memory store for memory, the work record for work). Everything
   else is a view.
5. **Replaceable layers.** Role, persona, model, harness and session are
   separate. Swapping the model never changes who the owner is working with or
   what that assistant may do.
6. **Local first, visible cloud.** Work stays on the owner's machine by
   default. Each cloud model or host is approved once, with what will leave the
   machine shown first. No silent sending, no paid fallback; keys live in the
   system keychain.
7. **Fail closed, save first.** Save the idea before anything else. After an
   interruption, resume exactly or say plainly why not; never invent a
   replacement result.
8. **Plain English by default.** Plain words first, detail second, one new term
   at a time, and every question comes with a recommendation.
9. **Showing isn't permitting.** A suggestion isn't acceptance, a pin isn't
   priority, a folder isn't access, a green check isn't security.
10. **Act where the thought occurs.** From any conversation or item, the owner
    can capture the next action right there, and the new item remembers where
    it came from.
11. **No sprawl.** One folder and one name per product; replace, don't add.
    Building machinery instead of product is the known failure.
12. **Observed vs enforced.** A rule an agent agrees to follow is a commitment,
    not a wall. Nothing is called "enforced" or "sandboxed" without a real
    boundary and a test that it can't be bypassed.
13. **Relabel anything, change nothing underneath.** Modules, submodules and
    agent profiles can be renamed and moved; what they do and may do never
    changes with the name.
14. **Runs on whatever brain you have.** Work is split into small steps, and
    each profile uses only skills its model handles well, so True Convo keeps
    working on modest local models. A step too hard for a small model says so
    and offers an approved bigger one; it never fakes it.
15. **Your layout is yours.** The owner arranges modules and submodules (order,
    groups, pinned, hidden). The layout is the owner's data, travels with export
    and survives updates. Moving a module never changes permissions or moves
    data between spaces.
16. **Your own keys, cost near pass-through.** Cloud AI runs on the owner's own
    provider accounts, and True Convo helps set up the keys. Local models cost
    nothing extra.
17. **Durable sessions.** Every session has a lasting identity: its lifespan
    (it survives renames, model switches and crashes), its origin (what started
    it), provenance (who or what produced each message and result, and when)
    and direction (a visible purpose; drift is flagged with an offer to split
    into a linked session). Sessions are kept, encrypted and owned by the user.
18. **Code holds the process, agents fill the steps.** The order of work,
    checks, stop points and approvals is ordinary code that always runs the
    same way. AI works only inside bounded steps.
19. **A safety floor no edition can remove.** However a relabeled edition
    renames, hides or replaces features, every member keeps ownership and
    export of their data, approval before anything is spent or sent, and a view
    of what is shared with whom.

## Product Shape

- **Personal first.** The first value is a personal assistant that helps with a
  real daily task. Creator and business tools come after, inside goals the
  owner chooses.
- **Free, owner-controlled core.** Memory, identity, permissions, export and
  host choice are free and self-hostable. Optional advanced features may cost
  extra; the owner's history is never held hostage.
- **A personal operating system.** A readable export that works without the
  original account. Restore brings back information, never permission to act.
  AI can be switched fully off while manual use and export keep working.
- **Return to where you were.** Coming back shows an editable card with the
  goal, decisions and next step.
- **Attention first.** The home view leads with what needs the owner. It
  interrupts only when a decision is useful now, and any urgency cites its
  source.
- **Use what exists.** Before building something new, check tools the owner
  already uses and open-source options, and explain privacy, cost and upkeep.

## Memory

- **Library and desk.** Memory is the library; context is the desk. A new model
  sits at the same desk with the same library.
- **Explicit save first.** Nothing goes into memory until the owner chooses.
  Automatic filing may come later only as an opt-in setting.
- **Separate spaces.** Personal, one per business, and later Family. Nothing
  moves between spaces without a choice.
- **Context packages.** Each job gets a temporary, purpose-built selection that
  says why, for whom, how fresh and what's allowed, and is discarded after.
- **Labels stay separate.** A raw source, an owner-approved fact, an AI
  interpretation and a proposed action are always labeled apart.
- **Anything in, from anywhere.** Links, files, photos, the owner's own video
  clips and voice can be shared in from any app on the Mac or iPhone. They land
  as sources in a separate inbox and don't count as the owner's experience
  until acted on.
- **Every source gets the right handling, and the owner can change it.** A
  small judge model (Jev to start) looks at what came in and proposes how to
  process it: transcribe a video, pull the text and images from a page, read a
  receipt, describe a photo. It also proposes where the result might go. Every
  result comes back in the same shape: what it is, what was done to it, links
  to what the owner already has, and an "unchecked" label until the owner
  looks. Where it goes is only proposed, never filed on its own. When the owner
  corrects a choice, that correction becomes the default for that kind of
  source (the owner's correction is what's kept, not the judge's answer).
- **Assistant tuning is separate** from facts about the owner.
- **Bring an old conversation forward** as a summary that separates facts,
  decisions, open questions and stale parts; the owner picks what comes along.

## Agents

- **One visible assistant.** One customizable assistant is the character.
  Specialists are profiles behind it, hidden until suggested or chosen, and
  enabled only after a review of their access and cost.
- **Specialists come from real work.** A specialist profile is saved from work
  the owner actually repeats, never designed up front as an imagined team.
- **Powerful tools need a pass.** Granted to one approved profile, for one task,
  expiring and revocable.
- **"I'll remember" isn't a save.** An agent says exactly what it saved and
  where.
- **Ask another intelligence.** The owner can send one previewed question to
  another model or agent and get one answer back, labeled "unchecked," with a
  receipt and no standing access.
- **One last check before anything leaves.** Right space, right recipient,
  right tool, acceptable cost.

## Voice

- **Privacy mode always visible.** Local only, cloud live, or cloud cleanup at
  the end. The cloud is never the only option.
- **The microphone never surprises anyone.** It's always clear whether
  dictation or voice conversation is on, and the microphone never switches mode
  or starts listening on its own. Any wake word is detected on the device,
  nothing is kept or sent before it, a light shows when it is listening, there
  is a physical mute, and tap-to-talk is the default.
- **Speech and thinking fail separately.** If the AI model is down, dictation
  still works, and the reverse.
- **Dictation vs conversation.** Dictation puts editable text where the cursor
  is, including inside sessions. Voice conversation is a separate, hands-free
  mode.

## Modules And Surfaces

- **Umbrellas.** Modules group under a few umbrellas: Personal, Family,
  Business, Creator, Code and Agents. Each umbrella pairs with a memory space
  type: the space protects the data, the umbrella holds the tools. Each module
  has one default home, and the owner (or an edition) can move or remove it.
- **One set of modules, many surfaces.** The Mac Desk, the pill, the iPhone and
  a wall screen show the same modules, data and settings, each in a layout
  suited to that screen (a display profile per surface).
- **The outside-software ladder.** Outside software moves through reference,
  trial, optional tool, adapter, integration, dependency and core, each step
  decided. Work built on outside software can run for the owner in a middle
  zone, and is promoted into the distributed core only when it is stable and
  legally distributable (open source, licensed, or rebuilt as our own).

## How We Build

- **Look before building:** use, adapt, wrap or build fresh, in that order.
- **Proof ladder:** planned, proven in the repo, proven on invented data,
  signed, proven on a clean machine, proven with real users.
- **Start-safe check:** a new session working alongside others first decides
  "wait," "look only" or "safe to start."
- **Drift checkpoints:** stop regularly to ask whether the work has wandered,
  and list what a pass did not do.
- **Park ideas, don't chase them.** New ideas are captured in full, linked to
  what they depend on, and surface when those pieces exist; work returns to the
  current step.
- **Claim discipline:** public copy says only what is proven, separating "real
  now" from "being built."
