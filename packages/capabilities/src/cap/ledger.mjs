// The spending ledger. Each entry is chained to the one before by SHA-256,
// and the protected state keeps the head and the count. A missing, edited,
// or older file counts as fully spent: paid runs stop until resetLedger is
// called with a new signed cap, a higher revision than the one already
// stored. Reservations take one in-process queue and one
// exclusive lock file, so two runs cannot share the last of a budget.
//
// A run counts in the calendar month of its reservation, in the cap's time
// zone, even if it is settled later. Settling replaces the reservation: the
// actual (or the reserved maximum, when the cost stays estimated) is what
// counts, not both. A provider figure, when the caller has one, replaces
// this route's settled total when it is higher. Open reservations are added
// on top, because the provider has not billed them yet.

import { resolve } from 'node:path';
import { canonicalJson, isPlainObject, own, sameText, sha256Hex } from './json.mjs';
import { atomicWrite, fileKind, readNoFollow } from './files.mjs';
import { inProcess, withFileLock } from './lock.mjs';
import { moneyFromMicros, parseDecimal, parseMoney } from './money.mjs';
import { REASONS } from './reasons.mjs';
import { convertQuote, signedCap, verifyCap } from './record.mjs';
import { calendarMonth, instantText } from './time.mjs';

const LEDGER_FILE = 'entries.jsonl';
const LOCK_FILE = 'ledger.lock';
// A damaged or hostile file must not be read without bound. Ordinary history
// never reaches these ceilings: closed months are folded into checkpoints
// first, and a write that would still cross either ceiling is refused
// before anything is saved.
let maxLedgerBytes = 2 * 1024 * 1024;
let maxLedgerEntries = 10000;

/** Test-only. Production callers do not use this. */
export function setLedgerCeilingForTests(entries, bytes) {
  maxLedgerEntries = entries;
  maxLedgerBytes = bytes;
}
const MAX_LINE = 4096;
const HEX = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const JOB = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KINDS = new Set(['reserve', 'settle', 'release', 'over-bill', 'checkpoint']);
const CHECKPOINT_JOB = 'checkpoint';

export async function reserve(args) {
  return transact(args, (dir) => mutate(dir, args, (loaded) => reserveEntry(loaded, args)));
}

export async function settle(args) {
  return transact(args, (dir) => mutate(dir, args, (loaded) => settleEntry(loaded, args)));
}

export async function release(args) {
  return transact(args, (dir) => mutate(dir, args, (loaded) => releaseEntry(loaded, args)));
}

export async function resetLedger(args) {
  return transact(args, (dir) => resetEntries(dir, args));
}

export async function monthSpent(args) {
  return transact(args, (dir) => readMonth(dir, args));
}

/** Read-only picture for the show command. It does not take the lock or write. */
export function describe({ ledgerDir, store, record, signature, publicKey, now }) {
  const state = store.read();
  const cap = verifyCap(record, signature, publicKey, state);
  const lines = [];
  if (!cap.ok) {
    lines.push('Cap per run: 0', 'Cap this capability this month: 0', 'Cap all paid capabilities this month: 0');
    lines.push('Paused: no', 'Time zone: unknown', `Why: ${cap.reason}`);
  } else {
    lines.push(
      `Cap per run: ${cap.perRun.amount} ${cap.currency}`,
      `Cap this capability this month: ${cap.monthlyByCapability.amount} ${cap.currency}`,
      `Cap all paid capabilities this month: ${cap.monthlyAll.amount} ${cap.currency}`,
      `Paused: ${cap.paused ? 'yes' : 'no'}`,
      `Time zone: ${cap.timeZone}`,
    );
  }
  const ledger = state.broken
    ? { ok: false, reason: REASONS.protectedBroken }
    : judgeLedger(ledgerDir, state, cap.ok ? cap.currency : null);
  if (!cap.ok || !instantText(now)) {
    lines.push('Reserved this month: unknown', 'Spent this month: unknown');
  } else if (!ledger.ok) {
    lines.push('Reserved this month: fully spent', 'Spent this month: fully spent');
  } else {
    const figures = figuresFor(ledger.jobs, ledger.checkpoints, calendarMonth(now, cap.timeZone), cap.timeZone, cap.currency);
    lines.push(
      `Reserved this month: ${figures.reserved.amount} ${cap.currency}`,
      `Spent this month: ${figures.spent.amount} ${cap.currency}`,
    );
  }
  lines.push(`Ledger: ${ledger.ok ? 'checks out' : ledger.reason}`);
  return lines;
}

async function transact(args, fn) {
  if (!args || typeof args.ledgerDir !== 'string') return { ok: false, reason: REASONS.ledgerFolder };
  const dir = resolve(args.ledgerDir);
  if (fileKind(dir) !== 'directory') return { ok: false, reason: REASONS.ledgerFolder };
  return inProcess(dir, async () => {
    const locked = await withFileLock(resolve(dir, LOCK_FILE), () => fn(dir));
    if (!locked.ok) return { ok: false, reason: REASONS.ledgerBusy };
    return locked.value;
  });
}

function mutate(dir, args, build) {
  const loaded = loadForWrite(dir, args);
  if (!loaded.ok) return loaded;
  const built = build(loaded);
  if (!built.ok) return built;
  const month = calendarMonth(loaded.now, loaded.cap.timeZone);
  const compacted = month ? compactClosedMonths(loaded.ledger.entries, month, loaded.cap.timeZone) : null;
  const prior = compacted ?? loaded.ledger.entries;
  const entry = compacted
    ? makeEntry({ ledgerHead: prior.at(-1)?.hash ?? null, ledgerCount: prior.length }, fieldsOf(built.entry))
    : built.entry;
  const entries = prior.concat(entry);
  // Refuse before saving. A write that succeeds must leave a ledger the next
  // read can check, never one that is over the ceiling and therefore "edited".
  if (!withinLimit(entries)) return { ok: false, reason: REASONS.ledgerFull };
  const saved = persist(dir, args.store, loaded.state, entries, entry);
  if (!saved.ok) {
    return saved.consistent
      ? { ok: false, reason: REASONS.notSaved }
      : { ok: false, reason: REASONS.ledgerEdited, fullySpent: true };
  }
  return built.result;
}

function loadForWrite(dir, args) {
  const state = args.store.read();
  if (state.broken) return { ok: false, reason: REASONS.protectedBroken, fullySpent: true };
  const cap = verifyCap(args.record, args.signature, args.publicKey, state);
  if (!cap.ok) return { ok: false, reason: cap.reason };
  const now = instantText(args.now);
  if (!now) return { ok: false, reason: REASONS.badNow };
  const ledger = judgeLedger(dir, state, cap.currency);
  if (!ledger.ok) return { ok: false, reason: ledger.reason, fullySpent: true };
  return { ok: true, state, cap, now, ledger };
}

function reserveEntry(loaded, args) {
  const { cap, ledger, now } = loaded;
  if (cap.paused) return { ok: false, reason: REASONS.paused };
  if (!idOk(args.capabilityId) || !idOk(args.routeId) || !jobOk(args.jobId)) return { ok: false, reason: REASONS.badAmount };
  if (ledger.jobs.has(args.jobId)) return { ok: false, reason: REASONS.jobDuplicate };
  const max = parseMoney(args.max);
  if (!max.ok || max.micros <= 0n) return { ok: false, reason: REASONS.badAmount };
  if (max.currency !== cap.currency) return { ok: false, reason: REASONS.currencyOff };
  let provider = null;
  if (args.providerTotal !== undefined && args.providerTotal !== null) {
    const parsed = parseMoney(args.providerTotal);
    if (!parsed.ok) return { ok: false, reason: REASONS.badAmount };
    if (parsed.currency !== cap.currency) return { ok: false, reason: REASONS.currencyOff };
    provider = parsed.micros;
  }
  const month = calendarMonth(now, cap.timeZone);
  if (!month) return { ok: false, reason: REASONS.badNow };
  if (max.micros > parseDecimal(cap.perRun.amount)) return { ok: false, reason: REASONS.perRun };
  const capabilitySpent = counted(ledger.jobs, ledger.checkpoints, month, cap.timeZone, {
    capabilityFilter: args.capabilityId,
    routeCapability: args.capabilityId,
    routeId: args.routeId,
    provider,
  });
  const allSpent = counted(ledger.jobs, ledger.checkpoints, month, cap.timeZone, {
    capabilityFilter: null,
    routeCapability: args.capabilityId,
    routeId: args.routeId,
    provider,
  });
  if (capabilitySpent + max.micros > parseDecimal(cap.monthlyByCapability.amount)) {
    return { ok: false, reason: REASONS.monthCapability };
  }
  if (allSpent + max.micros > parseDecimal(cap.monthlyAll.amount)) return { ok: false, reason: REASONS.monthAll };
  const amount = moneyFromMicros(cap.currency, max.micros);
  const entry = makeEntry(loaded.state, {
    kind: 'reserve',
    capabilityId: args.capabilityId,
    routeId: args.routeId,
    amount,
    estimated: false,
    jobId: args.jobId,
    at: now,
  });
  return { ok: true, entry, result: { ok: true, jobId: args.jobId, amount, seq: entry.seq } };
}

function settleEntry(loaded, args) {
  const open = openJob(loaded, args.jobId);
  if (!open.ok) return open;
  const quote = settleAmount(loaded, args);
  if (!quote.ok) return quote;
  const over = !quote.estimated && quote.micros > open.job.reserve.micros;
  const amount = moneyFromMicros(loaded.cap.currency, quote.estimated ? open.job.reserve.micros : quote.micros);
  const entry = makeEntry(loaded.state, {
    kind: over ? 'over-bill' : 'settle',
    capabilityId: open.job.reserve.capabilityId,
    routeId: open.job.reserve.routeId,
    amount,
    estimated: quote.estimated,
    jobId: args.jobId,
    at: loaded.now,
  });
  return {
    ok: true,
    entry,
    result: {
      ok: true,
      routeOff: over,
      estimated: quote.estimated,
      amount,
      reason: over ? REASONS.overBill : null,
      ...(quote.bill ? { bill: quote.bill, capAmount: amount } : {}),
    },
  };
}

function settleAmount(loaded, args) {
  if (args.estimated === true) return { ok: true, estimated: true };
  if (args.actual == null) return { ok: false, reason: REASONS.needFigure };
  const actual = parseMoney(args.actual);
  // A started run may finish with no bill. Zero counts as nothing. A run
  // that never started is release, not a zero settle. The amount text still
  // has to be real money, so a negative figure is refused.
  if (!actual.ok || actual.micros < 0n) return { ok: false, reason: REASONS.badAmount };
  if (actual.currency === loaded.cap.currency) return { ok: true, estimated: false, micros: actual.micros };
  const converted = convertQuote({
    quote: args.actual,
    record: args.record,
    signature: args.signature,
    publicKey: args.publicKey,
    protectedState: loaded.state,
    now: loaded.now,
  });
  if (!converted.ok) return { ok: false, reason: converted.reason, routeOff: true };
  return { ok: true, estimated: false, micros: parseDecimal(converted.capAmount.amount), bill: converted.quote };
}

function releaseEntry(loaded, args) {
  const open = openJob(loaded, args.jobId);
  if (!open.ok) return open;
  const entry = makeEntry(loaded.state, {
    kind: 'release',
    capabilityId: open.job.reserve.capabilityId,
    routeId: open.job.reserve.routeId,
    amount: open.job.reserve.amount,
    estimated: false,
    jobId: args.jobId,
    at: loaded.now,
  });
  return { ok: true, entry, result: { ok: true, jobId: args.jobId, amount: entry.amount } };
}

function openJob(loaded, jobId) {
  if (!jobOk(jobId)) return { ok: false, reason: REASONS.jobUnknown };
  const job = loaded.ledger.jobs.get(jobId);
  if (!job || job.terminal) return { ok: false, reason: REASONS.jobUnknown };
  return { ok: true, job };
}

function resetEntries(dir, args) {
  const state = args.store.read();
  if (state.broken) return { ok: false, reason: REASONS.protectedBroken };
  const signed = signedCap(args.record, args.signature, args.publicKey);
  if (!signed.ok) return { ok: false, reason: signed.reason };
  // The cap already in the protected state is not a fresh signature. Reusing
  // it would empty the month without the same approval a raise needs.
  if (signed.revision <= state.capRevision) {
    return {
      ok: false,
      reason: signed.revision < state.capRevision ? REASONS.capOlder : REASONS.resetNeedsFresh,
    };
  }
  const next = {
    capRevision: signed.revision,
    capHash: signed.hash,
    tightening: 'none',
    ledgerHead: null,
    ledgerCount: 0,
  };
  // Confirm the new head before erasing the file. A lost compare-and-swap
  // leaves the history where it was.
  if (!args.store.write(next, state.core)) return { ok: false, reason: REASONS.notSaved };
  try {
    if (!writeEntries(dir, [])) return { ok: false, reason: REASONS.ledgerEdited, fullySpent: true };
  } catch {
    return { ok: false, reason: REASONS.ledgerEdited, fullySpent: true };
  }
  return { ok: true };
}

function readMonth(dir, args) {
  const state = args.store.read();
  if (state.broken) return { ok: false, reason: REASONS.protectedBroken, fullySpent: true };
  const cap = verifyCap(args.record, args.signature, args.publicKey, state);
  if (!cap.ok) return { ok: false, reason: cap.reason, fullySpent: false };
  const now = instantText(args.now);
  if (!now) return { ok: false, reason: REASONS.badNow };
  const ledger = judgeLedger(dir, state, cap.currency);
  if (!ledger.ok) return { ok: false, reason: ledger.reason, fullySpent: true };
  const month = calendarMonth(now, cap.timeZone);
  if (!month) return { ok: false, reason: REASONS.badNow };
  let provider = null;
  if (args.providerTotal !== undefined && args.providerTotal !== null) {
    const parsed = parseMoney(args.providerTotal);
    if (!parsed.ok) return { ok: false, reason: REASONS.badAmount };
    if (parsed.currency !== cap.currency) return { ok: false, reason: REASONS.currencyOff };
    // The figure belongs to one route's key. Without that route, comparing
    // it with every route's settled total would hide the other routes.
    if (!idOk(args.capabilityId) || !idOk(args.routeId)) return { ok: false, reason: REASONS.providerRoute };
    provider = parsed.micros;
  }
  const figures = figuresFor(ledger.jobs, ledger.checkpoints, month, cap.timeZone, cap.currency, args.capabilityId ?? null);
  const parts = spendParts(ledger.jobs, ledger.checkpoints, month, cap.timeZone, {
    capabilityFilter: args.capabilityId ?? null,
    routeCapability: args.capabilityId ?? null,
    routeId: args.routeId ?? null,
  });
  const routeSettled = provider === null ? figures.spentMicros : max(parts.settledThis, provider);
  const countedMicros = provider === null
    ? figures.reservedMicros + figures.spentMicros
    : parts.reserved + parts.settledOther + routeSettled;
  return {
    ok: true,
    currency: cap.currency,
    reserved: figures.reserved,
    spent: figures.spent,
    counted: moneyFromMicros(cap.currency, countedMicros),
    providerUsed: provider !== null && provider > parts.settledThis,
  };
}

function persist(dir, store, state, entries, entry) {
  // The head is written first. If that compare-and-swap loses, the file is
  // left as it was and the run was not started. If the head is written and
  // the file is not, the two disagree and the next read stops paid runs.
  const next = { ...state.core, ledgerHead: entry.hash, ledgerCount: entry.seq };
  if (!store.write(next, state.core)) return { ok: false, consistent: true };
  try {
    if (!writeEntries(dir, entries)) return { ok: false, consistent: false };
  } catch {
    return { ok: false, consistent: false };
  }
  return { ok: true };
}

function makeEntry(state, fields) {
  const entry = {
    seq: state.ledgerCount + 1,
    kind: fields.kind,
    capabilityId: fields.capabilityId,
    routeId: fields.routeId,
    amount: fields.amount,
    estimated: fields.estimated,
    jobId: fields.jobId,
    at: fields.at,
    prevHash: state.ledgerHead,
  };
  entry.hash = entryHash(entry);
  entry.micros = parseDecimal(fields.amount.amount);
  return entry;
}

function fieldsOf(entry) {
  return {
    kind: entry.kind,
    capabilityId: entry.capabilityId,
    routeId: entry.routeId,
    amount: entry.amount,
    estimated: entry.estimated,
    jobId: entry.jobId,
    at: entry.at,
  };
}

// Fold completed runs from months before `currentMonth` into one checkpoint
// per capability and route. Open runs stay, so they can still settle. The
// result is a new chain; null means nothing was folded.
function compactClosedMonths(entries, currentMonth, timeZone) {
  const jobs = buildJobs(entries);
  if (!jobs.ok) return null;
  let folded = false;
  const totals = new Map();
  const kept = [];
  for (const entry of entries) {
    if (entry.kind !== 'checkpoint') continue;
    const month = calendarMonth(entry.at, timeZone);
    if (!month || month >= currentMonth) {
      kept.push(entry);
      continue;
    }
    addTotal(totals, month, entry);
  }
  for (const job of jobs.jobs.values()) {
    const month = calendarMonth(job.reserve.at, timeZone);
    if (!month || month >= currentMonth || !job.terminal) {
      kept.push(job.reserve);
      if (job.terminal) kept.push(job.terminal);
      continue;
    }
    folded = true;
    if (job.terminal.kind !== 'release' && job.terminal.micros > 0n) addTotal(totals, month, job.terminal, job.reserve.at);
  }
  if (!folded) return null;
  const checkpoints = [...totals.values()]
    .sort((left, right) => left.month.localeCompare(right.month)
      || left.capabilityId.localeCompare(right.capabilityId)
      || left.routeId.localeCompare(right.routeId))
    .map((row) => ({
      kind: 'checkpoint',
      capabilityId: row.capabilityId,
      routeId: row.routeId,
      amount: moneyFromMicros(row.currency, row.micros),
      estimated: false,
      jobId: CHECKPOINT_JOB,
      at: row.at,
      micros: row.micros,
    }));
  kept.sort((left, right) => left.seq - right.seq);
  return rechain([...checkpoints, ...kept]);
}

function addTotal(totals, month, entry, at = entry.at) {
  const key = `${month}\n${entry.capabilityId}\n${entry.routeId}`;
  const current = totals.get(key);
  if (current) current.micros += entry.micros;
  else {
    totals.set(key, {
      month,
      capabilityId: entry.capabilityId,
      routeId: entry.routeId,
      currency: entry.amount.currency,
      micros: entry.micros,
      at,
    });
  }
}

function rechain(entries) {
  let previous = null;
  return entries.map((entry, index) => {
    const next = {
      seq: index + 1,
      kind: entry.kind,
      capabilityId: entry.capabilityId,
      routeId: entry.routeId,
      amount: { amount: entry.amount.amount, currency: entry.amount.currency },
      estimated: entry.estimated,
      jobId: entry.jobId,
      at: entry.at,
      prevHash: previous,
      micros: entry.micros,
    };
    next.hash = entryHash(next);
    previous = next.hash;
    return next;
  });
}

function withinLimit(entries) {
  if (entries.length > maxLedgerEntries) return false;
  let bytes = 0;
  for (const entry of entries) {
    const line = canonicalJson(publicEntry(entry));
    if (line.length > MAX_LINE) return false;
    bytes += Buffer.byteLength(line) + 1;
  }
  return bytes <= maxLedgerBytes;
}

function writeEntries(dir, entries) {
  const body = entries.length === 0 ? '' : `${entries.map((entry) => canonicalJson(publicEntry(entry))).join('\n')}\n`;
  return atomicWrite(resolve(dir, LEDGER_FILE), body);
}

function publicEntry(entry) {
  return {
    seq: entry.seq,
    kind: entry.kind,
    capabilityId: entry.capabilityId,
    routeId: entry.routeId,
    amount: { amount: entry.amount.amount, currency: entry.amount.currency },
    estimated: entry.estimated,
    jobId: entry.jobId,
    at: entry.at,
    prevHash: entry.prevHash,
    hash: entry.hash,
  };
}

function entryHash(entry) {
  return sha256Hex(Buffer.from(canonicalJson({
    seq: entry.seq,
    kind: entry.kind,
    capabilityId: entry.capabilityId,
    routeId: entry.routeId,
    amount: { amount: entry.amount.amount, currency: entry.amount.currency },
    estimated: entry.estimated,
    jobId: entry.jobId,
    at: entry.at,
    prevHash: entry.prevHash,
  }), 'utf8'));
}

function judgeLedger(dir, state, currency) {
  const file = readEntries(dir);
  if (!file.ok) return { ok: false, reason: REASONS.ledgerEdited };
  if (file.absent) {
    if (state.ledgerCount === 0 && state.ledgerHead === null) {
      return { ok: true, entries: [], jobs: new Map(), checkpoints: [] };
    }
    return { ok: false, reason: REASONS.ledgerMissing };
  }
  const sameLength = file.entries.length === state.ledgerCount;
  const sameHead = state.ledgerCount === 0
    ? file.entries.length === 0
    : file.head != null && sameText(file.head, state.ledgerHead);
  if (sameLength && sameHead) {
    if (currency && file.entries.some((entry) => entry.amount.currency !== currency)) {
      return { ok: false, reason: REASONS.ledgerEdited };
    }
    const jobs = buildJobs(file.entries);
    if (!jobs.ok) return { ok: false, reason: REASONS.ledgerEdited };
    return {
      ok: true,
      entries: file.entries,
      jobs: jobs.jobs,
      checkpoints: file.entries.filter((entry) => entry.kind === 'checkpoint'),
    };
  }
  if (file.entries.length < state.ledgerCount) return { ok: false, reason: REASONS.ledgerOlder };
  return { ok: false, reason: REASONS.ledgerEdited };
}

function readEntries(dir) {
  const path = resolve(dir, LEDGER_FILE);
  const kind = fileKind(path);
  if (kind === 'absent') return { ok: true, absent: true, entries: [] };
  if (kind !== 'file') return { ok: false };
  let text;
  try {
    text = readNoFollow(path, maxLedgerBytes);
  } catch {
    return { ok: false };
  }
  if (text === '') return { ok: true, absent: false, entries: [], head: null };
  if (!text.endsWith('\n')) return { ok: false };
  const lines = text.slice(0, -1).split('\n');
  if (lines.length > maxLedgerEntries) return { ok: false };
  const entries = [];
  let previous = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].length > MAX_LINE) return { ok: false };
    let parsed;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      return { ok: false };
    }
    const entry = parseStoredEntry(parsed);
    if (!entry || entry.seq !== index + 1 || entry.prevHash !== previous) return { ok: false };
    previous = entry.hash;
    entries.push(entry);
  }
  return { ok: true, absent: false, entries, head: previous };
}

function parseStoredEntry(value) {
  if (!isPlainObject(value)) return null;
  const keys = ['seq', 'kind', 'capabilityId', 'routeId', 'amount', 'estimated', 'jobId', 'at', 'prevHash', 'hash'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !own(value, key))) return null;
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) return null;
  if (!KINDS.has(value.kind)) return null;
  if (!idOk(value.capabilityId) || !idOk(value.routeId) || !jobOk(value.jobId)) return null;
  const money = parseMoney(value.amount);
  if (!money.ok) return null;
  if (typeof value.estimated !== 'boolean') return null;
  if ((value.kind === 'reserve' || value.kind === 'release' || value.kind === 'over-bill' || value.kind === 'checkpoint') && value.estimated) return null;
  if (!instantText(value.at)) return null;
  if (!(value.prevHash === null || (typeof value.prevHash === 'string' && HEX.test(value.prevHash)))) return null;
  if (typeof value.hash !== 'string' || !HEX.test(value.hash)) return null;
  const entry = {
    seq: value.seq,
    kind: value.kind,
    capabilityId: value.capabilityId,
    routeId: value.routeId,
    amount: { amount: value.amount.amount, currency: value.amount.currency },
    estimated: value.estimated,
    jobId: value.jobId,
    at: value.at,
    prevHash: value.prevHash,
    hash: value.hash,
    micros: money.micros,
  };
  if (!sameText(entryHash(entry), entry.hash)) return null;
  return entry;
}

function buildJobs(entries) {
  const jobs = new Map();
  for (const entry of entries) {
    if (entry.kind === 'checkpoint') continue;
    if (entry.kind === 'reserve') {
      if (jobs.has(entry.jobId)) return { ok: false };
      jobs.set(entry.jobId, { reserve: entry, terminal: null });
      continue;
    }
    const job = jobs.get(entry.jobId);
    if (!job || job.terminal) return { ok: false };
    if (job.reserve.capabilityId !== entry.capabilityId || job.reserve.routeId !== entry.routeId) return { ok: false };
    if (job.reserve.amount.currency !== entry.amount.currency) return { ok: false };
    job.terminal = entry;
  }
  return { ok: true, jobs };
}

function counted(jobs, checkpoints, month, timeZone, options) {
  const parts = spendParts(jobs, checkpoints, month, timeZone, options);
  const settled = options.provider === null ? parts.settledThis : max(parts.settledThis, options.provider);
  return parts.reserved + parts.settledOther + settled;
}

function spendParts(jobs, checkpoints, month, timeZone, { capabilityFilter, routeCapability, routeId }) {
  let reserved = 0n;
  let settledThis = 0n;
  let settledOther = 0n;
  for (const job of jobs.values()) {
    if (capabilityFilter && job.reserve.capabilityId !== capabilityFilter) continue;
    if (calendarMonth(job.reserve.at, timeZone) !== month) continue;
    const sameRoute = job.reserve.capabilityId === routeCapability && job.reserve.routeId === routeId;
    if (!job.terminal) reserved += job.reserve.micros;
    else if (job.terminal.kind === 'release') continue;
    else if (sameRoute) settledThis += job.terminal.micros;
    else settledOther += job.terminal.micros;
  }
  for (const checkpoint of checkpoints) addCheckpoint(checkpoint, month, timeZone, capabilityFilter, routeCapability, routeId, (same, micros) => {
    if (same) settledThis += micros;
    else settledOther += micros;
  });
  return { reserved, settledThis, settledOther };
}

function figuresFor(jobs, checkpoints, month, timeZone, currency, capabilityId = null) {
  let reservedMicros = 0n;
  let spentMicros = 0n;
  for (const job of jobs.values()) {
    if (capabilityId && job.reserve.capabilityId !== capabilityId) continue;
    if (calendarMonth(job.reserve.at, timeZone) !== month) continue;
    if (!job.terminal) reservedMicros += job.reserve.micros;
    else if (job.terminal.kind !== 'release') spentMicros += job.terminal.micros;
  }
  for (const checkpoint of checkpoints) {
    if (capabilityId && checkpoint.capabilityId !== capabilityId) continue;
    if (calendarMonth(checkpoint.at, timeZone) !== month) continue;
    spentMicros += checkpoint.micros;
  }
  return {
    reservedMicros,
    spentMicros,
    reserved: moneyFromMicros(currency, reservedMicros),
    spent: moneyFromMicros(currency, spentMicros),
  };
}

function addCheckpoint(checkpoint, month, timeZone, capabilityFilter, routeCapability, routeId, add) {
  if (capabilityFilter && checkpoint.capabilityId !== capabilityFilter) return;
  if (calendarMonth(checkpoint.at, timeZone) !== month) return;
  const same = checkpoint.capabilityId === routeCapability && checkpoint.routeId === routeId;
  add(same, checkpoint.micros);
}

function max(left, right) {
  return left > right ? left : right;
}

function idOk(value) {
  return typeof value === 'string' && value.length <= 64 && ID.test(value);
}

function jobOk(value) {
  return typeof value === 'string' && JOB.test(value);
}
