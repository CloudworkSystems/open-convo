import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { SiteEngineError } from "./errors.mjs";

const MARKER_FILE = "site-engine.txt";
const MARKER_TEXT = "Built by Open Convo Site Engine.\n";

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export async function publishSite(outPath, files, factsPath, options = {}) {
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
  if (existing?.isDirectory()) await assertEarlierBuild(destination);

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
    await writeFile(path.join(scratch, MARKER_FILE), MARKER_TEXT);
    if (options.beforeReplace) await options.beforeReplace(destination);
    await replaceDirectory(scratch, destination, existing !== null);
    published = true;
  } catch (error) {
    if (!published) await rm(scratch, { recursive: true, force: true });
    if (error instanceof SiteEngineError) throw error;
    throw new SiteEngineError("Output folder could not be written.");
  }
}

async function assertEarlierBuild(directory, displayName = path.basename(directory)) {
  let names;
  try {
    names = await readdir(directory);
  } catch {
    throw new SiteEngineError("Output folder could not be opened.");
  }
  if (names.length === 0) return;

  const markerPath = path.join(directory, MARKER_FILE);
  let info;
  try {
    info = await lstat(markerPath);
  } catch {
    refuseUnmarked(displayName);
  }
  if (info.isSymbolicLink() || !info.isFile()) refuseUnmarked(displayName);
  const markerLength = Buffer.byteLength(MARKER_TEXT);
  if (info.size !== markerLength) refuseUnmarked(displayName);
  await readExactMarker(markerPath, markerLength, displayName);
}

function refuseUnmarked(displayName) {
  throw new SiteEngineError(`Output folder is not an earlier Site Engine build: ${displayName}`);
}

async function readExactMarker(markerPath, markerLength, displayName) {
  let handle;
  try {
    handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    refuseUnmarked(displayName);
  }
  try {
    const buf = Buffer.alloc(markerLength);
    const { bytesRead } = await handle.read(buf, 0, markerLength, 0);
    if (bytesRead !== markerLength || buf.toString("utf8") !== MARKER_TEXT) refuseUnmarked(displayName);
  } catch (error) {
    if (error instanceof SiteEngineError) throw error;
    refuseUnmarked(displayName);
  } finally {
    await handle.close();
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

// The previous folder is moved aside and checked again before the new folder
// takes its name. A folder that is no longer an earlier build is moved back.
// The swap is two renames on the same parent, so a failed build does not leave
// a half-written site in the output path.
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
      const moved = await lstat(backup);
      if (!moved.isDirectory()) refuseUnmarked(path.basename(destination));
      await assertEarlierBuild(backup, path.basename(destination));
    }
    await rename(scratch, destination);
    movedAside = false;
  } catch (error) {
    if (movedAside) {
      try {
        await rename(backup, destination);
      } catch {
        throw new SiteEngineError(
          "Output folder could not be replaced. The previous folder was left in place.",
        );
      }
    }
    if (error instanceof SiteEngineError) throw error;
    throw new SiteEngineError(
      "Output folder could not be replaced. The previous folder was left in place.",
    );
  }
  if (hadExisting) await rm(backup, { recursive: true, force: true }).catch(() => {});
}
