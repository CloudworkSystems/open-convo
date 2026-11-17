#!/usr/bin/env node
// The push gate's command. The Mac-only part (reading the app's key through
// the 1Password service account) lives in scripts/push-gate/ and is loaded
// only by the commands that need the key.

import { main } from '../src/cli.mjs';

const loadSeam = async () => {
  const { createMacSeam } = await import(new URL('../../../scripts/push-gate/mac-seam.mjs', import.meta.url));
  return createMacSeam(process.env);
};

process.exitCode = await main(process.argv.slice(2), { loadSeam });
