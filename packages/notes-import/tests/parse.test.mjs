import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { HouseholdLists } from '../../household-lists/src/index.mjs';
import {
  EMPTY_ITEM,
  EMPTY_NOTE,
  LIMITS,
  LONG_LINE,
  NOT_AN_ITEM,
  NotesImportError,
  controlCharacterMessage,
  parseChecklist,
  repeatedMessage,
  toListFile,
  tooBigMessage,
  tooManyItemsMessage,
  tooManySectionsMessage,
} from '../src/index.mjs';

const sample = readFileSync(new URL('../samples/grocery.txt', import.meta.url), 'utf8');
const large = readFileSync(new URL('../samples/large.txt', import.meta.url), 'utf8');

function refusal(text, options) {
  let caught;
  assert.throws(() => parseChecklist(text, options), error => {
    assert.ok(error instanceof NotesImportError);
    caught = error;
    return true;
  });
  return caught;
}

test('the sample grocery note gives the title, sections, and items', () => {
  const parsed = parseChecklist(sample);
  assert.deepEqual(parsed.list, { title: 'Weekend groceries', titleFrom: 'note' });
  assert.deepEqual(parsed.sections, [
    { name: 'Produce', line: 3 },
    { name: 'Dairy', line: 9 },
    { name: 'Bakery', line: 14 },
  ]);
  assert.deepEqual(parsed.items, [
    { text: 'apples', checked: false, section: 'Produce', line: 4 },
    { text: 'bananas', checked: false, section: 'Produce', line: 5 },
    { text: 'lemons', checked: true, section: 'Produce', line: 6 },
    { text: 'limes', checked: false, section: 'Produce', line: 7 },
    { text: 'whole milk', checked: false, section: 'Dairy', line: 10 },
    { text: 'yogurt', checked: true, section: 'Dairy', line: 11 },
    { text: 'butter', checked: false, section: 'Dairy', line: 12 },
    { text: 'sourdough loaf', checked: false, section: 'Bakery', line: 15 },
  ]);
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(parsed.warnings, []);
});

test('every listed mark is read as checked or unchecked', () => {
  const note = [
    'Every mark',
    '- [ ] box dash',
    '* [ ] box star',
    '[ ] box bare',
    '☐ ballot',
    '○ circle',
    '◦ hollow bullet',
    '• bullet',
    '- hyphen',
    '* star',
    '\u2013 en dash',
    '- [x] ex dash',
    '- [X] ex dash upper',
    '* [x] ex star',
    '[x] ex bare',
    '[X] ex bare upper',
    '☑ checked ballot',
    '☒ crossed ballot',
    '✓ check',
    '✔ heavy check',
    '● filled',
    '1. numbered dot',
    '2) numbered paren',
  ].join('\n');
  const parsed = parseChecklist(note);
  assert.deepEqual(parsed.items.map(item => [item.text, item.checked]), [
    ['box dash', false],
    ['box star', false],
    ['box bare', false],
    ['ballot', false],
    ['circle', false],
    ['hollow bullet', false],
    ['bullet', false],
    ['hyphen', false],
    ['star', false],
    ['en dash', false],
    ['ex dash', true],
    ['ex dash upper', true],
    ['ex star', true],
    ['ex bare', true],
    ['ex bare upper', true],
    ['checked ballot', true],
    ['crossed ballot', true],
    ['check', true],
    ['heavy check', true],
    ['filled', true],
    ['numbered dot', false],
    ['numbered paren', false],
  ]);
});

test('text is kept exactly, and a repeated item is kept with a warning', () => {
  const note = [
    'Exact',
    '- 2 x café',
    '- chili 🌶️  pepper',
    '- naïve crème brûlée',
    '- keep   inner',
    '- keep   inner',
    '- Keep   inner',
  ].join('\n');
  const parsed = parseChecklist(note);
  assert.deepEqual(parsed.items.map(item => item.text), [
    '2 x café',
    'chili 🌶️  pepper',
    'naïve crème brûlée',
    'keep   inner',
    'keep   inner',
    'Keep   inner',
  ]);
  assert.deepEqual(parsed.warnings, [
    { line: 6, text: 'keep   inner', message: repeatedMessage('keep   inner') },
  ]);
});

test('a loose paragraph is skipped with its line number, and a long line is skipped with a reason', () => {
  const note = [
    'Title',
    'Produce',
    '- apple',
    `- ${'a'.repeat(501)}`,
    '- pear',
    'Remember to lock the shed when you leave the garden.',
  ].join('\n');
  const parsed = parseChecklist(note);
  assert.deepEqual(parsed.items.map(item => item.text), ['apple', 'pear']);
  assert.equal(parsed.items[1].section, 'Produce');
  assert.deepEqual(parsed.skipped, [
    { line: 4, text: 'a'.repeat(501), reason: LONG_LINE },
    { line: 6, text: 'Remember to lock the shed when you leave the garden.', reason: NOT_AN_ITEM },
  ]);
});

test('an item of 500 characters is kept and 501 is left out', () => {
  const kept = 'b'.repeat(500);
  const parsed = parseChecklist(`Title\n- ${kept}\n- ${'c'.repeat(501)}\n`);
  assert.deepEqual(parsed.items.map(item => item.text), [kept]);
  assert.equal(parsed.skipped[0].reason, LONG_LINE);
});

test('limits and a control character refuse the note and return no list', () => {
  const head = '- milk\n';
  const exact = head + ' '.repeat(LIMITS.bytes - Buffer.byteLength(head));
  assert.equal(Buffer.byteLength(exact), LIMITS.bytes);
  assert.equal(parseChecklist(exact).items[0].text, 'milk');
  assert.equal(refusal(`${exact} `).message, tooBigMessage());

  const items = ['Title'];
  for (let i = 1; i <= LIMITS.items; i += 1) items.push(`- item ${i}`);
  assert.equal(parseChecklist(items.join('\n')).items.length, LIMITS.items);
  items.push('- one more');
  assert.equal(refusal(items.join('\n')).message, tooManyItemsMessage());

  const sections = ['Title'];
  for (let i = 1; i <= LIMITS.sections; i += 1) sections.push(`Section ${i}`, `- row ${i}`);
  assert.equal(parseChecklist(sections.join('\n')).sections.length, LIMITS.sections);
  sections.push('Section 101', '- row 101');
  assert.equal(refusal(sections.join('\n')).message, tooManySectionsMessage());

  const lines = ['Title'];
  for (let i = 0; i < 12; i += 1) lines.push('- ok');
  lines.push('bad\u0000line');
  assert.equal(lines.length, 14);
  assert.equal(refusal(lines.join('\n')).message, controlCharacterMessage(14));
});

test('a tab is kept inside an item, and other controls are refused', () => {
  const parsed = parseChecklist('Title\n- milk\tbread\n');
  assert.equal(parsed.items[0].text, 'milk\tbread');
  assert.equal(refusal('Title\n- milk\u0007\n').message, controlCharacterMessage(2));
  assert.equal(refusal('Title\n- milk\u007f\n').message, controlCharacterMessage(2));
  assert.equal(refusal('Title\n- milk\u0085\n').message, controlCharacterMessage(2));
  assert.equal(refusal('Title\n- milk\u2028next\n').message, controlCharacterMessage(2));
});

test('toListFile loads in the household lists engine with the same items, checks, and sections', () => {
  const parsed = parseChecklist(sample);
  const json = toListFile(parsed, { deviceId: 'reader-phone', now: () => 1234 });
  const raw = JSON.parse(json);
  assert.equal(raw.fields.name.value, 'Weekend groceries');
  assert.equal(raw.fields.sectionsEnabled.value, true);
  assert.equal(raw.fields.sort.value, 'alphabetical');
  const counters = [];
  for (const item of parsed.items) {
    const saved = raw.items.find(entry => entry.fields.text.value === item.text);
    assert.ok(saved);
    assert.equal(saved.fields.checked.value, item.checked);
    assert.equal(saved.fields.section.value, item.section);
    assert.equal(saved.fields.added.value.time, 1234);
    assert.equal(saved.fields.added.value.device, 'reader-phone');
    counters.push(saved.fields.added.value.counter);
  }
  for (let i = 1; i < counters.length; i += 1) assert.ok(counters[i] > counters[i - 1]);
  for (const stamp of stamps(raw)) {
    assert.equal(stamp.device, 'reader-phone');
    assert.equal(stamp.time, 1234);
  }

  const engine = new HouseholdLists({ deviceId: 'reader-phone', now: () => 1234 });
  const loaded = engine.load(json);
  const view = engine.view(loaded.id);
  assert.equal(view.name, 'Weekend groceries');
  assert.equal(view.sectionsEnabled, true);
  assert.equal(view.sort, 'alphabetical');
  assert.deepEqual(signature(view.items), signature(parsed.items));
});

test('a note with no headings leaves sections off', () => {
  const parsed = parseChecklist('- oats\n- rice\n');
  assert.equal(parsed.list.title, 'Checklist');
  assert.equal(parsed.list.titleFrom, 'fallback');
  assert.deepEqual(parsed.sections, []);
  const json = toListFile(parsed, { deviceId: 'reader-phone', now: () => 50 });
  const raw = JSON.parse(json);
  assert.equal(raw.fields.sectionsEnabled.value, false);
  assert.equal(raw.items.every(item => item.fields.section.value === ''), true);
  const engine = new HouseholdLists({ deviceId: 'reader-phone', now: () => 50 });
  const loaded = engine.load(json);
  const view = engine.view(loaded.id);
  assert.equal(view.sectionsEnabled, false);
  assert.equal(view.items.every(item => item.section === ''), true);
  assert.deepEqual(signature(view.items), signature(parsed.items));
});

test('carriage returns give the same result as line feeds', () => {
  const base = 'Weekend groceries\nProduce\n- apples\n☐ bananas\n';
  const lf = parseChecklist(base);
  assert.deepEqual(parseChecklist(base.replaceAll('\n', '\r\n')), lf);
  assert.deepEqual(parseChecklist(base.replaceAll('\n', '\r')), lf);
  assert.deepEqual(parseChecklist(`${base.trimEnd()}`), lf);
});

test('the large sample sits on the item limit', () => {
  const parsed = parseChecklist(large);
  assert.equal(parsed.list.title, 'Large invented list');
  assert.equal(parsed.items.length, 2000);
  assert.equal(parsed.sections.length, 10);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(refusal(`${large}- one more\n`).message, tooManyItemsMessage());
});

test('edge cases from the readme', () => {
  const titled = parseChecklist('Produce\n- apples\nDairy\n- milk\n', { title: 'Saturday market' });
  assert.deepEqual(titled.list, { title: 'Saturday market', titleFrom: 'option' });
  assert.deepEqual(titled.sections.map(section => section.name), ['Dairy']);
  assert.equal(titled.items[0].section, '');
  assert.equal(titled.items[0].text, 'apples');

  const first = parseChecklist('Produce\n- apples\n');
  assert.equal(first.list.title, 'Produce');
  assert.deepEqual(first.sections, []);
  assert.equal(first.items[0].section, '');

  const plain = parseChecklist('Title\n* [ X ] spaced\n- apples\n-5 apples\n+ plus sign\n\u2014 em dash\n(1) paren\n1.2 liters of milk\n-[ ] stuck\n');
  assert.deepEqual(plain.items.map(item => item.text), ['[ X ] spaced', 'apples']);
  assert.equal(plain.items[0].checked, false);
  assert.equal(plain.skipped.some(line => line.text === '1.2 liters of milk'), true);
  assert.equal(plain.skipped.some(line => line.text === '-5 apples'), true);

  const star = parseChecklist('Title\n* [X] upper star\n');
  assert.deepEqual(star.items, [{ text: 'upper star', checked: true, section: '', line: 2 }]);

  const nested = parseChecklist('Title\nProduce\n  - apples\n\t- bananas\n\n- pears\n');
  assert.deepEqual(nested.items.map(item => [item.text, item.section]), [
    ['apples', 'Produce'],
    ['bananas', 'Produce'],
    ['pears', 'Produce'],
  ]);

  const emptyMark = parseChecklist('Title\n- \n- [ ]\n- milk\n');
  assert.deepEqual(emptyMark.items.map(item => item.text), ['milk']);
  assert.equal(emptyMark.skipped.every(line => line.reason === EMPTY_ITEM), true);

  const repeated = parseChecklist('Title\nAisle\n- milk\nOther\n- milk\n- milk\n');
  assert.equal(repeated.items.length, 3);
  assert.equal(repeated.warnings.length, 2);
  assert.equal(repeated.warnings[0].message, repeatedMessage('milk'));

  const bom = parseChecklist('\uFEFFWeekend groceries\n- milk\n');
  assert.equal(bom.list.title, 'Weekend groceries');
  assert.equal(bom.items[0].text, 'milk');

  const keptSection = parseChecklist(`Title\nAisle\n- ${'z'.repeat(501)}\n- pear\n`);
  assert.equal(keptSection.sections[0].name, 'Aisle');
  assert.equal(keptSection.items[0].text, 'pear');
  assert.equal(keptSection.items[0].section, 'Aisle');

  const longHeading = `Title\n${'H'.repeat(501)}\n- milk\n`;
  const headed = parseChecklist(longHeading);
  assert.equal(headed.items[0].section, '');
  assert.equal(headed.skipped[0].reason, LONG_LINE);
  assert.deepEqual(headed.sections, []);

  const apples = '🍎'.repeat(500);
  const counted = parseChecklist(`Title\n- ${apples}\n`);
  assert.equal(counted.items[0].text, apples);
  assert.equal(parseChecklist(`Title\n- ${'🍎'.repeat(501)}\n`).items.length, 0);

  const sameName = parseChecklist('Title\nProduce\n- apple\nProduce\n- pear\n');
  assert.deepEqual(sameName.sections.map(section => section.name), ['Produce', 'Produce']);
  assert.equal(sameName.items[1].section, 'Produce');

  assert.equal(parseChecklist('   \n\n').items.length, 0);
  assert.equal(EMPTY_NOTE.startsWith('This note has no checklist items.'), true);
  assert.equal(refusal(7).message, 'The note must be text.');
  assert.equal(refusal('Title\n- milk\n', { title: 4 }).message, 'The title must be text.');
  assert.match(refusal('- milk\n', { title: ` ${'t'.repeat(501)} ` }).message, /longer than 500/);
  assert.throws(() => toListFile({ items: [] }), /no checklist/);
  assert.throws(() => toListFile(parseChecklist('- milk\n'), { deviceId: 'phone' }), /clock function/);
  assert.equal(refusalMessage(() => toListFile(parseChecklist(''), { deviceId: 'phone', now: () => 0 })), EMPTY_NOTE);
  assert.equal(refusalMessage(() => toListFile(parseChecklist('Saturday market\n'), { deviceId: 'phone', now: () => 0 })), EMPTY_NOTE);
});

function refusalMessage(run) {
  let message = '';
  assert.throws(run, error => {
    assert.ok(error instanceof NotesImportError);
    message = error.message;
    return true;
  });
  return message;
}

function signature(items) {
  return items.map(item => `${item.checked}\n${item.section}\n${item.text}`).sort();
}

function stamps(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (typeof value.counter === 'number' && typeof value.time === 'number' && typeof value.device === 'string' && Object.keys(value).length === 3) {
    found.push(value);
  }
  for (const child of Object.values(value)) stamps(child, found);
  return found;
}
