import test from 'node:test';
import assert from 'node:assert/strict';
import {HouseholdLists, mergeLists, serializeList, deserializeList, compareStamps} from '../src/index.mjs';

function engine(deviceId = 'phone-a', time = 100) { return new HouseholdLists({deviceId, now: () => time}); }
function fixture() {
  const a = engine(); const id = a.createList('Maple household groceries', {id: 'groceries'});
  a.addItem(id, {text: 'Milk'}, {itemId: 'milk'});
  a.addItem(id, {text: 'Apples'}, {itemId: 'apples'});
  const b = engine('phone-b'); b.importList(a.getList(id));
  return {a, b, id};
}
function converges(a, b, id) {
  const left = a.getList(id), right = b.getList(id);
  const merged = mergeLists(left, right);
  assert.deepEqual(merged, mergeLists(right, left));
  assert.deepEqual(mergeLists(merged, merged), merged);
  assert.deepEqual(a.getList(id), left); assert.deepEqual(b.getList(id), right);
  return merged;
}

test('add/check/uncheck/edit/delete preserve identity and checking never removes', () => {
  const {a, id} = fixture(); const before = a.view(id).items.map(item => item.id);
  a.setChecked(id, 'milk', true); assert.equal(a.view(id).items.find(i => i.id === 'milk').checked, true);
  assert.deepEqual(a.view(id).items.map(i => i.id), before);
  a.setChecked(id, 'milk', false);
  a.editItem(id, 'milk', {text: 'Oat milk', quantity: '2', note: 'Unsweetened', addedBy: 'Robin', section: 'dairy'});
  assert.equal(a.view(id).items.find(i => i.id === 'milk').quantity, '2');
  a.deleteItem(id, 'milk'); assert.equal(a.view(id).items.length, 1);
  assert.equal(a.view(id, {trash: true}).items[0].id, 'milk');
});

test('alphabetical ignores case, accents, leading quantities and check state', () => {
  const a = engine(); const id = a.createList('Sorting');
  for (const text of ['2 milk', 'Zucchini', 'Éclair', 'apple', 'Banana', '½ cream', '2 x dates', '1/2 flour']) a.addItem(id, {text});
  const expected = ['apple', 'Banana', '½ cream', '2 x dates', 'Éclair', '1/2 flour', '2 milk', 'Zucchini'];
  assert.deepEqual(a.view(id).items.map(i => i.text), expected);
  for (const item of a.view(id).items) a.setChecked(id, item.id, true);
  assert.deepEqual(a.view(id).items.map(i => i.text), expected);
});

test('section grouping, unsectioned last, suggestions never silently assign', () => {
  const a = engine(); const id = a.createList('Sections');
  for (const [text, section] of [['Zebra toy', ''], ['Milk', 'dairy'], ['Butter', 'dairy'], ['Apples', 'produce'], ['Bread', 'bakery']]) a.addItem(id, {text, section});
  a.setSort(id, 'section');
  assert.deepEqual(a.view(id).items.map(i => i.text), ['Bread', 'Butter', 'Milk', 'Apples', 'Zebra toy']);
  assert.equal(a.suggestSection(id, '2 mílk'), 'dairy');
  const before = a.view(id).items;
  a.setSectionWord(id, 'milk', 'chilled'); a.setSectionWord(id, 'tofu', 'chilled');
  assert.equal(a.suggestSection(id, 'tofu'), 'chilled'); assert.deepEqual(a.view(id).items, before);
  a.editItem(id, before[0].id, {section: 'custom'}); assert.equal(a.view(id).items.find(i => i.id === before[0].id).section, 'custom');
});

test('as-added survives text edits, rechecks, trash and restore', () => {
  const {a, id} = fixture(); a.setSort(id, 'added');
  a.editItem(id, 'milk', {text: 'Zebra milk'}); a.setChecked(id, 'milk', true); a.setChecked(id, 'milk', false);
  a.deleteItem(id, 'milk'); a.restoreItem(id, 'milk');
  assert.deepEqual(a.view(id).items.map(i => i.id), ['milk', 'apples']);
});

test('several lists and their settings, history and trash are independent', () => {
  const {a, id} = fixture(); const before = a.getList(id);
  const other = a.createList('Hardware'); a.addItem(other, {text: 'Nails'}); a.setSort(other, 'added'); a.deleteList(other);
  assert.deepEqual(a.getList(id), before); assert.deepEqual(a.listIds(), [id]);
  assert.deepEqual(a.listIds({trash: true}), [other]); a.restoreList(other);
  assert.equal(a.view(other).name, 'Hardware'); a.renameList(other, 'Workshop'); assert.equal(a.view(other).name, 'Workshop');
});

test('undo restores exact user state for all changes and merges as a new change', () => {
  const {a, b, id} = fixture();
  for (const operation of [() => a.renameList(id, 'Changed'), () => a.setSort(id, 'added'), () => a.setSectionWord(id, 'tofu', 'chilled'), () => a.setSectionWord(id, 'milk', 'chilled'), () => a.addItem(id, {text: 'Bread'}), () => a.editItem(id, 'milk', {text: 'Cream'}), () => a.setChecked(id, 'milk', true), () => a.deleteItem(id, 'milk'), () => a.deleteList(id)]) {
    const before = a.view(id); const trash = a.view(id, {trash: true});
    operation(); b.importList(a.getList(id)); assert.equal(a.undo(id), true);
    assert.deepEqual(a.view(id), before); assert.deepEqual(a.view(id, {trash: true}), trash);
    b.importList(a.getList(id)); assert.deepEqual(b.view(id), before);
  }
});

test('undo history is bounded and emptying trash destroys recoverable content', () => {
  const a = new HouseholdLists({deviceId: 'a', undoLimit: 2}); const id = a.createList('Bounded');
  a.renameList(id, 'One'); a.renameList(id, 'Two'); a.renameList(id, 'Three');
  assert.equal(a.undo(id), true); assert.equal(a.undo(id), true); assert.equal(a.undo(id), false);
  const item = a.addItem(id, {text: 'Discard me'}); a.deleteItem(id, item); a.emptyTrash(id);
  assert.equal(a.view(id, {trash: true}).items.length, 0); assert.equal(a.undo(id), false);
  assert.throws(() => a.restoreItem(id, item), /emptied/); assert.ok(!a.save(id).includes('Discard me'));
  a.deleteList(id); a.emptyTrash(id); assert.throws(() => a.restoreList(id), /emptied/);
  assert.deepEqual(a.getList(id).fields, {}); assert.equal(a.getList(id).life.value, false);
});

test('merge preserves different items and check versus text edits', () => {
  const {a, b, id} = fixture(); a.setChecked(id, 'milk', true); b.editItem(id, 'milk', {text: 'Oat milk'}); b.editItem(id, 'apples', {quantity: '4'});
  const merged = converges(a, b, id); a.importList(merged);
  const milk = a.view(id).items.find(i => i.id === 'milk'); assert.equal(milk.checked, true); assert.equal(milk.text, 'Oat milk');
  assert.equal(a.view(id).items.find(i => i.id === 'apples').quantity, '4');
});

test('same-field and same-time conflicts use device ID final tie-breaker', () => {
  const {a, b, id} = fixture(); a.editItem(id, 'milk', {text: 'A'}); b.editItem(id, 'milk', {text: 'B'});
  a.importList(converges(a, b, id)); assert.equal(a.view(id).items.find(i => i.id === 'milk').text, 'B');
});

test('logical clocks move past all seen stamps even when wall clock runs hours behind', () => {
  const {a, id} = fixture(); const b = engine('behind', -10_000_000); b.importList(a.getList(id));
  a.editItem(id, 'milk', {text: 'Earlier'}); b.importList(a.getList(id)); b.editItem(id, 'milk', {text: 'Later'});
  a.importList(converges(a, b, id)); assert.equal(a.view(id).items.find(i => i.id === 'milk').text, 'Later');
  assert.equal(compareStamps({counter: 1, time: 2, device: 'a'}, {counter: 1, time: 1, device: 'z'}), 1);
});

test('delete versus edit and deliberate later restore resolve by stamp', () => {
  const {a, b, id} = fixture(); a.editItem(id, 'milk', {text: 'Edited'}); b.importList(a.getList(id)); b.deleteItem(id, 'milk');
  a.importList(converges(a, b, id)); assert.ok(!a.view(id).items.some(i => i.id === 'milk'));
  a.restoreItem(id, 'milk'); b.importList(converges(a, b, id)); assert.equal(b.view(id).items.find(i => i.id === 'milk').text, 'Edited');
});

test('list rename, sort, section word changes and item changes merge per field', () => {
  const {a, b, id} = fixture(); a.renameList(id, 'Weekly'); a.setSort(id, 'section'); a.setSectionWord(id, 'tofu', 'chilled');
  b.editItem(id, 'milk', {quantity: '3'}); b.setSectionWord(id, 'tea', 'pantry');
  a.importList(converges(a, b, id)); const view = a.view(id);
  assert.equal(view.name, 'Weekly'); assert.equal(view.sort, 'section'); assert.equal(view.sectionMap.tofu, 'chilled'); assert.equal(view.sectionMap.tea, 'pantry');
  assert.equal(view.items.find(i => i.id === 'milk').quantity, '3');
});

test('same list fields and section words resolve by higher stamp', () => {
  const {a, b, id} = fixture();
  for (const device of [a, b]) { device.renameList(id, device.deviceId); device.setSort(id, device === a ? 'added' : 'section'); device.setSectionWord(id, 'tofu', device.deviceId); }
  a.importList(converges(a, b, id)); assert.equal(a.view(id).name, 'phone-b'); assert.equal(a.view(id).sort, 'section'); assert.equal(a.view(id).sectionMap.tofu, 'phone-b');
});

test('list removal defeats earlier item edits and loses to later item edits or restore', () => {
  const {a, b, id} = fixture(); a.editItem(id, 'milk', {note: 'Earlier'}); b.importList(a.getList(id)); b.deleteList(id);
  a.importList(converges(a, b, id)); assert.equal(a.view(id).deleted, true);
  a.editItem(id, 'milk', {note: 'Later'}); b.importList(converges(a, b, id)); assert.equal(b.view(id).deleted, false);
  a.deleteList(id); a.restoreList(id); assert.equal(a.view(id).deleted, false);
});

test('purged item never returns from an offline copy and marker survives serialization', () => {
  const {a, b, id} = fixture(); a.deleteItem(id, 'milk'); a.emptyTrash(id);
  a.importList(converges(a, b, id)); assert.ok(!a.view(id).items.some(i => i.id === 'milk')); assert.equal(a.view(id, {trash: true}).items.length, 0);
  const c = engine('c'); c.load(a.save(id)); c.importList(b.getList(id)); assert.deepEqual(c.view(id), a.view(id));
  const marker = a.getList(id).items.find(i => i.id === 'milk'); assert.deepEqual(marker.fields, {}); assert.ok(marker.purge);
});

test('purged list fences offline contents, including when later explicitly recreated', () => {
  const {a, b, id} = fixture(); a.deleteList(id); a.emptyTrash(id);
  const marker = a.getList(id); a.importList(converges(a, b, id)); assert.deepEqual(a.getList(id), marker);
  a.renameList(id, 'New groceries'); a.importList(b.getList(id));
  assert.equal(a.view(id).deleted, false); assert.equal(a.view(id).items.length, 0);
  assert.ok(!a.save(id).includes('Apples')); assert.ok(!a.save(id).includes('Milk'));
});

test('merge is associative across three devices and independent additions', () => {
  const {a, b, id} = fixture(); const c = engine('c'); c.importList(a.getList(id));
  a.addItem(id, {text: 'A'}); b.addItem(id, {text: 'B'}); c.deleteItem(id, 'milk'); c.emptyTrash(id);
  const [x, y, z] = [a, b, c].map(d => d.getList(id));
  assert.deepEqual(mergeLists(mergeLists(x, y), z), mergeLists(x, mergeLists(y, z)));
});

test('JSON round trip is exact, unknown versions and malformed files are refused', () => {
  const {a, id} = fixture(); const before = a.getList(id);
  assert.deepEqual(deserializeList(serializeList(before)), before);
  const b = engine('b'); b.load(a.save(id)); assert.deepEqual(b.getList(id), before);
  assert.throws(() => deserializeList('{"schemaVersion":99}'), /Unsupported schemaVersion/);
  assert.throws(() => deserializeList('{'), /Invalid list JSON/);
  assert.throws(() => deserializeList('{"schemaVersion":1}'), /Invalid record/);
  const malformed = structuredClone(before); malformed.items[0].fields.checked.value = 'yes';
  assert.throws(() => deserializeList(JSON.stringify(malformed)), /Invalid field value/);
});

test('hostile text, huge names, emoji and prototype-like section words stay plain text', () => {
  const a = engine(); const hostile = '" <tag> & 🥕 \\ \n' + 'z'.repeat(100_000); const id = a.createList(hostile);
  const item = a.addItem(id, {text: hostile, note: hostile, quantity: hostile, addedBy: hostile, section: hostile});
  a.setSectionWord(id, '__proto__', hostile); a.setSectionWord(id, 'constructor', hostile);
  const b = engine('b'); b.load(a.save(id)); assert.deepEqual(b.view(id), a.view(id));
  assert.equal(b.view(id).name, hostile); assert.equal(b.view(id).items.find(i => i.id === item).text, hostile);
  assert.equal(b.suggestSection(id, '__proto__'), hostile); assert.equal({}.polluted, undefined);
});

test('invalid operations are atomic and returned data cannot mutate engine state', () => {
  const {a, id} = fixture(); const before = a.getList(id);
  assert.throws(() => a.editItem(id, 'milk', {checked: 'yes'}), /Invalid item field/);
  assert.throws(() => a.addItem(id, {text: 'Duplicate'}, {itemId: 'milk'}), /already exists/);
  assert.throws(() => a.setSort(id, 'unknown'), /Unknown sort/);
  assert.deepEqual(a.getList(id), before);
  const copy = a.getList(id); copy.fields.name.value = 'Mutated'; assert.deepEqual(a.getList(id), before);
  const b = engine('b'); const other = b.createList('Other'); assert.throws(() => mergeLists(before, b.getList(other)), /different list IDs/);
});

test('prototype-like map keys merge as own entries and undo correctly', () => {
  const {a, b, id} = fixture(); a.setSectionWord(id, '__proto__', 'aisle-a'); b.setSectionWord(id, 'constructor', 'aisle-b');
  a.importList(converges(a, b, id)); assert.equal(a.suggestSection(id, '__proto__'), 'aisle-a'); assert.equal(a.suggestSection(id, 'constructor'), 'aisle-b');
  const before = a.view(id); a.setSectionWord(id, '__proto__', 'changed'); a.undo(id); assert.deepEqual(a.view(id), before);
});

test('explicit re-add after purge uses the permanent ID and survives old copies', () => {
  const {a, b, id} = fixture(); a.deleteItem(id, 'milk'); a.emptyTrash(id);
  a.addItem(id, {text: 'Fresh milk', quantity: '2'}, {itemId: 'milk'});
  a.importList(converges(a, b, id)); const item = a.view(id).items.find(i => i.id === 'milk');
  assert.equal(item.text, 'Fresh milk'); assert.equal(item.quantity, '2');
});

test('permutations of remove/purge/recreate list merges converge', () => {
  const {a, b, id} = fixture(); const c = engine('c'); c.importList(a.getList(id));
  a.deleteList(id); a.emptyTrash(id); b.setChecked(id, 'milk', true); c.renameList(id, 'Old rename');
  const snapshots = [a, b, c].map(d => d.getList(id));
  const reference = mergeLists(mergeLists(snapshots[0], snapshots[1]), snapshots[2]);
  for (const [i, j, k] of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(mergeLists(mergeLists(snapshots[i], snapshots[j]), snapshots[k]), reference);
  }
});

test('undo of newly added prototype-like word leaves a mergeable removal marker', () => {
  const {a, b, id} = fixture(); const before = a.view(id);
  a.setSectionWord(id, '__proto__', 'custom'); b.importList(a.getList(id));
  a.undo(id); assert.deepEqual(a.view(id), before); b.importList(a.getList(id)); assert.deepEqual(b.view(id), before);
});

test('self merge after list purge and new item is unchanged', () => {
  const {a, id} = fixture(); a.deleteList(id); a.emptyTrash(id); a.renameList(id, 'New list'); a.addItem(id, {text: 'New rice'});
  const copy = a.getList(id); assert.deepEqual(mergeLists(copy, copy), copy);
});

test('three-device mixed histories converge under every delivery order', () => {
  let seed = 261016;
  const next = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 60; run++) {
    const {a, b, id} = fixture(); const c = engine('phone-c', -100000); c.importList(a.getList(id));
    const devices = [a, b, c];
    for (let step = 0; step < 12; step++) {
      const d = devices[next(3)];
      switch (next(8)) {
        case 0: d.renameList(id, `Name ${step}`); break;
        case 1: d.setSort(id, ['added', 'section', 'alphabetical'][next(3)]); break;
        case 2: d.deleteList(id); break;
        case 3: d.emptyTrash(id); break;
        case 4: d.addItem(id, {text: `Beans ${step}`}, {itemId: `new-${run}-${step}`}); break;
        case 5: {
          const item = d.view(id).items[0]; if (item) d.deleteItem(id, item.id); break;
        }
        case 6: {
          const item = d.view(id).items[0]; if (item) d.setChecked(id, item.id, true); break;
        }
        case 7: d.importList(devices[next(3)].getList(id)); break;
      }
    }
    const snapshots = devices.map(d => d.getList(id));
    for (const copy of snapshots) assert.deepEqual(mergeLists(copy, copy), copy, `self merge run ${run}`);
    const expected = mergeLists(mergeLists(snapshots[0], snapshots[1]), snapshots[2]);
    for (const [i, j, k] of [[0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
      assert.deepEqual(mergeLists(mergeLists(snapshots[i], snapshots[j]), snapshots[k]), expected, `delivery order run ${run}`);
    }
  }
});
