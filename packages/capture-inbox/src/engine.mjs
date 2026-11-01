import { CLIP_BYTES, CLIP_TYPES, ONLY_MEDIA, SCHEMA_VERSION } from './errors.mjs';
import { clipTitle, nameProblem, readTextItem } from './link.mjs';
import { validateDrop } from './validate.mjs';

function compareId(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function compareEntry(a, b) {
  if (a.addedAtMs < b.addedAtMs) return -1;
  if (a.addedAtMs > b.addedAtMs) return 1;
  return compareId(a.id, b.id);
}

function readClip(item) {
  const file = item.file;
  if (!CLIP_TYPES.has(file.type)) return { error: ONLY_MEDIA };
  if (file.sha256 === null) return { error: 'A clip needs a sha256 of its bytes.' };
  if (file.sizeBytes > CLIP_BYTES) return { error: 'The clip is larger than 8 GB.' };
  return {
    sourceKey: `clip:${file.sha256}`,
    title: clipTitle(item.name),
    file: { sizeBytes: file.sizeBytes, type: file.type, sha256: file.sha256 },
  };
}

function toSource(entry) {
  if (entry.kind === 'link') {
    return {
      id: entry.id,
      kind: 'link',
      sourceKey: entry.sourceKey,
      site: entry.site,
      url: entry.url,
      title: entry.title,
      addedAt: entry.addedAt,
    };
  }
  return {
    id: entry.id,
    kind: 'clip',
    sourceKey: entry.sourceKey,
    title: entry.title,
    addedAt: entry.addedAt,
    file: entry.file,
  };
}

export function sortDrop(drop) {
  const { items, known } = validateDrop(drop);
  const knownSet = new Set(known);
  const accepted = [];
  const refused = [];
  let droppedWords = 0;

  for (const item of items) {
    const nameReason = nameProblem(item.name);
    if (nameReason) {
      refused.push({ id: item.id, addedAtMs: item.addedAtMs, reason: nameReason });
      continue;
    }
    if (item.kind === 'text') {
      const parsed = readTextItem(item.name, item.text);
      if (parsed.error) {
        refused.push({ id: item.id, addedAtMs: item.addedAtMs, reason: parsed.error });
        continue;
      }
      droppedWords += parsed.droppedWords;
      accepted.push({
        id: item.id,
        addedAt: item.addedAt,
        addedAtMs: item.addedAtMs,
        kind: 'link',
        sourceKey: parsed.url,
        site: parsed.site,
        url: parsed.url,
        title: parsed.title,
      });
      continue;
    }
    const parsed = readClip(item);
    if (parsed.error) {
      refused.push({ id: item.id, addedAtMs: item.addedAtMs, reason: parsed.error });
      continue;
    }
    accepted.push({
      id: item.id,
      addedAt: item.addedAt,
      addedAtMs: item.addedAtMs,
      kind: 'clip',
      sourceKey: parsed.sourceKey,
      title: parsed.title,
      file: parsed.file,
    });
  }

  const groups = new Map();
  for (const entry of accepted) {
    const group = groups.get(entry.sourceKey);
    if (group) group.push(entry);
    else groups.set(entry.sourceKey, [entry]);
  }

  const sources = [];
  const duplicates = [];
  for (const [sourceKey, group] of groups) {
    const ranked = [...group].sort(compareEntry);
    if (knownSet.has(sourceKey)) {
      for (const entry of ranked) {
        duplicates.push({
          id: entry.id,
          addedAtMs: entry.addedAtMs,
          sourceKey,
          repeats: 'known',
        });
      }
      continue;
    }
    const winner = ranked[0];
    sources.push(winner);
    for (const entry of ranked.slice(1)) {
      duplicates.push({
        id: entry.id,
        addedAtMs: entry.addedAtMs,
        sourceKey,
        repeats: winner.id,
      });
    }
  }

  sources.sort(compareEntry);
  duplicates.sort(compareEntry);
  refused.sort(compareEntry);

  const links = sources.filter((source) => source.kind === 'link').length;
  return {
    schemaVersion: SCHEMA_VERSION,
    sources: sources.map(toSource),
    duplicates: duplicates.map((duplicate) => ({
      id: duplicate.id,
      sourceKey: duplicate.sourceKey,
      repeats: duplicate.repeats,
    })),
    refused: refused.map((refusal) => ({ id: refusal.id, reason: refusal.reason })),
    counts: {
      items: items.length,
      sources: sources.length,
      links,
      clips: sources.length - links,
      duplicates: duplicates.length,
      refused: refused.length,
      droppedWords,
    },
  };
}
