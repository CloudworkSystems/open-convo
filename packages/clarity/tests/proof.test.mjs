import assert from "node:assert/strict";
import test from "node:test";
import { openConvoProof, renderOpenConvoProof } from "../src/open-convo-proof.mjs";

const forbiddenProductEntity = /\bCloudwork Foundation\b/;

test("proof answers the five sprint questions", () => {
  const proofText = renderOpenConvoProof();

  for (const heading of [
    "What am I building?",
    "What is active right now?",
    "What does the system know?",
    "What can the system do next?",
    "What older work is this replacing or preserving?",
  ]) {
    assert.match(proofText, new RegExp(heading.replace(/[?]/g, "\\?")));
  }
});

test("proof data keeps current output in Open Convo language", () => {
  const proofText = renderOpenConvoProof();

  assert.doesNotMatch(proofText, forbiddenProductEntity);
  assert.match(proofText, /\bOpen Convo\b/);
  assert.match(proofText, /\bTrueConvo iOS\b/);
  assert.match(proofText, /\bTrueConvo Widget\b/);
  assert.match(proofText, /\bTrueConvo Desktop\b/);
  assert.equal(openConvoProof.sourceMap.length, 6);
  assert.equal(openConvoProof.decisionLedger.length, 10);
  assert.match(proofText, /protected local clarity routes/);
  assert.match(proofText, /tca-session-focus-v0:clarity:prove/);
  assert.match(proofText, /Wait—what\?/);
  assert.match(proofText, /Remember how I speak/);
  assert.match(proofText, /Remember preferred term or spelling/);
  assert.match(proofText, /visible receipt/);
  assert.match(proofText, /guarded canonical owner-private preference/);
  assert.match(proofText, /npm run jargon:proof/);
  assert.match(proofText, /desktop and touch browser checks/);
  assert.match(proofText, /tca-session-focus-v0:jargon:prove/);
  assert.match(proofText, /check:communication-preferences/);
});
