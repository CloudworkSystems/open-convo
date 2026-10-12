#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyCommunicationPreferenceAction,
  rememberHowISpeak,
  summarizeCommunicationPreference,
} from "../src/communication-preference.mjs";
import { createCommunicationPreferenceProofStore } from "../src/communication-preference-store.mjs";
import { repeatWaitWhatRepair, summarizeWaitWhatRepair, validateWaitWhatRepair } from "../src/wait-what.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const waitFixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures/wait-what.example.json"), "utf8"));
const clarityFixture = JSON.parse(fs.readFileSync(path.join(root, "fixtures/clarity-correction.example.json"), "utf8"));

validateWaitWhatRepair(waitFixture);
const repeated = repeatWaitWhatRepair(waitFixture, {
  actor: "fixture-owner",
  at: "2026-08-06T14:01:00.000Z",
  mainPoint: "TrueConvo should not be trapped by one tool.",
  missingPremise: "The tool doing a job today may not be the best tool tomorrow.",
  repitch: "TrueConvo asks for the result it needs. Another small part chooses which tool can deliver that result today.",
  concreteExample: "It is like asking for a ride without promising that every ride must use the same car forever.",
});

const remembered = rememberHowISpeak(clarityFixture, {
  signal: "remember_how_i_speak",
  ownerId: "fixture-owner",
  at: "2026-08-06T15:00:00.000Z",
}, { idFactory: () => "fixture-clarity-preference" });
const rememberedAfterWait = rememberHowISpeak(repeated, {
  signal: "remember_how_i_speak",
  ownerId: "fixture-owner",
  at: "2026-08-06T15:00:00.000Z",
}, { idFactory: () => "fixture-wait-preference" });

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "open-convo-jargon-proof-"));
const filePath = path.join(tempDirectory, "preferences.json");
let result;
try {
  const store = createCommunicationPreferenceProofStore({ filePath, proofOnly: true });
  const created = store.create(remembered);
  const reopened = createCommunicationPreferenceProofStore({ filePath, proofOnly: true });
  const loaded = reopened.read(remembered.id);
  const tuned = applyCommunicationPreferenceAction(loaded, "tune", {
    actor: "fixture-owner",
    at: "2026-08-06T15:05:00.000Z",
    statement: "Use ordinary wording first. Define the technical term only if it is needed.",
    preferredWording: "give this part the tool it needs",
  });
  reopened.replace(tuned, { expectedVersion: 1 });
  const undone = applyCommunicationPreferenceAction(tuned, "undo", {
    actor: "fixture-owner",
    at: "2026-08-06T15:10:00.000Z",
  });
  reopened.replace(undone, { expectedVersion: 2 });

  result = {
    ok: true,
    fixedDataOnly: true,
    waitWhat: {
      first: summarizeWaitWhatRepair(waitFixture),
      repeated: summarizeWaitWhatRepair(repeated),
    },
    rememberHowISpeak: {
      fromSelectedText: summarizeCommunicationPreference(remembered),
      fromWholeMessageRepair: summarizeCommunicationPreference(rememberedAfterWait),
      store: created,
      tuned: summarizeCommunicationPreference(tuned),
      undone: summarizeCommunicationPreference(reopened.read(remembered.id)),
    },
    boundaries: {
      realBrainWrite: false,
      sharedMemoryWrite: false,
      externalAction: false,
      rawConversationStored: false,
      proofFileRemovedAfterRun: true,
    },
  };
} finally {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
}

console.log("TrueConvo three-action jargon clarity proof: PASS");
console.log("");
console.log(JSON.stringify(result, null, 2));
