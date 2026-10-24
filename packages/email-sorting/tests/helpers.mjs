// Invented mail for the tests. Every person, business and address here is
// made up; addresses use the reserved .example domain.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE = fileURLToPath(new URL('../fixtures/mailbox.json', import.meta.url));
export const FIXTURE_SETTINGS = fileURLToPath(new URL('../fixtures/settings.json', import.meta.url));
export const EXPECTED_JSON = fileURLToPath(new URL('./expected/mailbox.json', import.meta.url));
export const EXPECTED_SUMMARY = fileURLToPath(new URL('./expected/mailbox.txt', import.meta.url));

export function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function mail(fields = {}) {
  return {
    id: 'm-1',
    inbox: 'home',
    from: { name: 'Tessa Vale', address: 'tessa@fernway.example' },
    to: [{ address: 'me@quillhome.example' }],
    subject: 'Hello',
    date: '2026-10-14T09:12:00-04:00',
    snippet: 'Just saying hi.',
    headers: {},
    ...fields,
  };
}

export function input(messages) {
  return { schemaVersion: 1, messages };
}

export function settings(fields = {}) {
  return { schemaVersion: 1, ...fields };
}

export function answer(category, confidence = 0.9, reason = `Model says ${category}`) {
  return { category, confidence, reason };
}

export function pileOf(result, category) {
  return result.piles.find(pile => pile.category === category);
}

export function allMessages(result) {
  return result.piles.flatMap(pile => pile.groups.flatMap(group => group.messages));
}

export function byId(result, id, inbox) {
  const found = allMessages(result).filter(m => m.id === id && (inbox === undefined || m.inboxes.includes(inbox)));
  if (found.length !== 1) throw new Error(`Expected one output message ${id}, found ${found.length}.`);
  return found[0];
}

// Runs the command's main() with captured output.
export async function runCommand(main, argv) {
  let stdout = '';
  let stderr = '';
  const code = await main(argv, {
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
  });
  return { code, stdout, stderr };
}

// Lets pending promise callbacks run (setImmediate is not mocked).
export async function flush(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise(resolve => setImmediate(resolve));
}
