import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Where the ledger lives unless a path is given: $ONEBROWSER_DB, else onebrowser/sessions.db in the user's data
 * directory ($XDG_DATA_HOME, default ~/.local/share). One ledger per machine is shared by every project on it, so
 * that the record of an account's sessions is whole, whichever project opened them.
 */
export function defaultLedgerPath() {
  if (process.env.ONEBROWSER_DB) return process.env.ONEBROWSER_DB;
  const data = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(data, 'onebrowser', 'sessions.db');
}

/** Every remote browser session, from when its provider has created it: it is billed from then on, even if connecting fails */
const SCHEMA = `
CREATE TABLE sessions (
  provider      TEXT NOT NULL,
  account       TEXT,                     -- the account it is billed to (Account.id); empty when not known: recorded
                                          -- before onebrowser 0.6, by a provider with several accounts here since
  id            TEXT NOT NULL,            -- the session id its provider gave it
  client        TEXT NOT NULL,            -- the program that opened it (OneBrowser's client)
  opened_at     TEXT NOT NULL,            -- when it was asked for; its provider created it right after
  ends_by       TEXT NOT NULL,            -- when it has ended at the latest, whatever becomes of its process
  closed_at     TEXT,                     -- when its provider released it; empty until then, and if it never was
  duration_ms   INTEGER,                  -- the provider's record, once the session has ended
  proxy_bytes   INTEGER,                  -- proxy traffic in the provider's record
  synced_at     TEXT,                     -- when the provider's record was stored; empty = not yet
  PRIMARY KEY (provider, id)
);
CREATE INDEX idx_sessions_opened ON sessions(account, opened_at);
`;

/**
 * The version of SCHEMA (PRAGMA user_version), and the step to it from each earlier one: a ledger outlives the
 * onebrowser that made it. onebrowser 0.1–0.3 made version 1 and left user_version 0; 0.4 and 0.5 made 2. Each
 * step makes its version as that version was, whatever SCHEMA has become since.
 */
const VERSION = 3;
const UPGRADES = {
  // 1 → 2: ends_by, as if the sessions of 1 had the default session options (15 min, then 60 s idle)
  1: `ALTER TABLE sessions RENAME TO sessions_1;
      DROP INDEX idx_sessions_opened;
      CREATE TABLE sessions (
        provider TEXT NOT NULL, id TEXT NOT NULL, client TEXT NOT NULL, opened_at TEXT NOT NULL, ends_by TEXT NOT NULL,
        closed_at TEXT, duration_ms INTEGER, proxy_bytes INTEGER, synced_at TEXT, PRIMARY KEY (provider, id)
      );
      CREATE INDEX idx_sessions_opened ON sessions(provider, opened_at);
      INSERT INTO sessions (provider, id, client, opened_at, ends_by, closed_at, duration_ms, proxy_bytes, synced_at)
        SELECT provider, id, client, opened_at, strftime('%Y-%m-%dT%H:%M:%fZ', opened_at, '+16 minutes'), closed_at, duration_ms, proxy_bytes, synced_at
        FROM sessions_1;
      DROP TABLE sessions_1;`,
  // 2 → 3: account, not known for the sessions so far (claim() settles those of a provider with one account)
  2: `ALTER TABLE sessions RENAME TO sessions_2;
      DROP INDEX idx_sessions_opened;
      CREATE TABLE sessions (
        provider TEXT NOT NULL, account TEXT, id TEXT NOT NULL, client TEXT NOT NULL, opened_at TEXT NOT NULL, ends_by TEXT NOT NULL,
        closed_at TEXT, duration_ms INTEGER, proxy_bytes INTEGER, synced_at TEXT, PRIMARY KEY (provider, id)
      );
      CREATE INDEX idx_sessions_opened ON sessions(account, opened_at);
      INSERT INTO sessions (provider, id, client, opened_at, ends_by, closed_at, duration_ms, proxy_bytes, synced_at)
        SELECT provider, id, client, opened_at, ends_by, closed_at, duration_ms, proxy_bytes, synced_at FROM sessions_2;
      DROP TABLE sessions_2;`,
};

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
  #file;
  #db;
  #stmts = new Map();

  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.#file = file;
    this.#db = new DatabaseSync(file);
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); // several processes share it
    this.#migrate();
  }

  /** Makes the ledger, or brings an earlier one up to date, in one transaction: another process may be opening it too */
  #migrate() {
    const version = () => this.#db.prepare('PRAGMA user_version').get().user_version;
    if (version() === VERSION) return;
    this.tx(() => {
      if (!this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'sessions'").get()) this.#db.exec(SCHEMA);
      else {
        const from = version() || 1;
        if (from > VERSION) throw new Error(`onebrowser: the ledger ${this.#file} was made by a later onebrowser (schema ${from}; this one knows ${VERSION})`);
        for (let v = from; v < VERSION; v++) this.#db.exec(UPGRADES[v]);
      }
      this.#db.exec(`PRAGMA user_version = ${VERSION}`);
    });
  }

  #q(sql) {
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, (s = this.#db.prepare(sql)));
    return s;
  }

  opened({ provider, account, id, client, openedAt, endsBy }) {
    this.#q('INSERT INTO sessions (provider, account, id, client, opened_at, ends_by) VALUES (?,?,?,?,?,?)').run(provider, account, id, client, iso(openedAt), iso(endsBy));
  }

  closed({ account, id, closedAt }) {
    this.#q('UPDATE sessions SET closed_at=? WHERE account=? AND id=? AND closed_at IS NULL').run(iso(closedAt), account, id);
  }

  /** The provider's sessions whose account is not known are `account`'s */
  claim(provider, account) {
    this.#q('UPDATE sessions SET account=? WHERE provider=? AND account IS NULL').run(account, provider);
  }

  /** The account's sessions that a quota reading shows, those that ended before `billedBefore` (ms); openSince() has the rest */
  history(account, billedBefore) {
    return {
      /** Their session time (ms) since `since` (ms), each as long as it can have lasted while it has no timing */
      endedSessionMsSince: (since) =>
        this.#q(`SELECT COALESCE(SUM(${SESSION_MS_AT_MOST}), 0) ms FROM sessions WHERE account=? AND opened_at >= ? AND ${ENDED_AT} < ?`).get(account, iso(since), iso(billedBefore)).ms,
    };
  }

  /** The account's sessions open at any time since `at` (ms): [{ durationMs }], as long as they can last while untimed */
  openSince(account, at) {
    return this.#q(`SELECT ${SESSION_MS_AT_MOST} durationMs FROM sessions WHERE account=? AND ${ENDED_AT} >= ?`).all(account, iso(at));
  }

  /** The account's sessions without their provider's record yet: [{ id, openedAt, closedAt }] (ISO times) */
  awaitingUsage(account) {
    return this.#q('SELECT id, opened_at openedAt, closed_at closedAt FROM sessions WHERE synced_at IS NULL AND account=? ORDER BY opened_at').all(account);
  }

  recordUsage(account, { id, durationMs, proxyBytes }) {
    this.#q('UPDATE sessions SET duration_ms=?, proxy_bytes=?, synced_at=? WHERE account=? AND id=?').run(int(durationMs), int(proxyBytes), iso(Date.now()), account, id);
  }

  /** Runs fn in a transaction that takes the write lock at once: another process may be writing too */
  tx(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
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
      `SELECT substr(opened_at, 1, 10) day, provider, COALESCE(account, provider) account, client, COUNT(*) sessions,
              COALESCE(SUM(${SESSION_MS}), 0) / 60000.0 minutes, SUM(${SESSION_MS} IS NULL) untimed,
              SUM(synced_at IS NULL) unsynced, COALESCE(SUM(proxy_bytes), 0) proxyBytes
       FROM sessions WHERE opened_at >= ? GROUP BY day, provider, account, client ORDER BY day, provider, account, client`,
    ).all(iso(since));
  }

  close() {
    this.#db.close();
  }
}
