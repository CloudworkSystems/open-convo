#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyCandidateMemoryAction,
  summarizeCandidateMemoryCard,
  validateCandidateMemoryCard,
} from "../src/candidate-memory-card.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = JSON.parse(
  fs.readFileSync(path.join(root, "fixtures/candidate-memory-card.example.json"), "utf8"),
);

validateCandidateMemoryCard(fixture);

const at = "2026-07-11T16:30:00.000Z";
const results = {
  keep: summarizeCandidateMemoryCard(
    applyCandidateMemoryAction(fixture, "keep", {
      actor: "owner",
      at,
      reason: "The proposed boundary is correct.",
    }),
  ),
  correct: summarizeCandidateMemoryCard(
    applyCandidateMemoryAction(fixture, "correct", {
      actor: "owner",
      at,
      reason: "Make the owner boundary explicit.",
      text: "Imported runtimes remain evidence until the owner explicitly promotes them through TCA.",
      durability: "core",
    }),
  ),
  forget: summarizeCandidateMemoryCard(
    applyCandidateMemoryAction(fixture, "forget", {
      actor: "owner",
      at,
      reason: "Do not retain this candidate.",
    }),
  ),
  park: summarizeCandidateMemoryCard(
    applyCandidateMemoryAction(fixture, "park", {
      actor: "owner",
      at,
      reason: "Potentially useful, but not now.",
    }),
  ),
};

console.log("Open Convo candidate memory proof");
console.log("");
console.log(JSON.stringify({ ok: true, fixture: true, results }, null, 2));
