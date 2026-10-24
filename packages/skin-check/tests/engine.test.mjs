import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SkinCheck, mergePeople, serializePerson, deserializePerson, evaluateAnswers, compareStamps, addMonths, startOfDay,
  QUESTIONS, OUTCOMES, REMINDER, REGIONS, SCHEMA_VERSION,
} from '../src/index.mjs';

// Invented people and spots only.
const ZONE = 'America/New_York';
const ALL_NO = Object.freeze(Object.fromEntries(QUESTIONS.map(question => [question.id, 'no'])));
const answers = changes => ({ ...ALL_NO, ...changes });
function engine(deviceId = 'mac-a', { time = Date.UTC(2026, 9, 1), timeZone = ZONE, person } = {}) {
  const clock = { time };
  const skin = new SkinCheck({ deviceId, now: () => clock.time, personId: 'river', timeZone, person });
  skin.clock = clock;
  return skin;
}
function pair() {
  const mac = engine('mac-a');
  mac.addSpot({ region: 'leftArm', label: 'Wrist freckle', createdAt: '2026-09-01T10:00:00-04:00' }, { id: 'spot-wrist' });
  mac.addSpot({ region: 'upperBack', label: 'Shoulder mole', createdAt: '2026-09-01T10:00:00-04:00' }, { id: 'spot-back' });
  const phone = engine('phone-b', { person: mac.getPerson() });
  return { mac, phone };
}
function converges(a, b) {
  const left = a.getPerson();
  const right = b.getPerson();
  const merged = mergePeople(left, right);
  assert.deepEqual(merged, mergePeople(right, left));
  assert.deepEqual(mergePeople(merged, merged), merged);
  assert.deepEqual(a.getPerson(), left);
  assert.deepEqual(b.getPerson(), right);
  return merged;
}

// 1. Spots
test('spots: create, rename, move region, archive, remove, Trash and restore', () => {
  const skin = engine();
  const id = skin.addSpot({ region: 'chest', label: 'Center mole' });
  assert.equal(skin.spot(id).regionName, 'Chest');
  skin.renameSpot(id, 'Breastbone mole');
  skin.moveSpot(id, 'other', 'Behind left ear');
  assert.deepEqual([skin.spot(id).label, skin.spot(id).region, skin.spot(id).note], ['Breastbone mole', 'other', 'Behind left ear']);
  assert.throws(() => skin.moveSpot(id, 'other', '  '), /needs a short note/);
  assert.throws(() => skin.moveSpot(id, 'elbow'), /Unknown body region/);
  skin.archiveSpot(id);
  assert.equal(skin.spots()[0].archived, true);
  skin.archiveSpot(id, false);
  skin.removeSpot(id);
  assert.deepEqual(skin.spots(), []);
  assert.deepEqual(skin.spots({ trash: true }).map(spot => spot.id), [id]);
  assert.throws(() => skin.renameSpot(id, 'x'), /in Trash/);
  skin.restoreSpot(id);
  assert.deepEqual(skin.spots().map(spot => spot.id), [id]);
  skin.removeSpot(id);
  assert.equal(skin.emptyTrash(), 1);
  assert.deepEqual(skin.spots({ trash: true }), []);
  assert.throws(() => skin.spot(id), /No spot/);
  assert.equal(Object.keys(REGIONS).length, 16);
});

// 2. Check-ins
test('check-ins record answers and photo references and refuse unknown or removed spots', () => {
  const { mac } = pair();
  const photo = { ref: 'photo-7f3a', distanceGuide: true, scaleMarker: false, light: 'daylight' };
  const id = mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:30:00-04:00', answers: answers({ color: 'notSure' }), photo, source: 'phone' });
  const stored = mac.getPerson().checkIns.find(record => record.id === id);
  assert.deepEqual(stored.photo, photo);
  assert.equal(stored.answers.color, 'notSure');
  assert.equal(stored.source, 'phone');
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-nowhere', capturedAt: '2026-10-02T08:30:00-04:00' }), /no spot with that ID/);
  mac.removeSpot('spot-back');
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:30:00-04:00' }), /in Trash\. Restore it before adding a check-in/);
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02 08:30' }), /UTC offset/);
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-02-30T08:30:00Z' }), /UTC offset/);
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:30:00Z', answers: { itch: 'yes' } }), /Unknown question/);
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:30:00Z', answers: { color: 'maybe' } }), /yes, no or notSure/);
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:30:00Z', photo: { ...photo, ref: 'data:image/jpeg;base64,AAAA' } }), /never image data/);
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:30:00Z', photo: { ...photo, bytes: 'AAAA' } }), /holds only/);
});

// 3. Rules
test('each question alone: "yes" or "not sure" is worth a look, urgent "yes" is book soon', () => {
  for (const question of QUESTIONS) {
    const yes = evaluateAnswers(answers({ [question.id]: 'yes' }));
    assert.equal(yes.outcome, question.urgent ? 'bookSoon' : 'worthShowing', question.id);
    assert.equal(yes.reasons.length, 1);
    assert.equal(yes.reasons[0].text, `You answered yes to "${question.text}"`);
    const unsure = evaluateAnswers(answers({ [question.id]: 'notSure' }));
    assert.equal(unsure.outcome, 'worthShowing', question.id);
    assert.equal(unsure.reasons[0].text, `You answered not sure to "${question.text}"`);
    const { [question.id]: _, ...missing } = ALL_NO;
    const blank = evaluateAnswers(missing);
    assert.equal(blank.outcome, 'worthShowing', question.id);
    assert.match(blank.reasons[0].text, /counted as not sure/);
  }
  assert.equal(evaluateAnswers(ALL_NO).outcome, 'noWarningSign');
  assert.equal(evaluateAnswers(ALL_NO).label, 'No warning sign noted by you');
  assert.equal(evaluateAnswers({}).outcome, 'worthShowing');
  assert.equal(evaluateAnswers({}).reasons.length, QUESTIONS.length);
});

test('urgent answers always win, including a sore that heals and comes back', () => {
  const sore = evaluateAnswers(answers({ sore: 'yes', asymmetry: 'yes', worry: 'notSure' }));
  assert.equal(sore.outcome, 'bookSoon');
  assert.equal(sore.label, OUTCOMES.bookSoon);
  assert.equal(sore.reasons[0].question, 'sore');
  assert.match(sore.reasons[0].text, /heals and keeps coming back/);
  assert.equal(sore.reasons.length, 3);
  assert.equal(evaluateAnswers({ bleeding: 'yes' }).outcome, 'bookSoon');
  assert.equal(evaluateAnswers(answers({ bleeding: 'notSure', sore: 'notSure' })).outcome, 'worthShowing');
});

// 4. Wording
const BANNED = /\b(safe|safely|benign|normal|low[- ]risk|healthy|clear|clean|fine|score|scored|diagnos\w*|all good|nothing to worry)\b/i;
function withoutReminder(text) { return text.split(REMINDER).join(' ').split(REMINDER.replace(/'/g, '&#39;')).join(' '); }
test('no output text reassures or grades, and the reminder is always there', () => {
  const { mac } = pair();
  mac.addSpot({ region: 'rightFoot', label: 'Heel spot' }, { id: 'spot-heel' });
  mac.addSpot({ region: 'neck', label: 'Collar mark' }, { id: 'spot-neck' });
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ bleeding: 'yes' }) });
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ border: 'notSure' }) });
  mac.addCheckIn({ spotId: 'spot-heel', capturedAt: '2026-10-02T08:00:00-04:00', answers: ALL_NO });
  mac.recordClinicianVisit('spot-neck', { date: '2026-10-01' });
  const strings = [...Object.values(OUTCOMES), ...QUESTIONS.map(question => question.text), ...Object.values(REGIONS)];
  for (const question of QUESTIONS) for (const answer of ['yes', 'notSure', null]) {
    const given = answer === null ? (({ [question.id]: _, ...rest }) => rest)(ALL_NO) : answers({ [question.id]: answer });
    const result = evaluateAnswers(given);
    strings.push(result.label, ...result.reasons.map(reason => reason.text));
  }
  for (const spot of mac.spots()) {
    const outcome = mac.spotOutcome(spot.id);
    strings.push(outcome.label, outcome.prompt ?? '', ...outcome.reasons.map(reason => reason.text));
    assert.equal(outcome.reminder, REMINDER);
  }
  const summary = mac.visitSummary({ date: '2026-10-03' });
  strings.push(summary.html, summary.text);
  for (const text of strings) assert.doesNotMatch(withoutReminder(text), BANNED, text.slice(0, 120));
  assert.ok(summary.text.startsWith(`Skin check: visit summary\n\n${REMINDER}`));
  assert.ok(summary.html.indexOf('class="reminder"') < summary.html.indexOf('<h2>'));
  assert.equal(evaluateAnswers(ALL_NO).reminder, REMINDER);
  const heel = mac.spotOutcome('spot-heel');
  assert.equal(heel.outcome, 'noWarningSign');
  assert.equal(heel.reminder, REMINDER);
  const heelSection = summary.text.slice(summary.text.indexOf('Heel spot'));
  assert.ok(heelSection.includes(REMINDER), 'reminder printed under the no-warning-sign spot');
});

// 5. Change over time
test('change over time pairs latest with earliest and previous, in instant then ID order', () => {
  const { mac, phone } = pair();
  const photo = ref => ({ ref, distanceGuide: true, scaleMarker: true, light: 'indoor' });
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ evolving: 'no' }), photo: photo('p1') }, { id: 'c-1' });
  let line = mac.timeline('spot-wrist');
  assert.deepEqual([line.earliest, line.previous, line.latest], ['c-1', null, 'c-1']);
  assert.deepEqual(line.photoPairs, { latestWithEarliest: null, latestWithPrevious: null });
  // Same day, later.
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T19:00:00-04:00', answers: answers({ evolving: 'yes' }), photo: photo('p2') }, { id: 'c-2' });
  // Same instant as c-2 in a different offset: 23:00Z. Ordered after c-2 by ID.
  phone.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T23:00:00Z', answers: answers({ evolving: 'yes' }), photo: photo('p3') }, { id: 'c-3' });
  // Identical capture time to c-1: c-0 sorts first by ID.
  phone.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ evolving: 'notSure' }) }, { id: 'c-0' });
  const merged = converges(mac, phone);
  for (const skin of [new SkinCheck({ deviceId: 'x', person: merged }), new SkinCheck({ deviceId: 'y', person: mergePeople(phone.getPerson(), mac.getPerson()) })]) {
    line = skin.timeline('spot-wrist');
    assert.deepEqual(line.checkIns.map(record => record.id), ['c-0', 'c-1', 'c-2', 'c-3']);
    assert.deepEqual([line.earliest, line.previous, line.latest], ['c-0', 'c-2', 'c-3']);
    assert.deepEqual(line.photoPairs, { latestWithEarliest: { from: 'c-1', to: 'c-3' }, latestWithPrevious: { from: 'c-2', to: 'c-3' } });
    assert.deepEqual(line.evolving.map(entry => [entry.answer, entry.changed]), [['notSure', false], ['no', true], ['yes', true], ['yes', false]]);
  }
});

// 6. Reminders
test('reminder dates across month ends, a leap day and a daylight-saving change', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  assert.equal(addMonths('2028-02-29', 1), '2028-03-29');
  assert.equal(addMonths('2026-12-31', 1), '2027-01-31');
  const skin = engine();
  const spot = skin.addSpot({ region: 'abdomen', createdAt: '2028-01-31T12:00:00-05:00' });
  assert.deepEqual(skin.nextCheck(spot), { setting: 'monthly', anchor: '2028-01-31', due: '2028-02-29' });
  // 01:30Z on March 8 is still March 7 in New York; clocks spring forward that night.
  skin.addCheckIn({ spotId: spot, capturedAt: '2026-03-08T01:30:00Z', answers: ALL_NO });
  assert.equal(skin.nextCheck(spot).anchor, '2026-03-07');
  skin.setReminder(spot, 1);
  assert.equal(skin.nextCheck(spot).due, '2026-03-14');
  skin.setReminder(spot, 12);
  assert.equal(skin.nextCheck(spot).due, '2026-05-30');
  skin.setReminder(spot, 'off');
  assert.deepEqual(skin.nextCheck(spot), { setting: 'off', anchor: '2026-03-07', due: null });
  assert.throws(() => skin.setReminder(spot, 13), /1 to 12/);
  assert.throws(() => skin.setReminder(spot, 0), /1 to 12/);
  // The autumn change: a late check-in stays on its local day.
  skin.setReminder(spot, 'monthly');
  skin.addCheckIn({ spotId: spot, capturedAt: '2026-11-01T23:30:00-05:00', answers: ALL_NO });
  assert.deepEqual(skin.nextCheck(spot), { setting: 'monthly', anchor: '2026-11-01', due: '2026-12-01' });
});

// 7. Visit summary
test('visit summary groups urgent first and keeps an urgent spot until a clinician visit', () => {
  const { mac } = pair();
  mac.addSpot({ region: 'leftLeg', label: '<b>Shin</b> & "knee"' }, { id: 'spot-shin' });
  mac.addSpot({ region: 'chest', label: 'Center' }, { id: 'spot-center' });
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ different: 'yes' }) });
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-03T08:00:00-04:00', answers: answers({ bleeding: 'yes' }) });
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-10T08:00:00-04:00', answers: ALL_NO });
  mac.addCheckIn({ spotId: 'spot-shin', capturedAt: '2026-10-04T08:00:00-04:00', answers: ALL_NO, worryNote: '<script>x</script>', photo: { ref: 'ph-1', distanceGuide: false, scaleMarker: true, light: 'flash' } });
  let summary = mac.visitSummary({ date: '2026-10-11' });
  assert.deepEqual(summary.groups.map(group => [group.key, group.spotIds]), [
    ['bookSoon', ['spot-wrist']], ['worthShowing', ['spot-back']], ['rest', ['spot-center', 'spot-shin']],
  ]);
  const wrist = mac.spotOutcome('spot-wrist');
  assert.equal(wrist.label, 'Book an appointment soon');
  assert.equal(wrist.reasons[0].date, '2026-10-03');
  assert.ok(summary.text.indexOf('BOOK AN APPOINTMENT SOON') < summary.text.indexOf('WORTH SHOWING A CLINICIAN'));
  assert.match(summary.text, /2026-10-03: You answered yes to "Has it bled without being hurt\?"/);
  assert.equal(mac.spotOutcome('spot-center').outcome, 'notCheckedYet');
  // Escaping, no image data, no links.
  assert.ok(summary.html.includes('&lt;b&gt;Shin&lt;/b&gt; &amp; &quot;knee&quot;'));
  assert.ok(summary.html.includes('&lt;script&gt;x&lt;/script&gt;'));
  assert.ok(!summary.html.includes('<script'));
  assert.doesNotMatch(summary.html, /<img|<a |href|src=|url\(|data:|https?:/i);
  assert.match(summary.html, /Photo reference: ph-1 \(distance guide used: no; scale marker: yes; light: flash\)/);
  // A visit resets the spot; right after it, never "no warning sign".
  mac.recordClinicianVisit('spot-wrist', { at: '2026-10-12T15:00:00-04:00', note: 'Dr. Example looked' }, { id: 'visit-1' });
  const after = mac.spotOutcome('spot-wrist');
  assert.equal(after.outcome, 'notCheckedSinceVisit');
  assert.match(after.prompt, /2026-10-12/);
  summary = mac.visitSummary({ date: '2026-10-13' });
  assert.deepEqual(summary.groups.map(group => group.key), ['worthShowing', 'notCheckedSinceVisit', 'rest']);
  assert.match(summary.text, /Seen by a clinician on 2026-10-12: Dr\. Example looked/);
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-20T08:00:00-04:00', answers: ALL_NO });
  assert.equal(mac.spotOutcome('spot-wrist').outcome, 'noWarningSign');
  // Archived spots are left out unless asked for.
  mac.archiveSpot('spot-back');
  assert.deepEqual(mac.visitSummary({ date: '2026-10-21' }).groups[0].key, 'rest');
  assert.deepEqual(mac.visitSummary({ date: '2026-10-21', includeArchived: true }).groups[0].spotIds, ['spot-back']);
});

test('check-ins before, at and after a visit land on the right side, before and after a merge', () => {
  const { mac, phone } = pair();
  mac.recordClinicianVisit('spot-wrist', { at: '2026-10-05T14:00:00-04:00' }, { id: 'visit-a' });
  phone.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-05T13:59:00-04:00', answers: answers({ bleeding: 'yes' }) }, { id: 'before' });
  const sides = skin => skin.spotOutcome('spot-wrist').reasons.map(reason => reason.checkInId);
  // Same instant written in UTC: counts as after.
  phone.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-05T18:00:00Z', answers: answers({ color: 'yes' }) }, { id: 'at' });
  phone.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-05T14:01:00-04:00', answers: answers({ border: 'notSure' }) }, { id: 'after' });
  for (const person of [mergePeople(mac.getPerson(), phone.getPerson()), mergePeople(phone.getPerson(), mac.getPerson())]) {
    const skin = new SkinCheck({ deviceId: 'viewer', person });
    assert.deepEqual(sides(skin).sort(), ['after', 'at']);
    assert.equal(skin.spotOutcome('spot-wrist').outcome, 'worthShowing');
  }
  assert.equal(phone.spotOutcome('spot-wrist').outcome, 'bookSoon');
});

test('a date-only visit starts at the start of that day, so a later urgent check-in still counts', () => {
  const { mac } = pair();
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-05T23:59:00-04:00', answers: answers({ worry: 'yes' }) }, { id: 'day-before' });
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-06T06:00:00-04:00', answers: answers({ sore: 'yes' }) }, { id: 'same-day' });
  mac.recordClinicianVisit('spot-wrist', { date: '2026-10-06' }, { id: 'visit-day' });
  const visit = mac.getPerson().visits[0];
  assert.deepEqual([visit.at, visit.dateOnly], ['2026-10-06T00:00:00-04:00', true]);
  const outcome = mac.spotOutcome('spot-wrist');
  assert.equal(outcome.outcome, 'bookSoon');
  assert.deepEqual(outcome.reasons.map(reason => reason.checkInId), ['same-day']);
  // Changing the time zone later does not move a recorded visit.
  mac.setTimeZone('Asia/Tokyo');
  assert.equal(mac.getPerson().visits[0].at, '2026-10-06T00:00:00-04:00');
  assert.throws(() => mac.recordClinicianVisit('spot-wrist', { date: '2026-10-06', at: '2026-10-06T09:00:00Z' }), /either/);
  assert.throws(() => mac.setTimeZone('Mars/Olympus'), /IANA/);
  // A day that starts at 01:00 because midnight is skipped (Havana, spring change).
  assert.equal(new Date(startOfDay('2026-03-08', 'America/Havana')).toISOString(), '2026-03-08T05:00:00.000Z');
});

test('concurrent clinician visits: the latest by instant, then ID, wins on every device', () => {
  const { mac, phone } = pair();
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-01T09:00:00-04:00', answers: answers({ bleeding: 'yes' }) }, { id: 'early' });
  phone.importPerson(mac.getPerson());
  mac.recordClinicianVisit('spot-back', { at: '2026-10-08T10:00:00-04:00' }, { id: 'visit-b' });
  phone.recordClinicianVisit('spot-back', { at: '2026-10-08T14:00:00Z' }, { id: 'visit-a' });
  phone.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-08T10:00:00-04:00', answers: answers({ diameter: 'yes' }) }, { id: 'tie' });
  const merged = converges(mac, phone);
  assert.equal(merged.visits.length, 2);
  const skin = new SkinCheck({ deviceId: 'viewer', person: merged });
  const outcome = skin.spotOutcome('spot-back');
  assert.equal(outcome.visit.id, 'visit-b');
  assert.equal(outcome.outcome, 'worthShowing');
  assert.deepEqual(outcome.reasons.map(reason => reason.checkInId), ['tie']);
});

// 8. Merge
test('merge: different spots, same field, delete vs edit, equal times and clock skew', () => {
  const { mac, phone } = pair();
  mac.addSpot({ region: 'neck' }, { id: 'spot-mac' });
  phone.addSpot({ region: 'rightHand' }, { id: 'spot-phone' });
  mac.renameSpot('spot-wrist', 'Mac name');
  phone.renameSpot('spot-wrist', 'Phone name');
  let merged = converges(mac, phone);
  assert.deepEqual(merged.spots.map(spot => spot.id), ['spot-back', 'spot-mac', 'spot-phone', 'spot-wrist']);
  // Same counter and time: the device ID breaks the tie.
  assert.equal(new SkinCheck({ deviceId: 'v', person: merged }).spot('spot-wrist').label, 'Phone name');
  // Clock skew: a phone far behind still wins with a newer counter after it has seen the file.
  phone.importPerson(merged);
  phone.clock.time = Date.UTC(2020, 0, 1);
  phone.renameSpot('spot-wrist', 'Skewed phone');
  merged = converges(new SkinCheck({ deviceId: 'v', person: merged }), phone);
  assert.equal(new SkinCheck({ deviceId: 'v', person: merged }).spot('spot-wrist').label, 'Skewed phone');
  // Delete vs edit: the edit keeps its field; Trash still wins until restored.
  mac.importPerson(merged);
  phone.importPerson(merged);
  mac.removeSpot('spot-back');
  phone.renameSpot('spot-back', 'Edited offline');
  merged = converges(mac, phone);
  const view = new SkinCheck({ deviceId: 'v', person: merged });
  assert.deepEqual(view.spots({ trash: true }).map(spot => [spot.id, spot.label]), [['spot-back', 'Edited offline']]);
});

test('merge: an offline copy cannot bring back a spot after Trash is emptied', () => {
  const { mac, phone } = pair();
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ bleeding: 'yes' }) }, { id: 'old' });
  mac.recordClinicianVisit('spot-back', { at: '2026-10-03T08:00:00-04:00' }, { id: 'old-visit' });
  phone.importPerson(mac.getPerson());
  const offline = phone.getPerson();
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  const merged = mergePeople(mac.getPerson(), offline);
  assert.deepEqual(merged, mergePeople(offline, mac.getPerson()));
  const view = new SkinCheck({ deviceId: 'v', person: merged });
  assert.deepEqual(view.spots().map(spot => spot.id), ['spot-wrist']);
  assert.deepEqual(view.spots({ trash: true }), []);
  assert.deepEqual([merged.checkIns, merged.visits], [[], []]);
  assert.equal(merged.spots.find(spot => spot.id === 'spot-back').fields.label, undefined);
});

test('merge: a check-in the emptying device never saw brings the spot back instead of vanishing', () => {
  const { mac, phone } = pair();
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  phone.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-04T08:00:00-04:00', answers: answers({ bleeding: 'yes' }) }, { id: 'unseen' });
  const merged = converges(mac, phone);
  const view = new SkinCheck({ deviceId: 'v', person: merged });
  const back = view.spots().find(spot => spot.id === 'spot-back');
  assert.equal(back.returned, true);
  assert.equal(back.region, 'other');
  assert.equal(view.spotOutcome('spot-back').outcome, 'bookSoon');
  view.moveSpot('spot-back', 'upperBack');
  assert.equal(view.spot('spot-back').region, 'upperBack');
});

test('merge: A into B equals B into A, the same check-in twice counts once, conflicts settle the same way', () => {
  const { mac, phone } = pair();
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ bleeding: 'yes' }) }, { id: 'shared' });
  phone.importPerson(mac.getPerson());
  phone.importPerson(mac.getPerson());
  const merged = converges(mac, phone);
  assert.equal(merged.checkIns.length, 1);
  assert.equal(new SkinCheck({ deviceId: 'v', person: merged }).spotOutcome('spot-wrist').reasons.length, 1);
  // Two different records under one key never block a sync: the more cautious one is kept, in either order.
  const forged = mac.getPerson();
  forged.checkIns[0].answers = ALL_NO;
  for (const result of [mergePeople(phone.getPerson(), forged), mergePeople(forged, phone.getPerson())]) {
    assert.equal(result.checkIns.length, 1);
    assert.equal(result.checkIns[0].answers.bleeding, 'yes');
  }
  const stranger = engine('mac-a', { person: undefined });
  assert.throws(() => mergePeople(mac.getPerson(), { ...stranger.getPerson(), id: 'someone-else' }), /different people/);
  // Three copies merge to the same file in any order.
  const third = engine('tablet-c', { person: mac.getPerson() });
  third.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-03T08:00:00-04:00', answers: ALL_NO }, { id: 'third' });
  phone.renameSpot('spot-back', 'Phone');
  const [a, b, c] = [mac.getPerson(), phone.getPerson(), third.getPerson()];
  assert.deepEqual(mergePeople(mergePeople(a, b), c), mergePeople(a, mergePeople(c, b)));
  assert.ok(compareStamps(null, { counter: 1, time: 0, device: 'x' }) < 0);
});

// 9. Saving and loading
test('saving and loading round-trips exactly; an unknown schemaVersion is refused', () => {
  const { mac } = pair();
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:00:00.250+05:30', answers: answers({ color: 'notSure' }), worryNote: 'Itches a little', photo: { ref: 'p-1', distanceGuide: true, scaleMarker: true, light: 'unknown' } });
  mac.recordClinicianVisit('spot-back', { date: '2026-10-05', note: 'Annual check' });
  mac.removeSpot('spot-back');
  const json = mac.save();
  assert.deepEqual(deserializePerson(json), mac.getPerson());
  assert.equal(serializePerson(deserializePerson(json)), json);
  const loaded = new SkinCheck({ deviceId: 'phone-b', person: deserializePerson(json) });
  assert.equal(loaded.save(), json);
  loaded.load(json);
  assert.equal(loaded.save(), json);
  assert.equal(JSON.parse(json).schemaVersion, SCHEMA_VERSION);
  assert.throws(() => deserializePerson(JSON.stringify({ ...JSON.parse(json), schemaVersion: 2 })), /Unsupported schemaVersion; expected 1/);
  assert.throws(() => deserializePerson('{not json'), /Invalid skin check JSON/);
  assert.throws(() => deserializePerson(JSON.stringify({ ...JSON.parse(json), image: 'AAAA' })), /Unknown data/);
  const extra = JSON.parse(json);
  extra.spots[0].life.note = 'x';
  assert.throws(() => deserializePerson(JSON.stringify(extra)), /Invalid spot/);
  const orphan = JSON.parse(json);
  orphan.checkIns[0].spotId = 'missing';
  assert.throws(() => deserializePerson(JSON.stringify(orphan)), /not in the file/);
  // New edits after loading get counters above every stamp in the file.
  const before = Math.max(...JSON.parse(json).spots.map(spot => spot.life.stamp.counter));
  loaded.renameSpot('spot-wrist', 'After load');
  assert.ok(loaded.getPerson().spots.find(spot => spot.id === 'spot-wrist').fields.label.stamp.counter > before);
});

test('the engine does not change returned copies and refuses a file for another person', () => {
  const { mac } = pair();
  const copy = mac.getPerson();
  copy.spots[0].fields.label.value = 'Changed outside';
  assert.notEqual(mac.getPerson().spots[0].fields.label.value, 'Changed outside');
  const other = new SkinCheck({ deviceId: 'mac-z', personId: 'sky', timeZone: 'UTC' });
  assert.throws(() => mac.load(other.save()), /different person/);
});

const offlineRecord = skin => skin.getPerson().checkIns[0];

// Edge cases named in the README.
test('edge cases: archived spots take check-ins, odd photo references are refused, a later restore brings a spot back', () => {
  const { mac, phone } = pair();
  mac.archiveSpot('spot-wrist');
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:00:00-04:00', answers: answers({ nonMole: 'yes' }) });
  assert.equal(mac.spotOutcome('spot-wrist').outcome, 'worthShowing');
  const photo = ref => ({ ref, distanceGuide: false, scaleMarker: false, light: 'unknown' });
  for (const ref of ['has space', '<b>', 'x'.repeat(201), 'DATA:abc']) {
    assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-02T08:00:00Z', photo: photo(ref) }), /never image data/, ref);
  }
  // The phone removed the spot offline; the Mac removes and empties first; the phone then restores with a newer counter.
  phone.removeSpot('spot-back');
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  for (let i = 0; i < 5; i += 1) phone.renameSpot('spot-wrist', `Busy ${i}`);
  phone.restoreSpot('spot-back');
  const view = new SkinCheck({ deviceId: 'v', person: converges(mac, phone) });
  const back = view.spot('spot-back');
  assert.deepEqual([back.inTrash, back.returned, back.label, back.region], [false, true, '', 'other']);
  // Its reminder anchors to the stored restore time, not to whenever it is viewed.
  const first = view.nextCheck('spot-back');
  const later = new SkinCheck({ deviceId: 'w', now: () => Date.UTC(2027, 5, 1), person: view.getPerson() });
  assert.deepEqual(later.nextCheck('spot-back'), first);
  assert.equal(first.anchor, '2026-09-30');
});

test('emptying Trash drops only the deleted records of that type and spot, even when IDs repeat elsewhere', () => {
  const { mac } = pair();
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:00:00-04:00', answers: ALL_NO }, { id: 'same-id' });
  mac.recordClinicianVisit('spot-wrist', { at: '2026-10-03T08:00:00-04:00' }, { id: 'same-id' });
  mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-04T08:00:00-04:00', answers: ALL_NO }, { id: 'other-id' });
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  const tomb = mac.getPerson().spots.find(spot => spot.id === 'spot-back');
  assert.deepEqual(tomb.purged, { checkIns: ['same-id'], visits: [] });
  // A file that keeps a record its own deletion marker names is refused rather than reviving the spot.
  const contradictory = JSON.parse(mac.save());
  contradictory.checkIns.push({ ...offlineRecord(mac), spotId: 'spot-back', id: 'same-id' });
  assert.throws(() => deserializePerson(JSON.stringify(contradictory)), /permanently deleted with its spot/);
  assert.throws(() => new SkinCheck({ deviceId: 'v', person: contradictory }), /permanently deleted with its spot/);
  const reloaded = deserializePerson(mac.save());
  const merged = mergePeople(reloaded, mac.getPerson());
  assert.deepEqual(merged.visits.map(visit => visit.id), ['same-id']);
  assert.deepEqual(merged.checkIns.map(record => record.id), ['other-id']);
  const viewer = new SkinCheck({ deviceId: 'v', person: reloaded });
  viewer.load(mac.save());
  assert.equal(viewer.spotOutcome('spot-wrist').visit.id, 'same-id');
});

test('deletion markers match spot and record IDs exactly, even when IDs contain newlines', () => {
  const skin = engine();
  skin.addSpot({ region: 'neck' }, { id: 'a\nb' });
  skin.addSpot({ region: 'chest' }, { id: 'a' });
  skin.addCheckIn({ spotId: 'a\nb', capturedAt: '2026-10-02T08:00:00Z', answers: ALL_NO }, { id: 'c' });
  skin.addCheckIn({ spotId: 'a', capturedAt: '2026-10-02T08:00:00Z', answers: ALL_NO }, { id: 'b\nc' });
  const offline = skin.getPerson();
  skin.removeSpot('a\nb');
  skin.emptyTrash();
  const merged = mergePeople(skin.getPerson(), offline);
  assert.deepEqual(merged.checkIns.map(record => [record.spotId, record.id]), [['a', 'b\nc']]);
});

test('a returned spot refuses the IDs of its permanently deleted records', () => {
  const { mac, phone } = pair();
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:00:00Z', answers: ALL_NO }, { id: 'gone-check' });
  mac.recordClinicianVisit('spot-back', { at: '2026-10-03T08:00:00Z', note: 'Checked' }, { id: 'gone-visit' });
  phone.importPerson(mac.getPerson());
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  phone.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-05T08:00:00Z', answers: ALL_NO }, { id: 'unseen' });
  mac.importPerson(phone.getPerson());
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-06T08:00:00Z' }, { id: 'gone-check' }), /permanently deleted/);
  assert.throws(() => mac.recordClinicianVisit('spot-back', { at: '2026-10-06T08:00:00Z' }, { id: 'gone-visit' }), /permanently deleted/);
  const visit = mac.recordClinicianVisit('spot-back', { at: '2026-10-06T08:00:00Z', note: 'New note' }, { id: 'new-visit' });
  assert.equal(deserializePerson(mac.save()).visits.find(record => record.id === visit).note, 'New note');
});

test('deleted record IDs stay reserved across spots, and an old copy never blocks a merge', () => {
  const { mac, phone } = pair();
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:00:00Z', answers: ALL_NO }, { id: 'reused' });
  mac.recordClinicianVisit('spot-back', { at: '2026-10-03T08:00:00Z' }, { id: 'reused-visit' });
  const offline = mac.getPerson();
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  assert.throws(() => mac.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-06T08:00:00Z' }, { id: 'reused' }), /permanently deleted/);
  assert.throws(() => mac.recordClinicianVisit('spot-wrist', { at: '2026-10-06T08:00:00Z' }, { id: 'reused-visit' }), /permanently deleted/);
  // Even a file written elsewhere that reuses the ID on another spot merges without clashing.
  phone.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-06T08:00:00Z', answers: ALL_NO }, { id: 'reused' });
  const merged = mergePeople(mergePeople(mac.getPerson(), phone.getPerson()), offline);
  assert.deepEqual(merged, mergePeople(offline, mergePeople(phone.getPerson(), mac.getPerson())));
  assert.deepEqual(merged.checkIns.map(record => [record.spotId, record.id]), [['spot-wrist', 'reused']]);
});

test('three copies with a reused ID on two spots and an emptied Trash merge the same in any order', () => {
  const { mac } = pair();
  const fork = engine('tablet-c', { person: mac.getPerson() });
  mac.addCheckIn({ spotId: 'spot-back', capturedAt: '2026-10-02T08:00:00Z', answers: answers({ bleeding: 'yes' }) }, { id: 'X' });
  const withRecord = mac.getPerson();
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  const purged = mac.getPerson();
  fork.addCheckIn({ spotId: 'spot-wrist', capturedAt: '2026-10-03T08:00:00Z', answers: ALL_NO }, { id: 'X' });
  const older = fork.getPerson();
  const orders = [[withRecord, purged, older], [withRecord, older, purged], [older, withRecord, purged], [purged, older, withRecord]];
  const results = orders.map(([a, b, c]) => mergePeople(mergePeople(a, b), c));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.deepEqual(results[0].checkIns.map(record => [record.spotId, record.id]), [['spot-wrist', 'X']]);
  // Before the emptying arrives, both records live side by side on their own spots.
  const both = mergePeople(withRecord, older);
  assert.deepEqual(both.checkIns.map(record => record.spotId).sort(), ['spot-back', 'spot-wrist']);
  assert.equal(new SkinCheck({ deviceId: 'v', person: both }).checkInOutcome('X').outcome, 'bookSoon');
});

test('a file missing its time zone or a spot field is refused', () => {
  const { mac } = pair();
  const file = JSON.parse(mac.save());
  delete file.fields.timeZone;
  assert.throws(() => deserializePerson(JSON.stringify(file)), /missing its time zone/);
  const spotless = JSON.parse(mac.save());
  delete spotless.spots[0].fields.createdAt;
  assert.throws(() => deserializePerson(JSON.stringify(spotless)), /missing a field/);
});

test('a spot brought back only by a visit anchors its reminder to that visit, even after a skewed purge', () => {
  const { mac, phone } = pair();
  mac.clock.time = Date.UTC(2030, 0, 1);
  mac.removeSpot('spot-back');
  mac.emptyTrash();
  phone.recordClinicianVisit('spot-back', { at: '2026-10-05T10:00:00-04:00' }, { id: 'unseen-visit' });
  const view = new SkinCheck({ deviceId: 'v', person: converges(mac, phone) });
  assert.equal(view.spotOutcome('spot-back').outcome, 'notCheckedSinceVisit');
  assert.deepEqual(view.nextCheck('spot-back'), { setting: 'monthly', anchor: '2026-10-05', due: '2026-11-05' });
});
