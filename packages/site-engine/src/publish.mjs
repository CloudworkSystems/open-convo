import { randomBytes } from "node:crypto";
import { lstat, mkdir, rename, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { SiteEngineError } from "./errors.mjs";

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function publishSite(outPath, files, factsPath) {
  const parent = path.dirname(outPath);
  let parentInfo;
  try {
    parentInfo = await lstat(parent);
  } catch {
    throw new SiteEngineError("Output folder's parent was not found.");
  }
  if (!parentInfo.isDirectory()) {
    throw new SiteEngineError("Output folder's parent is not a folder.");
  }

  const realParent = await realpath(parent);
  const destination = path.join(realParent, path.basename(outPath));
  if (!path.basename(destination) || destination === path.parse(destination).root) {
    throw new SiteEngineError("Output folder must be a named folder.");
  }
  const factsReal = await realpath(factsPath).catch(() => null);
  if (!factsReal) throw new SiteEngineError("Facts file was not found.");
  if (isInside(destination, factsReal)) {
    throw new SiteEngineError("Output folder cannot contain the facts file.");
  }

  let existing = null;
  try {
    existing = await lstat(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw new SiteEngineError("Output folder could not be opened.");
  }
  if (existing?.isSymbolicLink()) throw new SiteEngineError("Output path is a symbolic link.");
  if (existing && !existing.isDirectory()) {
    throw new SiteEngineError("Output path is a file, not a folder.");
  }

  const scratch = await createScratch(realParent);
  let published = false;
  try {
    for (const file of files) {
      if (file.path.includes("\\") || path.isAbsolute(file.path)) {
        throw new SiteEngineError("Output folder could not be written.");
      }
      const target = path.join(scratch, file.path);
      if (!isInside(scratch, target)) throw new SiteEngineError("Output folder could not be written.");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.contents);
    }
    await replaceDirectory(scratch, destination, existing !== null);
    published = true;
  } catch (error) {
    if (!published) await rm(scratch, { recursive: true, force: true });
    if (error instanceof SiteEngineError) throw error;
    throw new SiteEngineError("Output folder could not be written.");
  }
}

async function createScratch(parent) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const scratch = path.join(parent, `.site-engine-build-${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(scratch);
      return scratch;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  throw new SiteEngineError("Output folder could not be written.");
}

// The previous folder is moved aside, the new folder takes its name, and only
// then is the previous folder deleted. A failure in the middle moves the
// previous folder back. The swap is two renames on the same parent, so a
// failed build does not leave a half-written site in the output path.
async function replaceDirectory(scratch, destination, hadExisting) {
  const backup = path.join(
    path.dirname(destination),
    `.site-engine-previous-${randomBytes(8).toString("hex")}`,
  );
  let movedAside = false;
  try {
    if (hadExisting) {
      await rename(destination, backup);
      movedAside = true;
    }
    await rename(scratch, destination);
    movedAside = false;
  } catch {
    if (movedAside) await rename(backup, destination).catch(() => {});
    throw new SiteEngineError(
      "Output folder could not be replaced. The previous folder was left in place.",
    );
  }
  if (hadExisting) await rm(backup, { recursive: true, force: true }).catch(() => {});
}
