import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const digest = token => createHash('sha256').update(token).digest('hex');
const publicUser = row => ({ id: row.id, email: row.email, name: row.name });

export class AuthStore {
  #db;
  constructor(path) {
    this.#db = new DatabaseSync(path, { timeout: 10000 });
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        password_hash TEXT NOT NULL, salt TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
        csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA foreign_keys = ON;
    `);
  }
  async register(email, password, name) {
    const salt = randomBytes(16).toString('hex'), hash = (await derive(password, salt, 64)).toString('hex');
    const user = { id: randomBytes(16).toString('hex'), email, name };
    try { this.#db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(user.id, email, name, hash, salt); }
    catch (error) { if (error.message.includes('UNIQUE')) throw Error('email_exists'); throw error; }
    return user;
  }
  async login(email, password) {
    const row = this.#db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Unknown users still run scrypt to avoid the quick timing path.
    const result = await derive(password, row?.salt ?? 'unknown-user-dummy-salt', 64);
    if (!row || !timingSafeEqual(result, Buffer.from(row.password_hash, 'hex'))) throw Error('invalid_credentials');
    return publicUser(row);
  }
  issue(userId, previousToken) {
    const token = randomBytes(32).toString('hex'), csrf = randomBytes(24).toString('hex'), expires = Date.now() + 86400000;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (previousToken) this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(previousToken));
      this.#db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
      this.#db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(digest(token), userId, csrf, expires);
      this.#db.exec('COMMIT');
    } catch (error) { this.#db.exec('ROLLBACK'); throw error; }
    return { token, csrf };
  }
  session(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.#db.prepare(`SELECT u.id, u.email, u.name, s.csrf FROM sessions s
      JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(digest(token), Date.now());
    return row ? { user: publicUser(row), csrf: row.csrf } : null;
  }
  revoke(token) { if (token) this.#db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token)); }
  close() { this.#db.close(); }
}
