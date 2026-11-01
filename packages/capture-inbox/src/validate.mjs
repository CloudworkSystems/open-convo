import { LIMITS, SCHEMA_VERSION, fail } from './errors.mjs';
import { parseInstant } from './instant.mjs';

const DROP_FIELDS = new Set(['schemaVersion', 'items', 'known']);
const ITEM_FIELDS = new Set(['id', 'name', 'addedAt', 'kind', 'text', 'file']);
const FILE_FIELDS = new Set(['sizeBytes', 'type', 'sha256']);

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function quoted(value) {
  return JSON.stringify(value);
}

function rejectUnknown(object, allowed, where) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) fail(`${where}: unknown field ${quoted(key)}.`);
  }
}

function wholeNonNegative(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0);
}

function itemWhere(index) {
  return `items, item ${index + 1}`;
}

function readFileObject(file, where) {
  if (!plainObject(file)) fail(`${where}: file must be an object.`);
  rejectUnknown(file, FILE_FIELDS, `${where}, file`);
  if (!own(file, 'sizeBytes')) fail(`${where}: file.sizeBytes is missing.`);
  if (!own(file, 'type')) fail(`${where}: file.type is missing.`);
  if (!wholeNonNegative(file.sizeBytes)) fail(`${where}: file.sizeBytes must be a whole number of 0 or more.`);
  if (typeof file.type !== 'string' || file.type.length === 0) fail(`${where}: file.type must be text.`);
  let sha256 = null;
  if (own(file, 'sha256')) {
    if (typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      fail(`${where}: file.sha256 must be 64 lowercase hex characters.`);
    }
    sha256 = file.sha256;
  }
  return { sizeBytes: file.sizeBytes, type: file.type, sha256 };
}

function readItem(item, index, seen) {
  const where = itemWhere(index);
  if (!plainObject(item)) fail(`${where}: expected an object.`);
  rejectUnknown(item, ITEM_FIELDS, where);
  for (const key of ['id', 'name', 'addedAt', 'kind']) {
    if (!own(item, key)) fail(`${where}: ${key} is missing.`);
  }
  if (typeof item.id !== 'string') fail(`${where}: id must be text.`);
  if (item.id.length < 1 || item.id.length > LIMITS.id) fail(`${where}: id must be 1 to 200 characters.`);
  if (seen.has(item.id)) fail(`${where}: repeated id ${quoted(item.id)}.`);
  seen.add(item.id);
  if (typeof item.name !== 'string') fail(`${where}: name must be text.`);
  const instant = parseInstant(item.addedAt);
  if (instant === null) fail(`${where}: addedAt must be an RFC 3339 instant with an offset or Z.`);
  if (item.kind !== 'text' && item.kind !== 'file') fail(`${where}: kind must be text or file.`);

  if (item.kind === 'text') {
    if (own(item, 'file')) fail(`${where}: unknown field "file".`);
    if (!own(item, 'text')) fail(`${where}: text is missing.`);
    if (typeof item.text !== 'string') fail(`${where}: text must be text.`);
    const bytes = Buffer.byteLength(item.text, 'utf8');
    if (bytes > LIMITS.textBytes) {
      fail(`${where}: text is ${bytes} bytes; the limit is ${LIMITS.textBytes} bytes (64 KB).`);
    }
    return {
      id: item.id,
      name: item.name,
      addedAt: item.addedAt,
      instant,
      kind: 'text',
      text: item.text,
    };
  }

  if (own(item, 'text')) fail(`${where}: unknown field "text".`);
  if (!own(item, 'file')) fail(`${where}: file is missing.`);
  return {
    id: item.id,
    name: item.name,
    addedAt: item.addedAt,
    instant,
    kind: 'file',
    file: readFileObject(item.file, where),
  };
}

export function validateDrop(drop) {
  if (!plainObject(drop)) fail('drop: the drop must be a JSON object.');
  let encoded;
  try {
    encoded = JSON.stringify(drop);
  } catch {
    fail('drop: the drop must be a JSON object.');
  }
  if (typeof encoded !== 'string') fail('drop: the drop must be a JSON object.');
  const bytes = Buffer.byteLength(encoded);
  if (bytes > LIMITS.fileBytes) {
    fail(`drop: the drop is ${bytes} bytes; the limit is ${LIMITS.fileBytes} bytes (8 MB).`);
  }
  rejectUnknown(drop, DROP_FIELDS, 'drop');
  if (!Object.is(drop.schemaVersion, SCHEMA_VERSION)) fail('drop: schemaVersion must be 1.');
  if (!own(drop, 'items')) fail('drop: items is missing.');
  if (!Array.isArray(drop.items)) fail('drop: items must be a list.');
  if (drop.items.length > LIMITS.items) fail(`items: ${drop.items.length} items; the limit is ${LIMITS.items}.`);
  if (!own(drop, 'known')) fail('drop: known is missing.');
  if (!Array.isArray(drop.known)) fail('drop: known must be a list.');
  if (drop.known.length > LIMITS.known) fail(`known: ${drop.known.length} items; the limit is ${LIMITS.known}.`);

  const seen = new Set();
  const items = drop.items.map((item, index) => readItem(item, index, seen));
  const known = drop.known.map((key, index) => {
    if (typeof key !== 'string') fail(`known, item ${index + 1}: sourceKey must be text.`);
    return key;
  });
  return { items, known };
}
