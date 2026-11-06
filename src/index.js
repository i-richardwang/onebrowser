import { sessionCost } from './cost.js';
import { readApiKey } from './credentials.js';
import { QuotaError } from './errors.js';
import { defaultLedgerPath, Ledger } from './ledger.js';
import { ADAPTERS, checkAdapter, fullSettings } from './providers/index.js';
import { KEEP_ALIVE_MS, Session } from './session.js';

export { apiKeyEnv } from './credentials.js';
export { QuotaError };

/** Session options when openSession() is not given them */
const SESSION_DEFAULTS = {
  proxyCountry: null,
  idleTimeoutSec: 60,
  maxDurationMs: 15 * 60_000,
};

/**
 * The session options of openSession() with the defaults filled in; throws when one is unknown or out of range,
 * so that a program can check its configuration before it opens any session:
 *   proxyCountry     country code: the provider's proxy there; null: its default egress
 *   idleTimeoutSec   a session whose client is gone ends this long after at the latest, or after the provider's
 *                    minIdleTimeoutSec if longer (≥ 2 × KEEP_ALIVE_MS)
 *   maxDurationMs    a session ends this long after it was opened at the latest
 */
export function sessionOptions(options = {}) {
  const unknown = Object.keys(options).filter((k) => !Object.hasOwn(SESSION_DEFAULTS, k));
  if (unknown.length) throw new Error(`unknown session option ${unknown.join(', ')} (expected ${Object.keys(SESSION_DEFAULTS).join(', ')})`);
  const o = { ...SESSION_DEFAULTS, ...options };
  if (!(Number.isFinite(o.idleTimeoutSec) && o.idleTimeoutSec * 1000 >= 2 * KEEP_ALIVE_MS)) {
    throw new Error(`idleTimeoutSec must be at least ${(2 * KEEP_ALIVE_MS) / 1000} (twice the keep-alive interval), not ${o.idleTimeoutSec}`);
  }
  if (!(Number.isFinite(o.maxDurationMs) && o.maxDurationMs > 0)) throw new Error(`maxDurationMs must be a number > 0, not ${o.maxDurationMs}`);
  return o;
}

/** How long a session lasts at most, whatever becomes of its process: closed at maxDurationMs, else ended by its provider once idle */
const sessionMsAtMost = (o, settings) => o.maxDurationMs + Math.max(o.idleTimeoutSec, settings.minIdleTimeoutSec) * 1000;

/**
 * Remote browsers from several providers behind one interface: a session is asked for by provider name. Every
 * session is recorded in a ledger (ledger.js) shared by the programs on the machine, so that each provider
 * account's usage, and what its quota has left at any moment, are known. Which provider to use, and when to
 * stop using one, are the caller's decisions.
 *
 * client: the program using it, recorded with each session; ledgerPath: the ledger's SQLite file, opened when
 * first needed; providers: settings per provider name on top of its adapter's defaults (providers/index.js),
 * apiKey among them (else credentials.js); adapters: further or replacement adapters by provider name.
 */
export class OneBrowser {
  #providers = new Map(); // name → { adapter, settings, apiKey }
  #ledger = null;
  #open = new Set();
  #readings = new Map(); // provider → { latest, done }: its latest quota reading, and the latest one done

  constructor({ client, ledgerPath = defaultLedgerPath(), providers = {}, adapters = {} }) {
    if (!client?.trim()) throw new Error('onebrowser: client must name the program using it');
    this.client = client;
    this.ledgerPath = ledgerPath;
    for (const [name, adapter] of Object.entries({ ...ADAPTERS, ...adapters })) {
      checkAdapter(name, adapter);
      const { apiKey, ...given } = providers[name] ?? {};
      this.#providers.set(name, { adapter, settings: fullSettings(name, { ...adapter.defaults, ...given }), apiKey });
    }
    const unknown = Object.keys(providers).filter((name) => !this.#providers.has(name));
    if (unknown.length) throw new Error(`onebrowser: no adapter for provider ${unknown.join(', ')}`);
  }

  get providers() {
    return [...this.#providers.keys()];
  }

  get #store() {
    return (this.#ledger ??= new Ledger(this.ledgerPath));
  }

  #known(provider) {
    const p = this.#providers.get(provider);
    if (!p) throw new Error(`unknown provider ${provider} (expected ${this.providers.join(', ')})`);
    return p;
  }

  #ready(provider) {
    const p = this.#known(provider);
    return { ...p, apiKey: readApiKey(provider, p.apiKey) };
  }

  /** Throws when sessions cannot be opened with `provider`: unknown, or no API key */
  checkReady(provider) {
    this.#ready(provider);
  }

  /**
   * A new session with `provider` (options: sessionOptions()), in the ledger from when its provider has created
   * it. Throws when the provider creates none; QuotaError when it refuses for the account's quota.
   */
  async openSession({ provider, ...options }) {
    const { adapter, settings, apiKey } = this.#ready(provider);
    const o = sessionOptions(options);
    const openedAt = Date.now();
    let remote;
    try {
      remote = await adapter.createSession(settings, apiKey, o);
    } catch (e) {
      if (e instanceof QuotaError) throw e;
      throw new Error(`failed to create a ${provider} session: ${e.message}`);
    }
    const session = new Session({ provider, remote, openedAt, maxDurationMs: o.maxDurationMs, release: (s) => this.#release(adapter, settings, apiKey, s) });
    try {
      this.#store.opened({ provider, id: session.id, client: this.client, openedAt, endsBy: openedAt + sessionMsAtMost(o, settings) });
    } catch (e) {
      await session.close().catch(() => {}); // a session the ledger does not know is not handed out
      throw e;
    }
    this.#open.add(session);
    return session;
  }

  /** Releases `session` at its provider and records it closed: when it was released, so its whole billed time counts */
  async #release(adapter, settings, apiKey, session) {
    try {
      await adapter.releaseSession(settings, apiKey, session);
      const closedAt = Date.now();
      this.#store.closed({ provider: session.provider, id: session.id, closedAt });
      return closedAt;
    } finally {
      this.#open.delete(session);
    }
  }

  /**
   * Reads the account's quota with `provider` from the provider, unless a reading in progress or started at most
   * maxAgeMs ago can be used (a failed one throws again); then answers as quota().
   */
  async readQuota(provider, { maxAgeMs = 0 } = {}) {
    const reading = this.#reading(provider, maxAgeMs);
    await reading.settled;
    if (reading.error) throw reading.error;
    return this.quota(provider);
  }

  /**
   * What is left of the account's quota now, in the provider's unit: { remaining, unbilled, unit, renewsAt }. The
   * last reading shows the sessions that ended billingDelayMs before it; `unbilled` is what the ledger's others
   * cost at the provider's price, open ones as if they lasted as long as they can, and remaining the reading less
   * that. renewsAt (ms): when the quota renews by itself; null: only a top-up renews it. Throws until the
   * provider has been read, and while its last reading failed.
   */
  quota(provider) {
    const { settings } = this.#known(provider);
    const reading = this.#readings.get(provider)?.done;
    if (!reading) throw new Error(`the quota of ${provider} has not been read yet (readQuota)`);
    if (reading.error) throw reading.error;
    const unbilled = this.#store.openSince(provider, reading.billedBefore).reduce((cost, s) => cost + sessionCost(settings.price, s.durationMs), 0);
    const { remaining, unit, renewsAt = null } = reading.value;
    return { remaining: remaining - unbilled, unbilled, unit, renewsAt };
  }

  /** The latest reading of the provider's quota if it is in progress or at most maxAgeMs old, else a new one */
  #reading(provider, maxAgeMs) {
    const readings = this.#readings.get(provider) ?? { latest: null, done: null };
    this.#readings.set(provider, readings);
    const { latest } = readings;
    const inProgress = latest && latest !== readings.done;
    if (inProgress || (latest && Date.now() - latest.startedAt <= maxAgeMs)) return latest;
    const { adapter, settings, apiKey } = this.#ready(provider);
    const startedAt = Date.now();
    const reading = { startedAt, billedBefore: startedAt - settings.billingDelayMs, value: null, error: null };
    readings.latest = reading;
    reading.settled = (async () => {
      try {
        const q = await adapter.quota(settings, apiKey, this.#store.history(provider, reading.billedBefore));
        if (!(Number.isFinite(q?.remaining) && typeof q.unit === 'string')) throw new Error(`${provider} answered no quota: ${JSON.stringify(q)}`);
        reading.value = q;
      } catch (e) {
        reading.error = e;
      }
      readings.done = reading;
    })();
    return reading;
  }

  /** What a session with these options costs at most, in the unit of the provider's quota */
  maxSessionCost(provider, options) {
    const { settings } = this.#known(provider);
    return sessionCost(settings.price, sessionMsAtMost(sessionOptions(options), settings));
  }

  /**
   * Stores the providers' records (duration, proxy traffic) of the ledger's ended sessions that have none yet:
   * { reported, failed: [{ provider, error }] }. What cannot be fetched now, and the sessions of providers it has
   * no adapter for, are left for a later call.
   */
  async syncUsage() {
    const store = this.#store;
    let reported = 0;
    const failed = [];
    for (const [provider, rows] of Map.groupBy(store.awaitingUsage(this.providers), (s) => s.provider)) {
      try {
        const { adapter, settings, apiKey } = this.#ready(provider);
        const usage = await adapter.sessionUsage(settings, apiKey, rows);
        store.tx(() => usage.forEach((u) => store.recordUsage(provider, u)));
        reported += usage.length;
      } catch (e) {
        failed.push({ provider, error: e.message });
      }
    }
    return { reported, failed };
  }

  /**
   * Sessions opened since `since` (ms), per UTC day, provider and client:
   * [{ day, provider, client, sessions, minutes, untimed, unsynced, proxyBytes }]. minutes: the provider's record
   * (syncUsage), else the open-to-close timing; untimed: sessions with neither; unsynced: those without the record.
   */
  usage({ since }) {
    return this.#store.usage(since);
  }

  /** Closes every session still open (their release errors are ignored: the providers end those) and the ledger */
  async close() {
    await Promise.all([...this.#open].map((s) => s.close().catch(() => {})));
    this.#ledger?.close();
    this.#ledger = null;
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}
