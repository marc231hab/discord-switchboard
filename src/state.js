import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

// Both sides persist before acknowledging. SQLite also survives abrupt exits.
export class State {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (
        kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
        updated INTEGER NOT NULL, PRIMARY KEY(kind,id));`)
  }
  get(kind, id) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id)
    return row ? JSON.parse(row.value) : null
  }
  put(kind, id, value) {
    this.db.prepare(`INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,id)
      DO UPDATE SET value=excluded.value,updated=excluded.updated`).run(kind, id, JSON.stringify(value), Date.now())
    return value
  }
  insert(kind, id, value) {
    return this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?)')
      .run(kind, id, JSON.stringify(value), Date.now()).changes > 0
  }
  all(kind) {
    return this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY updated').all(kind).map(r => JSON.parse(r.value))
  }
  delete(kind, id) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, id) }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = work(); this.db.exec('COMMIT'); return result }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  close() { this.db.close() }
}
