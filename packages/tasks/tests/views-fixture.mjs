import { Tasks } from '../src/index.mjs';

export const VIEW_NOW = Date.parse('2026-03-10T15:00:00.000Z');
export const VIEW_ZONE = 'America/New_York';

/** Fixed invented household, viewed at 11:00 in New York on 10 March 2026. */
export function viewFixture() {
  const engine = new Tasks({
    deviceId: 'desk',
    id: 'maple-household',
    timeZone: VIEW_ZONE,
    now: () => 1_800_000_000_000,
  });
  engine.addTask({ title: 'Renew registration', due: '2026-03-01', priority: 'high', list: 'Errands' }, { taskId: 'reg' });
  engine.addTask({ title: 'Call the dentist', due: { dateTime: '2026-03-10T09:00', timeZone: VIEW_ZONE }, list: 'Home' }, { taskId: 'call' });
  engine.addTask({ title: 'Water the plants', due: '2026-03-10', priority: 'high', list: 'Home' }, { taskId: 'plants' });
  engine.addTask({ title: 'Book tickets', due: { dateTime: '2026-03-10T18:00', timeZone: VIEW_ZONE } }, { taskId: 'tickets' });
  engine.addTask({ title: 'Return the book', due: '2026-03-10', list: 'Errands' }, { taskId: 'book' });
  engine.addTask({ title: 'Pay the fee', due: '2026-03-12', list: 'Errands' }, { taskId: 'fee' });
  engine.addTask({ title: 'Stretch', due: '2026-03-10', repeat: { kind: 'days', every: 1, mode: 'onSchedule', endAfter: 2 } }, { taskId: 'stretch' });
  engine.addTask({ title: 'Water the fern', due: '2026-03-11', repeat: { kind: 'days', every: 3, mode: 'afterDone' }, list: 'Home' }, { taskId: 'fern' });
  engine.addTask({ title: 'Finished note', due: '2026-03-10' }, { taskId: 'finished' });
  engine.complete('finished', Date.parse('2026-03-09T15:00:00.000Z'), { recordId: 'fin' });
  engine.addTask({ title: 'Dropped errand', due: '2026-03-10' }, { taskId: 'dropped' });
  engine.drop('dropped', Date.parse('2026-03-09T15:00:00.000Z'), { recordId: 'drop1' });
  engine.addTask({
    title: 'Take the letter',
    due: '2026-03-20',
    reminders: [{ dateTime: '2026-03-10T08:00', timeZone: VIEW_ZONE }],
  }, { taskId: 'letter' });
  return engine;
}
