// Runs a handful of reservations in this thread. The parent starts two of
// these beside its own reservations, all against one ledger.

import { parentPort, workerData } from 'node:worker_threads';
import { reserve } from '../src/cap/ledger.mjs';
import { fileStore } from '../src/cap/state.mjs';

const { ledgerDir, statePath, record, signatureB64, publicKeyPem, jobIds, now, max } = workerData;
const store = fileStore(statePath);
const signature = Buffer.from(signatureB64, 'base64');

const results = await Promise.all(jobIds.map(async (jobId) => {
  const result = await reserve({
    ledgerDir,
    store,
    record,
    signature,
    publicKey: publicKeyPem,
    capabilityId: 'make-media',
    routeId: 'own-key',
    max,
    jobId,
    now,
  });
  return result.ok === true;
}));

parentPort.postMessage(results);
