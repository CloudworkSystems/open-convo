#!/usr/bin/env node
// node src/sort.mjs --messages <messages.json> [--settings <settings.json>] [--json]
import { main } from './cli.mjs';

process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr });
