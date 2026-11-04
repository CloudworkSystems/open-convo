export const SCHEMA_VERSION = 1;

// 2 MB, measured in bytes. The command uses the file's size; renderBoard
// uses the UTF-8 size of JSON.stringify of the value it was given.
export const FILE_BYTES = 2 * 1024 * 1024;

export const LIMITS = Object.freeze({
  fileBytes: FILE_BYTES,
  people: Object.freeze({ min: 1, max: 8 }),
  lists: Object.freeze({ min: 0, max: 6 }),
  listItems: 12,
  sources: 50,
  showRules: 200,
  privateRules: 500,
  timeline: 500,
  tasks: 1000,
  habits: 100,
  clashes: 500,
  name: 200,
  title: 200,
  id: 200,
  item: 200,
  key: 10000,
  more: 10000,
  summary: 20,
  freeTime: 50,
  agendaLists: 50,
});

export const STALE_MS = 30 * 60 * 1000;

export class WallBoardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WallBoardError';
  }
}

export function fail(message) {
  throw new WallBoardError(message);
}
