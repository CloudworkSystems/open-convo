// Holds the ledger lock until this worker is stopped. The parent checks
// that a running worker is not interrupted, and that stopping the worker
// releases the lock. Loaded on its own, with no lock path, it does nothing.
// The interval keeps the thread alive: a pending promise alone does not.

import { parentPort, workerData } from 'node:worker_threads';
import { withFileLock } from '../src/cap/lock.mjs';

if (workerData) {
  await withFileLock(workerData, async () => {
    parentPort.postMessage('held');
    await new Promise((resolve) => {
      const timer = setInterval(() => {}, 1000);
      parentPort.on('close', () => {
        clearInterval(timer);
        resolve();
      });
    });
  });
}
