import test from 'node:test';
import assert from 'node:assert/strict';
import {HouseholdLists, mergeLists, viewList, deserializeList} from '../src/index.mjs';
function pair() {
  const a = new HouseholdLists({deviceId: 'a', now: () => 100});
  const id = a.createList('Maple groceries', {id: 'groceries'});
  a.addItem(id, {text: 'Milk'}, {itemId: 'milk'});
  a.addItem(id, {text: 'Apples'}, {itemId: 'apples'});
  const b = new HouseholdLists({deviceId: 'b', now: () => 100});
  b.importList(a.getList(id)); return {a, b, id};
}
function merged(a, b, id) {
  const x = a.getList(id), y = b.getList(id), result = mergeLists(x, y);
  assert.deepEqual(result, mergeLists(y, x));
  assert.deepEqual(mergeLists(result, result), result);
  return viewList(result);
}
test('unrelated undo preserves concurrent checking, text, item deletion and list deletion', async t => {
  const edits = {
    check: (b, id) => b.setChecked(id, 'milk', true),
    text: (b, id) => b.editItem(id, 'milk', {text: 'Oat milk'}),
    deleteItem: (b, id) => b.deleteItem(id, 'milk'),
    deleteList: (b, id) => b.deleteList(id),
  };
  const unrelated = {
    rename: (a, id) => a.renameList(id, 'Weekly'),
    sort: (a, id) => a.setSort(id, 'added'),
    sectionWord: (a, id) => a.setSectionWord(id, 'tofu', 'chilled'),
    otherItem: (a, id) => a.editItem(id, 'apples', {note: 'For pie'}),
  };
  for (const [change, edit] of Object.entries(edits)) {
    for (const [action, operation] of Object.entries(unrelated)) {
      await t.test(`${action} undo versus ${change}`, () => {
        const {a, b, id} = pair(); edit(b, id); operation(a, id); a.undo(id);
        assert.deepEqual(merged(a, b, id), b.view(id));
      });
    }
  }
});
test('undo text compensates text only and preserves concurrent check on the same item', () => {
  const {a, b, id} = pair(); const before = a.getList(id);
  b.setChecked(id, 'milk', true); a.editItem(id, 'milk', {text: 'Cream'}); a.undo(id);
  const result = merged(a, b, id).items.find(i => i.id === 'milk');
  assert.equal(result.text, 'Milk'); assert.equal(result.checked, true);
  const after = a.getList(id); assert.deepEqual(after.life, before.life);
  const oldMilk = before.items.find(i => i.id === 'milk'), milk = after.items.find(i => i.id === 'milk');
  assert.deepEqual(milk.life, oldMilk.life); assert.deepEqual(milk.fields.checked, oldMilk.fields.checked);
  assert.ok(milk.fields.text.stamp.counter > oldMilk.fields.text.stamp.counter);
});
test('sequential undos preserve earlier addition tombstones without re-stamping them', () => {
  const {a, b, id} = pair(); a.renameList(id, 'Weekly');
  a.addItem(id, {text: 'Bread'}, {itemId: 'bread'}); b.importList(a.getList(id)); a.undo(id);
  const marker = a.getList(id).items.find(i => i.id === 'bread'); a.undo(id);
  assert.deepEqual(a.getList(id).items.find(i => i.id === 'bread'), marker);
  assert.ok(!merged(a, b, id).items.some(i => i.id === 'bread'));
  assert.equal(a.view(id).name, 'Maple groceries');
});
test('stamp-valued registers compare structurally across JSON key orders', () => {
  const {a, id} = pair(); const original = a.getList(id);
  const reordered = JSON.parse(a.save(id), (key, value) => {
    if (value && typeof value === 'object' && Object.hasOwn(value, 'counter')) return {device: value.device, time: value.time, counter: value.counter};
    return value;
  });
  assert.deepEqual(mergeLists(original, reordered), original);
  assert.deepEqual(mergeLists(reordered, original), original);
  const corrupt = structuredClone(original); corrupt.items[0].fields.added.value = {...corrupt.items[0].fields.added.value, counter: corrupt.items[0].fields.added.value.counter + 1};
  assert.throws(() => mergeLists(original, corrupt), /Conflicting values/);
});
test('suggestions prefer exact phrases then whole words, never substrings or assignments', () => {
  const {a, id} = pair(); a.setSectionsEnabled(id, true); const before = a.view(id).items;
  for (const text of ['Oat milk', 'Greek yogurt', 'milk 2%', '2 OAT MÍLK', 'milk, 2%']) assert.equal(a.suggestSection(id, text), 'dairy', text);
  assert.equal(a.suggestSection(id, 'silk milkweed'), null);
  a.setSectionWord(id, 'oat milk', 'plant-based'); assert.equal(a.suggestSection(id, '2 Oat milk'), 'plant-based');
  a.setSectionWord(id, 'milk', 'chilled'); assert.equal(a.suggestSection(id, 'Chocolate milk'), 'chilled');
  a.setSectionWord(id, 'oat milk', ''); assert.equal(a.suggestSection(id, 'Oat milk'), '');
  assert.deepEqual(a.view(id).items, before);
});
test('sections default off; toggles preserve saved sections/sort with alphabetical fallback', () => {
  const {a, id} = pair();
  a.editItem(id, 'milk', {section: 'dairy'}); a.editItem(id, 'apples', {section: 'produce'}); a.setSectionWord(id, 'tofu', 'chilled');
  const stored = a.getList(id), off = a.view(id);
  assert.equal(off.sectionsEnabled, false); assert.deepEqual(off.availableSortOrders, ['alphabetical', 'added', 'custom']);
  assert.deepEqual(off.sectionMap, {}); assert.ok(off.items.every(i => i.section === ''));
  assert.equal(a.suggestSection(id, 'Milk'), null); assert.throws(() => a.setSort(id, 'section'), /disabled/i);
  a.setSectionsEnabled(id, true); a.setSort(id, 'section'); const on = a.view(id);
  assert.equal(on.sectionsEnabled, true); assert.deepEqual(on.availableSortOrders, ['alphabetical', 'section', 'added', 'custom']);
  assert.deepEqual(on.items.map(i => i.id), ['milk', 'apples']); assert.equal(a.suggestSection(id, 'tofu'), 'chilled');
  a.setSectionsEnabled(id, false);
  assert.equal(a.view(id).sort, 'alphabetical'); assert.deepEqual(a.view(id).items.map(i => i.id), ['apples', 'milk']);
  assert.equal(a.getList(id).fields.sort.value, 'alphabetical'); assert.deepEqual(a.getList(id).items, stored.items); assert.deepEqual(a.getList(id).sections, stored.sections);
  a.setSectionsEnabled(id, true); assert.equal(a.view(id).sort, 'alphabetical');
  assert.deepEqual(a.view(id).sectionMap, on.sectionMap);
  assert.deepEqual(a.view(id).items, on.items.slice().sort((a, b) => a.text.localeCompare(b.text)));
  a.setSort(id, 'added'); a.setSectionsEnabled(id, false); assert.equal(a.view(id).sort, 'added');
});
test('section setting persists, merges per field, supports undo and is independent per list', () => {
  const {a, b, id} = pair(); const other = a.createList('Hardware');
  a.setSectionsEnabled(id, true); b.setChecked(id, 'milk', true);
  const view = merged(a, b, id); assert.equal(view.sectionsEnabled, true); assert.equal(view.items.find(i => i.id === 'milk').checked, true);
  assert.equal(a.view(other).sectionsEnabled, false);
  const c = new HouseholdLists({deviceId: 'c'}); c.load(a.save(id)); assert.deepEqual(c.getList(id), a.getList(id));
  const before = a.view(id); a.setSectionsEnabled(id, false); a.undo(id); assert.deepEqual(a.view(id), before);
  b.importList(a.getList(id)); b.setSectionsEnabled(id, false); a.importList(b.getList(id)); assert.equal(a.view(id).sectionsEnabled, false);
  const malformed = a.getList(id); malformed.fields.sectionsEnabled.value = 'yes'; assert.throws(() => deserializeList(JSON.stringify(malformed)), /Invalid field value/);
  const snapshot = a.getList(id); assert.throws(() => a.setSectionsEnabled(id, 'yes'), /boolean/i); assert.deepEqual(a.getList(id), snapshot);
});
test('legacy snapshots without a toggle load as off without rewriting the file', () => {
  const {a, id} = pair(); const legacy = a.getList(id); delete legacy.fields.sectionsEnabled; legacy.fields.sort.value = 'section';
  const b = new HouseholdLists({deviceId: 'legacy-reader'}); b.importList(legacy); assert.deepEqual(b.getList(id), legacy);
  assert.equal(b.view(id).sectionsEnabled, false); assert.equal(b.view(id).sort, 'alphabetical'); assert.equal(b.suggestSection(id, 'Milk'), null);
  b.setSectionsEnabled(id, true); assert.equal(b.view(id).sort, 'section'); b.undo(id); assert.equal(b.view(id).sectionsEnabled, false);
});
test('concurrent equal-counter edits with hours of skew resolve by time in both directions', () => {
  const {a, id} = pair(); const b = new HouseholdLists({deviceId: 'z-behind', now: () => -10_000_000}); b.importList(a.getList(id));
  a.editItem(id, 'milk', {text: 'Ahead milk'}); b.editItem(id, 'milk', {text: 'Behind milk'});
  const x = a.getList(id).items.find(i => i.id === 'milk').fields.text.stamp, y = b.getList(id).items.find(i => i.id === 'milk').fields.text.stamp;
  assert.equal(x.counter, y.counter); assert.ok(x.time > y.time); assert.equal(merged(a, b, id).items.find(i => i.id === 'milk').text, 'Ahead milk');
});

test('undoing item deletion preserves another phone text edit and section-map additions', () => {
  const {a, b, id} = pair();
  a.setSectionsEnabled(id, true); b.importList(a.getList(id));
  b.editItem(id, 'milk', {text: 'Brown milk'}); b.setSectionWord(id, 'tofu', 'chilled');
  a.deleteItem(id, 'milk'); a.undo(id);
  const view = merged(a, b, id);
  assert.equal(view.items.find(i => i.id === 'milk').text, 'Brown milk');
  assert.equal(view.sectionMap.tofu, 'chilled');
});

test('concurrent section toggles resolve the same field by stamp and ignore remote grouping while off', () => {
  const {a, b, id} = pair();
  a.setSectionsEnabled(id, true); b.setSectionsEnabled(id, false);
  // Same logical counter and wall clock: device b wins, independently of sort.
  a.setSort(id, 'section'); a.editItem(id, 'milk', {section: 'dairy'});
  const view = merged(a, b, id);
  assert.equal(view.sectionsEnabled, false); assert.equal(view.sort, 'alphabetical');
  assert.deepEqual(view.availableSortOrders, ['alphabetical', 'added', 'custom']);
  assert.ok(view.items.every(item => item.section === ''));
  assert.deepEqual(view.sectionMap, {});
});

test('undoing a prior same-value write keeps later undo compensation against an observed copy', () => {
  const {a, b, id} = pair(); const original = a.view(id);
  a.renameList(id, original.name); // Earlier no-op must not erase the later compensation.
  a.renameList(id, 'Weekly'); b.importList(a.getList(id));
  a.undo(id); const compensation = a.getList(id).fields.name;
  a.undo(id);
  assert.deepEqual(a.getList(id).fields.name, compensation);
  assert.deepEqual(merged(a, b, id), original);
});
