import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const SORT_ORDERS = Object.freeze(['alphabetical', 'section', 'added', 'custom']);
export const STARTER_SECTIONS = Object.freeze({
  apple: 'produce', apples: 'produce', banana: 'produce', bananas: 'produce',
  carrot: 'produce', carrots: 'produce', milk: 'dairy', cheese: 'dairy',
  yogurt: 'dairy', butter: 'dairy', eggs: 'dairy', bread: 'bakery',
  rice: 'pantry', pasta: 'pantry', 'ice cream': 'frozen', peas: 'frozen',
});
const clone = value => structuredClone(value);
const own = (object, key) => Object.hasOwn(object, key);
const lex = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = message => { throw new Error(message); };
const string = (value, label) => typeof value === 'string' ? value : fail(`${label} must be text.`);
const identity = (value, label) => string(value, label).length ? value : fail(`${label} must not be empty.`);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = text => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
export function sortKey(text) {
  return normalized(string(text, 'Item text')).trim().replace(/^(?:\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])\s*(?:[x×]\s*)?(?=\S)/u, '');
}

export function compareStamps(a, b) {
  if (!a) return b ? -1 : 0;
  if (!b) return 1;
  return lex(a.counter, b.counter) || lex(a.time, b.time) || lex(a.device, b.device);
}
const latest = (a, b) => compareStamps(a, b) >= 0 ? a : b;
// Register values are primitives or stamps, whose JSON key order is immaterial.
const sameValue = (a, b) => a === b || (validStamp(a) && validStamp(b) && compareStamps(a, b) === 0);
function register(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  const order = compareStamps(a.stamp, b.stamp);
  if (!order && !sameValue(a.value, b.value)) fail('Conflicting values share a version stamp. Use a unique device ID per writer.');
  return clone(order >= 0 ? a : b);
}
function records(a, b, purge = null) {
  const result = {};
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const value = register(own(a, key) ? a[key] : undefined, own(b, key) ? b[key] : undefined);
    if (compareStamps(value.stamp, purge) > 0) Object.defineProperty(result, key, {value, enumerable: true, writable: true, configurable: true});
  }
  return result;
}
// After a purge, only a complete new add (text and birth stamp) can restore
// an item. Checking, notes and moves alone must never create a blank row.
function hasItemContent(item, listPurge = null) {
  const purge = latest(item.purge, listPurge);
  return !purge || (compareStamps(item.fields.text?.stamp, purge) > 0 &&
    compareStamps(item.fields.added?.stamp, purge) > 0);
}
function mergeItem(a, b, listPurge) {
  if (!a) a = {id: b.id, fields: {}, life: b.life, purge: null};
  if (!b) b = {id: a.id, fields: {}, life: a.life, purge: null};
  const ownPurge = latest(a.purge, b.purge);
  const purge = latest(ownPurge, listPurge);
  const life = register(a.pendingLife ?? a.life, b.pendingLife ?? b.life);
  const marker = {id: a.id, fields: {}, life: {value: false, stamp: clone(purge)}, purge: clone(purge)};
  if (compareStamps(life.stamp, purge) <= 0) return marker;
  const result = {id: a.id, fields: records(a.fields, b.fields, purge), life, purge: clone(ownPurge)};
  if (purge && !hasItemContent(result, listPurge)) {
    // Retain post-purge registers and the latest event for later full re-adds.
    // Discarding them here would make a three-copy merge order-dependent.
    return {...marker, fields: result.fields, pendingLife: life};
  }
  return result;
}

// Dense, ASCII-ordered position keys. Appending a unique stamp suffix to a
// midpoint gives concurrent moves distinct keys without moving other items.
const POSITION_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function positionBetween(lower, upper) {
  if (lower !== null && upper !== null && lex(lower, upper) >= 0) fail('Custom positions must be distinct and ordered.');
  let prefix = '';
  for (let i = 0; ; i++) {
    const low = i < (lower?.length ?? 0) ? POSITION_DIGITS.indexOf(lower[i]) : 0;
    const high = i < (upper?.length ?? 0) ? POSITION_DIGITS.indexOf(upper[i]) : 61;
    if (high - low > 1) return prefix + POSITION_DIGITS[Math.floor((low + high) / 2)];
    prefix += POSITION_DIGITS[low];
    if (low < high) upper = null;
  }
}
function stampPosition(stamp, id) {
  const hex = value => value.toString(16).padStart(14, '0');
  // A leading 1 on each code unit and a 0 terminator preserve prefix order.
  const text = value => value.split('').map(char => '1' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('') + '0';
  return 'G' + hex(BigInt(stamp.counter)) + hex(BigInt(stamp.time) + BigInt(Number.MAX_SAFE_INTEGER)) + text(stamp.device) + text(id) + 'V';
}
function customPosition(item) {
  return item.fields.customPosition?.value ?? stampPosition(item.fields.added?.value ?? item.life.stamp, item.id);
}
const compareCustom = (a, b) => lex(customPosition(a), customPosition(b)) || lex(a.id, b.id);
function appendPosition(list, stamp, itemId) {
  const birth = stampPosition(stamp, itemId);
  const last = list.items.filter(item => hasItemContent(item, list.purge) && Object.keys(item.fields).length)
    .map(customPosition).sort().at(-1);
  return !last || lex(birth, last) > 0 ? birth : positionBetween(last, null) + birth;
}
function canonical(list) {
  const result = clone(list);
  result.fields = records(result.fields, {});
  result.sections = records(result.sections, {});
  result.items.sort((a, b) => lex(a.id, b.id));
  for (const item of result.items) item.fields = records(item.fields, {});
  return result;
}

/** Pure, commutative merge. No input is mutated. */
export function mergeLists(left, right) {
  validate(left); validate(right);
  if (left.id !== right.id) fail('Cannot merge different list IDs.');
  const purge = latest(left.purge, right.purge);
  const life = register(left.life, right.life);
  const ids = [...new Set([...left.items, ...right.items].map(item => item.id))].sort();
  const a = new Map(left.items.map(item => [item.id, item]));
  const b = new Map(right.items.map(item => [item.id, item]));
  const result = {
    schemaVersion: SCHEMA_VERSION, id: left.id,
    life: compareStamps(life.stamp, purge) <= 0 ? {value: false, stamp: clone(purge)} : life,
    purge: clone(purge), fields: records(left.fields, right.fields, purge),
    sections: records(left.sections, right.sections, purge),
    items: ids.map(id => mergeItem(a.get(id), b.get(id), purge)),
  };
  // A purged list needs only its own permanent marker; its cutoff also fences old items.
  if (!result.life.value && result.purge && compareStamps(result.life.stamp, result.purge) === 0) result.items = [];
  return canonical(validate(result));
}

function validStamp(stamp) {
  return object(stamp) && Number.isSafeInteger(stamp.counter) && stamp.counter > 0 &&
    Number.isSafeInteger(stamp.time) && typeof stamp.device === 'string' && stamp.device.length > 0;
}
const itemTypes = {text: 'string', quantity: 'string', note: 'string', section: 'string', addedBy: 'string', checked: 'boolean', added: 'stamp', customPosition: 'position'};
const listTypes = {name: 'string', sort: 'sort', sectionsEnabled: 'boolean'};
function validateFields(fields, types) {
  if (!object(fields)) fail('Invalid fields in list file.');
  for (const [key, entry] of Object.entries(fields)) {
    if (!own(types, key) || !object(entry) || !validStamp(entry.stamp)) fail('Invalid field or version stamp in list file.');
    const type = types[key];
    if (type === 'position' ? !(typeof entry.value === 'string' && /^[0-9A-Za-z]+$/.test(entry.value) && !entry.value.endsWith('0')) : type === 'stamp' ? !validStamp(entry.value) : type === 'sort' ? !SORT_ORDERS.includes(entry.value) : typeof entry.value !== type) fail('Invalid field value in list file.');
  }
}
function validateRecord(record, types) {
  if (!object(record) || typeof record.id !== 'string' || !record.id || !object(record.life) || typeof record.life.value !== 'boolean' || !validStamp(record.life.stamp) || (record.purge !== null && !validStamp(record.purge))) fail('Invalid record in list file.');
  validateFields(record.fields, types);
}
function validate(list) {
  if (!object(list) || list.schemaVersion !== SCHEMA_VERSION) fail(`Unsupported schemaVersion; expected ${SCHEMA_VERSION}.`);
  validateRecord(list, listTypes);
  if (!Array.isArray(list.items) || !object(list.sections)) fail('Invalid items or sections in list file.');
  const ids = new Set();
  const positions = new Set();
  for (const item of list.items) {
    validateRecord(item, itemTypes);
    if (own(item, 'pendingLife') && (!object(item.pendingLife) || typeof item.pendingLife.value !== 'boolean' || !validStamp(item.pendingLife.stamp) || !item.purge)) fail('Invalid pending item event in list file.');
    if (ids.has(item.id)) fail('Duplicate item ID in list file.');
    ids.add(item.id);
    // Include recoverable Trash entries: restoring one must remain draggable.
    // Engine-generated keys carry a unique stamp/ID suffix; tied imported keys
    // have no representable midpoint and are refused rather than misordered.
    if (Object.keys(item.fields).length && hasItemContent(item, list.purge)) {
      const position = customPosition(item);
      if (positions.has(position)) fail('Duplicate Custom position in list file.');
      positions.add(position);
    }
  }
  for (const entry of Object.values(list.sections)) {
    if (!object(entry) || (entry.value !== null && typeof entry.value !== 'string') || !validStamp(entry.stamp)) fail('Invalid section map entry in list file.');
  }
  return list;
}
export function serializeList(list) { return JSON.stringify(validate(list)); }
export function deserializeList(json) {
  let value;
  try { value = JSON.parse(json); } catch { fail('Invalid list JSON.'); }
  return clone(validate(value));
}
function stamps(list) {
  const result = [list.life.stamp, list.purge];
  for (const entry of [...Object.values(list.fields), ...Object.values(list.sections)]) result.push(entry.stamp);
  for (const item of list.items) {
    result.push(item.life.stamp, item.purge, item.pendingLife?.stamp);
    for (const entry of Object.values(item.fields)) { result.push(entry.stamp); if (validStamp(entry.value)) result.push(entry.value); }
  }
  return result.filter(Boolean);
}
const values = fields => Object.fromEntries(Object.entries(fields).map(([key, entry]) => [key, clone(entry.value)]));
function itemView(item) {
  const {added, customPosition, ...fields} = values(item.fields);
  return {id: item.id, ...fields};
}
export function viewList(list, {trash = false} = {}) {
  validate(list);
  const fields = values(list.fields);
  const sectionsEnabled = fields.sectionsEnabled ?? false;
  const sort = !sectionsEnabled && fields.sort === 'section' ? 'alphabetical' : fields.sort ?? 'alphabetical';
  const items = list.items.filter(item => item.life.value !== trash && hasItemContent(item, list.purge) && Object.keys(item.fields).length).slice();
  const order = (a, b) => compareStamps(a.fields.added?.value, b.fields.added?.value) || lex(a.id, b.id);
  const alpha = (a, b) => lex(sortKey(a.fields.text?.value ?? ''), sortKey(b.fields.text?.value ?? '')) || order(a, b);
  items.sort(sort === 'custom' ? compareCustom : sort === 'added' ? order : sort === 'section' ? (a, b) => {
    const sa = normalized(a.fields.section?.value ?? '').trim();
    const sb = normalized(b.fields.section?.value ?? '').trim();
    return lex(!sa, !sb) || lex(sa, sb) || alpha(a, b);
  } : alpha);
  return {
    id: list.id, name: fields.name ?? '', sort, sectionsEnabled,
    availableSortOrders: SORT_ORDERS.filter(order => sectionsEnabled || order !== 'section'),
    deleted: !list.life.value,
    sectionMap: sectionsEnabled ? {...STARTER_SECTIONS, ...Object.fromEntries(Object.entries(values(list.sections)).filter(([, value]) => value !== null))} : {},
    items: items.map(item => ({...itemView(item), ...(!sectionsEnabled ? {section: ''} : {})})),
  };
}

/** One writer per unique device ID. State and undo history are held only in memory. */
export class HouseholdLists {
  #lists = new Map(); #history = new Map(); #counter = 0;
  constructor({deviceId, now = Date.now, undoLimit = 20} = {}) {
    this.deviceId = identity(deviceId, 'Device ID');
    if (typeof now !== 'function' || !Number.isSafeInteger(undoLimit) || undoLimit < 0) fail('Invalid clock or undo limit.');
    this.now = now; this.undoLimit = undoLimit;
  }
  #observe(list) { for (const stamp of stamps(list)) this.#counter = Math.max(this.#counter, stamp.counter); }
  #stamp() {
    const time = this.now();
    if (!Number.isSafeInteger(time) || this.#counter >= Number.MAX_SAFE_INTEGER) fail('Invalid clock or exhausted logical counter.');
    return {counter: ++this.#counter, time, device: this.deviceId};
  }
  #get(id) { return this.#lists.get(id) ?? fail('List not found.'); }
  #change(id, operation) {
    const before = this.#get(id); const draft = clone(before); const stamp = this.#stamp();
    operation(draft, stamp);
    const history = this.#history.get(id) ?? [];
    history.push({before: clone(before), after: clone(draft)});
    if (history.length > this.undoLimit) history.shift();
    this.#history.set(id, history); this.#lists.set(id, canonical(draft));
    return this.getList(id);
  }
  createList(name, {id = randomUUID()} = {}) {
    string(name, 'List name'); identity(id, 'List ID');
    if (this.#lists.has(id)) fail('List ID already exists; restore the existing list.');
    const stamp = this.#stamp();
    this.#lists.set(id, {schemaVersion: SCHEMA_VERSION, id, life: {value: true, stamp}, purge: null,
      fields: {name: {value: name, stamp}, sort: {value: 'alphabetical', stamp}, sectionsEnabled: {value: false, stamp}}, sections: {}, items: []});
    return id;
  }
  getList(id) { return clone(this.#get(id)); }
  listIds({trash = false} = {}) { return [...this.#lists.values()].filter(list => list.life.value !== trash && Object.keys(list.fields).length).map(list => list.id).sort(); }
  view(id, options) { return viewList(this.#get(id), options); }
  renameList(id, name) { string(name, 'List name'); return this.#change(id, (list, stamp) => { list.fields.name = {value: name, stamp}; list.life = {value: true, stamp}; }); }
  setSort(id, sort) {
    if (!SORT_ORDERS.includes(sort)) fail('Unknown sort order.');
    if (sort === 'section' && !this.view(id).sectionsEnabled) fail('Section sorting is disabled for this list.');
    return this.#change(id, (list, stamp) => { list.fields.sort = {value: sort, stamp}; list.life = {value: true, stamp}; });
  }
  setSectionsEnabled(id, enabled) {
    if (typeof enabled !== 'boolean') fail('Sections enabled must be a boolean.');
    return this.#change(id, (list, stamp) => {
      list.fields.sectionsEnabled = {value: enabled, stamp};
      if (!enabled && list.fields.sort?.value === 'section') list.fields.sort = {value: 'alphabetical', stamp};
      list.life = {value: true, stamp};
    });
  }
  setSectionWord(id, word, section) {
    identity(word, 'Section word'); string(section, 'Section'); const key = sortKey(word);
    return this.#change(id, (list, stamp) => { Object.defineProperty(list.sections, key, {value: {value: section, stamp}, enumerable: true, writable: true, configurable: true}); list.life = {value: true, stamp}; });
  }
  suggestSection(id, text) {
    const view = this.view(id);
    if (!view.sectionsEnabled) return null;
    const map = view.sectionMap;
    const key = sortKey(text);
    // Exact phrases (including custom overrides) precede whole-word fallback.
    if (own(map, key)) return map[key];
    const words = key.match(/[\p{L}\p{N}_]+/gu) ?? [];
    for (const word of words.reverse()) if (own(map, word)) return map[word];
    return null;
  }
  addItem(id, fields, {itemId = randomUUID()} = {}) {
    identity(itemId, 'Item ID'); this.#checkItemFields(fields);
    if (!own(fields, 'text')) fail('Item text is required.');
    this.#change(id, (list, stamp) => {
      const existing = list.items.findIndex(item => item.id === itemId);
      if (existing >= 0 && hasItemContent(list.items[existing], list.purge) && Object.keys(list.items[existing].fields).length) fail('Item ID already exists; restore the existing item.');
      const purge = existing >= 0 ? list.items[existing].purge : null;
      if (existing >= 0) list.items.splice(existing, 1);
      const data = {text: fields.text, quantity: '', note: '', section: '', addedBy: '', checked: false, ...fields, added: stamp, customPosition: appendPosition(list, stamp, itemId)};
      list.items.push({id: itemId, life: {value: true, stamp}, purge, fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, {value, stamp}]))});
      list.life = {value: true, stamp};
    });
    return itemId;
  }
  #checkItemFields(fields) {
    if (!object(fields)) fail('Item fields must be an object.');
    for (const [key, value] of Object.entries(fields)) {
      if (!own(itemTypes, key) || (key === 'added' || key === 'customPosition') || typeof value !== itemTypes[key]) fail('Invalid item field.');
    }
  }
  editItem(id, itemId, fields) {
    this.#checkItemFields(fields);
    return this.#change(id, (list, stamp) => {
      const item = list.items.find(item => item.id === itemId) ?? fail('Item not found.');
      if (item.purge && (!hasItemContent(item, list.purge) || !Object.keys(item.fields).length)) fail('Item was emptied from Trash; add a new item.');
      for (const [key, value] of Object.entries(fields)) item.fields[key] = {value, stamp};
      item.life = {value: true, stamp}; list.life = {value: true, stamp};
    });
  }
  moveItem(id, itemId, {beforeId = null} = {}) {
    return this.#change(id, (list, stamp) => {
      const items = list.items.filter(item => item.life.value && hasItemContent(item, list.purge) && Object.keys(item.fields).length).sort(compareCustom);
      const item = items.find(item => item.id === itemId) ?? fail('Active item not found.');
      if (beforeId === itemId) fail('An item cannot be moved before itself.');
      const remaining = items.filter(item => item.id !== itemId);
      const index = beforeId === null ? remaining.length : remaining.findIndex(item => item.id === beforeId);
      if (index < 0) fail('Move target not found.');
      const lower = index ? customPosition(remaining[index - 1]) : null;
      const upper = index < remaining.length ? customPosition(remaining[index]) : null;
      item.fields.customPosition = {value: positionBetween(lower, upper) + stampPosition(stamp, itemId), stamp};
      item.life = {value: true, stamp};
      list.life = {value: true, stamp};
    });
  }
  setChecked(id, itemId, checked) { return this.editItem(id, itemId, {checked}); }
  deleteItem(id, itemId) {
    return this.#change(id, (list, stamp) => {
      const item = list.items.find(item => item.id === itemId) ?? fail('Item not found.');
      if (!hasItemContent(item, list.purge) || !Object.keys(item.fields).length) fail('Item was emptied from Trash.');
      item.life = {value: false, stamp}; list.life = {value: true, stamp};
    });
  }
  restoreItem(id, itemId) { return this.editItem(id, itemId, {}); }
  deleteList(id) { return this.#change(id, (list, stamp) => { list.life = {value: false, stamp}; }); }
  restoreList(id) {
    if (!Object.keys(this.#get(id).fields).length) fail('List was emptied from Trash; create a new list.');
    return this.#change(id, (list, stamp) => { list.life = {value: true, stamp}; });
  }
  emptyTrash(id) {
    const result = this.#change(id, (list, stamp) => {
      if (!list.life.value) {
        list.fields = {}; list.sections = {}; list.items = []; list.purge = stamp; list.life = {value: false, stamp};
      } else {
        for (const item of list.items) if (!item.life.value) {
          item.fields = {}; item.purge = stamp; item.life = {value: false, stamp}; delete item.pendingLife;
        }
      }
    });
    // Purged content must not linger in undo history or be recoverable by Undo.
    this.#history.delete(id);
    return result;
  }
  undo(id) {
    const current = this.#get(id);
    const history = this.#history.get(id);
    if (!history?.length) return false;
    const {before, after} = history.at(-1);
    const stamp = this.#stamp();
    const restored = clone(current);

    // Use the original operation's footprint, not changes left by later undos.
    // In particular, never re-stamp unrelated fields or existing tombstones.
    const compensate = (previous, written, currentEntry, fallback) => {
      if (!previous) return {value: clone(fallback), stamp};
      if (sameValue(previous.value, written.value)) {
        // A later undo may already have compensated this register. Keep that
        // newer compensation rather than exposing a previously undone edit.
        return clone(compareStamps(currentEntry.stamp, written.stamp) === 0 ? previous : currentEntry);
      }
      return {value: clone(previous.value), stamp};
    };
    const undoFields = (target, previous, written, defaults) => {
      for (const [key, entry] of Object.entries(written)) {
        const old = own(previous, key) ? previous[key] : undefined;
        if (old && compareStamps(old.stamp, entry.stamp) === 0) continue;
        Object.defineProperty(target, key, {
          value: compensate(old, entry, target[key], own(defaults, key) ? defaults[key] : null),
          enumerable: true, writable: true, configurable: true,
        });
      }
    };
    if (compareStamps(before.life.stamp, after.life.stamp)) {
      restored.life = compensate(before.life, after.life, restored.life);
    }
    undoFields(restored.fields, before.fields, after.fields, {name: '', sort: 'alphabetical', sectionsEnabled: false});
    undoFields(restored.sections, before.sections, after.sections, {});
    const previousItems = new Map(before.items.map(item => [item.id, item]));
    const targets = new Map(restored.items.map(item => [item.id, item]));
    for (const item of after.items) {
      const previous = previousItems.get(item.id);
      const target = targets.get(item.id);
      if (!previous || ((!hasItemContent(previous, before.purge) || !Object.keys(previous.fields).length) && Object.keys(item.fields).length)) {
        target.fields = {};
        target.life = {value: false, stamp};
        target.purge = stamp;
        delete target.pendingLife;
        continue;
      }
      if (compareStamps(previous.life.stamp, item.life.stamp)) {
        target.life = compensate(previous.life, item.life, target.life);
      }
      undoFields(target.fields, previous.fields, item.fields, {
        text: '', quantity: '', note: '', section: '', addedBy: '', checked: false, customPosition: customPosition(previous),
      });
    }
    history.pop();
    this.#lists.set(id, canonical(restored));
    return true;
  }
  importList(list) {
    validate(list); this.#observe(list);
    const existing = this.#lists.get(list.id);
    const merged = existing ? mergeLists(existing, list) : canonical(list);
    this.#lists.set(list.id, merged); this.#history.delete(list.id);
    return this.getList(list.id);
  }
  load(json) { return this.importList(deserializeList(json)); }
  save(id) { return serializeList(this.#get(id)); }
}
