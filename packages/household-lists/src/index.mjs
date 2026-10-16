import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const SORT_ORDERS = Object.freeze(['alphabetical', 'section', 'added']);
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
function register(a, b) {
  if (!a) return clone(b);
  if (!b) return clone(a);
  const order = compareStamps(a.stamp, b.stamp);
  if (!order && JSON.stringify(a.value) !== JSON.stringify(b.value)) fail('Conflicting values share a version stamp. Use a unique device ID per writer.');
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
function mergeItem(a, b, listPurge) {
  if (!a) a = {id: b.id, fields: {}, life: b.life, purge: null};
  if (!b) b = {id: a.id, fields: {}, life: a.life, purge: null};
  const ownPurge = latest(a.purge, b.purge);
  const purge = latest(ownPurge, listPurge);
  const life = register(a.life, b.life);
  if (compareStamps(life.stamp, purge) <= 0) return {id: a.id, fields: {}, life: {value: false, stamp: clone(purge)}, purge: clone(purge)};
  return {id: a.id, fields: records(a.fields, b.fields, purge), life, purge: clone(ownPurge)};
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
  return canonical(result);
}

function validStamp(stamp) {
  return object(stamp) && Number.isSafeInteger(stamp.counter) && stamp.counter > 0 &&
    Number.isSafeInteger(stamp.time) && typeof stamp.device === 'string' && stamp.device.length > 0;
}
const itemTypes = {text: 'string', quantity: 'string', note: 'string', section: 'string', addedBy: 'string', checked: 'boolean', added: 'stamp'};
const listTypes = {name: 'string', sort: 'sort'};
function validateFields(fields, types) {
  if (!object(fields)) fail('Invalid fields in list file.');
  for (const [key, entry] of Object.entries(fields)) {
    if (!own(types, key) || !object(entry) || !validStamp(entry.stamp)) fail('Invalid field or version stamp in list file.');
    const type = types[key];
    if (type === 'stamp' ? !validStamp(entry.value) : type === 'sort' ? !SORT_ORDERS.includes(entry.value) : typeof entry.value !== type) fail('Invalid field value in list file.');
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
  for (const item of list.items) {
    validateRecord(item, itemTypes);
    if (ids.has(item.id)) fail('Duplicate item ID in list file.');
    ids.add(item.id);
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
    result.push(item.life.stamp, item.purge);
    for (const entry of Object.values(item.fields)) { result.push(entry.stamp); if (validStamp(entry.value)) result.push(entry.value); }
  }
  return result.filter(Boolean);
}
const values = fields => Object.fromEntries(Object.entries(fields).map(([key, entry]) => [key, clone(entry.value)]));
function itemView(item) {
  const {added, ...fields} = values(item.fields);
  return {id: item.id, ...fields};
}
export function viewList(list, {trash = false} = {}) {
  validate(list);
  const fields = values(list.fields);
  const items = list.items.filter(item => item.life.value !== trash && Object.keys(item.fields).length).slice();
  const order = (a, b) => compareStamps(a.fields.added?.value, b.fields.added?.value) || lex(a.id, b.id);
  const alpha = (a, b) => lex(sortKey(a.fields.text?.value ?? ''), sortKey(b.fields.text?.value ?? '')) || order(a, b);
  items.sort(fields.sort === 'added' ? order : fields.sort === 'section' ? (a, b) => {
    const sa = normalized(a.fields.section?.value ?? '').trim();
    const sb = normalized(b.fields.section?.value ?? '').trim();
    return lex(!sa, !sb) || lex(sa, sb) || alpha(a, b);
  } : alpha);
  return {id: list.id, name: fields.name ?? '', sort: fields.sort ?? 'alphabetical', deleted: !list.life.value, sectionMap: {...STARTER_SECTIONS, ...Object.fromEntries(Object.entries(values(list.sections)).filter(([, value]) => value !== null))}, items: items.map(itemView)};
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
    history.push(clone(before));
    if (history.length > this.undoLimit) history.shift();
    this.#history.set(id, history); this.#lists.set(id, canonical(draft));
    return this.getList(id);
  }
  createList(name, {id = randomUUID()} = {}) {
    string(name, 'List name'); identity(id, 'List ID');
    if (this.#lists.has(id)) fail('List ID already exists; restore the existing list.');
    const stamp = this.#stamp();
    this.#lists.set(id, {schemaVersion: SCHEMA_VERSION, id, life: {value: true, stamp}, purge: null,
      fields: {name: {value: name, stamp}, sort: {value: 'alphabetical', stamp}}, sections: {}, items: []});
    return id;
  }
  getList(id) { return clone(this.#get(id)); }
  listIds({trash = false} = {}) { return [...this.#lists.values()].filter(list => list.life.value !== trash && Object.keys(list.fields).length).map(list => list.id).sort(); }
  view(id, options) { return viewList(this.#get(id), options); }
  renameList(id, name) { string(name, 'List name'); return this.#change(id, (list, stamp) => { list.fields.name = {value: name, stamp}; list.life = {value: true, stamp}; }); }
  setSort(id, sort) {
    if (!SORT_ORDERS.includes(sort)) fail('Unknown sort order.');
    return this.#change(id, (list, stamp) => { list.fields.sort = {value: sort, stamp}; list.life = {value: true, stamp}; });
  }
  setSectionWord(id, word, section) {
    identity(word, 'Section word'); string(section, 'Section'); const key = sortKey(word);
    return this.#change(id, (list, stamp) => { Object.defineProperty(list.sections, key, {value: {value: section, stamp}, enumerable: true, writable: true, configurable: true}); list.life = {value: true, stamp}; });
  }
  suggestSection(id, text) {
    const map = this.view(id).sectionMap; const key = sortKey(text);
    return own(map, key) ? map[key] : null;
  }
  addItem(id, fields, {itemId = randomUUID()} = {}) {
    identity(itemId, 'Item ID'); this.#checkItemFields(fields);
    if (!own(fields, 'text')) fail('Item text is required.');
    this.#change(id, (list, stamp) => {
      const existing = list.items.findIndex(item => item.id === itemId);
      if (existing >= 0 && Object.keys(list.items[existing].fields).length) fail('Item ID already exists; restore the existing item.');
      const purge = existing >= 0 ? list.items[existing].purge : null;
      if (existing >= 0) list.items.splice(existing, 1);
      const data = {text: fields.text, quantity: '', note: '', section: '', addedBy: '', checked: false, ...fields, added: stamp};
      list.items.push({id: itemId, life: {value: true, stamp}, purge, fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, {value, stamp}]))});
      list.life = {value: true, stamp};
    });
    return itemId;
  }
  #checkItemFields(fields) {
    if (!object(fields)) fail('Item fields must be an object.');
    for (const [key, value] of Object.entries(fields)) {
      if (!own(itemTypes, key) || key === 'added' || typeof value !== itemTypes[key]) fail('Invalid item field.');
    }
  }
  editItem(id, itemId, fields) {
    this.#checkItemFields(fields);
    return this.#change(id, (list, stamp) => {
      const item = list.items.find(item => item.id === itemId) ?? fail('Item not found.');
      if (item.purge && !Object.keys(item.fields).length) fail('Item was emptied from Trash; add a new item.');
      for (const [key, value] of Object.entries(fields)) item.fields[key] = {value, stamp};
      item.life = {value: true, stamp}; list.life = {value: true, stamp};
    });
  }
  setChecked(id, itemId, checked) { return this.editItem(id, itemId, {checked}); }
  deleteItem(id, itemId) {
    return this.#change(id, (list, stamp) => {
      const item = list.items.find(item => item.id === itemId) ?? fail('Item not found.');
      if (!Object.keys(item.fields).length) fail('Item was emptied from Trash.');
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
          item.fields = {}; item.purge = stamp; item.life = {value: false, stamp};
        }
      }
    });
    // Purged content must not linger in undo history or be recoverable by Undo.
    this.#history.delete(id);
    return result;
  }
  undo(id) {
    const current = this.#get(id); const history = this.#history.get(id);
    if (!history?.length) return false;
    const before = history.at(-1); const stamp = this.#stamp(); const restored = clone(before);
    const rewrite = entry => ({value: clone(entry.value), stamp});
    restored.life = rewrite(before.life);
    for (const key of Object.keys(restored.fields)) restored.fields[key] = rewrite(restored.fields[key]);
    // Null removes a custom override and reveals the starter entry, if any.
    for (const key of Object.keys(current.sections)) if (!own(restored.sections, key)) Object.defineProperty(restored.sections, key, {value: {value: null, stamp}, enumerable: true, writable: true, configurable: true});
    for (const key of Object.keys(restored.sections)) restored.sections[key] = rewrite(restored.sections[key]);
    for (const item of restored.items) {
      item.life = rewrite(item.life);
      for (const key of Object.keys(item.fields)) if (key !== 'added') item.fields[key] = rewrite(item.fields[key]);
    }
    for (const item of current.items) if (!restored.items.some(previous => previous.id === item.id)) restored.items.push({id: item.id, fields: {}, life: {value: false, stamp}, purge: stamp});
    history.pop(); this.#lists.set(id, canonical(restored)); return true;
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
