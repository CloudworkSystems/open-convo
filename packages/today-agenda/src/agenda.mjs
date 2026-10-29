#!/usr/bin/env node
// node packages/today-agenda/src/agenda.mjs --day <day.json> [--json]
import { pathToFileURL } from 'node:url';

import { main } from './command.mjs';

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
}

export { main };
