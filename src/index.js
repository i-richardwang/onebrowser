import { readApiKey } from './credentials.js';
import { QuotaError } from './errors.js';
import { defaultLedgerPath, Ledger } from './ledger.js';
import { ADAPTERS, checkAdapter } from './providers/index.js';
import { KEEP_ALIVE_MS, Session } from './session.js';

export { apiKeyEnv } from './credentials.js';
export { QuotaError };

/** Session options when openSession() is not given them */
const SESSION_DEFAULTS = {
  proxyCountry: null, // null: the provider's default egress
  idleTimeoutSec: 60, // a session whose client is gone (its process was killed) ends this long after at the latest
  maxDurationMs: 15 * 60_000,
};

/**
 * The session options of openSession() with the defaults filled in (SESSION_DEFAULTS); throws when one is unknown
 * or out of range, so that a program can check its configuration before it opens any session:
 *   proxyCountry     country code: the provider's proxy there; null: its default egress
 *   idleTimeoutSec   a session whose client is gone ends this long after at the latest; at least twice the
 *                    keep-alive interval (session.js)
 *   maxDurationMs    the session ends this long after it was opened at the latest
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

/**
 * Remote browsers from several providers behind one interface: a session is asked for by provider name, the way
 * an LLM request names its model. Every session is recorded in a ledger (ledger.js), which the usage of each
 * provider account and, for providers that cannot report it themselves, its quota are read from.
 *
 * Which provider to use, how many sessions to hold and when to stop using one are the caller's decisions:
 * OneBrowser opens the sessions it is asked for.
 *
 * new OneBrowser({ client, ledgerPath, providers, adapters })
 *   client       the program using it, recorded with each session (several programs may share one ledger)
 *   ledgerPath   SQLite file of the ledger (default: defaultLedgerPath() in ledger.js; ':memory:' for tests),
 *                opened when first needed
 *   providers    settings per provider name: apiKey (else from the environment, see credentials.js), and the
 *                adapter's own settings on top of its defaults (providers/<name>.js)
 *   adapters     further adapters by provider name, or replacements of built-in ones (providers/index.js)
 */
export class OneBrowser {
  #providers = new Map(); // name → { adapter, settings: its defaults with the given ones on top, apiKey: the one given }
  #ledger = null;
  #open = new Set();

  constructor({ client, ledgerPath = defaultLedgerPath(), providers = {}, adapters = {} }) {
    if (!client?.trim()) throw new Error('onebrowser: client must name the program using it');
    this.client = client;
    this.ledgerPath = ledgerPath;
    for (const [name, adapter] of Object.entries({ ...ADAPTERS, ...adapters })) {
      checkAdapter(name, adapter);
      const { apiKey, ...settings } = providers[name] ?? {};
      this.#providers.set(name, { adapter, settings: { ...adapter.defaults, ...settings }, apiKey });
    }
    const unknown = Object.keys(providers).filter((name) => !this.#providers.has(name));
    if (unknown.length) throw new Error(`onebrowser: no adapter for provider ${unknown.join(', ')}`);
  }

  /** Names of the providers it can open sessions with */
  get providers() {
    return [...this.#providers.keys()];
  }

  get #store() {
    return (this.#ledger ??= new Ledger(this.ledgerPath));
  }

  /** The adapter, settings and API key of `provider`; throws when it is unknown or has no API key */
  #ready(provider) {
    const p = this.#providers.get(provider);
    if (!p) throw new Error(`unknown provider ${provider} (expected ${this.providers.join(', ')})`);
    return { ...p, apiKey: readApiKey(provider, p.apiKey) };
  }

  /** Throws when sessions cannot be opened with `provider`: unknown, or no API key */
  checkReady(provider) {
    this.#ready(provider);
  }

  /**
   * A new session with `provider`, recorded in the ledger once the provider has created it; options: see
   * sessionOptions(). Throws when the provider does not create one; QuotaError when it refuses for the account's
   * quota.
   */
  async openSession({ provider, ...options }) {
    const { adapter, settings, apiKey } = this.#ready(provider);
    const o = sessionOptions(options);
    let remote;
    try {
      remote = await adapter.createSession(settings, apiKey, o);
    } catch (e) {
      if (e instanceof QuotaError) throw e;
      throw new Error(`failed to create a ${provider} session: ${e.message}`);
    }
    const session = new Session({
      provider, remote, maxDurationMs: o.maxDurationMs,
      release: async (s) => {
        this.#open.delete(s);
        this.#store.closed(s);
        await adapter.releaseSession(settings, apiKey, s);
      },
    });
    try {
      this.#store.opened({ provider, id: session.id, client: this.client, openedAt: session.openedAt });
    } catch (e) {
      await session.close().catch(() => {}); // a session the ledger has no record of is not handed out
      throw e;
    }
    this.#open.add(session);
    return session;
  }

  /**
   * What is left of the account's quota with `provider`: { remaining, unit, renewsAt } in the provider's own
   * unit; renewsAt (ms) when it renews by itself, null when only a top-up renews it. Throws when it cannot be read.
   */
  async quota(provider) {
    const { adapter, settings, apiKey } = this.#ready(provider);
    const q = await adapter.quota(settings, apiKey, this.#store.history(provider));
    if (!(Number.isFinite(q?.remaining) && typeof q.unit === 'string')) throw new Error(`${provider} answered no quota: ${JSON.stringify(q)}`);
    return { remaining: q.remaining, unit: q.unit, renewsAt: q.renewsAt ?? null };
  }

  /**
   * Stores each provider's record (duration, proxy traffic) of the sessions in the ledger that have ended and have
   * none yet; sessions still running wait for a later call. A provider that cannot be reached, or has no API key,
   * is left for a later call too. Sessions of a provider it has no adapter for (another program's own) are left
   * to the programs that have one. Returns { reported: sessions completed, failed: [{ provider, error }] }.
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
   * [{ day, provider, client, sessions, minutes, untimed, unsynced, proxyBytes }]. Minutes are the provider's
   * record where syncUsage has stored it, otherwise the open-to-close timing of the process that opened the
   * session; untimed: sessions with neither (their process ended before closing them and the provider has not
   * reported them yet); unsynced: sessions without the provider's record.
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

  /** close(), for `await using browsers = new OneBrowser(…)` */
  [Symbol.asyncDispose]() {
    return this.close();
  }
}
