#!/usr/bin/env node
// Command entry point; the work is in cli.mjs.
import { main } from './cli.mjs';

process.exitCode = await main(process.argv.slice(2));
