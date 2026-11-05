import test from "node:test";
import assert from "node:assert/strict";
import { applyOperation, emptyState, read } from "../src/index.mjs";

const spaces = [{ id: "personal", name: "Personal", kind: "personal" }, { id: "studio", name: "Studio", kind: "business" }];
const now = "2040-01-01T00:00:00.000Z";
const run = (state, type, id, extra = {}) => applyOperation(state, { type, id, now, actor: "person", ...extra }).state;
const proposed = () => run(emptyState(spaces), "propose", "op-1", { actor: "helper", candidate: { id: "memory-1", text: "The invented character likes blue covers." } });
const kept = () => run(proposed(), "keep", "op-2", { candidateId: "memory-1", space: "personal", subject: "notebooks", label: { kind: "owner said", date: "2040-01-01" } });

test("proposals stay out of reads; keep, separation, sharing, and skip", () => {
  let state = proposed(); assert.equal(read(state, { space: "personal" }).length, 0); assert.equal(state.proposed[0].unconfirmedAgent, true);
  state = run(state, "keep", "op-2", { candidateId: "memory-1", space: "personal", subject: "notebooks", label: { kind: "owner said", date: "2040-01-01" } });
  assert.equal(read(state, { space: "personal" }).length, 1); assert.equal(read(state, { space: "studio" }).length, 0);
  state = run(state, "share", "op-3", { entryId: "memory-1", space: "studio" }); assert.equal(read(state, { space: "studio" })[0].origin, "personal");
  let other = run(emptyState(spaces), "propose", "x1", { candidate: { id: "x", text: "Invented." } }); other = run(other, "skip", "x2", { candidateId: "x" }); assert.equal(other.proposed.length, 0);
});

test("person-only operations refuse agents", () => {
  for (const type of ["keep", "skip", "correct", "forget", "restore", "undo", "share", "move", "allowCloud", "purge"])
    assert.throws(() => applyOperation(kept(), { type, id: `bad-${type}`, now, actor: "agent" }), /only be done by the person/);
});

test("labels, sensitive save, and cloud reads", () => {
  assert.throws(() => run(proposed(), "keep", "bad", { candidateId: "memory-1", space: "personal", subject: "notes" }), /exactly one label/);
  for (const label of [{ kind: "owner said" }, { kind: "agent's reading, kept" }, { kind: "from a source" }]) assert.throws(() => run(proposed(), "keep", `bad-${label.kind}`, { candidateId: "memory-1", space: "personal", subject: "notes", label }), /needs/);
  let state = run(emptyState(spaces), "propose", "p", { candidate: { id: "s", text: "Invented sensitive note.", sensitive: true } });
  assert.throws(() => run(state, "keep", "k", { candidateId: "s", space: "personal", subject: "notes", label: { kind: "from a source", link: "https://example.invalid/source" } }), /save: true/);
  state = run(state, "keep", "k", { candidateId: "s", space: "personal", subject: "notes", save: true, label: { kind: "from a source", link: "https://example.invalid/source" } });
  assert.equal(read(state, { space: "personal", cloud: true }).length, 0); state = run(state, "allowCloud", "a", { entryId: "s" }); assert.equal(read(state, { space: "personal", cloud: true }).length, 1);
});

test("correct, forget, restore, expiry, purge redaction, and dependencies", () => {
  let state = kept(); state = run(state, "correct", "op-3", { entryId: "memory-1", text: "The invented character likes green covers." });
  assert.equal(read(state, { space: "personal" })[0].history, undefined); assert.equal(state.subjects.personal.notebooks[0].history.length, 1); assert.throws(() => run(state, "undo", "u", { opId: "op-2" }), /op-3.*depends/);
  state = run(state, "forget", "op-4", { entryId: "memory-1" }); assert.equal(read(state, { space: "personal" }).length, 0);
  assert.throws(() => applyOperation(state, { type: "restore", id: "late", actor: "person", now: "2040-02-01T00:00:00.001Z", entryId: "memory-1" }), /30 days/);
  state = applyOperation(state, { type: "purge", id: "purge", actor: "person", now: "2040-02-01T00:00:00.001Z" }).state;
  const serialized = JSON.stringify(state); assert.equal(serialized.includes("blue covers"), false); assert.equal(serialized.includes("green covers"), false); assert.throws(() => run(state, "undo", "u2", { opId: "op-4" }), /cannot be undone/);
});

test("undo operation kinds", () => {
  let state = kept(); state = run(state, "allowCloud", "a", { entryId: "memory-1" }); state = run(state, "undo", "ua", { opId: "a" }); assert.equal(read(state, { space: "personal" })[0].cloud, false);
  state = run(state, "move", "m", { entryId: "memory-1", space: "studio" }); state = run(state, "undo", "um", { opId: "m" }); assert.equal(read(state, { space: "personal" }).length, 1);
  state = run(state, "share", "s", { entryId: "memory-1", space: "studio" }); state = run(state, "undo", "us", { opId: "s" }); assert.equal(read(state, { space: "studio" }).length, 0);
  state = run(state, "correct", "c", { entryId: "memory-1", text: "Changed invented text." }); state = run(state, "undo", "uc", { opId: "c" }); assert.match(read(state, { space: "personal" })[0].text, /blue/);
  state = run(state, "forget", "f", { entryId: "memory-1" }); state = run(state, "undo", "uf", { opId: "f" }); assert.equal(read(state, { space: "personal" }).length, 1);
});

test("invalid ids, duplicates, deterministic writes, and size limit", () => {
  for (const subject of ["../business/client", "INDEX", "index", "Work", "a.b", ""]) assert.throws(() => run(proposed(), "keep", `bad-${subject}`, { candidateId: "memory-1", space: "personal", subject, label: { kind: "owner said", date: "2040-01-01" } }), /Subject id/);
  const duplicateSpace = emptyState([{ id: "same", name: "A", kind: "personal" }, { id: "same", name: "B", kind: "business" }]); assert.throws(() => applyOperation(duplicateSpace, { type: "purge", id: "p", actor: "person", now }), /repeated/);
  const state = kept(); assert.throws(() => applyOperation(state, { type: "purge", id: "op-2", actor: "person", now }), /already in the log/);
  const duplicateLog = structuredClone(state); duplicateLog.log.push(structuredClone(duplicateLog.log[0])); assert.throws(() => applyOperation(duplicateLog, { type: "purge", id: "new", actor: "person", now }), /repeated in the log/);
  const duplicateRecord = structuredClone(state); duplicateRecord.proposed.push({ id: "memory-1", text: "Repeated invented item." }); assert.throws(() => applyOperation(duplicateRecord, { type: "purge", id: "new", actor: "person", now }), /Candidate or entry id.*repeated/);
  const a = applyOperation(proposed(), { type: "keep", id: "op-2", actor: "person", now, candidateId: "memory-1", space: "personal", subject: "notebooks", label: { kind: "owner said", date: "2040-01-01" } });
  const b = applyOperation(proposed(), { type: "keep", id: "op-2", actor: "person", now, candidateId: "memory-1", space: "personal", subject: "notebooks", label: { kind: "owner said", date: "2040-01-01" } }); assert.deepEqual(a, b);
  let huge = run(emptyState(spaces), "propose", "hp", { candidate: { id: "huge", text: "x".repeat(4090) } }); assert.throws(() => run(huge, "keep", "hk", { candidateId: "huge", space: "personal", subject: "notes", label: { kind: "owner said", date: "2040-01-01" } }), /subject is full/);
});
