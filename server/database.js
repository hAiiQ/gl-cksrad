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
      winner_id TEXT
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL REFERENCES rounds(id),
      participant_id TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT,
      joined_at INTEGER NOT NULL,
      eligible INTEGER NOT NULL DEFAULT 1,
      UNIQUE(round_id, participant_id)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  // Preserve previous participants and the exact participant set of historical draws.
  db.exec('BEGIN IMMEDIATE');
  try {
  const entryColumns = db.prepare('PRAGMA table_info(entries)').all().map((column) => column.name);
  if (entryColumns.includes('discord_id') && !entryColumns.includes('participant_id')) {
    db.exec('ALTER TABLE entries RENAME COLUMN discord_id TO participant_id');
  }
  if (!entryColumns.includes('eligible')) {
    db.exec('ALTER TABLE entries ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1');
    const roundColumns = db.prepare('PRAGMA table_info(rounds)').all().map((column) => column.name);
    if (roundColumns.includes('requires_twitch') && entryColumns.includes('twitch_id') && entryColumns.includes('twitch_verified_at')) {
      db.exec(`UPDATE entries SET eligible = 0 WHERE (twitch_id IS NULL OR twitch_verified_at IS NULL)
        AND round_id IN (SELECT id FROM rounds WHERE status != 'open' AND requires_twitch = 1)`);
    }
  }
  db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    db.close();
    throw error;
  }
  if (!db.prepare('SELECT id FROM rounds LIMIT 1').get()) {
    db.prepare('INSERT INTO rounds (created_at) VALUES (?)').run(Date.now());
  }
  return db;
}

// Admin session payloads are encrypted at rest.
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
  close() { clearInterval(this.cleanup); }
}
