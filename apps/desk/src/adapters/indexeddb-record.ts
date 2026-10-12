export const INDEXEDDB_RECORD_STORE = 'records';
export const INDEXEDDB_RECORD_KEY = 'current';
export const INDEXEDDB_OPEN_TIMEOUT_MS = 4_000;

export class IndexedDBRecordFormatError extends Error {}

/** One serialized browser record, with atomic read/validate/update semantics. */
export class IndexedDBRecord {
  private opening?: Promise<IDBDatabase>;
  private readonly factory?: IDBFactory;

  constructor(private readonly databaseName: string, factory?: IDBFactory) {
    if (factory) this.factory = factory;
    else {
      try { this.factory = typeof window === 'undefined' ? undefined : window.indexedDB; }
      catch { /* Opening will fail closed if browser storage access is denied. */ }
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.opening) return this.opening;
    this.opening = new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error('Browser database unavailable')); return; }
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(error);
      };
      const deadline = setTimeout(() => fail(new Error('Browser database did not open in time')), INDEXEDDB_OPEN_TIMEOUT_MS);
      let request: IDBOpenDBRequest;
      try { request = this.factory.open(this.databaseName, 1); }
      catch (error) { fail(error); return; }
      request.onupgradeneeded = () => {
        if (settled) { request.transaction?.abort(); return; }
        if (!request.result.objectStoreNames.contains(INDEXEDDB_RECORD_STORE)) request.result.createObjectStore(INDEXEDDB_RECORD_STORE);
      };
      request.onblocked = () => fail(new Error('Browser database upgrade blocked'));
      request.onerror = () => fail(request.error ?? new Error('Browser database could not open'));
      request.onsuccess = () => {
        const database = request.result;
        if (settled) { database.close(); return; }
        settled = true;
        clearTimeout(deadline);
        database.onversionchange = () => { database.close(); this.opening = undefined; };
        resolve(database);
      };
    });
    return this.opening;
  }

  private raw(value: unknown): string | null {
    if (value === undefined) return null;
    if (typeof value !== 'string') throw new IndexedDBRecordFormatError('Saved browser record has an unsupported representation');
    return value;
  }

  async read(): Promise<string | null> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(INDEXEDDB_RECORD_STORE, 'readonly');
      let raw: string | null;
      let readError: unknown;
      transaction.objectStore(INDEXEDDB_RECORD_STORE).get(INDEXEDDB_RECORD_KEY).onsuccess = (event) => {
        try { raw = this.raw((event.target as IDBRequest<unknown>).result); }
        catch (error) { readError = error; transaction.abort(); }
      };
      transaction.oncomplete = () => resolve(raw);
      transaction.onabort = () => reject(readError ?? transaction.error ?? new Error('Browser record read aborted'));
    });
  }

  /** The updater runs synchronously inside one serialized readwrite transaction. */
  async update<T>(operation: (currentRaw: string | null) => { result: T; raw?: string }): Promise<T> {
    const database = await this.open();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(INDEXEDDB_RECORD_STORE, 'readwrite');
      let result: T;
      let operationError: unknown;
      let wrote = false;
      transaction.objectStore(INDEXEDDB_RECORD_STORE).get(INDEXEDDB_RECORD_KEY).onsuccess = (event) => {
        try {
          const change = operation(this.raw((event.target as IDBRequest<unknown>).result));
          result = change.result;
          if (Object.hasOwn(change, 'raw')) {
            if (typeof change.raw !== 'string') throw new IndexedDBRecordFormatError('Browser record update is not serialized text');
            transaction.objectStore(INDEXEDDB_RECORD_STORE).put(change.raw, INDEXEDDB_RECORD_KEY);
            wrote = true;
          }
        } catch (error) {
          operationError = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => {
        if (wrote) this.notify();
        resolve(result);
      };
      transaction.onabort = () => reject(operationError ?? transaction.error ?? new Error('Browser record save aborted'));
    });
  }

  private notify() {
    try {
      const channel = new BroadcastChannel(`${this.databaseName}:commits`);
      channel.postMessage('record-committed');
      channel.close();
    } catch { /* The committed record remains authoritative without notifications. */ }
  }

  subscribe(changed: () => void): () => void {
    let channel: BroadcastChannel | undefined;
    try {
      channel = new BroadcastChannel(`${this.databaseName}:commits`);
      channel.onmessage = (event) => { if (event.data === 'record-committed') changed(); };
    } catch { /* Callers can still refresh through focus/visibility reads. */ }
    return () => channel?.close();
  }
}
