import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Where the ledger lives unless a path is given: $ONEBROWSER_DB, else onebrowser/sessions.db in the user's data
 * directory ($XDG_DATA_HOME, default ~/.local/share). One ledger per machine is shared by every project on it, so
 * that the record of a provider account's sessions is whole, whichever project opened them.
 */
export function defaultLedgerPath() {
  if (process.env.ONEBROWSER_DB) return process.env.ONEBROWSER_DB;
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'onebrowser', 'sessions.db');
}

/**
 * sessions   every remote browser session: recorded when its provider has created it (it is billed from then on,
 *            even if connecting fails), closed when released, and completed with the provider's own record
 *            (duration, proxy traffic) once the session has ended and syncUsage has fetched it
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  provider      TEXT NOT NULL,
  id            TEXT NOT NULL,            -- the session id its provider gave it
  client        TEXT NOT NULL,            -- the program that opened it (OneBrowser's client)
  opened_at     TEXT NOT NULL,            -- when the provider created it
  closed_at     TEXT,                     -- when it was released; empty if its process ended first
  duration_ms   INTEGER,                  -- the provider's record, once the session has ended
  proxy_bytes   INTEGER,                  -- proxy traffic in the provider's record
  synced_at     TEXT,                     -- when the provider's record was stored; empty = not yet
  PRIMARY KEY (provider, id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_opened ON sessions(provider, opened_at);
`;

/** Duration of a session: the provider's record, else the open-to-close timing of the process that opened it */
const SESSION_MS = 'COALESCE(duration_ms, CAST((julianday(closed_at) - julianday(opened_at)) * 86400000 AS INTEGER))';

const iso = (ms) => new Date(ms).toISOString();
const int = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Math.trunc(Number(x)));

export class Ledger {
  #db;
  #stmts = new Map();

  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); // several processes share it
    this.#db.exec(SCHEMA);
  }

  #q(sql) {
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, (s = this.#db.prepare(sql)));
    return s;
  }

  opened({ provider, id, client, openedAt }) {
    this.#q('INSERT INTO sessions (provider, id, client, opened_at) VALUES (?,?,?,?)').run(provider, id, client, iso(openedAt));
  }

  closed({ provider, id, closedAt }) {
    this.#q('UPDATE sessions SET closed_at=? WHERE provider=? AND id=? AND closed_at IS NULL').run(iso(closedAt), provider, id);
  }

  /** The record of one provider's sessions, as a provider adapter reads it for its quota (providers/index.js) */
  history(provider) {
    return {
      /** Session time (ms) of the sessions opened since `since` (ms) that have a duration */
      sessionMsSince: (since) => this.#q(`SELECT COALESCE(SUM(${SESSION_MS}), 0) ms FROM sessions WHERE provider=? AND opened_at >= ?`).get(provider, iso(since)).ms,
    };
  }

  /** Sessions with one of `providers` whose provider's record has not been stored yet: [{ provider, id, openedAt, closedAt }] (ISO times) */
  awaitingUsage(providers) {
    return this.#q(
      'SELECT provider, id, opened_at openedAt, closed_at closedAt FROM sessions WHERE synced_at IS NULL AND provider IN (SELECT value FROM json_each(?)) ORDER BY opened_at',
    ).all(JSON.stringify(providers));
  }

  recordUsage(provider, { id, durationMs, proxyBytes }) {
    this.#q('UPDATE sessions SET duration_ms=?, proxy_bytes=?, synced_at=? WHERE provider=? AND id=?').run(int(durationMs), int(proxyBytes), iso(Date.now()), provider, id);
  }

  tx(fn) {
    this.#db.exec('BEGIN');
    try {
      const r = fn();
      this.#db.exec('COMMIT');
      return r;
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  /** See OneBrowser.usage() */
  usage(since) {
    return this.#q(
      `SELECT substr(opened_at, 1, 10) day, provider, client, COUNT(*) sessions,
              COALESCE(SUM(${SESSION_MS}), 0) / 60000.0 minutes, SUM(${SESSION_MS} IS NULL) untimed,
              SUM(synced_at IS NULL) unsynced, COALESCE(SUM(proxy_bytes), 0) proxyBytes
       FROM sessions WHERE opened_at >= ? GROUP BY day, provider, client ORDER BY day, provider, client`,
    ).all(iso(since));
  }

  close() {
    this.#db.close();
  }
}
