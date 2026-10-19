import test from 'node:test';
import assert from 'node:assert/strict';
import {HouseholdLists, mergeLists, viewList, deserializeList} from '../src/index.mjs';
const make = deviceId => new HouseholdLists({deviceId, now: () => 100});
const ids = (engine, id) => engine.view(id).items.map(item => item.id);
function fixture() {
  const a = make('a'), id = a.createList('Maple groceries', {id: 'groceries'});
  for (const [itemId, text] of [['milk', 'Milk'], ['apples', 'Apples'], ['bread', 'Bread'], ['dates', 'Dates']]) a.addItem(id, {text}, {itemId});
  const b = make('b'); b.importList(a.getList(id)); return {a, b, id};
}
function merge(a, b, id) {
  const x = a.getList(id), y = b.getList(id), result = mergeLists(x, y);
  assert.deepEqual(result, mergeLists(y, x)); assert.deepEqual(mergeLists(result, result), result);
  return result;
}
function assertDeleted(snapshot, itemId) {
  assert.ok(!viewList(snapshot).items.some(item => item.id === itemId));
  assert.ok(!viewList(snapshot, {trash: true}).items.some(item => item.id === itemId));
  assert.equal(snapshot.items.find(item => item.id === itemId).life.value, false);
}

test('purged item stays deleted when an offline phone checks it at a higher counter', () => {
  const {a, b, id} = fixture();
  a.deleteItem(id, 'milk'); a.emptyTrash(id);
  for (let i = 0; i < 6; i++) b.editItem(id, 'apples', {note: `${i}`});
  b.setChecked(id, 'milk', true);
  const snapshot = merge(a, b, id); assertDeleted(snapshot, 'milk');
  const c = make('c'); c.load(JSON.stringify(snapshot)); c.importList(b.getList(id));
  assertDeleted(c.getList(id), 'milk');
});

test('undoing an add cannot be reversed by a later offline check', () => {
  const {a, b, id} = fixture();
  a.addItem(id, {text: 'Eggs'}, {itemId: 'eggs'}); b.importList(a.getList(id));
  a.undo(id);
  for (let i = 0; i < 5; i++) b.editItem(id, 'apples', {note: `${i}`});
  b.setChecked(id, 'eggs', true);
  assertDeleted(merge(a, b, id), 'eggs');
});

test('purge, delayed check and full re-add converge under every three-copy delivery order', () => {
  const {a, b, id} = fixture(); a.deleteItem(id, 'milk'); a.emptyTrash(id);
  const c = make('c'); c.importList(a.getList(id));
  c.addItem(id, {text: 'Fresh milk', quantity: '2'}, {itemId: 'milk'});
  for (let i = 0; i < 6; i++) b.editItem(id, 'apples', {note: `${i}`});
  b.setChecked(id, 'milk', true);
  const copies = [a, b, c].map(engine => engine.getList(id));
  const expected = mergeLists(copies[0], mergeLists(copies[1], copies[2]));
  for (const [i, j, k] of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(mergeLists(mergeLists(copies[i], copies[j]), copies[k]), expected);
  }
  const milk = viewList(expected).items.find(item => item.id === 'milk');
  assert.equal(milk.text, 'Fresh milk'); assert.equal(milk.quantity, '2');
  assert.equal(milk.checked, true);
});

test('plan test 4: custom starts as added, keeps moves through edits/checks, appends new items', () => {
  const {a, id} = fixture();
  assert.equal(a.view(id).sort, 'alphabetical'); assert.equal(a.view(id).sectionsEnabled, false);
  a.setSort(id, 'custom'); assert.deepEqual(ids(a, id), ['milk', 'apples', 'bread', 'dates']);
  a.moveItem(id, 'dates', {beforeId: 'apples'});
  a.editItem(id, 'dates', {text: 'Zucchini'}); a.setChecked(id, 'dates', true); a.setChecked(id, 'dates', false);
  assert.deepEqual(ids(a, id), ['milk', 'dates', 'apples', 'bread']);
  a.addItem(id, {text: 'Avocado'}, {itemId: 'avocado'});
  assert.deepEqual(ids(a, id), ['milk', 'dates', 'apples', 'bread', 'avocado']);
  a.moveItem(id, 'milk'); assert.deepEqual(ids(a, id), ['dates', 'apples', 'bread', 'avocado', 'milk']);
  a.addItem(id, {text: 'Beans'}, {itemId: 'beans'}); assert.equal(ids(a, id).at(-1), 'beans');
  a.setSort(id, 'added'); assert.deepEqual(ids(a, id), ['milk', 'apples', 'bread', 'dates', 'avocado', 'beans']);
  a.setSort(id, 'custom'); assert.deepEqual(ids(a, id), ['dates', 'apples', 'bread', 'avocado', 'milk', 'beans']);
});

test('custom moves to different items survive merging and same-item moves use the higher stamp', () => {
  const {a, b, id} = fixture(); a.setSort(id, 'custom'); b.importList(a.getList(id));
  a.moveItem(id, 'dates', {beforeId: 'apples'}); b.moveItem(id, 'bread', {beforeId: 'milk'});
  a.importList(merge(a, b, id)); assert.deepEqual(ids(a, id), ['bread', 'milk', 'dates', 'apples']);
  b.importList(a.getList(id)); a.moveItem(id, 'milk'); b.moveItem(id, 'milk', {beforeId: 'bread'});
  a.importList(merge(a, b, id)); assert.equal(ids(a, id)[0], 'milk');
});

test('custom positions round-trip and undo; invalid moves are atomic and managed fields are protected', () => {
  const {a, id} = fixture(); a.setSort(id, 'custom'); const before = a.view(id);
  a.moveItem(id, 'dates', {beforeId: 'milk'});
  const c = make('c'); c.load(a.save(id)); assert.deepEqual(c.view(id), a.view(id));
  c.importList(a.getList(id)); a.undo(id); c.importList(a.getList(id)); assert.deepEqual(c.view(id), before);
  const snapshot = a.getList(id);
  for (const operation of [() => a.moveItem(id, 'missing'), () => a.moveItem(id, 'milk', {beforeId: 'missing'}), () => a.moveItem(id, 'milk', {beforeId: 'milk'}), () => a.editItem(id, 'milk', {customPosition: 'V'})]) assert.throws(operation);
  assert.deepEqual(a.getList(id), snapshot);
  a.deleteItem(id, 'milk'); const deleted = a.getList(id); assert.throws(() => a.moveItem(id, 'milk')); assert.deepEqual(a.getList(id), deleted);
  a.restoreItem(id, 'milk'); assert.deepEqual(ids(a, id), before.items.map(item => item.id));
});

test('legacy items start custom in first-added order and can be moved, undone and extended', () => {
  const {a, id} = fixture(); const legacy = a.getList(id);
  for (const item of legacy.items) delete item.fields.customPosition;
  const c = make('c'); c.importList(legacy); c.setSort(id, 'custom'); const before = c.view(id);
  assert.deepEqual(ids(c, id), ['milk', 'apples', 'bread', 'dates']);
  c.moveItem(id, 'dates', {beforeId: 'milk'}); c.undo(id); assert.deepEqual(c.view(id), before);
  c.addItem(id, {text: 'Eggs'}, {itemId: 'eggs'}); assert.equal(ids(c, id).at(-1), 'eggs');
  const malformed = c.getList(id); malformed.items.find(item => item.id === 'eggs').fields.customPosition.value = '!';
  assert.throws(() => deserializeList(JSON.stringify(malformed)), /Invalid field value/);
});

test('turning sections off saves A-to-Z, enabling does not restore section sort, and undo restores both settings', () => {
  const {a, b, id} = fixture(); a.setSectionsEnabled(id, true); a.setSort(id, 'section');
  const before = a.view(id); a.setSectionsEnabled(id, false);
  assert.equal(a.getList(id).fields.sort.value, 'alphabetical');
  b.importList(a.getList(id)); a.undo(id); b.importList(a.getList(id)); assert.deepEqual(b.view(id), before);
  a.setSectionsEnabled(id, false); const c = make('c'); c.load(a.save(id)); c.setSectionsEnabled(id, true);
  assert.equal(c.view(id).sort, 'alphabetical');
});

test('concurrent moves into the same gap have distinct keys and support repeated insertion', () => {
  const {a, b, id} = fixture(); a.setSort(id, 'custom'); b.importList(a.getList(id));
  a.moveItem(id, 'dates', {beforeId: 'apples'}); b.moveItem(id, 'bread', {beforeId: 'apples'});
  a.importList(merge(a, b, id));
  assert.deepEqual(ids(a, id), ['milk', 'dates', 'bread', 'apples']);
  const positions = a.getList(id).items.map(item => item.fields.customPosition.value);
  assert.equal(new Set(positions).size, positions.length);
  for (let step = 0; step < 60; step++) {
    const order = ids(a, id), moving = order.at(-1), target = order[1];
    a.moveItem(id, moving, {beforeId: target});
    assert.deepEqual(ids(a, id), [order[0], moving, ...order.slice(1, -1)]);
  }
  const c = make('c'); c.load(a.save(id)); assert.deepEqual(c.view(id), a.view(id));
});

test('undo of a custom move preserves another item move on an offline phone', () => {
  const {a, b, id} = fixture(); a.setSort(id, 'custom'); b.importList(a.getList(id));
  b.moveItem(id, 'bread', {beforeId: 'milk'});
  a.moveItem(id, 'dates', {beforeId: 'apples'}); a.undo(id);
  a.importList(merge(a, b, id)); assert.deepEqual(ids(a, id), ['bread', 'milk', 'apples', 'dates']);
});

test('suppressed post-purge edits cannot be restored or moved, but permit a full re-add', () => {
  const {a, b, id} = fixture(); a.deleteItem(id, 'milk'); a.emptyTrash(id);
  for (let i = 0; i < 6; i++) b.editItem(id, 'apples', {note: `${i}`});
  b.editItem(id, 'milk', {text: 'Offline milk', note: 'Later note'});
  a.importList(merge(a, b, id)); assertDeleted(a.getList(id), 'milk');
  assert.throws(() => a.restoreItem(id, 'milk'), /emptied/); assert.throws(() => a.moveItem(id, 'milk'), /Active item/);
  a.addItem(id, {text: 'Whole new milk'}, {itemId: 'milk'});
  const item = a.view(id).items.find(item => item.id === 'milk');
  assert.equal(item.text, 'Whole new milk'); assert.equal(item.note, '');
  a.undo(id); assertDeleted(a.getList(id), 'milk');
});
