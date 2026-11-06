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
 * sessions   every remote browser session: recorded when it is asked for, once its provider has created it (it
 *            is billed from then on, even if connecting fails), closed when released, and completed with the
 *            provider's own record (duration, proxy traffic) once the session has ended and syncUsage has
 *            fetched it
 */
const SESSIONS = `
CREATE TABLE sessions (
  provider      TEXT NOT NULL,
  id            TEXT NOT NULL,            -- the session id its provider gave it
  client        TEXT NOT NULL,            -- the program that opened it (OneBrowser's client)
  opened_at     TEXT NOT NULL,            -- when it was asked for; its provider created it right after
  ends_by       TEXT NOT NULL,            -- when it has ended at the latest, whatever becomes of its process
  closed_at     TEXT,                     -- when it was released; empty if its process ended first
  duration_ms   INTEGER,                  -- the provider's record, once the session has ended
  proxy_bytes   INTEGER,                  -- proxy traffic in the provider's record
  synced_at     TEXT,                     -- when the provider's record was stored; empty = not yet
  PRIMARY KEY (provider, id)
);
CREATE INDEX idx_sessions_opened ON sessions(provider, opened_at);
`;

/**
 * The schema's versions, each the step from the one before (PRAGMA user_version counts the steps taken). A ledger
 * is shared by every program on the machine and outlives the onebrowser version that created it, so an older
 * ledger is brought up to date when it is opened.
 */
const MIGRATIONS = [
  // 1: the sessions, as onebrowser 0.1–0.3 kept them
  `CREATE TABLE IF NOT EXISTS sessions (
     provider TEXT NOT NULL, id TEXT NOT NULL, client TEXT NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT,
     duration_ms INTEGER, proxy_bytes INTEGER, synced_at TEXT, PRIMARY KEY (provider, id)
   );`,
  // 2: ends_by; the sessions of 1 were all opened with the session options' defaults: 15 min, then 60 s idle
  `ALTER TABLE sessions RENAME TO sessions_1;
   DROP INDEX IF EXISTS idx_sessions_opened;
   ${SESSIONS}
   INSERT INTO sessions (provider, id, client, opened_at, ends_by, closed_at, duration_ms, proxy_bytes, synced_at)
     SELECT provider, id, client, opened_at, strftime('%Y-%m-%dT%H:%M:%fZ', opened_at, '+16 minutes'), closed_at, duration_ms, proxy_bytes, synced_at
     FROM sessions_1;
   DROP TABLE sessions_1;`,
];

/** ms from one ISO time to another */
const msBetween = (from, to) => `CAST(ROUND((julianday(${to}) - julianday(${from})) * 86400000) AS INTEGER)`;

/** How long a session lasted: the provider's record, else the open-to-close timing of the process that opened it */
const SESSION_MS = `COALESCE(duration_ms, ${msBetween('opened_at', 'closed_at')})`;

/** How long a session lasts at most: as SESSION_MS, or until it ends at the latest while it has no timing */
const SESSION_MS_AT_MOST = `COALESCE(${SESSION_MS}, ${msBetween('opened_at', 'ends_by')})`;

/** When a session has ended or ends at the latest */
const ENDED_AT = 'COALESCE(closed_at, ends_by)';

const iso = (ms) => new Date(ms).toISOString();
const int = (x) => (x === null || x === undefined || !Number.isFinite(Number(x)) ? null : Math.trunc(Number(x)));

export class Ledger {
  #db;
  #stmts = new Map();

  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); // several processes share it
    this.#migrate();
  }

  /** Takes the steps of MIGRATIONS the ledger has not taken, in one transaction: another process may be at it too */
  #migrate() {
    const version = () => this.#db.prepare('PRAGMA user_version').get().user_version;
    if (version() === MIGRATIONS.length) return;
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (let v = version(); v < MIGRATIONS.length; v++) this.#db.exec(MIGRATIONS[v]);
      this.#db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
      this.#db.exec('COMMIT');
    } catch (e) {
      this.#db.exec('ROLLBACK');
      throw e;
    }
  }

  #q(sql) {
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, (s = this.#db.prepare(sql)));
    return s;
  }

  opened({ provider, id, client, openedAt, endsBy }) {
    this.#q('INSERT INTO sessions (provider, id, client, opened_at, ends_by) VALUES (?,?,?,?,?)').run(provider, id, client, iso(openedAt), iso(endsBy));
  }

  closed({ provider, id, closedAt }) {
    this.#q('UPDATE sessions SET closed_at=? WHERE provider=? AND id=? AND closed_at IS NULL').run(iso(closedAt), provider, id);
  }

  /** The record of one provider's sessions, as a provider adapter reads it for its quota (providers/index.js) */
  history(provider) {
    return {
      /** Session time (ms) of the sessions opened since `since` (ms) that have ended, each at most as long as it can have lasted */
      endedSessionMsSince: (since) =>
        this.#q(`SELECT COALESCE(SUM(${SESSION_MS_AT_MOST}), 0) ms FROM sessions WHERE provider=? AND opened_at >= ? AND ${ENDED_AT} < ?`).get(provider, iso(since), iso(Date.now())).ms,
    };
  }

  /**
   * The sessions of `provider` still open at `at` (ms): those open now, and those that have ended since.
   * [{ durationMs }]: each as long as it lasted, or can last at most while it has no timing
   */
  openAfter(provider, at) {
    return this.#q(`SELECT ${SESSION_MS_AT_MOST} durationMs FROM sessions WHERE provider=? AND ${ENDED_AT} >= ?`).all(provider, iso(at));
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
