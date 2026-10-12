import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyClarityLessonAction } from "../src/clarity-correction.mjs";
import { createClaritySessionStore } from "../src/clarity-session-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/clarity-correction.example.json"), "utf8"));
const scope = { ownerId: "fixture-owner", sessionId: "fake-session-clarity-001" };

test("session store returns an opaque reference and keeps the full record server-side", () => {
  const store = createClaritySessionStore({
    clock: () => Date.parse("2026-08-06T13:20:00.000Z"),
    idFactory: () => "opaque-proof-ref",
  });
  const created = store.create(structuredClone(fixture), scope);

  assert.equal(created.lesson_ref, "clarity-session-opaque-proof-ref");
  assert.equal(created.storage, "server_memory");
  assert.equal(created.persistent, false);
  assert.equal("record" in created, false);

  const firstRead = store.read(created.lesson_ref, scope);
  firstRead.working_lesson.guidance = "forged in caller";
  const secondRead = store.read(created.lesson_ref, scope);
  assert.notEqual(secondRead.working_lesson.guidance, "forged in caller");
});

test("session store refuses a valid reference under the wrong owner or session", () => {
  const store = createClaritySessionStore({ idFactory: () => "scope-proof" });
  const created = store.create(structuredClone(fixture), scope);

  assert.throws(
    () => store.read(created.lesson_ref, { ...scope, ownerId: "forged-owner" }),
    /not found for this owner and session/,
  );
  assert.throws(
    () => store.read(created.lesson_ref, { ...scope, sessionId: "other-session" }),
    /not found for this owner and session/,
  );
  assert.equal(store.read(created.lesson_ref, scope).id, fixture.id);
});

test("session store replaces the record only inside the same scope", () => {
  const store = createClaritySessionStore({ idFactory: () => "replace-proof" });
  const created = store.create(structuredClone(fixture), scope);
  const undone = applyClarityLessonAction(structuredClone(fixture), "undo");
  const metadata = store.replace(created.lesson_ref, undone, scope);

  assert.equal(metadata.persistent, false);
  assert.equal(store.read(created.lesson_ref, scope).status, "undone");
  const wrongIdentity = { ...structuredClone(undone), id: "other-correction" };
  assert.throws(() => store.replace(created.lesson_ref, wrongIdentity, scope), /identity cannot change/);
});

test("session store expires and discards temporary lessons", () => {
  let current = 1_000;
  const store = createClaritySessionStore({
    clock: () => current,
    idFactory: () => "expiry-proof",
    ttlMs: 100,
  });
  const created = store.create(structuredClone(fixture), scope);
  current = 1_101;
  assert.throws(() => store.read(created.lesson_ref, scope), /expired/);

  current = 2_000;
  const second = store.create(structuredClone(fixture), scope);
  store.discard(second.lesson_ref, scope);
  assert.throws(() => store.read(second.lesson_ref, scope), /not found/);
});
