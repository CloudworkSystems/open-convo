// Test helpers. Every calendar here is invented.
import './setup/guard.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeCalendars } from '../src/index.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const NY = 'America/New_York';

export function fixture(name) {
  return fs.readFileSync(path.join(HERE, 'fixtures', name), 'utf8');
}

// A calendar from VEVENTs (arrays of lines) and loose lines, CRLF endings.
export function cal(...items) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Open Convo tests//Invented//EN',
    ...items.flat(), 'END:VCALENDAR', '',
  ].join('\r\n');
}

export function ev(...props) {
  return ['BEGIN:VEVENT', ...props, 'END:VEVENT'];
}

// sources: { id: icsText, ... } in order, or a ready list.
export function merge(sources, query) {
  const list = Array.isArray(sources) ? sources : Object.entries(sources).map(([id, ics]) => ({ id, name: id, ics }));
  return mergeCalendars(list, { timeZone: NY, ...query });
}

export const locals = (result) => result.occurrences.map((o) => (o.allDay ? o.start : o.start.local));
export const utcs = (result) => result.occurrences.map((o) => (o.allDay ? o.start : o.start.utc));
export const titles = (result) => result.occurrences.map((o) => o.title);
export const sourceIds = (occurrence) => occurrence.sources.map((s) => s.id);

// Splits a calendar's VEVENTs out and puts them back in the given order.
export function reorderEvents(text, order) {
  const lines = text.split(/\r\n|\n/);
  const head = [];
  const events = [];
  const tail = [];
  let current = null;
  for (const line of lines) {
    if (/^BEGIN:VEVENT$/i.test(line)) current = [line];
    else if (current) {
      current.push(line);
      if (/^END:VEVENT$/i.test(line)) { events.push(current); current = null; }
    } else if (events.length) tail.push(line);
    else head.push(line);
  }
  const picked = order(events.map((_, i) => i)).map((i) => events[i]);
  return [...head, ...picked.flat(), ...tail].join('\r\n');
}

export const reversed = (indexes) => [...indexes].reverse();
export const rotated = (indexes) => [...indexes.slice(1), indexes[0]];
