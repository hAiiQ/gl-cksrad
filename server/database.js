import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import session from 'express-session';

export function openDatabase(directory) {
  if (directory !== ':memory:') mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'giveaway.sqlite'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'drawing', 'finished')),
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      duration_ms INTEGER,
      rotation REAL,
      winner_id TEXT,
      requires_twitch INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      discord_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      joined_at INTEGER NOT NULL,
      twitch_id TEXT,
      twitch_name TEXT,
      twitch_verified_at INTEGER,
      UNIQUE(round_id, discord_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  // Upgrade existing installations without changing completed/in-progress draws.
  const roundColumns = db.prepare('PRAGMA table_info(rounds)').all().map((column) => column.name);
  if (!roundColumns.includes('requires_twitch')) db.exec('ALTER TABLE rounds ADD COLUMN requires_twitch INTEGER NOT NULL DEFAULT 0');
  const entryColumns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
  for (const [name, type] of [['twitch_id', 'TEXT'], ['twitch_name', 'TEXT'], ['twitch_verified_at', 'INTEGER']]) {
    if (!entryColumns.includes(name)) db.exec(`ALTER TABLE entries ADD COLUMN ${name} ${type}`);
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS one_twitch_per_round ON entries(round_id, twitch_id) WHERE twitch_id IS NOT NULL;
    UPDATE rounds SET requires_twitch = 1 WHERE status = 'open';
  `);
  if (!db.prepare('SELECT id FROM rounds LIMIT 1').get()) {
    db.prepare('INSERT INTO rounds (created_at, requires_twitch) VALUES (?, 1)').run(Date.now());
  }
  return db;
}

// OAuth tokens stay on the server. Session payloads are encrypted at rest.
export class SQLiteSessionStore extends session.Store {
  constructor(db, secret) {
    super();
    this.db = db;
    this.key = createHash('sha256').update(secret).digest();
    this.cleanup = setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3_600_000);
    this.cleanup.unref();
  }
  seal(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  open(value) {
    const data = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
  }
  get(sid, callback) {
    try {
      const row = this.db.prepare('SELECT payload FROM sessions WHERE sid = ? AND expires_at > ?').get(sid, Date.now());
      let value = null;
      if (row) {
        try { value = this.open(row.payload); }
        catch { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); }
      }
      callback(null, value);
    } catch (error) { callback(error); }
  }
  set(sid, value, callback = () => {}) {
    try {
      const expires = value.cookie?.expires ? new Date(value.cookie.expires).getTime() : Date.now() + 86_400_000;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, payload, expires_at) VALUES (?, ?, ?)')
        .run(sid, this.seal(value), expires);
      callback(null);
    } catch (error) { callback(error); }
  }
  destroy(sid, callback = () => {}) {
    try { this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid); callback(null); }
    catch (error) { callback(error); }
  }
  touch(sid, value, callback = () => {}) {
    try {
      this.db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?')
        .run(new Date(value.cookie.expires).getTime(), sid);
      callback(null);
    } catch (error) { callback(error); }
  }
  close() { this.closed = true; clearInterval(this.cleanup); }

  async auditSessions(callback) {
    const rows = this.db.prepare('SELECT sid, payload FROM sessions WHERE expires_at > ?').all(Date.now());
    for (const row of rows) {
      if (this.closed) return;
      let value;
      try { value = this.open(row.payload); } catch { continue; }
      if (!value.twitchTokens) continue;
      await callback(value);
      if (this.closed) return;
      // Do not overwrite a newer request or resurrect a logged-out session.
      this.db.prepare('UPDATE sessions SET payload = ? WHERE sid = ? AND payload = ?')
        .run(this.seal(value), row.sid, row.payload);
    }
  }
}
