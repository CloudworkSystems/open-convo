// Plan test 13: determinism, and no clock or machine time zone.
import './setup/guard.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, reorderEvents, reversed, rotated } from './helpers.mjs';
import { formatAgenda, mergeCalendars } from '../src/index.mjs';

const QUERY = { from: '2026-11-01', to: '2026-11-07', timeZone: 'America/New_York', includeCancelled: true };
const sources = (order = (i) => i) => ['home', 'family', 'work'].map((id) => ({ id, name: id, ics: reorderEvents(fixture(`${id}.ics`), order) }));
const json = async (list) => JSON.stringify(await mergeCalendars(list, QUERY));

test('the same input twice gives byte-identical JSON', async () => {
  assert.equal(await json(sources()), await json(sources()));
});

test('shuffling the order of events inside a file gives the same result', async () => {
  const base = JSON.parse(await json(sources()));
  for (const order of [reversed, rotated]) {
    const shuffled = JSON.parse(await json(sources(order)));
    assert.deepEqual(shuffled.occurrences, base.occurrences);
  }
});

test('the merge runs with the clock, argument-less Date and local-time Date methods all throwing', async () => {
  const expected = await json(sources());
  const RealDate = globalThis.Date;
  const proto = RealDate.prototype;
  const local = Object.getOwnPropertyNames(proto).filter((name) => /^(get|set)(?!UTC)|^to(?!ISOString|JSON|UTCString|GMTString)/.test(name) && name !== 'getTime' && name !== 'setTime');
  const saved = new Map(local.map((name) => [name, proto[name]]));
  const savedTz = process.env.TZ;
  const realNow = RealDate.now;
  const trap = (what) => () => { throw new Error(`clock or local time read: ${what}`); };
  class TrapDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) trap('new Date()')();
      super(...args);
    }
    static now() { return trap('Date.now')(); }
  }
  try {
    globalThis.Date = TrapDate;
    RealDate.now = trap('Date.now');
    for (const name of local) proto[name] = trap(`Date.prototype.${name}`);
    assert.throws(() => new Date(), /new Date\(\)/);
    assert.throws(() => Date.now(), /Date\.now/);
    assert.throws(() => new RealDate(0).getHours(), /getHours/);
    process.env.TZ = 'Pacific/Kiritimati';
    const result = await mergeCalendars(sources(), QUERY);
    formatAgenda(result);
    assert.equal(JSON.stringify(result), expected);
  } finally {
    globalThis.Date = RealDate;
    RealDate.now = realNow;
    for (const [name, fn] of saved) proto[name] = fn;
    if (savedTz === undefined) delete process.env.TZ; else process.env.TZ = savedTz;
  }
  assert.equal(typeof Date.now(), 'number');
});
