/**
 * Read-only views of the formats written by the retired Desk lifecycle helper.
 * This module deliberately has no dependency on that helper, a repository,
 * browser storage, a provider, or a filesystem. Nothing here is a migration.
 */
export const MAX_LEGACY_HISTORY_BYTES = 32 * 1024 * 1024;
export const MAX_LEGACY_HISTORY_SESSIONS = 10_000;
export const MAX_LEGACY_HISTORY_MESSAGES = 100_000;

export interface LegacyHistoryMessage {
  actor: string;
  time: string;
  body: string;
  system: boolean;
  contextOnly: boolean;
  participantId?: string;
  recipients?: string[];
  routing?: { source: string; mode: string };
}

export interface LegacyHistorySession {
  id: string;
  title: string;
  summary: string;
  group: string;
  time: string;
  retainedAt: string | null;
  locked: boolean;
  archived: boolean;
  pinned: boolean;
  folderIds: string[];
  messages: LegacyHistoryMessage[];
}

export interface LegacyHistoryFolder {
  id: string;
  name: string;
}

export interface LegacyHistory {
  format: 'retained-store' | 'retained-pack' | 'session-export';
  sessions: LegacyHistorySession[];
  folders: LegacyHistoryFolder[];
  folderMetadataWarning: string | null;
  lastSelectedId: string | null;
  exportedAt: string | null;
}

export type LegacyHistoryResult =
  | { kind: 'ready'; history: LegacyHistory }
  | { kind: 'invalid'; message: string };

type JsonObject = Record<string, unknown>;

class HistoryFormatError extends Error {}

function fail(message: string): never {
  throw new HistoryFormatError(message);
}

function object(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a JSON object. No sessions were opened.`);
  }
  return value as JsonObject;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must contain text. No sessions were opened.`);
  return value;
}

function id(value: unknown, label: string): string {
  const result = text(value, label);
  if (!result.trim()) fail(`${label} is empty. No sessions were opened.`);
  return result;
}

function optionalText(record: JsonObject, key: string, label: string): string {
  return Object.hasOwn(record, key) ? text(record[key], label) : '';
}

function optionalNullableText(record: JsonObject, key: string, label: string): string | null {
  return !Object.hasOwn(record, key) || record[key] === null ? null : text(record[key], label);
}

function optionalBool(record: JsonObject, key: string, label: string): boolean {
  if (!Object.hasOwn(record, key)) return false;
  if (typeof record[key] !== 'boolean') fail(`${label} must be true or false. No sessions were opened.`);
  return record[key] as boolean;
}

/**
 * JSON.parse silently overwrites repeated object keys. Refuse that ambiguity
 * rather than show a transcript from which sessions or messages disappeared.
 * JSON.parse has already checked the grammar; this scan also bounds nesting.
 */
function checkJsonStructure(raw: string): void {
  let position = 0;
  const whitespace = () => {
    while (position < raw.length && /\s/.test(raw[position])) position += 1;
  };
  const readString = (): string => {
    const start = position++;
    while (position < raw.length) {
      if (raw[position] === '\\') position += 2;
      else if (raw[position++] === '"') return raw.slice(start, position);
    }
    fail('The file is not valid JSON. No sessions were opened.');
  };
  const value = (depth: number): void => {
    if (depth > 100) fail('The file is nested too deeply to open safely. No sessions were opened.');
    whitespace();
    if (raw[position] === '{') {
      position += 1;
      whitespace();
      if (raw[position] === '}') { position += 1; return; }
      const keys = new Set<string>();
      while (position < raw.length) {
        const key = JSON.parse(readString()) as string;
        if (keys.has(key)) fail('The file repeats a JSON object key, so its saved data is ambiguous. No sessions were opened.');
        keys.add(key);
        whitespace();
        position += 1; // Colon, already checked by JSON.parse.
        value(depth + 1);
        whitespace();
        if (raw[position++] === '}') return;
        whitespace();
      }
    } else if (raw[position] === '[') {
      position += 1;
      whitespace();
      if (raw[position] === ']') { position += 1; return; }
      while (position < raw.length) {
        value(depth + 1);
        whitespace();
        if (raw[position++] === ']') return;
      }
    } else if (raw[position] === '"') {
      readString();
    } else {
      while (position < raw.length && !/[\s,}\]]/.test(raw[position])) position += 1;
    }
  };
  value(0);
}

function readMessage(value: unknown, label: string): LegacyHistoryMessage {
  const source = object(value, label);
  const message: LegacyHistoryMessage = {
    actor: optionalText(source, 'actor', `${label} speaker`),
    time: optionalText(source, 'time', `${label} time`),
    body: text(source.body, `${label} body`),
    system: optionalBool(source, 'system', `${label} system marker`),
    contextOnly: optionalBool(source, 'contextOnly', `${label} context marker`),
  };
  if (Object.hasOwn(source, 'participantId')) message.participantId = text(source.participantId, `${label} participant`);
  if (Object.hasOwn(source, 'recipients')) {
    if (!Array.isArray(source.recipients)) fail(`${label} recipients must be a list. No sessions were opened.`);
    message.recipients = source.recipients.map((recipient) => text(recipient, `${label} recipient`));
  }
  if (Object.hasOwn(source, 'routing')) {
    const routing = object(source.routing, `${label} routing record`);
    message.routing = { source: text(routing.source, `${label} routing source`), mode: text(routing.mode, `${label} routing mode`) };
  }
  return message;
}

function readFolders(root: JsonObject): LegacyHistoryFolder[] {
  if (!Object.hasOwn(root, 'folders')) return [];
  if (!Array.isArray(root.folders) || root.folders.length > 500) fail('Saved folders must be a list of up to 500 folders.');
  const seen = new Set<string>();
  return root.folders.map((value, index) => {
    const source = object(value, `Folder ${index + 1}`);
    const folderId = id(source.id, `Folder ${index + 1} id`);
    const name = text(source.name, `Folder ${index + 1} name`);
    if (!/^[a-z0-9_-]{1,80}$/i.test(folderId) || !name.trim() || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) {
      fail('Saved folder information is invalid.');
    }
    if (seen.has(folderId)) fail('The file contains duplicate folder ids. No sessions were opened.');
    seen.add(folderId);
    return { id: folderId, name };
  });
}

/**
 * The old lifecycle helper kept session snapshots and carried damaged folder
 * fields forward on session-only saves. Those optional fields must not make
 * intact conversations unreadable. Validate them as a unit; do not guess which
 * relationships were intended or show a partly repaired folder view.
 */
function readFolderMetadata(root: JsonObject, sessions: LegacyHistorySession[]): {
  folders: LegacyHistoryFolder[];
  placements: Map<string, string[]>;
  warning: string | null;
} {
  try {
    const folders = readFolders(root);
    const placements = new Map<string, string[]>();
    if (Object.hasOwn(root, 'placements')) {
      const source = object(root.placements, 'Saved folder placements');
      const folderIds = new Set(folders.map((folder) => folder.id));
      const sessionIds = new Set(sessions.map((session) => session.id));
      for (const [sessionId, rawFolderIds] of Object.entries(source)) {
        if (!sessionIds.has(sessionId) || !Array.isArray(rawFolderIds) || rawFolderIds.length > 500) {
          fail('Saved folder placements refer to missing or invalid sessions.');
        }
        placements.set(sessionId, rawFolderIds.map((value) => {
          const folderId = text(value, 'Saved folder placement');
          if (!folderIds.has(folderId)) fail('Saved folder placements refer to a missing folder.');
          return folderId;
        }));
      }
    }
    return { folders, placements, warning: null };
  } catch (error) {
    if (!(error instanceof HistoryFormatError)) throw error;
    return {
      folders: [],
      placements: new Map(),
      // One bounded message, without echoing damaged values or private IDs.
      warning: 'Saved folder information is damaged or ambiguous. All saved sessions were opened; folder names and placements are not shown. The chosen file was not changed.',
    };
  }
}

function readHistory(root: JsonObject): LegacyHistory {
  let format: LegacyHistory['format'];
  let entries: { key?: string; envelope: JsonObject; snapshot: unknown }[];
  if (Array.isArray(root.sessions)) {
    if (root.schemaVersion !== 1) fail('Unsupported saved-session pack version. Expected schemaVersion 1. No sessions were opened.');
    if (Object.hasOwn(root, 'service') && root.service !== 'true-convo-local-shell') fail('This is not a True Convo saved-session pack. No sessions were opened.');
    if (Object.hasOwn(root, 'pack') && root.pack !== 'retained-sessions') fail('Unsupported saved-session pack format. No sessions were opened.');
    if (Object.hasOwn(root, 'sessionCount') && root.sessionCount !== root.sessions.length) fail('The saved session count does not match the file. No sessions were opened.');
    format = 'retained-pack';
    entries = root.sessions.map((value, index) => {
      const envelope = object(value, `Session ${index + 1}`);
      return { envelope, snapshot: Object.hasOwn(envelope, 'session') ? envelope.session : envelope };
    });
  } else if (Object.hasOwn(root, 'sessions')) {
    if (Object.hasOwn(root, 'version') && root.version !== 1) fail('Unsupported retained.json version. Expected version 1. No sessions were opened.');
    if (Object.hasOwn(root, 'schemaVersion')) fail('Unsupported saved-session structure. No sessions were opened.');
    format = 'retained-store';
    const source = object(root.sessions, 'Saved sessions');
    entries = Object.entries(source).map(([key, value], index) => {
      const envelope = object(value, `Session ${index + 1}`);
      return { key, envelope, snapshot: envelope.snapshot };
    });
  } else if (Object.hasOwn(root, 'session') && root.service === 'true-convo-local-shell' && root.lifecycle === 'retain-lock-export') {
    format = 'session-export';
    entries = [{ envelope: root, snapshot: root.session }];
  } else {
    fail('Choose a retained.json file or a True Convo saved-session export. This format is unsupported. No sessions were opened.');
  }
  if (entries.length > MAX_LEGACY_HISTORY_SESSIONS) fail(`The file contains more than ${MAX_LEGACY_HISTORY_SESSIONS.toLocaleString('en-US')} sessions. No sessions were opened; the file was not partially read.`);
  const seen = new Set<string>();
  let messageCount = 0;
  const sessions = entries.map(({ key, envelope, snapshot }, index): LegacyHistorySession => {
    const label = `Session ${index + 1}`;
    const source = object(snapshot, `${label} snapshot`);
    const sessionId = id(source.id, `${label} id`);
    if (key !== undefined && key !== sessionId) fail(`${label} id does not match its saved key. No sessions were opened.`);
    if (seen.has(sessionId)) fail('The file contains duplicate session ids. No sessions were opened.');
    seen.add(sessionId);
    if (!Array.isArray(source.messages)) fail(`${label} messages must be a list. No sessions were opened.`);
    messageCount += source.messages.length;
    if (messageCount > MAX_LEGACY_HISTORY_MESSAGES) fail(`The file contains more than ${MAX_LEGACY_HISTORY_MESSAGES.toLocaleString('en-US')} messages. No sessions were opened; the transcript was not partially read.`);
    return {
      id: sessionId,
      title: text(source.title, `${label} title`),
      summary: optionalText(source, 'summary', `${label} summary`),
      group: optionalText(source, 'group', `${label} group`),
      time: optionalText(source, 'time', `${label} time`),
      retainedAt: optionalNullableText(envelope, 'retainedAt', `${label} retained date`),
      locked: optionalBool(envelope, 'locked', `${label} lock marker`),
      archived: optionalBool(envelope, 'archived', `${label} archive marker`),
      pinned: optionalBool(source, 'pinned', `${label} pin marker`),
      folderIds: [],
      messages: source.messages.map((message, messageIndex) => readMessage(message, `${label}, message ${messageIndex + 1}`)),
    };
  });
  const folderMetadata = readFolderMetadata(root, sessions);
  for (const session of sessions) session.folderIds = folderMetadata.placements.get(session.id) ?? [];
  return {
    format,
    sessions,
    folders: folderMetadata.folders,
    folderMetadataWarning: folderMetadata.warning,
    lastSelectedId: optionalNullableText(root, 'lastSelectedId', 'Last selected session'),
    exportedAt: optionalNullableText(root, 'exportedAt', 'Export date'),
  };
}

/** Parse the entire chosen file or reject it; never truncate or salvage a partial transcript. */
export function parseLegacyHistory(raw: string): LegacyHistoryResult {
  if (typeof raw !== 'string') return { kind: 'invalid', message: 'The chosen file could not be read as text. No sessions were opened.' };
  if (raw.length > MAX_LEGACY_HISTORY_BYTES || new TextEncoder().encode(raw).byteLength > MAX_LEGACY_HISTORY_BYTES) {
    return { kind: 'invalid', message: 'The file is larger than 32 MiB. No sessions were opened; the file was not partially read.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', message: 'The file is not valid JSON. No sessions were opened.' };
  }
  try {
    checkJsonStructure(raw);
    return { kind: 'ready', history: readHistory(object(parsed, 'Saved session file')) };
  } catch (error) {
    return { kind: 'invalid', message: error instanceof HistoryFormatError ? error.message : 'The saved session file could not be read safely. No sessions were opened.' };
  }
}
