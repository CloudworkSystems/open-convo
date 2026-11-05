const DAY = 86_400_000;
const LIMIT = 4096;
const kinds = new Set(["personal", "business", "family"]);
const personOnly = new Set(["keep", "skip", "correct", "forget", "restore", "undo", "share", "move", "allowCloud", "purge"]);

export function emptyState(spaces = [{ id: "personal", name: "Personal", kind: "personal" }]) {
  return { spaces: structuredClone(spaces), subjects: Object.create(null), proposed: [], trash: [], log: [] };
}

export function applyOperation(input, operation) {
  const state = cloneState(input);
  validateState(state);
  const op = structuredClone(operation);
  requireText(op.id, "Operation id");
  if (state.log.some((record) => record.id === op.id)) throw new Error(`Operation id '${op.id}' is already in the log.`);
  if (personOnly.has(op.type) && op.actor !== "person") throw new Error(`${op.type} can only be done by the person.`);
  if (!op.now) throw new Error("The operation needs a now value.");
  if (Number.isNaN(Date.parse(op.now))) throw new Error("The operation's now value must be a valid date and time.");
  let result;
  switch (op.type) {
    case "propose": result = propose(state, op); break;
    case "keep": result = keep(state, op); break;
    case "skip": result = skip(state, op); break;
    case "correct": result = correct(state, op); break;
    case "forget": result = forget(state, op); break;
    case "restore": result = restore(state, op); break;
    case "share": result = share(state, op); break;
    case "move": result = move(state, op); break;
    case "allowCloud": result = allowCloud(state, op); break;
    case "undo": result = undo(state, op); break;
    case "purge": result = purge(state, op); break;
    default: throw new Error(`Unknown operation '${op.type}'.`);
  }
  validateState(state);
  const writes = renderWrites(state);
  return { state, writes, result };
}

export function read(input, options) {
  const state = cloneState(input);
  validateState(state);
  requireSpace(state, options.space);
  const entries = [];
  for (const [space, subjects] of Object.entries(state.subjects)) {
    for (const [subject, list] of Object.entries(subjects)) for (const entry of list) {
      if (entry.space === options.space || entry.shares?.includes(options.space)) {
        if (!options.cloud || entry.cloud) {
          const visible = structuredClone(entry);
          delete visible.history;
          delete visible.candidate;
          entries.push({ ...visible, subject, ...(entry.space === options.space ? {} : { origin: entry.space }) });
        }
      }
    }
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return entries;
}

function propose(state, op) {
  requireText(op.candidate?.id, "Candidate id");
  requireText(op.candidate?.text, "Candidate text");
  ensureFreeRecordId(state, op.candidate.id);
  const candidate = { ...op.candidate, sensitive: Boolean(op.candidate.sensitive), proposedBy: op.actor, unconfirmedAgent: op.actor !== "person" && op.confirmed !== true };
  state.proposed.push(candidate);
  log(state, op, { candidateId: candidate.id, text: candidate.text });
  return candidate;
}

function keep(state, op) {
  const candidate = takeCandidate(state, op.candidateId, false);
  const candidateIndex = state.proposed.indexOf(candidate);
  requireSpace(state, op.space);
  validateSubject(op.subject);
  validateLabel(op.label);
  if (candidate.sensitive && op.save !== true) throw new Error(`Candidate '${candidate.id}' is sensitive. Keep it with save: true.`);
  const entry = { id: candidate.id, text: candidate.text, space: op.space, subject: op.subject, label: structuredClone(op.label), cloud: false, history: [], shares: [], candidate: structuredClone(candidate) };
  mutateWithSizeCheck(state, () => { takeCandidate(state, op.candidateId, true); addEntry(state, entry); });
  log(state, op, { entryId: entry.id, candidateId: entry.id, candidateIndex, text: entry.text });
  return entry;
}

function skip(state, op) {
  const candidate = takeCandidate(state, op.candidateId, true);
  log(state, op, { candidateId: candidate.id, text: candidate.text, snapshot: candidate });
  return { skipped: candidate.id };
}

function correct(state, op) {
  requireText(op.text, "Corrected text");
  const entry = findEntry(state, op.entryId);
  const oldText = entry.text;
  mutateWithSizeCheck(state, () => { entry.history.push({ text: oldText, actor: op.actor, at: op.now }); entry.text = op.text; });
  log(state, op, { entryId: entry.id, text: op.text, oldText });
  return entry;
}

function forget(state, op) {
  const entry = findEntry(state, op.entryId);
  const entryIndex = own(own(state.subjects, entry.space), entry.subject).indexOf(entry);
  const snapshot = structuredClone(entry);
  removeEntry(state, entry.id);
  state.trash.push({ ...snapshot, forgottenAt: op.now });
  log(state, op, { entryId: entry.id, entryIndex, text: entry.text, snapshot });
  return { forgotten: entry.id };
}

function restore(state, op) {
  const item = findTrash(state, op.entryId);
  withinTrashWindow(item, op.now);
  const forgotten = state.log.findLast(record => record.type === 'forget' && record.entryId === item.id);
  mutateWithSizeCheck(state, () => { state.trash.splice(state.trash.indexOf(item), 1); const restored = structuredClone(item); delete restored.forgottenAt; addEntry(state, restored, forgotten?.entryIndex); });
  log(state, op, { entryId: item.id, text: item.text });
  return findEntry(state, item.id);
}

function share(state, op) {
  const entry = findEntry(state, op.entryId);
  requireSpace(state, op.space);
  if (entry.space === op.space || entry.shares.includes(op.space)) throw new Error(`Memory '${entry.id}' is already available in space '${op.space}'.`);
  mutateWithSizeCheck(state, () => entry.shares.push(op.space));
  log(state, op, { entryId: entry.id, space: op.space, text: entry.text });
  return entry;
}

function move(state, op) {
  const entry = findEntry(state, op.entryId);
  requireSpace(state, op.space);
  if (op.subject !== undefined) validateSubject(op.subject);
  const before = { space: entry.space, subject: entry.subject, shares: structuredClone(entry.shares), entryIndex: own(own(state.subjects, entry.space), entry.subject).indexOf(entry) };
  mutateWithSizeCheck(state, () => { removeEntry(state, entry.id); entry.space = op.space; entry.subject = op.subject ?? entry.subject; entry.shares = entry.shares.filter(space => space !== op.space); addEntry(state, entry); });
  log(state, op, { entryId: entry.id, before, space: entry.space, text: entry.text });
  return entry;
}

function allowCloud(state, op) {
  const entry = findEntry(state, op.entryId);
  const beforeCloud = entry.cloud;
  entry.cloud = true;
  log(state, op, { entryId: entry.id, beforeCloud, text: entry.text });
  return entry;
}

function undo(state, op) {
  const target = state.log.find((record) => record.id === op.opId);
  if (!target) throw new Error(`Operation '${op.opId}' was not found.`);
  if (!["keep", "correct", "forget", "share", "move", "allowCloud"].includes(target.type) || target.purged) throw new Error(`Operation '${op.opId}' cannot be undone.`);
  const reversed = new Set(state.log.filter(record => record.type === 'undo' && !record.purged).map(record => record.targetId));
  if (reversed.has(target.id)) throw new Error(`Operation '${op.opId}' has already been undone.`);
  const later = state.log.slice(state.log.indexOf(target) + 1).find((record) => record.type !== 'undo' && !reversed.has(record.id) && dependsOn(record, target));
  if (later) throw new Error(`Operation '${op.opId}' cannot be undone because operation '${later.id}' depends on it.`);
  const previousLocation = target.type === 'move' ? target.before : target.type === 'forget' ? findTrash(state, target.entryId) : findEntry(state, target.entryId);
  try { mutateWithSizeCheck(state, () => {
    if (target.type === "keep") { const entry = findEntry(state, target.entryId); removeEntry(state, entry.id); state.proposed.splice(target.candidateIndex ?? state.proposed.length, 0, structuredClone(entry.candidate)); }
    if (target.type === "correct") { const entry = findEntry(state, target.entryId); entry.text = target.oldText; entry.history.pop(); }
    if (target.type === "forget") { const item = findTrash(state, target.entryId); withinTrashWindow(item, op.now); state.trash.splice(state.trash.indexOf(item), 1); const restored = structuredClone(item); delete restored.forgottenAt; addEntry(state, restored, target.entryIndex); }
    if (target.type === "share") { const entry = findEntry(state, target.entryId); entry.shares = entry.shares.filter((id) => id !== target.space); }
    if (target.type === "move") { const entry = findEntry(state, target.entryId); removeEntry(state, entry.id); const removedShare = target.before.shares?.find(space => space === entry.space); if (removedShare) entry.shares.splice(target.before.shares.indexOf(removedShare), 0, removedShare); entry.space = target.before.space; entry.subject = target.before.subject; addEntry(state, entry, target.before.entryIndex); }
    if (target.type === "allowCloud") findEntry(state, target.entryId).cloud = target.beforeCloud ?? false;
  }); } catch (error) {
    if (/subject is full|index is full/.test(error.message)) {
      const dependency = state.log.slice(state.log.indexOf(target) + 1).findLast(record => {
        if (reversed.has(record.id)) return false;
        if (!record.entryId || record.entryId === target.entryId || !['keep', 'correct', 'move', 'restore', 'undo'].includes(record.type)) return false;
        let entry; try { entry = findEntry(state, record.entryId); } catch { return false; }
        return entry.space === previousLocation.space && (/index is full/.test(error.message) || entry.subject === previousLocation.subject);
      });
      if (dependency) throw new Error(`Operation '${op.opId}' cannot be undone because operation '${dependency.id}' depends on it: ${error.message}`);
    }
    throw error;
  }
  log(state, op, { entryId: target.entryId, targetId: target.id });
  return { undone: target.id };
}

function purge(state, op) {
  const expired = state.trash.filter((item) => Date.parse(op.now) - Date.parse(item.forgottenAt) > 30 * DAY);
  const ids = new Set(expired.map((item) => item.id));
  const texts = new Set(expired.flatMap((item) => [item.text, ...item.history.map((h) => h.text), item.candidate?.text].filter(Boolean)));
  state.trash = state.trash.filter((item) => !ids.has(item.id));
  state.proposed = state.proposed.filter((item) => !ids.has(item.id));
  for (const record of state.log) if (ids.has(record.entryId) || ids.has(record.candidateId)) {
    for (const key of Object.keys(record)) if (!["id", "type", "now", "actor"].includes(key)) delete record[key];
    record.purged = true;
  } else redactLogText(record, texts);
  log(state, op, { purgedIds: [...ids] });
  return { purged: [...ids] };
}

function validateState(state) {
  if (!Array.isArray(state.spaces) || state.spaces.length < 1 || state.spaces.length > 20) throw new Error("State needs 1 to 20 spaces.");
  const spaceIds = new Set();
  for (const space of state.spaces) {
    if (!/^[a-z0-9-]+$/.test(space.id ?? "")) throw new Error(`Space id '${space.id ?? ""}' is invalid.`);
    if (spaceIds.has(space.id)) throw new Error(`Space id '${space.id}' is repeated.`);
    if (!kinds.has(space.kind)) throw new Error(`Space '${space.id}' has an invalid kind.`);
    spaceIds.add(space.id);
  }
  const opIds = new Set();
  for (const record of state.log ?? []) { requireText(record.id, "Logged operation id"); if (opIds.has(record.id)) throw new Error(`Operation id '${record.id}' is repeated in the log.`); opIds.add(record.id); }
  const recordIds = new Set();
  const addId = (id) => { requireText(id, "Candidate or entry id"); if (recordIds.has(id)) throw new Error(`Candidate or entry id '${id}' is repeated.`); recordIds.add(id); };
  for (const item of state.proposed ?? []) addId(item.id);
  for (const item of state.trash ?? []) addId(item.id);
  for (const [space, subjects] of Object.entries(state.subjects ?? {})) {
    if (!spaceIds.has(space)) throw new Error(`Subjects refer to unknown space '${space}'.`);
    for (const [subject, entries] of Object.entries(subjects)) {
      validateSubject(subject);
      for (const entry of entries) {
        addId(entry.id);
        if (entry.space !== space || entry.subject !== subject) throw new Error(`Memory '${entry.id}' is filed under the wrong space or subject.`);
        validateLabel(entry.label);
        if (!Array.isArray(entry.shares) || new Set(entry.shares).size !== entry.shares.length || entry.shares.some((id) => !spaceIds.has(id) || id === space)) throw new Error(`Memory '${entry.id}' has invalid shared spaces.`);
      }
    }
  }
}

function validateLabel(label) {
  if (!label || typeof label !== "object") throw new Error("A kept memory needs exactly one label.");
  const valid = ["owner said", "agent's reading, kept", "from a source"];
  if (!valid.includes(label.kind)) throw new Error("A kept memory needs exactly one valid label.");
  const detailKeys = ["date", "agent", "link"].filter((key) => label[key] !== undefined);
  if (detailKeys.length !== 1) throw new Error("A kept memory needs exactly one label, not two.");
  if (label.kind === "owner said" && !label.date) throw new Error("The owner-said label needs a date.");
  if (label.kind === "agent's reading, kept" && !label.agent) throw new Error("The kept agent-reading label needs the agent name.");
  if (label.kind === "from a source" && !label.link) throw new Error("The source label needs a link.");
}
function validateSubject(id) { if (!/^[a-z][a-z0-9-]{0,63}$/.test(id ?? "") || id === "index") throw new Error(`Subject id '${id ?? ""}' is invalid.`); }
function requireText(value, name) { if (typeof value !== "string" || !value.length) throw new Error(`${name} must not be empty.`); }
function requireSpace(state, id) { if (!state.spaces.some((space) => space.id === id)) throw new Error(`Space '${id}' was not found.`); }
function ensureFreeRecordId(state, id) { try { findAny(state, id); } catch { return; } throw new Error(`Candidate or entry id '${id}' is already in use.`); }
function findAny(state, id) { return state.proposed.find((x) => x.id === id) ?? state.trash.find((x) => x.id === id) ?? findEntry(state, id); }
function takeCandidate(state, id, remove) { const item = state.proposed.find((x) => x.id === id); if (!item) throw new Error(`Candidate '${id}' was not found.`); if (remove) state.proposed.splice(state.proposed.indexOf(item), 1); return item; }
function findEntry(state, id) { for (const subjects of Object.values(state.subjects)) for (const entries of Object.values(subjects)) { const item = entries.find((x) => x.id === id); if (item) return item; } throw new Error(`Memory '${id}' was not found.`); }
function findTrash(state, id) { const item = state.trash.find((x) => x.id === id); if (!item) throw new Error(`Memory '${id}' was not found in Trash.`); return item; }
function own(object, key) { return Object.hasOwn(object, key) ? object[key] : undefined; }
function cloneState(input) {
  const state = structuredClone(input);
  state.subjects = Object.assign(Object.create(null), state.subjects);
  for (const [space, subjects] of Object.entries(state.subjects)) state.subjects[space] = Object.assign(Object.create(null), subjects);
  return state;
}
function addEntry(state, entry, index) {
  if (!Object.hasOwn(state.subjects, entry.space)) state.subjects[entry.space] = Object.create(null);
  const subjects = own(state.subjects, entry.space);
  if (!Object.hasOwn(subjects, entry.subject)) subjects[entry.subject] = [];
  const entries = own(subjects, entry.subject);
  entries.splice(index ?? entries.length, 0, entry);
}
function redactLogText(record, texts) {
  // Only these schema fields contain memory text. IDs, actors, dates and labels are metadata.
  for (const key of ['text', 'oldText']) if (texts.has(record[key])) delete record[key];
  function redactEntry(entry) {
    if (!entry || typeof entry !== 'object') return;
    if (texts.has(entry.text)) delete entry.text;
    for (const version of entry.history ?? []) if (texts.has(version.text)) delete version.text;
    if (entry.candidate && texts.has(entry.candidate.text)) delete entry.candidate.text;
  }
  redactEntry(record.snapshot);
}
function dependsOn(record, target) {
  if (!target.entryId || record.entryId !== target.entryId) return false;
  if (target.type === 'keep') return true;
  const effective = record;
  if (effective.type === 'forget') return true;
  if (target.type === 'forget') return ['restore', 'forget'].includes(effective.type);
  if (target.type === 'correct') return effective.type === 'correct';
  if (target.type === 'allowCloud') return effective.type === 'allowCloud';
  if (target.type === 'move') return ['move', 'share'].includes(effective.type);
  if (target.type === 'share') return ['share', 'move'].includes(effective.type) && effective.space === target.space;
  return false;
}
function removeEntry(state, id) { for (const subjects of Object.values(state.subjects)) for (const entries of Object.values(subjects)) { const i = entries.findIndex((x) => x.id === id); if (i >= 0) { entries.splice(i, 1); return; } } }
function withinTrashWindow(item, now) { if (Date.parse(now) - Date.parse(item.forgottenAt) > 30 * DAY) throw new Error("This memory's 30 days in Trash are over."); }
function log(state, op, detail) { state.log.push({ id: op.id, type: op.type, now: op.now, actor: op.actor, ...structuredClone(detail) }); }
function mutateWithSizeCheck(state, change) { const before = structuredClone(state); change(); try { checkSizes(state); } catch (error) { Object.keys(state).forEach((key) => delete state[key]); Object.assign(state, before); throw error; } }
function checkSizes(state) { for (const space of state.spaces) { const subjects = own(state.subjects, space.id) ?? Object.create(null); for (const subject of Object.keys(subjects)) if (Buffer.byteLength(renderSubject(subject, own(subjects, subject))) > LIMIT) throw new Error("This subject is full. Split it or correct an older entry."); if (Buffer.byteLength(renderIndex(space.id, subjects)) > LIMIT) throw new Error(`Space '${space.id}' index is full. Use fewer subjects.`); } }
function renderSubject(subject, entries) { return `# ${subject}\n` + [...entries].sort((a,b) => a.id.localeCompare(b.id)).map((e) => `- [${e.id}] ${e.text} (${labelText(e.label)})`).join("\n") + "\n"; }
function labelText(label) { return label.kind === "owner said" ? `${label.kind}, ${label.date}` : label.kind === "agent's reading, kept" ? `${label.kind}, ${label.agent}` : `${label.kind}, ${label.link}`; }
function renderIndex(space, subjects) { return "<!-- Generated. Do not edit. -->\n" + Object.keys(subjects).sort().map((subject) => `- ${subject}.md: # ${subject}`).join("\n") + (Object.keys(subjects).length ? "\n" : ""); }
export function renderWrites(state) {
  validateState(state); checkSizes(state);
  const writes = [];
  for (const space of state.spaces) { const subjects = own(state.subjects, space.id) ?? Object.create(null); writes.push({ path: `${space.id}/INDEX.md`, text: renderIndex(space.id, subjects) }); for (const subject of Object.keys(subjects).sort()) writes.push({ path: `${space.id}/${subject}.md`, text: renderSubject(subject, own(subjects, subject)) }); }
  writes.push({ path: ".proposed/candidates.json", text: JSON.stringify(state.proposed, null, 2) + "\n" });
  writes.push({ path: ".trash/trash.json", text: JSON.stringify(state.trash, null, 2) + "\n" });
  writes.push({ path: ".log/log.jsonl", text: state.log.map((x) => JSON.stringify(x)).join("\n") + (state.log.length ? "\n" : "") });
  for (const write of writes) if (write.path.startsWith("/") || write.path.split("/").includes("..") || !(write.path.startsWith(".") || state.spaces.some((s) => write.path.startsWith(`${s.id}/`)))) throw new Error(`Write path '${write.path}' is outside the memory layout.`);
  return writes;
}
