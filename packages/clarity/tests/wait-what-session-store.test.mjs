import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { repeatWaitWhatRepair } from "../src/wait-what.mjs";
import { createWaitWhatSessionStore } from "../src/wait-what-session-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(HERE, "../fixtures/wait-what.example.json"), "utf8"));

test("Wait—what? session store keeps full repair data server-side and scope-bound", () => {
  let clock = 1_000;
  const store = createWaitWhatSessionStore({
    clock: () => clock,
    idFactory: () => "opaque-repair",
    ttlMs: 500,
  });
  const scope = { ownerId: "fixture-owner", sessionId: "session-1" };
  const record = structuredClone(fixture);
  record.provenance.session_id = "session-1";
  const metadata = store.create(record, scope);
  assert.equal(metadata.repair_ref, "wait-session-opaque-repair");
  assert.equal(metadata.persistent, false);
  assert.equal("record" in metadata, false);
  assert.equal(store.read(metadata.repair_ref, scope).target.assistant_text, record.target.assistant_text);
  assert.throws(
    () => store.read(metadata.repair_ref, { ownerId: "fixture-owner", sessionId: "session-2" }),
    /not found/,
  );

  const repeated = repeatWaitWhatRepair(record, {
    at: "2026-08-06T15:01:00.000Z",
    mainPoint: "TCA stays in charge.",
    missingPremise: "The worker can change.",
    repitch: "TCA asks a replaceable worker to do the job while keeping your history.",
    concreteExample: "One dispatcher can send different drivers.",
  });
  store.replace(metadata.repair_ref, repeated, scope);
  assert.equal(store.read(metadata.repair_ref, scope).request.attempt, 2);

  clock = 2_000;
  assert.throws(() => store.read(metadata.repair_ref, scope), /expired/);
});
