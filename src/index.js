import { sessionCost } from './cost.js';
import { readApiKey } from './credentials.js';
import { QuotaError } from './errors.js';
import { defaultLedgerPath, Ledger } from './ledger.js';
import { ADAPTERS, checkAdapter, checkSettings } from './providers/index.js';
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
 * How long a session with these options (sessionOptions) lasts at most, whatever becomes of its process: this
 * process ends it at maxDurationMs, and its provider idleTimeoutSec after its client left, should the process die
 * or its release fail before
 */
const sessionMsAtMost = (o) => o.maxDurationMs + o.idleTimeoutSec * 1000;

/**
 * Remote browsers from several providers behind one interface: a session is asked for by provider name, the way
 * an LLM request names its model. Every session is recorded in a ledger (ledger.js), which the usage of each
 * provider account and, for providers that cannot report it themselves, its quota are read from.
 *
 * What is left of an account's quota is what its provider reads, less what the sessions it has not billed yet
 * cost (quota()): the ledger knows those, and each provider's price (cost.js) what they cost. So a program can
 * tell, before it opens a session, whether the account can pay for it.
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
  #readings = new Map(); // provider → its last quota reading (#reading)

  constructor({ client, ledgerPath = defaultLedgerPath(), providers = {}, adapters = {} }) {
    if (!client?.trim()) throw new Error('onebrowser: client must name the program using it');
    this.client = client;
    this.ledgerPath = ledgerPath;
    for (const [name, adapter] of Object.entries({ ...ADAPTERS, ...adapters })) {
      checkAdapter(name, adapter);
      const { apiKey, ...given } = providers[name] ?? {};
      const settings = { ...adapter.defaults, ...given };
      checkSettings(name, settings);
      this.#providers.set(name, { adapter, settings, apiKey });
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

  /** The adapter, settings and the API key given of `provider`; throws when it is unknown */
  #known(provider) {
    const p = this.#providers.get(provider);
    if (!p) throw new Error(`unknown provider ${provider} (expected ${this.providers.join(', ')})`);
    return p;
  }

  /** The adapter, settings and API key of `provider`; throws when it is unknown or has no API key */
  #ready(provider) {
    const p = this.#known(provider);
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
    const openedAt = Date.now(); // the provider bills the session from some time after this
    let remote;
    try {
      remote = await adapter.createSession(settings, apiKey, o);
    } catch (e) {
      if (e instanceof QuotaError) throw e;
      throw new Error(`failed to create a ${provider} session: ${e.message}`);
    }
    const session = new Session({
      provider, remote, openedAt, maxDurationMs: o.maxDurationMs,
      release: async (s) => {
        this.#open.delete(s);
        this.#store.closed(s);
        await adapter.releaseSession(settings, apiKey, s);
      },
    });
    try {
      this.#store.opened({ provider, id: session.id, client: this.client, openedAt, endsBy: openedAt + sessionMsAtMost(o) });
    } catch (e) {
      await session.close().catch(() => {}); // a session the ledger has no record of is not handed out
      throw e;
    }
    this.#open.add(session);
    return session;
  }

  /**
   * What is left of the account's quota with `provider`, in the provider's own unit: { remaining, unbilled, unit,
   * renewsAt }. remaining: what the provider reads, less `unbilled`: what the sessions in the ledger that the
   * reading may not show yet cost, each at the provider's price (cost.js). Those are the sessions that had not
   * ended billingDelayMs before the reading: open ones as if they lasted as long as they can, ended ones as long
   * as they lasted. renewsAt (ms) when the quota renews by itself, null when only a top-up renews it.
   *
   * The provider is read anew unless a reading started at most maxAgeMs ago, or still in progress, can be used
   * (a failed one too: it throws again); what is unbilled is worked out from the ledger every time, so it includes
   * the sessions opened since, by any program sharing the ledger. Throws when the provider cannot be read.
   */
  async quota(provider, { maxAgeMs = 0 } = {}) {
    const { settings } = this.#known(provider);
    const reading = this.#reading(provider, maxAgeMs);
    const answer = await reading.answer;
    const sessions = this.#store.openAfter(provider, reading.startedAt - settings.billingDelayMs);
    const unbilled = sessions.reduce((cost, s) => cost + sessionCost(settings.price, s.durationMs), 0);
    return { remaining: answer.remaining - unbilled, unbilled, unit: answer.unit, renewsAt: answer.renewsAt ?? null };
  }

  /**
   * The provider's quota reading, { startedAt, answer: a promise of the adapter's answer }: the last one if it
   * started at most maxAgeMs ago or is still in progress, else a new one. A failed reading counts as one too: its
   * error is the answer until maxAgeMs have passed.
   */
  #reading(provider, maxAgeMs) {
    const last = this.#readings.get(provider);
    if (last && (!last.done || Date.now() - last.startedAt <= maxAgeMs)) return last;
    const { adapter, settings, apiKey } = this.#ready(provider);
    const reading = { startedAt: Date.now(), done: false };
    reading.answer = adapter
      .quota(settings, apiKey, this.#store.history(provider))
      .then((q) => {
        if (!(Number.isFinite(q?.remaining) && typeof q.unit === 'string')) throw new Error(`${provider} answered no quota: ${JSON.stringify(q)}`);
        return q;
      })
      .finally(() => (reading.done = true));
    reading.answer.catch(() => {}); // awaited by the callers; not an unhandled rejection while cached
    this.#readings.set(provider, reading);
    return reading;
  }

  /**
   * What a session with `provider` and these session options (sessionOptions) costs at most, in the unit of its
   * quota: as if it lasted as long as it can, at the provider's price
   */
  maxSessionCost(provider, options) {
    return sessionCost(this.#known(provider).settings.price, sessionMsAtMost(sessionOptions(options)));
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
