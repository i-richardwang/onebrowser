import { Account } from './account.js';
import { readApiKeys } from './credentials.js';
import { QuotaError } from './errors.js';
import { defaultLedgerPath, Ledger } from './ledger.js';
import { ADAPTERS, checkAdapter, fullSettings } from './providers/index.js';

export { apiKeyEnv } from './credentials.js';
export { sessionOptions } from './options.js';
export { QuotaError };

/**
 * Remote browsers from several providers behind one interface. A provider is an adapter (providers/index.js);
 * an account is one API key at a provider (account.js), which sessions are opened with. Every session is
 * recorded in a ledger (ledger.js) shared by the programs on the machine, so that each account's usage, and
 * what its quota has left at any moment, are known. Which account to use, and when to stop using one, are the
 * caller's decisions.
 *
 * client: the program using it, recorded with each session; ledgerPath: the ledger's SQLite file, opened when
 * first needed; providers: settings per provider name on top of its adapter's defaults, apiKeys among them
 * (else credentials.js); adapters: further or replacement adapters by provider name.
 */
export class OneBrowser {
  #providers = []; // names, in the adapters' order
  #accounts = [];
  #ledger = null;

  constructor({ client, ledgerPath = defaultLedgerPath(), providers = {}, adapters = {} }) {
    if (!client?.trim()) throw new Error('onebrowser: client must name the program using it');
    this.client = client;
    this.ledgerPath = ledgerPath;
    const all = { ...ADAPTERS, ...adapters };
    const unknown = Object.keys(providers).filter((name) => !all[name]);
    if (unknown.length) throw new Error(`onebrowser: no adapter for provider ${unknown.join(', ')}`);
    for (const [provider, adapter] of Object.entries(all)) {
      checkAdapter(provider, adapter);
      const { apiKeys, ...given } = providers[provider] ?? {};
      const settings = fullSettings(provider, { ...adapter.defaults, ...given });
      this.#providers.push(provider);
      for (const apiKey of readApiKeys(provider, apiKeys)) {
        this.#accounts.push(new Account({ provider, adapter, settings, apiKey, client, ledger: () => this.#store }));
      }
    }
  }

  /**
   * The ledger, opened on first use. Sessions recorded before accounts were (onebrowser 0.5 and earlier) are
   * the provider's only account's, when it has one here; with several, no one knows which they belong to.
   */
  get #store() {
    if (!this.#ledger) {
      this.#ledger = new Ledger(this.ledgerPath);
      for (const [provider, accounts] of Map.groupBy(this.#accounts, (a) => a.provider)) {
        if (accounts.length === 1) this.#ledger.claim(provider, accounts[0].id);
      }
    }
    return this.#ledger;
  }

  /** Names of the providers it has adapters for */
  get providers() {
    return [...this.#providers];
  }

  /** The accounts with an API key, in the providers' order and then the keys': all, or `provider`'s (throws for an unknown one) */
  accounts(provider) {
    if (provider === undefined) return [...this.#accounts];
    if (!this.#providers.includes(provider)) throw new Error(`unknown provider ${provider} (expected ${this.#providers.join(', ')})`);
    return this.#accounts.filter((a) => a.provider === provider);
  }

  /**
   * Stores the providers' records (duration, proxy traffic) of the ledger's ended sessions that have none yet:
   * { reported, failed: [{ account, error }] }. What cannot be fetched now, and the sessions of accounts without
   * a key here, are left for a later call.
   */
  async syncUsage() {
    let reported = 0;
    const failed = [];
    for (const account of this.#accounts) {
      try {
        reported += await account.syncUsage();
      } catch (e) {
        failed.push({ account: account.id, error: e.message });
      }
    }
    return { reported, failed };
  }

  /**
   * Sessions opened since `since` (ms), per UTC day, account and client:
   * [{ day, provider, account, client, sessions, minutes, untimed, unsynced, proxyBytes }]. minutes: the
   * provider's record (syncUsage), else the open-to-close timing; untimed: sessions with neither; unsynced:
   * those without the record. account: the provider's name alone for sessions whose account is not known.
   */
  usage({ since }) {
    return this.#store.usage(since);
  }

  /** Closes every session still open and the ledger */
  async close() {
    await Promise.all(this.#accounts.map((a) => a.close()));
    this.#ledger?.close();
    this.#ledger = null;
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}
