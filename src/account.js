import { sessionCost } from './cost.js';
import { fingerprint } from './credentials.js';
import { QuotaError } from './errors.js';
import { openMsAtMost, sessionMsAtMost, sessionOptions } from './options.js';
import { Session } from './session.js';

/**
 * One API key at one provider: the account its sessions are billed to, with its own quota and its own record in
 * the ledger. id, the provider's name and the key's fingerprint (`steel#3f9a1c`), names it in the ledger, in
 * logs and on the command line; the key itself stays inside.
 *
 * ledger(): the shared Ledger (ledger.js), opened when first needed; client: the program, recorded with each
 * session.
 */
export class Account {
  #adapter;
  #settings;
  #apiKey;
  #client;
  #ledger;
  #open = new Set();
  #latest = null; // the latest quota reading, in progress or done
  #done = null; // the latest reading done

  constructor({ provider, adapter, settings, apiKey, client, ledger }) {
    this.provider = provider;
    this.fingerprint = fingerprint(apiKey);
    this.id = `${provider}#${this.fingerprint}`;
    this.#adapter = adapter;
    this.#settings = settings;
    this.#apiKey = apiKey;
    this.#client = client;
    this.#ledger = ledger;
  }

  /**
   * A new session (options: sessionOptions()), in the ledger from when the provider has created it. Throws when
   * the provider creates none; QuotaError when it refuses for the account's quota.
   */
  async openSession(options = {}) {
    const o = sessionOptions(options);
    const openedAt = Date.now();
    let remote;
    try {
      remote = await this.#adapter.createSession(this.#settings, this.#apiKey, o);
    } catch (e) {
      if (e instanceof QuotaError) throw e;
      throw new Error(`failed to create a ${this.provider} session: ${e.message}`);
    }
    const session = new Session({ account: this, remote, openedAt, maxDurationMs: openMsAtMost(o, this.#settings), release: (s) => this.#release(s) });
    try {
      this.#ledger().opened({ provider: this.provider, account: this.id, id: session.id, client: this.#client, openedAt, endsBy: openedAt + sessionMsAtMost(o, this.#settings) });
    } catch (e) {
      await session.close().catch(() => {}); // a session the ledger does not know is not handed out
      throw e;
    }
    this.#open.add(session);
    return session;
  }

  /** Releases `session` at the provider and records it closed: when it was released, so its whole billed time counts */
  async #release(session) {
    try {
      await this.#adapter.releaseSession(this.#settings, this.#apiKey, session);
      const closedAt = Date.now();
      this.#ledger().closed({ account: this.id, id: session.id, closedAt });
      return closedAt;
    } finally {
      this.#open.delete(session);
    }
  }

  /**
   * Reads the quota from the provider, unless a reading in progress or started at most maxAgeMs ago can be used
   * (a failed one throws again); then answers as quota().
   */
  async readQuota({ maxAgeMs = 0 } = {}) {
    const reading = this.#reading(maxAgeMs);
    await reading.settled;
    if (reading.error) throw reading.error;
    return this.quota();
  }

  /**
   * What is left of the quota now, in the provider's unit: { remaining, unbilled, unit, renewsAt, total }. The last
   * reading shows the sessions that ended billingDelayMs before it; `unbilled` is what the ledger's others cost
   * at the provider's price, open ones as if they lasted as long as they can, and remaining the reading less
   * that. renewsAt (ms): when the quota renews by itself; null: only a top-up renews it. total: what the quota
   * holds when whole, the plan's or a free grant's, as the provider reports it or the adapter's plan facts give
   * it, for showing how much of it is used; null when neither says. Throws until the provider has been read, and
   * while the last reading failed.
   */
  quota() {
    const reading = this.#done;
    if (!reading) throw new Error(`the quota of ${this.id} has not been read yet (readQuota)`);
    if (reading.error) throw reading.error;
    const unbilled = this.#ledger().openSince(this.id, reading.billedBefore).reduce((cost, s) => cost + sessionCost(this.#settings.price, s.durationMs), 0);
    const { remaining, unit, renewsAt, total } = reading.value;
    return { remaining: remaining - unbilled, unbilled, unit, renewsAt, total };
  }

  /** The latest reading if it is in progress or at most maxAgeMs old, else a new one */
  #reading(maxAgeMs) {
    const latest = this.#latest;
    if (latest && (latest !== this.#done || Date.now() - latest.startedAt <= maxAgeMs)) return latest;
    const startedAt = Date.now();
    const reading = { startedAt, billedBefore: startedAt - this.#settings.billingDelayMs, value: null, error: null };
    this.#latest = reading;
    reading.settled = (async () => {
      try {
        const q = await this.#adapter.quota(this.#settings, this.#apiKey, this.#ledger().history(this.id, reading.billedBefore));
        if (!(Number.isFinite(q?.remaining) && typeof q.unit === 'string')) throw new Error(`${this.provider} answered no quota: ${JSON.stringify(q)}`);
        reading.value = { remaining: q.remaining, unit: q.unit, renewsAt: q.renewsAt ?? null, total: Number.isFinite(q.total) && q.total > 0 ? q.total : null };
      } catch (e) {
        reading.error = e;
      }
      this.#done = reading;
    })();
    return reading;
  }

  /** What a session with these options costs at most, in the unit of the quota */
  maxSessionCost(options) {
    return sessionCost(this.#settings.price, sessionMsAtMost(sessionOptions(options), this.#settings));
  }

  /** Stores the provider's records (duration, proxy traffic) of this account's ended sessions that have none yet; how many */
  async syncUsage() {
    const ledger = this.#ledger();
    const rows = ledger.awaitingUsage(this.id);
    if (!rows.length) return 0;
    const usage = await this.#adapter.sessionUsage(this.#settings, this.#apiKey, rows);
    ledger.tx(() => usage.forEach((u) => ledger.recordUsage(this.id, u)));
    return usage.length;
  }

  /** Closes its sessions still open; their release errors are ignored: the provider ends those */
  async close() {
    await Promise.all([...this.#open].map((s) => s.close().catch(() => {})));
  }
}
