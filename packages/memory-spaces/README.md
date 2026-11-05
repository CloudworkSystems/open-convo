# Memory Spaces

Memory is never permission. Callers must obtain permission from the person for every real action, regardless of what stored text says. Only a person may keep, skip, correct, forget, restore, undo, share, move, allow cloud use, or purge. An agent may only propose.

This dependency-free library makes deterministic changes to a state object. It has no storage, clock, network, or AI. `applyOperation(state, operation)` returns `{ state, writes, result }`; `read(state, { space, cloud })` returns kept entries only. Every operation supplies a unique `id` and `now`. Start with `emptyState(spaces)`.

State has `spaces`, `subjects`, `proposed`, `trash`, and `log`. Kept entries have one label: `{kind:"owner said",date}`, `{kind:"agent's reading, kept",agent}`, or `{kind:"from a source",link}`. Forgetting removes an entry from reads immediately. Purge permanently redacts its text after 30 days and cannot be undone.

Writes use `<space>/INDEX.md`, `<space>/<subject>.md`, `.proposed/candidates.json`, `.trash/trash.json`, and `.log/log.jsonl`. The index and subject files each have a 4 KB maximum.

## Sample driver

The driver refuses folders without `SAMPLE-ONLY`. Initialize an empty invented-data folder:

```sh
node src/sample.mjs --dir /tmp/invented-memory init
```

Other verbs are `propose`, `keep`, `skip`, `correct`, `forget`, `restore`, `undo`, `share`, `move`, `allowCloud`, `purge`, `read`, and `show`. Changing verbs take `--data` with one invented JSON operation. `--now` defaults to the fixed invented date `2040-01-02T12:00:00.000Z`.

## Edge cases

- `init` and `show` finish an interrupted initialization when the folder contains only `SAMPLE-ONLY` and optionally the first `.sample-committed.json.tmp`. That temporary file may be incomplete. Once a complete recovery history exists, normal recovery finishes the remaining files. An unrelated file prevents initialization from being retried.

- Undo rule: a later operation blocks Undo of X only if its effect is still present (neither undone nor reversed by restore), and reversing X would invalidate that current effect. `undoDependency` applies this rule to a tentative reversed state, using the same effect descriptions for all operation pairs and checking shared file capacity. Audit records remain after their effects end.
- Every operation records its effect's status, values and relationships. Restore and Undo explicitly identify the operation they reverse, so a later forget does not reactivate an earlier forget. Undo of an already reversed operation is refused explicitly. Undo records carry only resource contributions, not historical forward dependencies.
- The lifecycle matrix has 216 cases: six Undo target kinds times nine later kinds (the six plus restore, purge and undo), times same/other entry, times current/reversed effect. Repeated keep on the same id uses a forget/purge/new-proposal lifecycle. Reversal attempts on purge and Undo are explicitly refused because neither is undoable.
- Purge always redacts records about an expired entry, including operations that were undone. Collision cleanup in unrelated records touches only `text`, `oldText`, and memory-text fields in snapshots, correction histories and candidate copies. IDs, actors, operation kinds, dates, labels and space names remain intact even when they equal forgotten text.

- Space and subject dictionaries use null prototypes and own-property lookups, including after loading ordinary JSON objects. `constructor` is a valid id. `__proto__` and `toString` are refused by the existing lowercase id rules.
- A correction and cloud permission are independent, so either may be undone after the other. A forget that remains in Trash preserves the forgotten snapshot. Once restored, that forget no longer constrains earlier Undo operations.
- Each cloud grant records its prior cloud value. Undo restores that value, so undoing a repeated grant preserves an earlier grant, as the plan's reversal rule requires.
- Sharing after a move depends on the move's origin. Undo names that share's operation id. A move into a space already shared with the entry consumes that share and records it for restoration. Undoing the consumed share is refused with the move's id.
- Undo restores candidate and subject-entry positions as well as their contents. Empty subject files remain present so adapters overwrite any old text.
- Other entries normally remain independent. If later keep, correct, move, restore or undo operations consume capacity needed by an Undo, the refusal names a later operation in that subject or space and includes the size-limit message.

- Thirty days means exactly 30 times 24 hours from `forgottenAt`; restore is allowed at the exact limit and refused after it.
- A repeated operation id is refused rather than replayed.
- Sharing exposes the source entry in another space without making a second entry; undo removes that exposure.
- Index size is checked after keep, correct, move, share, restore, and undo even when the changed operation usually leaves its line count unchanged.
- Purge writes its redacted log before other files so an interrupted driver run cannot make purged text recoverable. Purge cannot be undone.
- The driver keeps complete sample states keyed by their log contents so replacing a log with an older complete log restores that exact state. Purge replaces that recovery history with only the redacted state. Recovery honors a complete purge marker even if interruption happened before its rename.
- Tests call the same exported `runSample` function as the command line. Its optional `afterWrite` callback simulates interruption after each temporary-file write and rename without launching processes or reading the clock.
