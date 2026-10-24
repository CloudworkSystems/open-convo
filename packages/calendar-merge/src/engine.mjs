// The calendar merge engine: `.ics` text in, one sorted list of occurrences
// for a date range out. Reads no clock, no files and no network.

import { Refusal, parseDateValue, parseDuration, readIcs, unescapeText } from './ics.mjs';
import { WorkLimit, expandRuleDays, parseRRule } from './rrule.mjs';
import {
  DAY_MS, canonicalZone, formatDate, formatLocal, formatUtc, formatWall, parseIsoDate,
  wallAt, wallToInstant, zoneFromTzid,
} from './time.mjs';

export const SCHEMA_VERSION = 1;
export const LIMITS = Object.freeze({
  sources: 20,
  sourceBytes: 5 * 1024 * 1024,
  idLength: 40,
  rangeDates: 400,
  seriesOccurrences: 10_000,
  // Work budgets, so a hostile or huge calendar can't stall a call.
  seriesSteps: 100_000, // repeat periods visited for one series
  callSteps: 2_000_000, // repeat periods visited in one call
  seriesValues: 50_000, // RDATE and EXDATE values in one series
  callValues: 200_000, // dates read through a time zone in one call
});

function refuse(message) {
  throw new Error(message);
}

function utf8Length(text) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) { bytes += 4; i += 1; } else bytes += 3;
  }
  return bytes;
}

// ---- Input checks --------------------------------------------------------

function checkSources(sources) {
  if (!Array.isArray(sources)) refuse('Calendars must be given as a list.');
  if (sources.length > LIMITS.sources) refuse(`Too many calendars: ${sources.length} given, at most ${LIMITS.sources}.`);
  const seen = new Set();
  return sources.map((source, index) => {
    if (!source || typeof source !== 'object') refuse(`Calendar ${index + 1} is not an object with id, name and ics.`);
    const { id, ics } = source;
    if (typeof id !== 'string' || id.length < 1 || id.length > LIMITS.idLength) {
      refuse(`Calendar ${index + 1} needs an id of 1 to ${LIMITS.idLength} characters.`);
    }
    if (seen.has(id)) refuse(`Calendar id "${id}" is used twice; each id must be unique.`);
    seen.add(id);
    const name = source.name === undefined ? id : source.name;
    if (typeof name !== 'string') refuse(`Calendar "${id}" has a name that isn't text.`);
    if (typeof ics !== 'string') refuse(`Calendar "${id}" has no .ics text.`);
    if (ics.length > LIMITS.sourceBytes || utf8Length(ics) > LIMITS.sourceBytes) {
      refuse(`Calendar "${id}" is over 5 MB.`);
    }
    return { id, name, ics, index };
  });
}

function checkQuery(query) {
  if (!query || typeof query !== 'object') refuse('The query must give from, to and timeZone.');
  const fromDay = typeof query.from === 'string' ? parseIsoDate(query.from) : null;
  if (fromDay === null) refuse('"from" must be a date written YYYY-MM-DD.');
  const toDay = typeof query.to === 'string' ? parseIsoDate(query.to) : null;
  if (toDay === null) refuse('"to" must be a date written YYYY-MM-DD.');
  if (toDay < fromDay) refuse('"to" is before "from".');
  if (toDay - fromDay + 1 > LIMITS.rangeDates) {
    refuse(`The range covers ${toDay - fromDay + 1} dates; at most ${LIMITS.rangeDates} are allowed.`);
  }
  const zone = canonicalZone(query.timeZone);
  if (!zone) refuse(`"${String(query.timeZone)}" is not a time zone name (use an IANA name such as America/New_York).`);
  if (query.includeCancelled !== undefined && typeof query.includeCancelled !== 'boolean') {
    refuse('"includeCancelled" must be true or false.');
  }
  return { fromDay, toDay, zone, includeCancelled: query.includeCancelled === true };
}

// ---- Reading events ------------------------------------------------------

// A written DATE or DATE-TIME, resolved. Floating times are read in
// `fallbackZone`.
function resolveValue(value, fallbackZone) {
  if (value.kind === 'date') return { date: true, day: value.day };
  if (value.utc) return { date: false, ms: value.day * DAY_MS + value.sec * 1000, zone: 'UTC', floating: false, day: value.day, sec: value.sec };
  if (value.tzid !== null) {
    const zone = zoneFromTzid(value.tzid);
    if (!zone) return { error: `unknown time zone "${value.tzid}"` };
    return { date: false, ms: wallToInstant(zone, value.day, value.sec), zone, floating: false, day: value.day, sec: value.sec };
  }
  return { date: false, ms: wallToInstant(fallbackZone, value.day, value.sec), zone: fallbackZone, floating: true, day: value.day, sec: value.sec };
}

const keyOf = (resolved) => (resolved.date ? `D${resolved.day}` : `T${resolved.ms}`);

function labelOf(resolved) {
  if (resolved.date) return formatDate(resolved.day);
  if (resolved.floating) return formatWall(resolved.day, resolved.sec);
  return formatUtc(resolved.ms);
}

function stampOf(prop) {
  if (!prop) return null;
  const value = parseDateValue(prop.value, prop.params);
  if (!value) return null;
  if (value.kind === 'date') return value.day * DAY_MS;
  if (value.tzid !== null) {
    const zone = zoneFromTzid(value.tzid);
    if (zone) return wallToInstant(zone, value.day, value.sec);
  }
  return value.day * DAY_MS + value.sec * 1000; // UTC, or floating read as UTC
}

function fingerprint(raw) {
  return JSON.stringify([...raw.props.keys()].sort().map((name) => [name, raw.props.get(name).map((p) => [p.params, p.value])]));
}

// One VEVENT to a copy (an event or a cancellation record), or a problem.
function interpret(raw, source, ctx) {
  const first = (name) => raw.props.get(name)?.[0];
  const where = { sourceIndex: source.index, line: raw.line };
  const uid = first('UID')?.value.trim();
  if (!uid) return { problem: { ...where, text: 'event skipped: no UID' } };
  const statusText = (first('STATUS')?.value || '').trim().toUpperCase();
  const cancelled = raw.method === 'CANCEL' || statusText === 'CANCELLED';
  const status = cancelled ? 'cancelled' : statusText === 'TENTATIVE' ? 'tentative' : 'confirmed';
  const sequenceText = (first('SEQUENCE')?.value || '').trim();
  const base = {
    ...where,
    uid,
    sequence: /^\d{1,15}$/.test(sequenceText) ? Number(sequenceText) : 0,
    lastModified: stampOf(first('LAST-MODIFIED')),
    dtstamp: stampOf(first('DTSTAMP')),
    fingerprint: fingerprint(raw),
  };
  const skip = (why) => ({ problem: { ...where, text: `event "${uid}" skipped: ${why}` } });

  const dtstartProp = first('DTSTART');
  const ridProp = first('RECURRENCE-ID');
  // RECURRENCE-ID: floating values are read in the component's own zone.
  let rid = null;
  let ridRange = false;
  const readRid = (fallbackZone) => {
    if (!ridProp) return null;
    const value = parseDateValue(ridProp.value, ridProp.params);
    if (!value) return { error: 'RECURRENCE-ID is not a readable date' };
    ridRange = (ridProp.params.RANGE || []).some((r) => r.toUpperCase() === 'THISANDFUTURE');
    return resolveValue(value, fallbackZone);
  };

  if (!dtstartProp) {
    if (!cancelled) return skip('no DTSTART');
    rid = readRid(ctx.zone);
    if (rid?.error) return skip(rid.error);
    return { copy: { ...base, kind: 'record', rid, ridKey: rid ? keyOf(rid) : null } };
  }

  const startValue = parseDateValue(dtstartProp.value, dtstartProp.params);
  if (!startValue) return skip('DTSTART is not a readable date');
  const start = resolveValue(startValue, ctx.zone);
  if (start.error) return skip(start.error);
  const zone = start.date ? null : start.zone;

  let duration;
  const dtendProp = first('DTEND');
  const durationProp = first('DURATION');
  if (dtendProp) {
    const endValue = parseDateValue(dtendProp.value, dtendProp.params);
    if (!endValue) return skip('DTEND is not a readable date');
    if ((endValue.kind === 'date') !== start.date) return skip('DTEND and DTSTART are not both dates or both date-times');
    if (start.date) {
      const days = endValue.day - start.day;
      if (days < 0) return skip('it ends before it starts');
      duration = { days: Math.max(days, 1) };
    } else {
      const end = resolveValue(endValue, zone);
      if (end.error) return skip(end.error);
      if (end.ms < start.ms) return skip('it ends before it starts');
      duration = { nominalDays: 0, exactMs: end.ms - start.ms };
    }
  } else if (durationProp) {
    const parsed = parseDuration(durationProp.value);
    if (!parsed) return skip('DURATION is not readable');
    const days = parsed.weeks * 7 + parsed.days;
    const exactMs = (parsed.hours * 3600 + parsed.minutes * 60 + parsed.seconds) * 1000;
    if (parsed.sign < 0 && (days || exactMs)) return skip('it ends before it starts');
    if (start.date) {
      if (exactMs) return skip('the DURATION of an all-day event is not whole days');
      duration = { days: Math.max(days, 1) };
    } else {
      duration = { nominalDays: days, exactMs };
    }
  } else {
    duration = start.date ? { days: 1 } : { nominalDays: 0, exactMs: 0 };
  }

  rid = readRid(zone ?? ctx.zone);
  if (rid?.error) return skip(rid.error);

  let rule = null;
  let ruleProblem = null;
  const rruleProp = first('RRULE');
  if (rruleProp) {
    const parsed = parseRRule(rruleProp.value);
    if (parsed.rule && parsed.rule.until !== null) {
      parsed.rule.untilValue = parseDateValue(parsed.rule.until);
      if (!parsed.rule.untilValue) { parsed.unsupported = 'bad UNTIL'; delete parsed.rule; }
    }
    if (parsed.rule) rule = parsed.rule; else ruleProblem = parsed.unsupported;
  }

  const listValues = (name) => (raw.props.get(name) || []).flatMap((prop) => prop.value.split(',').map((text) => ({ text, params: prop.params, line: prop.line })));

  return {
    copy: {
      ...base,
      kind: 'event',
      title: unescapeText(first('SUMMARY')?.value ?? ''),
      location: first('LOCATION') ? unescapeText(first('LOCATION').value) : null,
      status,
      start,
      zone,
      duration,
      rule,
      ruleProblem,
      rdates: listValues('RDATE'),
      exdates: listValues('EXDATE'),
      isRepeat: Boolean(rruleProp || raw.props.has('RDATE')),
      rid,
      ridKey: rid ? keyOf(rid) : null,
      ridRange,
    },
  };
}

// Higher SEQUENCE, then later LAST-MODIFIED, then later DTSTAMP, then the
// earlier source; a full tie inside one source falls to the content itself.
function compareCopies(a, b) {
  return (b.sequence - a.sequence)
    || ((b.lastModified ?? -Infinity) - (a.lastModified ?? -Infinity) || 0)
    || ((b.dtstamp ?? -Infinity) - (a.dtstamp ?? -Infinity) || 0)
    || (a.sourceIndex - b.sourceIndex)
    || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0);
}

// ---- Expanding one series ------------------------------------------------

function endOf(copy, startMs, wallDay, wallSec) {
  const { nominalDays, exactMs } = copy.duration;
  if (!nominalDays) return startMs + exactMs;
  return wallToInstant(copy.zone, wallDay + nominalDays, wallSec) + exactMs;
}

function timedInstance(copy, startMs, wallDay, wallSec) {
  return { allDay: false, startMs, endMs: endOf(copy, startMs, wallDay, wallSec), wallDay };
}

function inRange(instance, q) {
  if (instance.allDay) return instance.startDay <= q.toDay && instance.endDay - 1 >= q.fromDay;
  if (instance.endMs === instance.startMs) return instance.startMs >= q.rangeStart && instance.startMs < q.rangeEnd;
  return instance.startMs < q.rangeEnd && instance.endMs > q.rangeStart;
}

// The expansion window in the series' own dates: wide enough for every
// occurrence that can touch the range, with a day to spare on each side.
function seriesWindow(copy, q) {
  if (copy.start.date) return { fromDay: q.fromDay - copy.duration.days, toDay: q.toDay };
  const spanDays = copy.duration.nominalDays + Math.ceil(copy.duration.exactMs / DAY_MS);
  return {
    fromDay: wallAt(copy.zone, q.rangeStart).day - spanDays - 1,
    toDay: wallAt(copy.zone, q.rangeEnd).day + 1,
  };
}

// Instances of a series (or a single event) that touch the range, keyed by
// their original start. Returns { instances: Map, notSupported, workLimit,
// problems }. A series that would take more work than its share of the
// budget (q.budget, shared by the whole call) shows only its first
// occurrence, with `workLimit` saying why.
export function expandSeries(copy, q, { forceSingle = false, stats = { steps: 0 } } = {}) {
  const budget = q.budget ?? { steps: LIMITS.callSteps, values: LIMITS.callValues };
  const notSupported = forceSingle || copy.ruleProblem !== null;
  try {
    const result = expandFully(copy, q, notSupported, stats, budget);
    return { ...result, notSupported, workLimit: null };
  } catch (error) {
    if (!(error instanceof WorkLimit)) throw error;
    const { instances } = expandFully(copy, q, true, { steps: 0 }, budget);
    return { instances, problems: [], notSupported: true, workLimit: error.message };
  } finally {
    budget.steps = Math.max(0, budget.steps - stats.steps);
  }
}

function expandFully(copy, q, single, stats, budget) {
  const problems = [];
  const at = (text) => problems.push({ sourceIndex: copy.sourceIndex, line: copy.line, text });
  const all = new Map();
  const allDay = copy.start.date;
  const window = seriesWindow(copy, q);
  const maxSteps = Math.min(LIMITS.seriesSteps, budget.steps);
  // Values outside the window can't touch the range: they are skipped before
  // any time zone work. The others count against the call's value budget.
  const outside = (day) => day < window.fromDay - 1 || day > window.toDay + 1;
  const resolve = (value) => {
    if (!value.utc) {
      if (budget.values <= 0) throw new WorkLimit(`more than ${LIMITS.callValues} dates to read in one call`);
      budget.values -= 1;
    }
    return resolveValue(value, copy.zone);
  };
  const add = (resolvedStart, instance) => {
    const key = keyOf(resolvedStart);
    if (!all.has(key)) all.set(key, { ...instance, origKey: key, origLabel: labelOf(resolvedStart) });
  };
  if (!single && copy.rdates.length + copy.exdates.length > LIMITS.seriesValues) {
    throw new WorkLimit(`more than ${LIMITS.seriesValues} RDATE and EXDATE values`);
  }

  if (allDay) {
    const days = copy.duration.days;
    let dates = [copy.start.day];
    if (copy.rule && !single) {
      const until = copy.rule.untilValue;
      dates = expandRuleDays(copy.rule, copy.start.day, window, until ? (day) => day > until.day : undefined, stats, maxSteps);
    }
    for (const day of dates) add({ date: true, day }, { allDay: true, startDay: day, endDay: day + days });
  } else {
    const { zone } = copy;
    const { sec } = copy.start;
    const instantOf = (day) => wallToInstant(zone, day, sec);
    let dates = [copy.start.day];
    if (copy.rule && !single) {
      const until = copy.rule.untilValue;
      let pastUntil;
      if (until && until.kind === 'date') pastUntil = (day) => day > until.day;
      else if (until) {
        const untilResolved = resolveValue(until, zone);
        const untilMs = untilResolved.error ? Infinity : untilResolved.ms;
        pastUntil = (day) => instantOf(day) > untilMs;
      }
      dates = expandRuleDays(copy.rule, copy.start.day, window, pastUntil, stats, maxSteps);
    }
    for (const day of dates) {
      const startMs = instantOf(day);
      add({ date: false, ms: startMs, floating: copy.start.floating, day, sec }, timedInstance(copy, startMs, day, sec));
    }
  }

  if (!single) {
    for (const rdate of copy.rdates) {
      const type = (rdate.params.VALUE?.[0] || '').toUpperCase();
      if (type === 'PERIOD') {
        const [startText, endText = ''] = rdate.text.split('/');
        const startValue = parseDateValue(startText, { TZID: rdate.params.TZID });
        if (!startValue || startValue.kind !== 'time' || allDay) { at(`RDATE period "${rdate.text}" skipped: not readable for this event`); continue; }
        const endValue = parseDateValue(endText, { TZID: rdate.params.TZID });
        const d = endValue ? null : parseDuration(endText);
        const lastDay = endValue ? endValue.day : startValue.day + (d ? d.weeks * 7 + d.days + 1 : 0);
        if (startValue.day > window.toDay + 1 || lastDay < window.fromDay - 1) continue;
        const s = resolve(startValue);
        if (s.error) { at(`RDATE "${rdate.text}" skipped: ${s.error}`); continue; }
        let endMs;
        if (endValue && endValue.kind === 'time') {
          const e = resolve(endValue);
          endMs = e.error ? null : e.ms;
        } else if (d && d.sign > 0) {
          const wall = wallAt(copy.zone, s.ms);
          endMs = wallToInstant(copy.zone, wall.day + d.weeks * 7 + d.days, wall.sec) + (d.hours * 3600 + d.minutes * 60 + d.seconds) * 1000;
        }
        if (endMs === undefined || endMs === null || endMs < s.ms) { at(`RDATE period "${rdate.text}" skipped: its end is not readable`); continue; }
        add(s, { allDay: false, startMs: s.ms, endMs, wallDay: wallAt(copy.zone, s.ms).day });
        continue;
      }
      const value = parseDateValue(rdate.text, rdate.params);
      if (!value) { at(`RDATE "${rdate.text}" skipped: not a readable date`); continue; }
      if ((value.kind === 'date') !== allDay) { at(`RDATE "${rdate.text}" skipped: it is ${allDay ? 'a date-time on an all-day event' : 'a date on a timed event'}`); continue; }
      if (outside(value.day)) continue;
      if (allDay) { add({ date: true, day: value.day }, { allDay: true, startDay: value.day, endDay: value.day + copy.duration.days }); continue; }
      const s = resolve(value);
      if (s.error) { at(`RDATE "${rdate.text}" skipped: ${s.error}`); continue; }
      const wall = wallAt(copy.zone, s.ms);
      add(s, timedInstance(copy, s.ms, wall.day, wall.sec));
    }

    const exMs = new Set();
    const exDays = new Set();
    for (const exdate of copy.exdates) {
      const value = parseDateValue(exdate.text, exdate.params);
      if (!value) { at(`EXDATE "${exdate.text}" ignored: not a readable date`); continue; }
      if (outside(value.day)) continue;
      if (value.kind === 'date' || allDay) { exDays.add(value.day); continue; }
      const resolved = resolve(value);
      if (resolved.error) { at(`EXDATE "${exdate.text}" ignored: ${resolved.error}`); continue; }
      exMs.add(resolved.ms);
    }
    for (const [key, instance] of all) {
      if (instance.allDay ? exDays.has(instance.startDay) : exMs.has(instance.startMs) || exDays.has(instance.wallDay)) all.delete(key);
    }
  }

  const instances = new Map([...all].filter(([, instance]) => inRange(instance, q)));
  return { instances, problems };
}

// ---- Merging -------------------------------------------------------------

function normalizeTitle(title) {
  return title.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC').trim();
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function compareOccurrenceRank(a, b) {
  return (b.rank.sequence - a.rank.sequence)
    || ((b.rank.lastModified ?? -Infinity) - (a.rank.lastModified ?? -Infinity) || 0)
    || ((b.rank.dtstamp ?? -Infinity) - (a.rank.dtstamp ?? -Infinity) || 0)
    || (a.minSource - b.minSource)
    || byCodeUnits(a.uid, b.uid)
    || byCodeUnits(a.key, b.key);
}

function makeOccurrence(copy, instance, extra) {
  const sources = [...extra.sources].sort((a, b) => a - b);
  return {
    uid: copy.uid,
    key: `${copy.uid}/${extra.origLabel ?? instance.origLabel}`,
    title: copy.title,
    location: copy.location,
    allDay: instance.allDay,
    startMs: instance.startMs,
    endMs: instance.endMs,
    startDay: instance.startDay,
    endDay: instance.endDay,
    eventTimeZone: copy.start.date || copy.start.floating ? null : copy.zone,
    floating: Boolean(copy.start.floating),
    status: extra.cancelled ? 'cancelled' : copy.status,
    sources,
    minSource: sources[0],
    matchedBy: sources.length > 1 ? 'uid' : null,
    isRepeat: extra.isRepeat,
    isChanged: extra.isChanged,
    repeatNotSupported: extra.repeatNotSupported,
    rank: { sequence: copy.sequence, lastModified: copy.lastModified, dtstamp: copy.dtstamp },
  };
}

function overrideInstance(copy) {
  if (copy.start.date) return { allDay: true, startDay: copy.start.day, endDay: copy.start.day + copy.duration.days };
  return timedInstance(copy, copy.start.ms, copy.start.day, copy.start.sec);
}

function mergeUid(group, q, problems) {
  const out = [];
  const masterCopies = [...group.masters].sort(compareCopies);
  const masterAll = [...group.masters, ...group.records].sort(compareCopies);
  const display = masterCopies[0] ?? null;
  const masterSources = new Set(masterAll.map((c) => c.sourceIndex));
  const hasOverrideCopies = [...group.overrides.values()].some((o) => o.copies.length);
  const seriesCancelled = (masterAll[0] && masterAll[0].kind === 'record') || display?.status === 'cancelled';

  if (!display && !hasOverrideCopies) {
    for (const record of group.records) problems.push({ sourceIndex: record.sourceIndex, line: record.line, text: `cancellation for "${record.uid}" matches no event in any source` });
  }

  // Winners of each changed occurrence (RECURRENCE-ID).
  const changed = new Map();
  for (const [ridKey, entry] of group.overrides) {
    const copies = [...entry.copies].sort(compareCopies);
    if (!copies.length && !display) {
      for (const record of entry.records) problems.push({ sourceIndex: record.sourceIndex, line: record.line, text: `cancellation for "${record.uid}" at ${labelOf(record.rid)} matches no event in any source` });
      continue;
    }
    const contenders = [...copies, ...entry.records];
    if (!copies.length) contenders.push({ ...display, virtualMaster: true });
    contenders.sort(compareCopies);
    const winner = contenders[0];
    if (winner.virtualMaster) continue; // the series copy is newer: nothing changes
    const sources = new Set([...masterSources, ...copies.map((c) => c.sourceIndex), ...entry.records.map((r) => r.sourceIndex)]);
    changed.set(ridKey, { override: copies[0] ?? null, cancelled: winner.kind === 'record', sources, rid: entry.rid });
  }

  const thisAndFuture = [...changed.values()].filter((c) => c.override?.ridRange);
  if (display) {
    const forceSingle = thisAndFuture.length > 0;
    const { instances, notSupported, workLimit, problems: found } = expandSeries(display, q, { forceSingle });
    problems.push(...found);
    if (workLimit) {
      problems.push({ sourceIndex: display.sourceIndex, line: display.line, text: `"${display.uid}" needs too much work to expand (${workLimit}); only its first occurrence is shown` });
    } else if (notSupported) {
      const why = display.ruleProblem ?? 'RANGE=THISANDFUTURE';
      problems.push({ sourceIndex: display.sourceIndex, line: display.line, text: `repeat rule of "${display.uid}" not supported (${why}); only its first occurrence is shown` });
    }
    let list = [...instances.values()].sort((a, b) => (a.allDay ? a.startDay - b.startDay : a.startMs - b.startMs) || byCodeUnits(a.origKey, b.origKey));
    if (list.length > LIMITS.seriesOccurrences) {
      problems.push({ sourceIndex: display.sourceIndex, line: display.line, text: `"${display.uid}" has more than ${LIMITS.seriesOccurrences} occurrences in the range; only the first ${LIMITS.seriesOccurrences} are shown` });
      list = list.slice(0, LIMITS.seriesOccurrences);
    }
    for (const instance of list) {
      const change = changed.get(instance.origKey);
      if (change && change.override) continue; // replaced by the changed copy below
      out.push(makeOccurrence(display, instance, {
        sources: change ? change.sources : masterSources,
        cancelled: seriesCancelled || Boolean(change?.cancelled),
        isRepeat: display.isRepeat,
        isChanged: false,
        repeatNotSupported: notSupported,
      }));
    }
  }

  for (const change of changed.values()) {
    if (!change.override) continue;
    const instance = overrideInstance(change.override);
    if (!inRange(instance, q)) continue;
    out.push(makeOccurrence(change.override, instance, {
      origLabel: labelOf(change.rid),
      sources: change.sources,
      cancelled: seriesCancelled || change.cancelled,
      isRepeat: true,
      isChanged: true,
      repeatNotSupported: Boolean(change.override.ridRange),
    }));
  }
  return out;
}

// Different UIDs, same title and time: grouped one to one, never two
// occurrences from one source in a group.
function matchTitleAndTime(occurrences) {
  const buckets = new Map();
  for (const occurrence of occurrences) {
    const when = occurrence.allDay ? `D${occurrence.startDay}-${occurrence.endDay}` : `T${occurrence.startMs}-${occurrence.endMs}`;
    const matchKey = JSON.stringify([when, normalizeTitle(occurrence.title), occurrence.status]);
    if (!buckets.has(matchKey)) buckets.set(matchKey, []);
    buckets.get(matchKey).push(occurrence);
  }
  const merged = [];
  for (const bucket of buckets.values()) {
    bucket.sort((a, b) => (a.minSource - b.minSource) || byCodeUnits(a.uid, b.uid) || byCodeUnits(a.key, b.key));
    const groups = [];
    for (const occurrence of bucket) {
      const group = groups.find((g) => occurrence.sources.every((s) => !g.sources.has(s)));
      if (group) {
        group.members.push(occurrence);
        for (const s of occurrence.sources) group.sources.add(s);
      } else {
        groups.push({ members: [occurrence], sources: new Set(occurrence.sources) });
      }
    }
    for (const group of groups) {
      if (group.members.length === 1) { merged.push(group.members[0]); continue; }
      const winner = [...group.members].sort(compareOccurrenceRank)[0];
      const sources = [...group.sources].sort((a, b) => a - b);
      merged.push({
        ...winner,
        key: group.members.map((m) => m.key).sort(byCodeUnits).join(' + '),
        sources,
        minSource: sources[0],
        matchedBy: 'title-and-time',
      });
    }
  }
  return merged;
}

function present(occurrence, q, sourceList) {
  const time = (ms) => ({ utc: formatUtc(ms), local: formatLocal(q.zone, ms) });
  return {
    key: occurrence.key,
    uid: occurrence.uid,
    title: occurrence.title,
    location: occurrence.location,
    allDay: occurrence.allDay,
    start: occurrence.allDay ? formatDate(occurrence.startDay) : time(occurrence.startMs),
    end: occurrence.allDay ? formatDate(occurrence.endDay) : time(occurrence.endMs),
    eventTimeZone: occurrence.eventTimeZone,
    floating: occurrence.floating,
    status: occurrence.status,
    sources: occurrence.sources.map((index) => ({ id: sourceList[index].id, name: sourceList[index].name })),
    matchedBy: occurrence.matchedBy,
    isRepeat: occurrence.isRepeat,
    isChanged: occurrence.isChanged,
    repeatNotSupported: occurrence.repeatNotSupported,
  };
}

function sortOccurrences(list, q) {
  const dayOf = (o) => (o.allDay ? Math.max(o.startDay, q.fromDay) : wallAt(q.zone, Math.max(o.startMs, q.rangeStart)).day);
  for (const o of list) o.sortDay = dayOf(o);
  return list.sort((a, b) => {
    if (a.sortDay !== b.sortDay) return a.sortDay - b.sortDay;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay) return byCodeUnits(a.title, b.title) || (a.startDay - b.startDay) || (a.endDay - b.endDay) || byCodeUnits(a.key, b.key);
    return (a.startMs - b.startMs) || (a.endMs - b.endMs) || byCodeUnits(a.title, b.title) || byCodeUnits(a.key, b.key);
  });
}

export async function mergeCalendars(sources, query) {
  const sourceList = checkSources(sources);
  const checked = checkQuery(query);
  const q = {
    ...checked,
    rangeStart: wallToInstant(checked.zone, checked.fromDay, 0),
    rangeEnd: wallToInstant(checked.zone, checked.toDay + 1, 0),
    budget: { steps: LIMITS.callSteps, values: LIMITS.callValues },
  };

  const problems = [];
  const groups = new Map();
  const groupFor = (uid) => {
    if (!groups.has(uid)) groups.set(uid, { masters: [], records: [], overrides: new Map() });
    return groups.get(uid);
  };
  for (const source of sourceList) {
    let read;
    try {
      read = readIcs(source.ics);
    } catch (error) {
      if (error instanceof Refusal) refuse(`Calendar "${source.id}" ${error.message}.`);
      throw error;
    }
    for (const problem of read.problems) problems.push({ sourceIndex: source.index, ...problem });
    for (const raw of read.events) {
      const result = interpret(raw, source, q);
      if (result.problem) { problems.push(result.problem); continue; }
      const { copy } = result;
      const group = groupFor(copy.uid);
      if (copy.ridKey === null) {
        (copy.kind === 'record' ? group.records : group.masters).push(copy);
      } else {
        if (!group.overrides.has(copy.ridKey)) group.overrides.set(copy.ridKey, { copies: [], records: [], rid: copy.rid });
        const entry = group.overrides.get(copy.ridKey);
        (copy.kind === 'record' ? entry.records : entry.copies).push(copy);
      }
    }
  }

  let occurrences = [];
  for (const uid of [...groups.keys()].sort(byCodeUnits)) occurrences.push(...mergeUid(groups.get(uid), q, problems));
  if (!q.includeCancelled) occurrences = occurrences.filter((o) => o.status !== 'cancelled');
  occurrences = sortOccurrences(matchTitleAndTime(occurrences), q);

  problems.sort((a, b) => (a.sourceIndex - b.sourceIndex) || (a.line - b.line) || byCodeUnits(a.text, b.text));
  return {
    schemaVersion: SCHEMA_VERSION,
    query: {
      from: { utc: formatUtc(q.rangeStart), local: formatLocal(q.zone, q.rangeStart) },
      to: { utc: formatUtc(q.rangeEnd), local: formatLocal(q.zone, q.rangeEnd) },
      timeZone: q.zone,
      includeCancelled: q.includeCancelled,
    },
    occurrences: occurrences.map((o) => present(o, q, sourceList)),
    problems: problems.map((p) => `Source "${sourceList[p.sourceIndex].id}", line ${p.line}: ${p.text}.`),
  };
}
