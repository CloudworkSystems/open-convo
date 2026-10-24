// Plan test 12: hostile but valid text, and what never reaches the output.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { cal, ev, fixture, merge } from './helpers.mjs';
import { formatAgenda } from '../src/index.mjs';

const NOV = { from: '2026-11-01', to: '2026-11-07' };
const escape = (text) => text.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

test('quotes, <script>, &amp;, emoji, right-to-left and very long text come back unchanged and print on one line', async () => {
  const title = 'Say "hi" <script>alert(1)</script> &amp; 🎉👩‍👩‍👧 שלום עולם\tTabbed\nSecond line';
  const place = `Café "Ünïcode" <b>bold</b> &lt; ${'long '.repeat(400)}end`;
  const text = cal(ev('UID:hostile@test.example', `SUMMARY:${escape(title)}`, `LOCATION:${escape(place)}`, 'DTSTART;TZID=America/New_York:20261103T100000', 'DURATION:PT1H'));
  const result = await merge([{ id: 'odd', name: 'Odd "name" <i>', ics: text }], NOV);
  assert.equal(result.occurrences[0].title, title);
  assert.equal(result.occurrences[0].location, place);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).occurrences[0].title, title);
  const agenda = formatAgenda(result);
  const line = agenda.split('\n').find((l) => l.includes('<script>'));
  assert.ok(line.includes('&amp; 🎉👩‍👩‍👧 שלום עולם\\tTabbed\\nSecond line'));
  assert.ok(line.endsWith('end  [Odd "name" <i>]'));
  assert.equal(agenda.split('\n').filter((l) => l.includes('Tabbed')).length, 1);
});

test('descriptions, attendees and alarms appear nowhere in the output', async () => {
  const sources = ['home', 'family', 'work'].map((id) => ({ id, name: id, ics: fixture(`${id}.ics`) }));
  const inline = cal(ev(
    'UID:markers@test.example', 'SUMMARY:Markers', 'DTSTART;TZID=America/New_York:20261104T100000', 'DURATION:PT1H',
    'DESCRIPTION:MARKER-DESCRIPTION-INLINE', 'ATTENDEE;CN=MARKER-ATTENDEE-NAME:mailto:MARKER-ATTENDEE-INLINE@inline.example',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:MARKER-ALARM-INLINE', 'TRIGGER:-PT5M', 'END:VALARM',
  ));
  for (const s of [...sources.map((x) => x.ics), inline]) assert.match(s, /MARKER-/);
  const result = await merge([...sources, { id: 'inline', name: 'inline', ics: inline }], { ...NOV, includeCancelled: true });
  assert.ok(result.occurrences.some((o) => o.title === 'Markers'));
  assert.doesNotMatch(JSON.stringify(result), /MARKER-/);
  assert.doesNotMatch(formatAgenda(result), /MARKER-/);
});
