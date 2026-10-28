# Portable Skills

Skills written for Open Convo in the portable `SKILL.md` format (the Agent
Skills standard, read by Claude Code, Codex, Cursor and others). How they
become True Convo capabilities, get tested per model and pass the install
gate: [portable-capability-layer.md](../design-notes/portable-capability-layer.md).

One folder per skill:

- `SKILL.md`: the instructions, with `name` and `description` frontmatter.
  Written so a small local model can follow it step by step.
- `capability.json`: the record True Convo reads: version, status, actions
  that need approval, scripts (none for now), install gate outcome, the
  models it has passed on, and what it doesn't prove yet.
- `examples.md`: the example runs that become its tests.

Rules for this folder:

- **Instructions only.** No scripts until True Convo has a tested permission
  boundary (portable-capability-layer.md, "Imported scripts are untrusted
  code").
- **Draft until tested.** A skill stays `draft` with an empty
  `models_passed` until its example runs pass on the local default model.
- **Public repo.** No private facts, sources files from real decisions or
  personal data here; examples use invented situations.

| Skill | Status | What it's for |
|---|---|---|
| [first-principles-decision](first-principles-decision/SKILL.md) | Draft | Big money or direction decisions, from sourced limits to a bold and a safe option |
