import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLOCK = '2026-04-01T12:00:00.000Z';

export function capture() {
  const out = [];
  const err = [];
  return {
    stdout: { write(chunk) { out.push(String(chunk)); } },
    stderr: { write(chunk) { err.push(String(chunk)); } },
    text() { return out.join(''); },
    errors() { return err.join(''); },
  };
}

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'creator-proof-'));
  return {
    dir,
    remove() { rmSync(dir, { recursive: true, force: true }); },
  };
}

export function deadPid() {
  for (let pid = 1_000_000; pid < 4_000_000; pid += 997) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') return pid;
    }
  }
  throw new Error('Could not find an unused process id.');
}
