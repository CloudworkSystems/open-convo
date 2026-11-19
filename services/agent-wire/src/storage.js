// All durable data lives in one object's SQLite database. The portable
// interface is synchronous so a complete tool call fits one transaction.
export class SqlStore {
  constructor(storage) {
    this.storage = storage;
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, id))');
  }
  transaction(fn) { return this.storage.transactionSync(fn); }
  get(kind, id) {
    const rows = [...this.sql.exec('SELECT value FROM records WHERE kind = ? AND id = ?', kind, id)];
    return rows.length ? JSON.parse(rows[0].value) : undefined;
  }
  all(kind) {
    return [...this.sql.exec('SELECT value FROM records WHERE kind = ? ORDER BY id', kind)].map((r) => JSON.parse(r.value));
  }
  count(kind) { return [...this.sql.exec('SELECT COUNT(*) AS n FROM records WHERE kind = ?', kind)][0].n; }
  put(kind, id, value) {
    this.sql.exec('INSERT INTO records (kind, id, value) VALUES (?, ?, ?) ON CONFLICT(kind, id) DO UPDATE SET value = excluded.value', kind, id, JSON.stringify(value));
  }
  delete(kind, id) { this.sql.exec('DELETE FROM records WHERE kind = ? AND id = ?', kind, id); }
}

// Node 22 needs no experimental flags. Intentionally volatile: export before
// stopping Node. Copy-on-write values and map snapshots provide rollback.
export class MemoryStore {
  constructor() { this.rows = new Map(); }
  transaction(fn) {
    const before = new Map(this.rows);
    try { return fn(); } catch (error) { this.rows = before; throw error; }
  }
  get(kind, id) { return structuredClone(this.rows.get(kind + ':' + id)); }
  all(kind) {
    return [...this.rows].filter(([key]) => key.startsWith(kind + ':')).map(([, value]) => structuredClone(value));
  }
  count(kind) { return [...this.rows.keys()].filter((key) => key.startsWith(kind + ':')).length; }
  put(kind, id, value) { this.rows.set(kind + ':' + id, structuredClone(value)); }
  delete(kind, id) { this.rows.delete(kind + ':' + id); }
}
