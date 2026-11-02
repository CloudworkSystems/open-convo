import assert from 'node:assert/strict';
import test from 'node:test';

import { fileURLToPath } from 'node:url';

import { main } from '../src/command.mjs';
import {
  addReminder, editReminder, formatSaved, listView, markDone, parseSaved,
  removeReminder, snoozeReminder,
} from '../src/index.mjs';
import { reminder, sampleList } from './helpers.mjs';

const fixture = fileURLToPath(new URL('./fixtures/sample.json', import.meta.url));

test('every function runs while Date.now and an argument-less Date throw', () => {
  const RealDate = Date;
  const realNow = Date.now;
  function FakeDate(...args) {
    if (args.length === 0) throw new Error('new Date()');
    return new RealDate(...args);
  }
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = () => { throw new Error('Date.parse'); };
  FakeDate.now = () => { throw new Error('Date.now'); };
  FakeDate.prototype = RealDate.prototype;
  globalThis.Date = FakeDate;
  try {
    const added = addReminder([], reminder({ when: { afterDays: 1, from: '2024-02-28' }, createdOn: '2024-01-01' }));
    const edited = editReminder(added.reminders, 'garden-plan', { title: 'Come back after the leap day' });
    const snoozed = snoozeReminder(edited.reminders, 'garden-plan', { days: 2 }, '2024-02-28');
    const done = markDone(sampleList(), 'shed-later', '2026-11-02');
    const removed = removeReminder(done.reminders, 'porch-done');
    const view = listView(removed.reminders, { today: '2026-11-02', days: 14, knownItems: [] });
    const text = formatSaved(snoozed.reminders);
    assert.equal(parseSaved(text)[0].title, 'Come back after the leap day');
    assert.equal(view.counts.done >= 1, true);
    let stdout = '';
    const code = main(['--file', fixture, '--today', '2026-11-02'], {
      stdout: { write(chunk) { stdout += chunk; } },
      stderr: { write() { throw new Error('the command wrote an error'); } },
    });
    assert.equal(code, 0);
    assert.match(stdout, /Come back to the garden plan session/);
  } finally {
    globalThis.Date = RealDate;
    Date.now = realNow;
  }
});
