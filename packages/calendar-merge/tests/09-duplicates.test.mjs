// Plan test 9 and the #121 requirements 1 and 6: the same event in several
// calendars.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, merge, reorderEvents, reversed, rotated, sourceIds } from './helpers.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-30' };
const at = (time) => `DTSTART;TZID=America/New_York:${time}`;

test('the same UID in two calendars shows once with both sources ({ id, name }, never the text)', async () => {
  const text = cal(ev('UID:shared@test.example', 'SUMMARY:Field trip', at('20261112T080000'), 'DURATION:PT8H'));
  const result = await mergeNamed([['school', 'School (iCloud)', text], ['family', 'Family (Google)', text]]);
  assert.equal(result.occurrences.length, 1);
  assert.deepEqual(result.occurrences[0].sources, [{ id: 'school', name: 'School (iCloud)' }, { id: 'family', name: 'Family (Google)' }]);
  assert.equal(result.occurrences[0].matchedBy, 'uid');
  assert.ok(!JSON.stringify(result).includes('BEGIN:VEVENT'));
});

function mergeNamed(list, query = NOV) {
  return merge(list.map(([id, name, ics]) => ({ id, name, ics })), query);
}

const copy = (...extra) => cal(ev('UID:dup@test.example', at('20261112T100000'), 'DURATION:PT1H', ...extra));

test('when copies differ, the higher SEQUENCE wins', async () => {
  const result = await merge({ a: copy('SUMMARY:Old title', 'SEQUENCE:1'), b: copy('SUMMARY:New title', 'SEQUENCE:2') }, NOV);
  assert.deepEqual(result.occurrences.map((o) => o.title), ['New title']);
  const reversedOrder = await merge({ b: copy('SUMMARY:New title', 'SEQUENCE:2'), a: copy('SUMMARY:Old title', 'SEQUENCE:1') }, NOV);
  assert.deepEqual(reversedOrder.occurrences.map((o) => o.title), ['New title']);
});

test('a cancelled copy with a higher SEQUENCE cancels; with a lower one it does not', async () => {
  const higher = await merge({ a: copy('SUMMARY:Lunch', 'SEQUENCE:1'), b: copy('SUMMARY:Lunch', 'SEQUENCE:2', 'STATUS:CANCELLED') }, NOV);
  assert.deepEqual(higher.occurrences, []);
  const lower = await merge({ a: copy('SUMMARY:Lunch', 'SEQUENCE:2'), b: copy('SUMMARY:Lunch', 'SEQUENCE:1', 'STATUS:CANCELLED') }, NOV);
  assert.deepEqual(lower.occurrences.map((o) => [o.title, o.status, sourceIds(o)]), [['Lunch', 'confirmed', ['a', 'b']]]);
});

test('ties fall to LAST-MODIFIED, then DTSTAMP, then source order', async () => {
  const byModified = await merge({ a: copy('SUMMARY:A', 'LAST-MODIFIED:20261001T000000Z', 'DTSTAMP:20261005T000000Z'), b: copy('SUMMARY:B', 'LAST-MODIFIED:20261002T000000Z', 'DTSTAMP:20261001T000000Z') }, NOV);
  assert.equal(byModified.occurrences[0].title, 'B');
  const byStamp = await merge({ a: copy('SUMMARY:A', 'DTSTAMP:20261005T000000Z'), b: copy('SUMMARY:B', 'DTSTAMP:20261001T000000Z') }, NOV);
  assert.equal(byStamp.occurrences[0].title, 'A');
  const bySource = await merge({ a: copy('SUMMARY:A', 'DTSTAMP:20261001T000000Z'), b: copy('SUMMARY:B', 'DTSTAMP:20261001T000000Z') }, NOV);
  assert.equal(bySource.occurrences[0].title, 'A');
  const swapped = await merge({ b: copy('SUMMARY:B', 'DTSTAMP:20261001T000000Z'), a: copy('SUMMARY:A', 'DTSTAMP:20261001T000000Z') }, NOV);
  assert.equal(swapped.occurrences[0].title, 'B');
});

test('different UIDs with the same title and time show once; other cases are not merged', async () => {
  const a = cal(
    ev('UID:a-cafe@test.example', 'SUMMARY:Café with Juniper', at('20261112T150000'), 'DURATION:PT1H'),
    ev('UID:a-twice-1@test.example', 'SUMMARY:Standup', at('20261113T090000'), 'DURATION:PT15M'),
    ev('UID:a-twice-2@test.example', 'SUMMARY:Standup', at('20261113T090000'), 'DURATION:PT15M'),
    ev('UID:a-later@test.example', 'SUMMARY:Piano', at('20261114T100000'), 'DURATION:PT1H'),
  );
  const b = cal(
    ev('UID:b-cafe@test.example', 'SUMMARY:  CAFE WITH JUNIPER  ', at('20261112T150000'), 'DURATION:PT1H'),
    ev('UID:b-later@test.example', 'SUMMARY:Piano', at('20261114T110000'), 'DURATION:PT1H'),
  );
  const result = await merge({ a, b }, NOV);
  const cafe = result.occurrences.filter((o) => /caf/i.test(o.title));
  assert.equal(cafe.length, 1);
  assert.equal(cafe[0].matchedBy, 'title-and-time');
  assert.deepEqual(sourceIds(cafe[0]), ['a', 'b']);
  assert.equal(result.occurrences.filter((o) => o.title === 'Standup').length, 2);
  assert.equal(result.occurrences.filter((o) => o.title === 'Piano').length, 2);
});

test('a title-and-time match takes every field from one winner, never a mix', async () => {
  const a = cal(ev('UID:yoga-a@test.example', 'SUMMARY:Yoga Class', at('20261112T090000'), 'DURATION:PT1H', 'LOCATION:Studio A', 'SEQUENCE:0', 'DTSTAMP:20261001T000000Z'));
  const b = cal(ev('UID:yoga-b@test.example', 'SUMMARY:yoga class', 'DTSTART:20261112T090000', 'DURATION:PT1H', 'LOCATION:Studio B', 'SEQUENCE:1', 'DTSTAMP:20261001T000000Z'));
  const pick = (r) => { const [o] = r.occurrences; return [o.uid, o.title, o.location, o.eventTimeZone, o.floating, sourceIds(o)]; };
  const winnerB = ['yoga-b@test.example', 'yoga class', 'Studio B', null, true, ['a', 'b']];
  assert.deepEqual(pick(await merge({ a, b }, NOV)), winnerB);
  // LAST-MODIFIED, then DTSTAMP, then source order, then uid.
  const same = (text) => text.replace('SEQUENCE:1', 'SEQUENCE:0');
  const aNewer = a.replace('SEQUENCE:0', 'SEQUENCE:0\r\nLAST-MODIFIED:20261003T000000Z');
  assert.deepEqual(pick(await merge({ a: aNewer, b: same(b) }, NOV))[0], 'yoga-a@test.example');
  const bStamp = same(b).replace('DTSTAMP:20261001T000000Z', 'DTSTAMP:20261002T000000Z');
  assert.deepEqual(pick(await merge({ a, b: bStamp }, NOV))[0], 'yoga-b@test.example');
  assert.deepEqual(pick(await merge({ a, b: same(b) }, NOV))[0], 'yoga-a@test.example');
  assert.deepEqual(pick(await merge({ b: same(b), a }, NOV))[0], 'yoga-b@test.example');
  assert.deepEqual(pick(await merge({ a, b: same(b) }, NOV)), ['yoga-a@test.example', 'Yoga Class', 'Studio A', 'America/New_York', false, ['a', 'b']]);
});

test('shuffling events inside each file gives the same result', async () => {
  const a = cal(
    ev('UID:x1@test.example', 'SUMMARY:Run', at('20261112T070000'), 'DURATION:PT1H', 'LOCATION:Park'),
    ev('UID:x2@test.example', 'SUMMARY:Run', at('20261112T070000'), 'DURATION:PT1H', 'LOCATION:Track'),
    ev('UID:x3@test.example', 'SUMMARY:Swim', at('20261112T180000'), 'DURATION:PT1H'),
  );
  const b = cal(
    ev('UID:y1@test.example', 'SUMMARY:run', at('20261112T070000'), 'DURATION:PT1H', 'LOCATION:Gym', 'SEQUENCE:4'),
    ev('UID:y2@test.example', 'SUMMARY:Swim', at('20261112T180000'), 'DURATION:PT1H'),
  );
  const base = JSON.stringify((await merge({ a, b }, NOV)).occurrences);
  for (const order of [reversed, rotated]) {
    const shuffled = await merge({ a: reorderEvents(a, order), b: reorderEvents(b, order) }, NOV);
    assert.equal(JSON.stringify(shuffled.occurrences), base);
  }
});

test('a cancelled copy and a live copy at the same time are not merged', async () => {
  const a = cal(ev('UID:c1@test.example', 'SUMMARY:Recital', at('20261112T180000'), 'DURATION:PT1H', 'STATUS:CANCELLED'));
  const b = cal(ev('UID:c2@test.example', 'SUMMARY:Recital', at('20261112T180000'), 'DURATION:PT1H'));
  const result = await merge({ a, b }, { ...NOV, includeCancelled: true });
  assert.deepEqual(result.occurrences.map((o) => [o.uid, o.status, o.matchedBy]), [['c1@test.example', 'cancelled', null], ['c2@test.example', 'confirmed', null]]);
});

const dentist = (uid) => ev(`UID:${uid}`, 'SUMMARY:Dentist', at('20261112T100000'), 'DURATION:PT1H');
const groupsOf = (result) => result.occurrences.map((o) => o.key.split(' + ').map((k) => k.split('/')[0]).sort().join('|')).sort();

test('collisions: Dentist twice in A and once in B, then a third copy in C', async () => {
  const A = cal(dentist('a1'), dentist('a2'));
  const B = cal(dentist('b1'));
  const C = cal(dentist('c1'));
  assert.deepEqual(groupsOf(await merge({ A, B }, NOV)), ['a1|b1', 'a2']);
  assert.deepEqual(groupsOf(await merge({ A, B, C }, NOV)), ['a1|b1|c1', 'a2']);
  // Shuffling events inside each file, or swapping which file holds which uid's event first, never changes the groups.
  assert.deepEqual(groupsOf(await merge({ A: reorderEvents(A, reversed), B, C }, NOV)), ['a1|b1|c1', 'a2']);
  assert.deepEqual(groupsOf(await merge({ A: cal(dentist('a2'), dentist('a1')), B, C }, NOV)), ['a1|b1|c1', 'a2']);
  for (const o of (await merge({ A, B, C }, NOV)).occurrences) {
    const ids = sourceIds(o);
    assert.equal(new Set(ids).size, ids.length);
  }
});

test('requirement 1: a candidate joins a group only if its whole source set is disjoint', async () => {
  // x is in A and B (one UID); y only in B; z only in C.
  const A = cal(dentist('x'));
  const B = cal(dentist('x'), dentist('y'));
  const C = cal(dentist('z'));
  const result = await merge({ A, B, C }, NOV);
  assert.deepEqual(groupsOf(result), ['x|z', 'y']);
  const xz = result.occurrences.find((o) => o.key.includes('x/'));
  assert.deepEqual(sourceIds(xz), ['A', 'B', 'C']);
  for (const o of result.occurrences) assert.equal(new Set(sourceIds(o)).size, o.sources.length);
});

test('requirement 1: ordering is by the smallest source index, then uid', async () => {
  // "c" is in A and B (one UID), "b" only in B, "a" only in C. Sorted by
  // smallest source index, then uid: c (A), b (B), a (C). So c and a share a
  // group and b is alone. (Sorting by uid first would have paired a with b.)
  const A = cal(dentist('c'));
  const B = cal(dentist('b'), dentist('c'));
  const C = cal(dentist('a'));
  assert.deepEqual(groupsOf(await merge({ A, B, C }, NOV)), ['a|c', 'b']);
  assert.deepEqual(groupsOf(await merge({ A, B: reorderEvents(B, reversed), C }, NOV)), ['a|c', 'b']);
});
