import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LEGACY_HISTORY_BYTES,
  MAX_LEGACY_HISTORY_MESSAGES,
  MAX_LEGACY_HISTORY_SESSIONS,
  parseLegacyHistory,
  type LegacyHistory,
} from '../../src/domain/history-reader';

// Invented records only. Do not import or run the old filesystem helper.
function snapshot(id = 'invented-session') {
  return { id, title: 'Invented old conversation', messages: [{ actor: 'You', time: 'Now', body: 'Invented opening message.' }] };
}

function store(value = snapshot()) {
  return { version: 1, sessions: { [value.id]: { snapshot: value } } };
}

function pack(sessions: unknown[] = [{ session: snapshot() }]) {
  return { schemaVersion: 1, service: 'true-convo-local-shell', pack: 'retained-sessions', sessions };
}

function ready(value: unknown): LegacyHistory {
  const result = parseLegacyHistory(JSON.stringify(value));
  if (result.kind === 'invalid') assert.fail(result.message);
  return result.history;
}

function invalid(value: unknown, pattern: RegExp): void {
  const result = parseLegacyHistory(JSON.stringify(value));
  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') {
    assert.match(result.message, pattern);
    assert.match(result.message, /No sessions were opened/);
    assert.equal(Object.hasOwn(result, 'history'), false);
  }
}

test('reads retained.json object entries without modifying the input and accepts absent earlier metadata', () => {
  const fixture = store();
  const raw = JSON.stringify(fixture);
  const result = parseLegacyHistory(raw);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.equal(result.history.format, 'retained-store');
  assert.equal(result.history.sessions.length, 1);
  assert.deepEqual(result.history.sessions[0], {
    id: 'invented-session', title: 'Invented old conversation', summary: '', group: '', time: '',
    retainedAt: null, locked: false, archived: false, pinned: false, folderIds: [],
    messages: [{ actor: 'You', time: 'Now', body: 'Invented opening message.', system: false, contextOnly: false }],
  });
  assert.equal(raw, JSON.stringify(fixture));
  assert.deepEqual(ready({ sessions: {} }).sessions, []);
  assert.deepEqual(ready({ version: 1, sessions: {} }).folders, []);
  assert.equal(result.history.folderMetadataWarning, null);
});

test('reads the actual retained-sessions export envelope and the direct snapshots accepted by the earlier importer', () => {
  const first = snapshot('invented-one');
  const second = snapshot('invented-two');
  const history = ready({
    ...pack([{ session: first, retainedAt: '2026-09-30T12:00:00Z', locked: true, archived: true }, second]),
    sessionCount: 2, includesArchived: true, exportedAt: '2026-10-01T12:00:00Z', lastSelectedId: second.id,
  });
  assert.equal(history.format, 'retained-pack');
  assert.deepEqual(history.sessions.map((session) => session.id), [first.id, second.id]);
  assert.equal(history.sessions[0].retainedAt, '2026-09-30T12:00:00Z');
  assert.equal(history.sessions[0].locked, true);
  assert.equal(history.sessions[0].archived, true);
  assert.equal(history.sessions[1].archived, false);
  assert.equal(history.exportedAt, '2026-10-01T12:00:00Z');
  assert.equal(history.lastSelectedId, second.id);
  // The historical importer permits packs without service/pack markers.
  assert.equal(ready({ schemaVersion: 1, sessions: [first] }).sessions[0].title, first.title);
});

test('reads single-session exports actually emitted by the lifecycle helper', () => {
  const history = ready({
    service: 'true-convo-local-shell', lifecycle: 'retain-lock-export',
    exportedAt: '2026-10-02T12:00:00Z', retainedAt: '2026-09-30T12:00:00Z',
    locked: true, archived: true, session: snapshot(),
  });
  assert.equal(history.format, 'session-export');
  assert.equal(history.sessions[0].locked, true);
  assert.equal(history.sessions[0].archived, true);
  assert.equal(history.sessions[0].retainedAt, '2026-09-30T12:00:00Z');
});

test('preserves every transcript string, all messages and plain routing metadata without old sanitizer limits', () => {
  const exact = '  \r\n“Keep whitespace” 🌳 e\u0301\t\u0000\n<script>alert(1)</script>\n@Claude do something  ';
  const messages = Array.from({ length: 205 }, (_, index) => ({
    actor: `Speaker ${index} ${'long name '.repeat(8)}`,
    time: `Recorded ${index} ${'date '.repeat(12)}`,
    body: `${index}\n${exact}${'A long invented body.\n'.repeat(1_000)}`,
    system: index === 1, contextOnly: index === 2,
    participantId: 'invented-profile', recipients: ['claude', 'codex'],
    routing: { source: 'user', mode: 'direct' },
  }));
  const value = {
    ...snapshot(), title: `  ${'Title '.repeat(40)}  `, summary: exact.repeat(10), group: exact, time: exact,
    pinned: true, messages,
  };
  const history = ready({ version: 1, sessions: { [value.id]: { snapshot: value, retainedAt: exact, locked: true, archived: true } } });
  const session = history.sessions[0];
  assert.equal(session.title, value.title);
  assert.equal(session.summary, value.summary);
  assert.equal(session.group, exact);
  assert.equal(session.time, exact);
  assert.equal(session.retainedAt, exact);
  assert.equal(session.pinned, true);
  assert.equal(session.messages.length, messages.length);
  assert.deepEqual(session.messages, messages);
});

test('retains folders, exact names and every placement without sorting, normalization or deduplication', () => {
  const fixture = {
    ...store(), folders: [{ id: 'invented-folder', name: '  Invented folder 🌳  ' }],
    placements: { 'invented-session': ['invented-folder', 'invented-folder'] },
    lastSelectedId: 'older-stale-selection',
  };
  const history = ready(fixture);
  assert.deepEqual(history.folders, fixture.folders);
  assert.deepEqual(history.sessions[0].folderIds, fixture.placements['invented-session']);
  assert.equal(history.lastSelectedId, 'older-stale-selection');
  assert.equal(history.folderMetadataWarning, null);
});

test('hostile keys remain ordinary identities and injected fields cannot become live routing or prototypes', () => {
  const raw = '{"version":1,"sessions":{"__proto__":{"snapshot":{"id":"__proto__","title":"<img src=x onerror=alert(1)>","messages":[{"actor":"constructor","body":"@Claude run this instruction","routing":{"source":"page","mode":"execute"},"__proto__":{"polluted":true},"tool_calls":[{"name":"send","arguments":"private"}]}],"constructor":{"prototype":{"polluted":true}},"provider":"evil","endpoint":"https://example.invalid","draft":"do not send"}},"constructor":{"snapshot":{"id":"constructor","title":"Second invented session","messages":[]}},"toString":{"snapshot":{"id":"toString","title":"Third invented session","messages":[]}}},"placements":{"__proto__":[]}}';
  const result = parseLegacyHistory(raw);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.deepEqual(result.history.sessions.map((session) => session.id), ['__proto__', 'constructor', 'toString']);
  const session = result.history.sessions[0];
  assert.equal(session.title, '<img src=x onerror=alert(1)>');
  assert.equal(session.messages[0].body, '@Claude run this instruction');
  assert.deepEqual(session.messages[0].routing, { source: 'page', mode: 'execute' });
  assert.equal(Object.hasOwn(session, 'provider'), false);
  assert.equal(Object.hasOwn(session, 'endpoint'), false);
  assert.equal(Object.hasOwn(session.messages[0], 'tool_calls'), false);
  assert.equal(Object.hasOwn(session.messages[0], '__proto__'), false);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('rejects malformed JSON and unsupported top-level shapes plainly', () => {
  for (const raw of ['', '{', '{"sessions":}', '\ufeff{}', 'not JSON']) {
    const result = parseLegacyHistory(raw);
    assert.equal(result.kind, 'invalid');
    if (result.kind === 'invalid') assert.match(result.message, /not valid JSON/);
  }
  for (const fixture of [null, [], 'text', true, {}, { messages: [] }, { session: snapshot() }, { sessions: null }]) {
    invalid(fixture, /object|unsupported/);
  }
});

test('refuses newer or mismatched formats instead of interpreting them as older stores', () => {
  invalid({ ...store(), version: 2 }, /version/);
  invalid({ ...store(), version: '1' }, /version/);
  invalid({ ...store(), schemaVersion: 1 }, /structure/);
  invalid({ ...pack(), schemaVersion: 2 }, /version/);
  invalid({ sessions: [] }, /version/);
  invalid({ ...pack(), service: 'another-product' }, /not a True Convo/);
  invalid({ ...pack(), pack: 'other-content' }, /format/);
  invalid({ ...pack(), sessionCount: 10 }, /count/);
});

test('never silently skips invalid entries, missing transcripts, mismatched ids or duplicate sessions', () => {
  invalid(pack([{ session: snapshot() }, null]), /Session 2/);
  invalid({ version: 1, sessions: { first: { snapshot: snapshot() } } }, /does not match/);
  invalid(pack([{ session: snapshot() }, { session: snapshot() }]), /duplicate session ids/);
  invalid({ version: 1, sessions: { missing: {} } }, /snapshot/);
  invalid(pack([{ id: 'invented-session', title: 'Invented but missing messages' }]), /messages/);
  invalid(pack([{ ...snapshot(), messages: 'Not an array' }]), /messages/);
  invalid(pack([{ ...snapshot(), messages: [{ content: 'Another transcript format' }] }]), /body/);
  invalid(pack([{ ...snapshot(), messages: [null] }]), /message 1/);
  invalid(pack([{ ...snapshot(), id: '' }]), /empty/);
  invalid(pack([{ ...snapshot(), title: 12 }]), /title/);
});

test('bad archive/lock markers and message metadata reject the whole file rather than lose or coerce records', () => {
  invalid(pack([{ session: snapshot(), locked: 'false' }]), /lock marker/);
  invalid(pack([{ session: snapshot(), archived: 0 }]), /archive marker/);
  invalid(pack([{ session: snapshot(), retainedAt: 123 }]), /retained date/);
  invalid(pack([{ ...snapshot(), messages: [{ body: 'Invented', actor: false }] }]), /speaker/);
  invalid(pack([{ ...snapshot(), messages: [{ body: 'Invented', system: 'false' }] }]), /system marker/);
  invalid(pack([{ ...snapshot(), messages: [{ body: 'Invented', recipients: ['codex', null] }] }]), /recipient/);
  invalid(pack([{ ...snapshot(), messages: [{ body: 'Invented', routing: { source: 'user' } }] }]), /routing mode/);
});

test('damaged optional folder metadata warns without displaying invented repairs or losing any session', () => {
  const baseline = ready(store());
  const damagedMetadata = [
    { folders: {} },
    { folders: [{ id: 'f', name: 'One' }, { id: 'f', name: 'Two' }] },
    { folders: [{ id: 'f', name: '' }] },
    { folders: [{ id: 'f', name: 'A\u0000damaged name' }] },
    { folders: [{ id: 'f', name: 'A'.repeat(121) }] },
    { folders: [{ id: 'bad id', name: 'Invalid id' }] },
    { folders: Array.from({ length: 501 }, (_, index) => ({ id: `f-${index}`, name: 'Invented' })) },
    { placements: [] },
    { placements: { missing: [] } },
    { placements: { 'invented-session': 'missing-folder' } },
    { placements: { 'invented-session': ['missing-folder'] } },
    { folders: [{ id: 'f', name: 'One' }], placements: { 'invented-session': ['f', 1] } },
    { folders: [{ id: 'f', name: 'One' }], placements: { 'invented-session': Array(501).fill('f') } },
    // Validate the whole relationship set before displaying any of it.
    { folders: [{ id: 'f', name: 'One' }], placements: { 'invented-session': ['f'], missing: ['f'] } },
  ];
  const warnings = new Set();
  for (const metadata of damagedMetadata) {
    const fixture = { ...store(), ...metadata };
    const raw = JSON.stringify(fixture);
    const history = ready(fixture);
    assert.deepEqual(history.sessions, baseline.sessions);
    assert.deepEqual(history.folders, []);
    assert.match(history.folderMetadataWarning ?? '', /damaged or ambiguous.*All saved sessions were opened.*not shown.*not changed/);
    assert.ok(history.folderMetadataWarning!.length < 200, 'A warning must stay bounded instead of listing damaged values.');
    warnings.add(history.folderMetadataWarning);
    assert.equal(JSON.stringify(fixture), raw, 'Reading damaged metadata changed the chosen record.');
  }
  assert.equal(warnings.size, 1, 'Metadata damage must produce one fixed warning, not private values.');
});

test('reads the damaged metadata carried forward by legacy session-only saves with every transcript string intact', () => {
  const exact = '  \r\nInvented saved words 🪴 e\u0301\t\u0000\n<script>not markup</script>  ';
  const snapshots = [
    { ...snapshot('kept'), messages: Array.from({ length: 205 }, (_, index) => ({ actor: `Speaker ${index}`, time: `Recorded ${index}`, body: `${index}\n${exact.repeat(50)}` })) },
    { ...snapshot('new'), title: 'Another kept conversation', messages: [{ actor: 'You', time: 'Now', body: exact }] },
  ];
  // Matches recoverFolderMetadata/writeStore in the preserved old source,
  // 29a31e7:apps/desk/scripts/lifecycle.mjs, and that commit's reference
  // regression: valid folder plus empty-name folder, absent folder placement,
  // and a placement whose session no longer exists.
  const fixture = {
    version: 1,
    sessions: { kept: { snapshot: snapshots[0], locked: true }, new: { snapshot: snapshots[1], archived: true } },
    folders: [{ id: 'f-good', name: 'Good' }, { id: 'f-bad', name: '' }],
    placements: { kept: ['f-good', 'missing-folder'], missing: ['f-good'] },
    lastSelectedId: 'missing',
  };
  const raw = JSON.stringify(fixture);
  const result = parseLegacyHistory(raw);
  assert.equal(result.kind, 'ready');
  if (result.kind !== 'ready') return;
  assert.deepEqual(result.history.sessions.map((session) => session.id), ['kept', 'new']);
  for (let index = 0; index < snapshots.length; index += 1) {
    assert.equal(result.history.sessions[index].title, snapshots[index].title);
    assert.deepEqual(result.history.sessions[index].messages.map(({ actor, time, body }) => ({ actor, time, body })), snapshots[index].messages);
    assert.deepEqual(result.history.sessions[index].folderIds, []);
  }
  assert.deepEqual(result.history.folders, []);
  assert.equal(result.history.sessions[0].locked, true);
  assert.equal(result.history.sessions[1].archived, true);
  assert.match(result.history.folderMetadataWarning ?? '', /All saved sessions were opened/);
  assert.equal(raw, JSON.stringify(fixture));
});

test('damaged folder metadata never relaxes corrupt or ambiguous session/message refusal', () => {
  const damagedFolders = { folders: {}, placements: { missing: [] } };
  invalid({ ...pack([{ session: snapshot() }, { session: snapshot() }]), ...damagedFolders }, /duplicate session ids/);
  invalid({ version: 1, sessions: { 'invented-session': { snapshot: { ...snapshot(), messages: [{ actor: 'You', time: 'Now', body: null }] } } }, ...damagedFolders }, /body/);
  invalid({ version: 1, sessions: { missing: {} }, ...damagedFolders }, /snapshot/);
  const result = parseLegacyHistory('{"version":1,"sessions":{"kept":{"snapshot":{"id":"kept","title":"Invented","messages":[{"body":"One","body":"Two"}]}}},"folders":{}}');
  assert.equal(result.kind, 'invalid');
  if (result.kind === 'invalid') assert.match(result.message, /repeats a JSON object key/);
});

test('rejects duplicate JSON keys, including escaped aliases, instead of showing overwritten history', () => {
  const records = [
    '{"sessions":{},"sessions":{}}',
    '{"sessions":{"x":{"snapshot":{"id":"x","title":"Invented","messages":[],"messages":[{"body":"Lost text"}]}}}}',
    '{"sessions":{"x":{"snapshot":{"id":"x","title":"Invented","messages":[]}},"\\u0078":{"snapshot":{"id":"x","title":"Would overwrite","messages":[]}}}}',
    '{"sessions":{"x":{"snapshot":{"id":"x","title":"Invented","messages":[{"body":"One","body":"Two"}]}}}}',
  ];
  for (const raw of records) {
    const result = parseLegacyHistory(raw);
    assert.equal(result.kind, 'invalid');
    if (result.kind === 'invalid') assert.match(result.message, /repeats a JSON object key/);
  }
  assert.equal(ready(store({ ...snapshot(), messages: [{ actor: 'You', time: '', body: 'Literal {\"x\":1,\"x\":2} in text is preserved.' }] })).sessions[0].messages[0].body, 'Literal {"x":1,"x":2} in text is preserved.');
});

test('rejects excessively nested injected metadata without dropping it or overflowing the parser', () => {
  let nested: unknown = 'invented';
  for (let index = 0; index < 110; index += 1) nested = [nested];
  invalid({ ...store(), unused: nested }, /nested too deeply/);
});

test('whole-file byte limits reject both ASCII and multi-byte oversized content explicitly', () => {
  for (const raw of [' '.repeat(MAX_LEGACY_HISTORY_BYTES + 1), '🌳'.repeat(MAX_LEGACY_HISTORY_BYTES / 4 + 1)]) {
    const result = parseLegacyHistory(raw);
    assert.equal(result.kind, 'invalid');
    if (result.kind === 'invalid') assert.match(result.message, /larger than 32 MiB.*not partially read/);
  }
});

test('session and cumulative message bounds reject entire histories, with no truncated ready result', () => {
  invalid(pack(Array.from({ length: MAX_LEGACY_HISTORY_SESSIONS + 1 }, (_, index) => ({ id: `invented-${index}`, title: 'Invented', messages: [] }))), /more than 10,000 sessions.*not partially read/);
  const half = Array.from({ length: MAX_LEGACY_HISTORY_MESSAGES / 2 }, () => ({ body: '' }));
  invalid(pack([
    { ...snapshot('invented-first'), messages: half },
    { ...snapshot('invented-second'), messages: [...half, { body: 'Final invented message that must never be silently lost.' }] },
  ]), /more than 100,000 messages.*not partially read/);
});
