export const SCHEMA_VERSION = 1;

// Binary units, matching the other packages: 8 MB, 64 KB and 8 GB.
export const FILE_BYTES = 8 * 1024 * 1024;
export const TEXT_BYTES = 64 * 1024;
export const NAME_BYTES = 255;
export const CLIP_BYTES = 8 * 1024 * 1024 * 1024;

export const LIMITS = Object.freeze({
  fileBytes: FILE_BYTES,
  textBytes: TEXT_BYTES,
  nameBytes: NAME_BYTES,
  items: 500,
  known: 50_000,
  id: 200,
  clipBytes: CLIP_BYTES,
  title: 80,
});

export const CLIP_TYPES = Object.freeze(new Set([
  'public.mpeg-4',
  'com.apple.quicktime-movie',
]));

export const ONLY_MEDIA = 'Only links and video clips go in the capture folder.';

export class CaptureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CaptureError';
  }
}

export function fail(message) {
  throw new CaptureError(message);
}
