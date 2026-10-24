import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { SiteEngineError } from "./errors.mjs";

const MAX_FACTS_BYTES = 1_000_000;

async function readFacts(factsAbs) {
  let real;
  try {
    real = await realpath(factsAbs);
  } catch {
    throw new SiteEngineError("Facts file was not found.");
  }
  const info = await lstat(real);
  if (!info.isFile()) throw new SiteEngineError("Facts file is not a file.");
  if (info.size > MAX_FACTS_BYTES) throw new SiteEngineError("Facts file is too large.");
  return (await readFile(real)).toString("utf8");
}

// Size limit, file checks, and JSON parsing shared by the build and the diff.
// Returns the parsed object without validating the facts schema.
export async function readFactsFile(factsPath) {
  const factsAbs = path.resolve(factsPath);
  const raw = await readFacts(factsAbs);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new SiteEngineError("Facts file is not valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SiteEngineError("Facts file must be a JSON object.");
  }
  return { factsPath: factsAbs, facts: parsed };
}
