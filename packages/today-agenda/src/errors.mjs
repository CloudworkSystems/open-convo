export const SCHEMA_VERSION = 1;

// 2 MB, measured in bytes. The command uses the file's size; buildAgenda uses
// the UTF-8 size of JSON.stringify of the value it was given.
export const FILE_BYTES = 2 * 1024 * 1024;

export const LIMITS = Object.freeze({
  fileBytes: FILE_BYTES,
  events: 500,
  tasks: 1000,
  habits: 100,
  lists: 50,
  taskTitle: 500,
  name: 200,
  minFreeMinutes: Object.freeze({ min: 5, max: 240 }),
  listOpen: Object.freeze({ min: 0, max: 10000 }),
});

export const DEFAULTS = Object.freeze({
  dayStart: '08:00',
  dayEnd: '18:00',
  minFreeMinutes: 30,
});

export class AgendaError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgendaError';
  }
}

export function fail(message) {
  throw new AgendaError(message);
}
