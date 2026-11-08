import { Account } from './account.js';
import { readApiKeys } from './credentials.js';
import { QuotaError } from './errors.js';
import { Ledger } from './ledger.js';
import { ledgerPathIn } from './ledger-path.js';
import { ADAPTERS, checkAdapter, fullSettings } from './providers/index.js';
import { readVariables } from './variables.js';

export { apiKeyEnv } from './credentials.js';
export { defaultLedgerPath, LEDGER_PATH_VARIABLES } from './ledger-path.js';
export { sessionOptions } from './options.js';
export { QuotaError };

/**
 * Remote browsers from several providers behind one interface. A provider is an adapter (providers/index.js);
 * an account is one API key at a provider (account.js), which sessions are opened with. Every session is
 * recorded in a ledger (ledger.js) shared by the programs on the machine, so that each account's usage, and
 * what its quota has left at any moment, are known. Which account to use, and when to stop using one, are the
 * caller's decisions.
 *
 * client: the program using it, recorded with each session; env, envFile: the variables it reads the API keys
 * and the ledger's place from (variables.js), the process's environment by default, over those of an env file
 * if one is named; ledgerPath: the ledger's SQLite file, opened when first needed; providers: settings per
 * provider name on top of its adapter's defaults, apiKeys among them; adapters: further or replacement adapters
 * by provider name.
 */
export class OneBrowser {
  #providers = []; // names, in the adapters' order
  #accounts = [];
  #ledger = null;

  constructor({ client, env = process.env, envFile, ledgerPath, providers = {}, adapters = {} }) {
    if (!client?.trim()) throw new Error('onebrowser: client must name the program using it');
    const variables = readVariables(env, envFile);
    this.client = client;
    this.ledgerPath = ledgerPath ?? ledgerPathIn(variables);
    const all = { ...ADAPTERS, ...adapters };
    const unknown = Object.keys(providers).filter((name) => !all[name]);
    if (unknown.length) throw new Error(`onebrowser: no adapter for provider ${unknown.join(', ')}`);
    for (const [provider, adapter] of Object.entries(all)) {
      checkAdapter(provider, adapter);
      const { apiKeys, ...given } = providers[provider] ?? {};
      const settings = fullSettings(provider, { ...adapter.defaults, ...given });
      this.#providers.push(provider);
      for (const apiKey of readApiKeys(provider, apiKeys, variables)) {
        this.#accounts.push(new Account({ provider, adapter, settings, apiKey, client, ledger: () => this.#store }));
      }
    }
  }

  /** The ledger, opened on first use; a provider with one account here claims its sessions recorded without one */
  get #store() {
    if (!this.#ledger) {
      this.#ledger = new Ledger(this.ledgerPath);
      for (const [provider, accounts] of Map.groupBy(this.#accounts, (a) => a.provider)) {
        if (accounts.length === 1) this.#ledger.claim(provider, accounts[0].id);
      }
    }
    return this.#ledger;
  }

  /** The ledger's own id, kept for the ledger's life: it tells its record from another ledger's */
  get ledgerId() {
    return this.#store.id;
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

  /**
   * The ledger's sessions opened since `since` (ms), oldest first, each as recorded:
   * [{ provider, account, id, client, openedAt, endsBy, closedAt, durationMs, proxyBytes, syncedAt }], times in
   * ms (closedAt, syncedAt null until then; durationMs and proxyBytes null without the provider's record). account:
   * the provider's name alone for a session whose account is not known.
   */
  sessions({ since }) {
    return this.#store.sessions(since);
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
