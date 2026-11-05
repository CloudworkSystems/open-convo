import { createHash } from 'node:crypto';

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
  log(state, op, { entryId: item.id, text: item.text, reverses: forgotten?.id });
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
  const reversed = reversedOperations(state);
  if (reversed.has(target.id)) {
    const reversal = state.log.find(record => record.reverses === target.id || record.targetId === target.id);
    throw new Error(`Operation '${op.opId}' has already been ${reversal?.type === 'restore' ? 'reversed by restore' : 'undone'}.`);
  }
  const candidate = cloneState(state);
  reverseRecord(candidate, target, op.now);
  candidate.log.push({ id: op.id, type: 'undo', targetId: target.id });
  const dependency = undoDependency(state, candidate, target, reversed);
  if (dependency) {
    let sizeMessage = ''; try { checkSizes(candidate); } catch (error) { sizeMessage = `: ${error.message}`; }
    throw new Error(`Operation '${op.opId}' cannot be undone because operation '${dependency.id}' depends on it${sizeMessage}.`);
  }
  validateState(candidate);
  checkSizes(candidate);
  state.subjects = candidate.subjects;
  state.proposed = candidate.proposed;
  state.trash = candidate.trash;
  log(state, op, { entryId: target.entryId, targetId: target.id, reverses: target.id });
  return { undone: target.id };
}

function purge(state, op) {
  const expired = state.trash.filter((item) => Date.parse(op.now) - Date.parse(item.forgottenAt) > 30 * DAY);
  const ids = new Set(expired.map((item) => item.id));
  state.trash = state.trash.filter((item) => !ids.has(item.id));
  state.proposed = state.proposed.filter((item) => !ids.has(item.id));
  for (const record of state.log) if (ids.has(record.entryId) || ids.has(record.candidateId)) {
    for (const key of Object.keys(record)) if (!["id", "type", "now", "actor"].includes(key)) delete record[key];
    record.purged = true;
  } else redactSnapshots(record, ids);
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
function redactSnapshots(record, ids) {
  // A snapshot carries its own entry/candidate identity. Equal words are unrelated.
  for (const key of ['snapshot', 'candidate']) {
    const snapshot = record[key];
    if (!snapshot || typeof snapshot !== 'object') continue;
    if (ids.has(snapshot.id)) delete record[key];
    else redactSnapshots(snapshot, ids);
  }
}
// One dependency rule: a later effect blocks Undo only while it still holds
// and the proposed reversal would invalidate it (including shared capacity).
function undoDependency(state, candidate, target, reversed) {
  const live = state.log.slice(state.log.indexOf(target) + 1).filter(record => !record.purged && !reversed.has(record.id) && effectHolds(state, record));
  const broken = live.find(record => !record.effect.resourceOnly && !effectHolds(candidate, record));
  if (broken) return broken;
  if (sizeExcess(candidate) > 0) return live.findLast(record => {
    if (record.entryId === target.entryId) return false;
    const without = cloneState(candidate);
    removeEntry(without, record.entryId);
    return sizeExcess(without) < sizeExcess(candidate);
  });
}
function entity(state, id) {
  for (const subjects of Object.values(state.subjects)) for (const entries of Object.values(subjects)) {
    const entry = entries.find(entry => entry.id === id); if (entry) return { status: 'kept', entry };
  }
  const trash = state.trash.find(entry => entry.id === id);
  if (trash) return { status: 'trash', entry: trash };
  const proposed = state.proposed.find(entry => entry.id === id);
  return { status: proposed ? 'proposed' : 'absent', entry: proposed };
}
function effectHolds(state, record) {
  if (!record.effect) return false;
  const { status, entry } = entity(state, record.entryId);
  const effect = record.effect;
  return !(effect.requires ?? []).some(id => reversedOperations(state).has(id)) && status === effect.status && Object.entries(effect.values).every(([key, value]) => valueHash(entry?.[key]) === value) &&
    (effect.contains ?? []).every(space => entry?.shares?.includes(space)) && (effect.excludes ?? []).every(space => !entry?.shares?.includes(space));
}
function reversedOperations(state) {
  return new Set(state.log.filter(record => !record.purged).map(record => record.reverses ?? record.targetId).filter(Boolean));
}
function describeEffect(state, record) {
  const { status, entry } = entity(state, record.entryId);
  const fields = { keep: [], correct: ['text', 'history'], forget: ['text', 'history', 'cloud', 'space', 'subject', 'shares'], restore: [], share: ['space'], move: ['space', 'subject'], allowCloud: ['cloud'], undo: [] };
  if (!Object.hasOwn(fields, record.type)) return undefined;
  const effect = { status, values: Object.fromEntries(fields[record.type].map(key => [key, valueHash(entry[key])])) };
  if (record.type === 'share') effect.contains = [record.space];
  if (record.type === 'undo') effect.resourceOnly = true;
  if (record.type === 'move') {
    effect.excludes = [entry.space];
    if (record.before.shares.includes(entry.space)) {
      const grant = state.log.findLast(r => r.entryId === record.entryId && r.type === 'share' && r.space === entry.space && !reversedOperations(state).has(r.id));
      if (grant) effect.requires = [grant.id];
    }
  }
  return effect;
}
function valueHash(value) {
  return createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
}
function sizeExcess(state) {
  let excess = 0;
  for (const space of state.spaces) {
    const subjects = own(state.subjects, space.id) ?? Object.create(null);
    excess += Math.max(0, Buffer.byteLength(renderIndex(space.id, subjects)) - LIMIT);
    for (const [subject, entries] of Object.entries(subjects)) excess += Math.max(0, Buffer.byteLength(renderSubject(subject, entries)) - LIMIT);
  }
  return excess;
}
function reverseRecord(state, target, now) {
  const current = entity(state, target.entryId);
  const entry = current.entry;
  if (target.type === 'forget') {
    if (current.status !== 'trash') throw new Error(`Operation '${target.id}' has already been reversed by restore.`);
    withinTrashWindow(entry, now);
    state.trash.splice(state.trash.indexOf(entry), 1);
    delete entry.forgottenAt; addEntry(state, entry, target.entryIndex); return;
  }
  if (!entry) throw new Error(`Memory '${target.entryId}' was not found.`);
  if (target.type === 'keep') {
    removeEntry(state, entry.id); state.trash = state.trash.filter(item => item.id !== entry.id);
    state.proposed.splice(target.candidateIndex ?? state.proposed.length, 0, structuredClone(entry.candidate));
  }
  if (target.type === 'correct') { entry.text = target.oldText; entry.history.pop(); }
  if (target.type === 'share') entry.shares = entry.shares.filter(space => space !== target.space);
  if (target.type === 'move') {
    if (current.status === 'kept') removeEntry(state, entry.id);
    const removedShare = target.before.shares?.find(space => space === entry.space);
    if (removedShare) entry.shares.splice(target.before.shares.indexOf(removedShare), 0, removedShare);
    entry.space = target.before.space; entry.subject = target.before.subject;
    if (current.status === 'kept') addEntry(state, entry, target.before.entryIndex);
  }
  if (target.type === 'allowCloud') entry.cloud = target.beforeCloud ?? false;
}
function removeEntry(state, id) { for (const subjects of Object.values(state.subjects)) for (const entries of Object.values(subjects)) { const i = entries.findIndex((x) => x.id === id); if (i >= 0) { entries.splice(i, 1); return; } } }
function withinTrashWindow(item, now) { if (Date.parse(now) - Date.parse(item.forgottenAt) > 30 * DAY) throw new Error("This memory's 30 days in Trash are over."); }
function log(state, op, detail) { const record = { id: op.id, type: op.type, now: op.now, actor: op.actor, ...structuredClone(detail) }; const effect = describeEffect(state, record); if (effect) record.effect = effect; state.log.push(record); }
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
