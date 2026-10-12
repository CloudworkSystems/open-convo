export const WORKSPACE_DATABASE_NAME = 'true-convo:desk:synthetic:v1';
const recordStore = 'records';
const recordKey = 'current';

/** Read committed native bytes; an absent database/record returns null. */
export function readNativeRecordRaw(page, databaseName = WORKSPACE_DATABASE_NAME) {
  return page.evaluate(({ databaseName, recordStore, recordKey }) => new Promise((resolve, reject) => {
    let absent = false;
    const opening = indexedDB.open(databaseName, 1);
    opening.onupgradeneeded = () => {
      // A read must not manufacture an authority or mask a legacy-only fixture.
      absent = true;
      opening.transaction.abort();
    };
    opening.onerror = () => absent ? resolve(null) : reject(opening.error);
    opening.onblocked = () => reject(new Error('Fixture database read was blocked.'));
    opening.onsuccess = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(recordStore)) {
        database.close();
        reject(new Error('Native fixture database has no records store.'));
        return;
      }
      const transaction = database.transaction(recordStore, 'readonly');
      let raw = null;
      let formatError;
      transaction.objectStore(recordStore).get(recordKey).onsuccess = (event) => {
        const value = event.target.result;
        if (value !== undefined && typeof value !== 'string') {
          formatError = new Error('Native fixture record is not serialized text.');
          transaction.abort();
        } else raw = value ?? null;
      };
      transaction.oncomplete = () => { database.close(); resolve(raw); };
      transaction.onabort = () => { database.close(); reject(formatError ?? transaction.error ?? new Error('Fixture read aborted.')); };
    };
  }), { databaseName, recordStore, recordKey });
}

/** Legacy bytes are recovery input only when no native record exists. */
export async function readRecordRaw(page, databaseName = WORKSPACE_DATABASE_NAME, legacyKey = databaseName) {
  const raw = await readNativeRecordRaw(page, databaseName);
  return raw === null ? page.evaluate((key) => localStorage.getItem(key), legacyKey) : raw;
}

export async function readRecord(page, databaseName = WORKSPACE_DATABASE_NAME, legacyKey = databaseName) {
  return JSON.parse(await readRecordRaw(page, databaseName, legacyKey));
}

export async function readNativeRecord(page, databaseName = WORKSPACE_DATABASE_NAME) {
  return JSON.parse(await readNativeRecordRaw(page, databaseName));
}

/** Fixture writes use a real transaction and notify only after its commit. */
export function writeNativeRecordRaw(page, databaseName, raw, { notify = true } = {}) {
  return page.evaluate(({ databaseName, raw, notify, recordStore, recordKey }) => new Promise((resolve, reject) => {
    const opening = indexedDB.open(databaseName, 1);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(recordStore)) opening.result.createObjectStore(recordStore);
    };
    opening.onerror = () => reject(opening.error);
    opening.onblocked = () => reject(new Error('Fixture database write was blocked.'));
    opening.onsuccess = () => {
      const database = opening.result;
      const transaction = database.transaction(recordStore, 'readwrite');
      const store = transaction.objectStore(recordStore);
      if (raw === null) store.delete(recordKey);
      else store.put(raw, recordKey);
      transaction.oncomplete = () => {
        database.close();
        if (notify) {
          const channel = new BroadcastChannel(`${databaseName}:commits`);
          channel.postMessage('record-committed');
          channel.close();
        }
        resolve();
      };
      transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Fixture write aborted.')); };
    };
  }), { databaseName, raw, notify, recordStore, recordKey });
}

/** Install a scoped, switchable quota failure before the application loads. */
export function installNativeWriteFailure(context, databaseName = WORKSPACE_DATABASE_NAME, flagName = '__deskFailWrites') {
  return context.addInitScript(({ databaseName, recordStore, flagName }) => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === databaseName && this.name === recordStore && window[flagName]) {
        throw new DOMException('Invented full disk', 'QuotaExceededError');
      }
      return put.apply(this, args);
    };
  }, { databaseName, recordStore, flagName });
}
