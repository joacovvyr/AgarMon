import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const initialState = () => ({ accounts: {}, journal: [], receipts: {}, users: {}, matches: {}, withdrawals: {} });

/** Single-host persistence for the financial reference model. Writers serialize.
 * The aggregate snapshot is intentionally simple; this is not a scalable payment service.
 */
export class SQLiteStore {
  #db;
  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path, { timeout: 10000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS state (
        id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS movements (
        sequence INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        destination TEXT NOT NULL CHECK (destination <> source),
        cents INTEGER NOT NULL CHECK (cents > 0),
        reason TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        cents INTEGER NOT NULL CHECK (cents >= 0 OR id = 'provider:clearing')
      ) STRICT;
      CREATE TRIGGER IF NOT EXISTS movements_no_update BEFORE UPDATE ON movements
        BEGIN SELECT RAISE(ABORT, 'immutable_journal'); END;
      CREATE TRIGGER IF NOT EXISTS movements_no_delete BEFORE DELETE ON movements
        BEGIN SELECT RAISE(ABORT, 'immutable_journal'); END;
    `);
    this.#db.prepare('INSERT OR IGNORE INTO state (id, value) VALUES (1, ?)').run(JSON.stringify(initialState()));
  }
  read() { return JSON.parse(this.#db.prepare('SELECT value FROM state WHERE id = 1').get().value); }
  transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const state = this.read();
      const previousCount = state.journal.length;
      const previousJournal = JSON.stringify(state.journal);
      const result = fn(state);
      if (state.journal.length < previousCount || JSON.stringify(state.journal.slice(0, previousCount)) !== previousJournal)
        throw Error('immutable_journal');
      const insert = this.#db.prepare('INSERT INTO movements VALUES (?, ?, ?, ?, ?)');
      for (const row of state.journal.slice(previousCount))
        insert.run(row.sequence, row.from, row.to, row.amount, row.reason);
      const upsert = this.#db.prepare('INSERT INTO accounts VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET cents = excluded.cents');
      for (const [id, amount] of Object.entries(state.accounts)) upsert.run(id, amount);
      this.#db.prepare('UPDATE state SET value = ? WHERE id = 1').run(JSON.stringify(state));
      this.#verifyMirrors(state);
      this.#db.exec('COMMIT');
      return structuredClone(result);
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
  #verifyMirrors(state) {
    const rows = this.#db.prepare('SELECT sequence, source AS "from", destination AS "to", cents AS amount, reason FROM movements ORDER BY sequence').all();
    if (JSON.stringify(rows) !== JSON.stringify(state.journal)) throw Error('persistent_journal_mismatch');
    const accounts = this.#db.prepare('SELECT id, cents FROM accounts').all();
    if (accounts.length !== Object.keys(state.accounts).length) throw Error('persistent_accounts_mismatch');
    for (const row of accounts) if (state.accounts[row.id] !== row.cents) throw Error('persistent_accounts_mismatch');
  }
  verify() {
    this.#db.exec('BEGIN');
    try {
      this.#verifyMirrors(this.read());
      this.#db.exec('COMMIT');
      return { persistentMirrorsValid: true };
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
  }
  close() { this.#db.close(); }
}
