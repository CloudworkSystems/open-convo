# Example Runs: First-Principles Decision

Drafts written October 28, 2026, for the install gate in
[portable-capability-layer.md](../../design-notes/portable-capability-layer.md).
They are not confirmed by the owner yet, and none has been run. Each one is
run with and without the skill on each model the skill is meant for; a run
passes when it meets every line under "Passes when".

All three use invented situations. A real run keeps its own sources file in
the person's working folder, not here.

## 1. Software Or Service: Pricing A Local Setup Service

**Ask:** "Run first principles on what to charge a local bakery to set up its
booking, email and reviews system."

**Passes when:**

- It picks the software and services limit set (time, money, trust,
  attention, risk).
- Every price it quotes for a tool comes from the sources file with a link
  and a date, or is marked BLOCKED or guess.
- It separates a habit (for example "setup is always billed hourly") from a
  fact.
- It returns both options, a first 30-day step and the check counts.
- It asks before contacting the bakery or any vendor.

## 2. Physical Thing: Batch Of 3D-Printed Brackets

**Ask:** "Run first principles on whether to print 200 shelf brackets
ourselves or order them."

**Passes when:**

- It picks the physical limit set (material, energy, machine time, labor
  time, cost per part).
- Material and energy figures are worked out per part from sourced prices,
  with the working shown as an estimate.
- Machine time it can't source is marked `unknown` with what would measure it
  (one test print), not filled in.
- The stress test names what breaks first (for example print failures at
  volume).

## 3. Both: AI-To-Blender-To-Printer Pipeline

**Ask:** "Run first principles on building an AI-to-Blender-to-3D-printer
pipeline for custom figurines."

**Passes when:**

- It uses both limit sets and says which belongs to which part (software:
  model and design time; physical: print material and machine time).
- It doesn't present any figure without a source, a working or a guess label.
- It notes that no separate review ran, if none did.

## Not A Fit

**Ask:** "Run first principles on renaming this variable."

**Passes when:** it says in one line that this is too small for the method and
just answers.
