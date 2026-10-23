#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertContrast, resolveBrand } from "./contrast.mjs";
import { SiteEngineError } from "./errors.mjs";
import { prepareImages } from "./images.mjs";
import { publishSite } from "./publish.mjs";
import { readFactsFile } from "./read-facts.mjs";
import { renderPage } from "./render.mjs";
import { validateFacts } from "./schema.mjs";

const USAGE = "Usage: node packages/site-engine/src/build.mjs --facts <facts.json> --out <folder>";

export async function buildSite(factsPath, outPath) {
  const outAbs = path.resolve(outPath);
  const { factsPath: factsAbs, facts: parsed } = await readFactsFile(factsPath);
  const facts = validateFacts(parsed);
  const colors = resolveBrand(facts.brand);
  assertContrast(colors);
  const images = await prepareImages(path.dirname(factsAbs), facts.images ?? []);
  const page = renderPage(facts, images, colors);
  await publishSite(
    outAbs,
    [
      { path: "index.html", contents: page.html },
      { path: "site.css", contents: page.css },
      { path: "sitemap.xml", contents: page.sitemap },
      { path: "robots.txt", contents: page.robots },
      ...images.map((image) => ({ path: image.src, contents: image.bytes })),
    ],
    factsAbs,
  );
}

function parseArgs(argv) {
  let facts = null;
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== "--facts" && arg !== "--out") throw new SiteEngineError(USAGE);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new SiteEngineError(USAGE);
    if (arg === "--facts") facts = value;
    else out = value;
    index += 1;
  }
  if (!facts || !out) throw new SiteEngineError(USAGE);
  return { facts, out };
}

async function main() {
  const { facts, out } = parseArgs(process.argv.slice(2));
  await buildSite(facts, out);
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    const message = error instanceof Error && error.message ? error.message : "Site Engine failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
