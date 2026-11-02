// Refusals name the field in the message. A reminder problem also names
// the reminder, by its id when that id is usable and by its 1-based place
// when it is not.

export const FILE_BYTES = 1024 * 1024;
export const DEFAULT_DAYS = 14;
export const MAX_SPAN = 3650;
export const ID_MAX = 64;
export const TITLE_MAX = 200;
export const NOTE_MAX = 2000;
export const ITEM_ID_MAX = 200;

export const ITEM_KINDS = Object.freeze(['session', 'note', 'link', 'other']);

export class RevisitError extends Error {
  constructor(field, detail, reminder = null) {
    const who = reminder == null ? '' : `reminder ${reminder}, `;
    super(`${who}field ${field}: ${detail}`);
    this.name = 'RevisitError';
    this.field = field;
    this.reminder = reminder;
  }
}

export function fail(field, detail, reminder = null) {
  throw new RevisitError(field, detail, reminder);
}
