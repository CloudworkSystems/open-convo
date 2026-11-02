// The protected state: cap revision and hash, the tightening, and the ledger
// head. Callers keep it in a store with read() and write(next, expected).
// write fails when the stored value is no longer `expected`.

import { canonicalJson, isPlainObject, own } from './json.mjs';
import { withSyncLock } from './lock.mjs';
import { parseMoney } from './money.mjs';
import { atomicWrite, fileKind, readNoFollow } from './files.mjs';

const HEX = /^[0-9a-f]{64}$/;
const STATE_BYTES = 64 * 1024;
const LEVELS = ['perRun', 'monthlyByCapability', 'monthlyAll'];

export const EMPTY_CORE = {
  capRevision: 0,
  capHash: null,
  tightening: 'none',
  ledgerHead: null,
  ledgerCount: 0,
};

export function memoryStore(initial = EMPTY_CORE) {
  let core = structuredClone(initial);
  return {
    read() {
      return interpret(structuredClone(core));
    },
    write(next, expected) {
      if (canonicalJson(core) !== canonicalJson(expected)) return false;
      const written = normalizeWritten(next);
      if (!written) return false;
      core = written;
      return true;
    },
  };
}

export function fileStore(path) {
  return {
    read() {
      if (fileKind(path) === 'absent') return interpret(structuredClone(EMPTY_CORE));
      if (fileKind(path) !== 'file') return brokenState();
      let text;
      try {
        text = readNoFollow(path, STATE_BYTES);
      } catch {
        return brokenState();
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return brokenState();
      }
      const loaded = normalizeRead(parsed);
      if (!loaded) return brokenState();
      return interpret(loaded.core, loaded.tighteningBroken);
    },
    write(next, expected) {
      const locked = withSyncLock(`${path}.lock`, () => {
        const current = this.read();
        if (current.broken) return false;
        if (canonicalJson(current.core) !== canonicalJson(expected)) return false;
        const written = normalizeWritten(next);
        if (!written) return false;
        return atomicWrite(path, `${canonicalJson(written)}\n`);
      });
      return locked.ok ? locked.value : false;
    },
  };
}

export function describeState(value) {
  if (!value || typeof value !== 'object') return brokenState();
  if (own(value, 'core')) return value.broken ? brokenState() : value;
  const loaded = normalizeRead(value);
  if (!loaded) return brokenState();
  return interpret(loaded.core, loaded.tighteningBroken);
}

function brokenState() {
  return {
    broken: true,
    tighteningBroken: true,
    core: null,
    capRevision: null,
    capHash: null,
    tightening: null,
    ledgerHead: null,
    ledgerCount: null,
  };
}

function interpret(core, tighteningBroken = false) {
  const shape = tighteningShape(core.tightening);
  return {
    broken: false,
    tighteningBroken: tighteningBroken || shape === 'broken',
    core,
    capRevision: core.capRevision,
    capHash: core.capHash,
    tightening: shape === 'ok' ? core.tightening : shape === 'none' ? 'none' : null,
    ledgerHead: core.ledgerHead,
    ledgerCount: core.ledgerCount,
  };
}

/** @returns {{ core: object, tighteningBroken: boolean } | null} */
function normalizeRead(parsed) {
  if (!isPlainObject(parsed)) return null;
  const allowed = new Set(['capRevision', 'capHash', 'tightening', 'ledgerHead', 'ledgerCount']);
  for (const key of Object.keys(parsed)) {
    if (!allowed.has(key)) return null;
  }
  if (!own(parsed, 'capRevision') || !own(parsed, 'capHash') || !own(parsed, 'ledgerHead') || !own(parsed, 'ledgerCount')) {
    return null;
  }
  if (!Number.isSafeInteger(parsed.capRevision) || parsed.capRevision < 0) return null;
  if (!(parsed.capHash === null || (typeof parsed.capHash === 'string' && HEX.test(parsed.capHash)))) return null;
  if (!Number.isSafeInteger(parsed.ledgerCount) || parsed.ledgerCount < 0) return null;
  if (!(parsed.ledgerHead === null || (typeof parsed.ledgerHead === 'string' && HEX.test(parsed.ledgerHead)))) return null;
  if ((parsed.ledgerCount === 0) !== (parsed.ledgerHead === null)) return null;
  if ((parsed.capRevision === 0) !== (parsed.capHash === null)) return null;
  const core = {
    capRevision: parsed.capRevision,
    capHash: parsed.capHash,
    ledgerHead: parsed.ledgerHead,
    ledgerCount: parsed.ledgerCount,
  };
  const hasTightening = own(parsed, 'tightening');
  if (hasTightening) core.tightening = parsed.tightening;
  return { core, tighteningBroken: !hasTightening || tighteningShape(parsed.tightening) === 'broken' };
}

function normalizeWritten(value) {
  const loaded = normalizeRead(value);
  if (!loaded || loaded.tighteningBroken) return null;
  if (tighteningShape(loaded.core.tightening) === 'broken') return null;
  return loaded.core;
}

function tighteningShape(value) {
  if (value === 'none') return 'none';
  if (!isPlainObject(value)) return 'broken';
  const keys = Object.keys(value);
  if (keys.length !== 4) return 'broken';
  for (const level of LEVELS) {
    if (!own(value, level) || !parseMoney(value[level]).ok) return 'broken';
  }
  if (!own(value, 'paused') || typeof value.paused !== 'boolean') return 'broken';
  return 'ok';
}
