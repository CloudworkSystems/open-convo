import { IndexedDBRecord, IndexedDBRecordFormatError } from './indexeddb-record';

export interface IdentityPreferences {
  brandName: string;
  displayName: string;
  brandImage: string | null;
  sessionNamingGuidance: string;
  /** Optional so older version-one records remain readable without a rewrite. */
  email?: string;
  avatarImage?: string | null;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface IdentityLoadResult {
  preferences: IdentityPreferences;
  warning: string | null;
  readOnly: boolean;
}

export type IdentitySaveResult =
  | { saved: true; preferences: IdentityPreferences; warning: null }
  | { saved: false; warning: string };

export interface IdentityBaseline { raw: string | null; legacyRaw: string | null }
export interface BrowserIdentityLoadResult extends IdentityLoadResult { baseline: IdentityBaseline | null }
export type BrowserIdentitySaveResult =
  | { saved: true; preferences: IdentityPreferences; baseline: IdentityBaseline; warning: null }
  | { saved: false; warning: string; kind: 'invalid' | 'conflict' | 'failed' };
export interface IdentityRecord {
  read(): Promise<string | null>;
  update<T>(operation: (raw: string | null) => { result: T; raw?: string }): Promise<T>;
  subscribe(changed: () => void): () => void;
}

export const IDENTITY_KEY = 'true-convo:desk:identity:v1';
export const IDENTITY_DATABASE_NAME = 'true-convo:desk:identity:records:v1';
export const DISPLAY_NAME_MAX = 80;
export const BRAND_NAME_MAX = 80;
export const BRAND_IMAGE_MAX_BYTES = 512 * 1024;
export const EMAIL_MAX = 254;
export const AVATAR_IMAGE_MAX_BYTES = BRAND_IMAGE_MAX_BYTES;
export const SESSION_NAMING_GUIDANCE_MAX = 2000;
export const DEFAULT_IDENTITY: Readonly<IdentityPreferences> = {
  brandName: 'True Convo',
  displayName: 'Sample workspace',
  brandImage: null,
  sessionNamingGuidance: '',
};

const invalidWarning = 'Saved display settings could not be read. Their original contents were kept; no replacement can be saved here.';
const unavailableWarning = 'Browser storage could not be read for display settings. Existing saved contents were not changed.';
const saveWarning = 'Display settings could not be saved. Browser storage may be full or blocked. Previous saved settings were kept.';
const conflictWarning = 'Browser identity changed in another window. Your edits are still shown here; discard them and reopen User options before saving another version.';
const imageTypeWarning = 'Choose a PNG, JPEG, or WebP image.';
const imageEncodingWarning = 'The image could not be read as a valid PNG, JPEG, or WebP image.';
const imageSizeWarning = 'Choose an image no larger than 512 KiB.';

function validateName(value: unknown, label: string, max: number): string | null {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= max
    ? null
    : `${label} must contain 1–${max} characters after trimming.`;
}

export function validateDisplayName(value: unknown): string | null {
  return validateName(value, 'Workspace display name', DISPLAY_NAME_MAX);
}

export function validateBrandName(value: unknown): string | null {
  return validateName(value, 'Brand name', BRAND_NAME_MAX);
}

export function validateSessionNamingGuidance(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length <= SESSION_NAMING_GUIDANCE_MAX
    ? null
    : `Session naming guidance must contain no more than ${SESSION_NAMING_GUIDANCE_MAX} characters after trimming.`;
}

export function validateEmail(value: unknown): string | null {
  if (typeof value !== 'string') return 'Enter an email address or leave it empty.';
  const email = value.trim();
  if (!email) return null;
  return email.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? null : 'Enter a valid email address, up to 254 characters, or leave it empty.';
}

/** Accepts only local, canonical base64 raster images with the declared file signature. */
export function validateBrandImage(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') return imageTypeWarning;
  const prefix = /^data:(image\/(?:png|jpeg|webp));base64,/.exec(value);
  if (!prefix) return imageTypeWarning;
  const payload = value.slice(prefix[0].length);
  if (payload.length > 4 * Math.ceil(BRAND_IMAGE_MAX_BYTES / 3)) return imageSizeWarning;
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return imageEncodingWarning;
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0;
  if (payload.length / 4 * 3 - padding > BRAND_IMAGE_MAX_BYTES) return imageSizeWarning;
  let bytes: string;
  try {
    bytes = atob(payload);
    if (btoa(bytes) !== payload) return imageEncodingWarning;
  } catch { return imageEncodingWarning; }
  const matches = (offset: number, signature: readonly number[]) => signature.every((byte, index) => bytes.charCodeAt(offset + index) === byte);
  if (prefix[1] === 'image/png') {
    return matches(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? null : imageEncodingWarning;
  }
  if (prefix[1] === 'image/jpeg') {
    return matches(0, [0xff, 0xd8, 0xff]) ? null : imageEncodingWarning;
  }
  return matches(0, [0x52, 0x49, 0x46, 0x46]) && matches(8, [0x57, 0x45, 0x42, 0x50]) ? null : imageEncodingWarning;
}

/** Avatar crops obey the same local raster and byte limits as workspace images. */
export const validateAvatarImage = validateBrandImage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function preferencesFrom(value: unknown): IdentityPreferences | null {
  const required = ['brandImage', 'brandName', 'displayName', 'sessionNamingGuidance'];
  if (!isRecord(value) || required.some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => ![...required, 'email', 'avatarImage'].includes(key))
    || validateBrandName(value.brandName) || validateDisplayName(value.displayName) || validateBrandImage(value.brandImage)
    || validateSessionNamingGuidance(value.sessionNamingGuidance)
    || (Object.hasOwn(value, 'email') && validateEmail(value.email))
    || (Object.hasOwn(value, 'avatarImage') && validateAvatarImage(value.avatarImage))) return null;
  return {
    brandName: (value.brandName as string).trim(),
    displayName: (value.displayName as string).trim(),
    brandImage: value.brandImage as string | null,
    sessionNamingGuidance: (value.sessionNamingGuidance as string).trim(),
    ...(Object.hasOwn(value, 'email') ? { email: (value.email as string).trim() } : {}),
    ...(Object.hasOwn(value, 'avatarImage') ? { avatarImage: value.avatarImage as string | null } : {}),
  };
}

function decodedPreferences(raw: string): IdentityPreferences | null {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.version !== 1) return null;
  if (['brandImage', 'brandName', 'displayName'].some((key) => !Object.hasOwn(value, key))
    || Object.keys(value).some((key) => !['version', 'brandImage', 'brandName', 'displayName', 'sessionNamingGuidance', 'email', 'avatarImage'].includes(key))) return null;
  return preferencesFrom({
    brandName: value.brandName,
    displayName: value.displayName,
    brandImage: value.brandImage,
    sessionNamingGuidance: Object.hasOwn(value, 'sessionNamingGuidance') ? value.sessionNamingGuidance : '',
    ...(Object.hasOwn(value, 'email') ? { email: value.email } : {}),
    ...(Object.hasOwn(value, 'avatarImage') ? { avatarImage: value.avatarImage } : {}),
  });
}

const fallback = (warning: string | null, readOnly: boolean): IdentityLoadResult => ({ preferences: { ...DEFAULT_IDENTITY }, warning, readOnly });

function identityFromRaw(raw: string | null): IdentityLoadResult {
  if (raw === null) return fallback(null, false);
  try {
    const preferences = decodedPreferences(raw);
    if (preferences) return { preferences, warning: null, readOnly: false };
  } catch { /* Preserve malformed bytes without a repair write. */ }
  return fallback(invalidWarning, true);
}

function invalidPreferences(preferences: IdentityPreferences): string {
  return validateBrandName(preferences?.brandName) || validateDisplayName(preferences?.displayName)
    || validateBrandImage(preferences?.brandImage) || validateSessionNamingGuidance(preferences?.sessionNamingGuidance)
    || (preferences && Object.hasOwn(preferences, 'email') && validateEmail(preferences.email))
    || (preferences && Object.hasOwn(preferences, 'avatarImage') && validateAvatarImage(preferences.avatarImage))
    || 'Display settings have an unsupported shape.';
}

export function sameIdentityBaseline(left: IdentityBaseline | null, right: IdentityBaseline | null): boolean {
  return left === right || (!!left && !!right && left.raw === right.raw && left.legacyRaw === right.legacyRaw);
}

/** Native preferences use one committed IndexedDB record. Legacy bytes are never changed. */
export class BrowserIdentityStore {
  constructor(private readonly record: IdentityRecord = new IndexedDBRecord(IDENTITY_DATABASE_NAME), private readonly legacyStorage?: Pick<StorageLike, 'getItem'>) {}

  private legacyRaw(): string | null {
    return (this.legacyStorage ?? globalThis.localStorage).getItem(IDENTITY_KEY);
  }

  async load(): Promise<BrowserIdentityLoadResult> {
    try {
      const raw = await this.record.read();
      const legacyRaw = raw === null ? this.legacyRaw() : null;
      return { ...identityFromRaw(raw ?? legacyRaw), baseline: { raw, legacyRaw } };
    } catch (error) {
      return { ...fallback(error instanceof IndexedDBRecordFormatError ? invalidWarning : unavailableWarning, true), baseline: null };
    }
  }

  async save(preferences: IdentityPreferences, expected: IdentityBaseline | null): Promise<BrowserIdentitySaveResult> {
    const valid = preferencesFrom(preferences);
    if (!valid) return { saved: false, kind: 'invalid', warning: invalidPreferences(preferences) };
    if (!expected || !(expected.raw === null || typeof expected.raw === 'string')
      || !(expected.legacyRaw === null || typeof expected.legacyRaw === 'string')) return { saved: false, kind: 'failed', warning: unavailableWarning };
    const raw = JSON.stringify({ version: 1, ...valid });
    try {
      return await this.record.update<BrowserIdentitySaveResult>((currentRaw) => {
        if (currentRaw !== expected.raw) return { result: { saved: false, kind: 'conflict', warning: conflictWarning } };
        const legacyRaw = currentRaw === null ? this.legacyRaw() : null;
        if (legacyRaw !== expected.legacyRaw) return { result: { saved: false, kind: 'conflict', warning: conflictWarning } };
        const current = identityFromRaw(currentRaw ?? legacyRaw);
        if (current.readOnly) return { result: { saved: false, kind: 'invalid', warning: current.warning! } };
        return { raw, result: { saved: true, preferences: valid, baseline: { raw, legacyRaw: null }, warning: null } };
      });
    } catch { return { saved: false, kind: 'failed', warning: saveWarning }; }
  }

  subscribe(changed: () => void): () => void { return this.record.subscribe(changed); }
}

let nativeIdentity: BrowserIdentityStore | undefined;
const nativeStore = () => nativeIdentity ??= new BrowserIdentityStore();
export const subscribeIdentity = (changed: () => void): (() => void) => nativeStore().subscribe(changed);

export function loadIdentity(storage: StorageLike): IdentityLoadResult;
export function loadIdentity(): Promise<BrowserIdentityLoadResult>;
export function loadIdentity(storage?: StorageLike): IdentityLoadResult | Promise<BrowserIdentityLoadResult> {
  if (!storage) return nativeStore().load();
  try { return identityFromRaw(storage.getItem(IDENTITY_KEY)); }
  catch { return fallback(unavailableWarning, true); }
}

/** Explicit injected storage is a synchronous test seam, never the native write path. */
export function saveIdentity(preferences: IdentityPreferences, storage: StorageLike): IdentitySaveResult;
export function saveIdentity(preferences: IdentityPreferences, baseline: IdentityBaseline | null): Promise<BrowserIdentitySaveResult>;
export function saveIdentity(preferences: IdentityPreferences, target: StorageLike | IdentityBaseline | null): IdentitySaveResult | Promise<BrowserIdentitySaveResult> {
  if (!target || !('getItem' in target)) return nativeStore().save(preferences, target);
  const valid = preferencesFrom(preferences);
  if (!valid) return { saved: false, warning: invalidPreferences(preferences) };
  // Read immediately before writing so newly malformed or unsupported data is never replaced.
  const current = loadIdentity(target);
  if (current.readOnly) return { saved: false, warning: current.warning! };
  try {
    target.setItem(IDENTITY_KEY, JSON.stringify({ version: 1, ...valid }));
    return { saved: true, preferences: valid, warning: null };
  } catch { return { saved: false, warning: saveWarning }; }
}
