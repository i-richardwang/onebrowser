# Changelog

## 0.8.0

- `quota()` has `total`: what the quota holds when whole, for showing how much of it is used. Firecrawl reports its plan's credits; Kernel and Lightpanda hold `monthlyHours`; Steel, TinyFish, Hyperbrowser and Anchor take `includedQuota`, a new plan fact set to what their free plan or a new account's grant gives (as of 2026-11), which a program on another plan sets. `null` when neither the provider nor the settings say. The command line prints it (`3 of 10 hours left`).
- `env` and `envFile`: the variables a `OneBrowser` reads its API keys and its ledger's place from, `process.env` by default, over those of an env file if one is named (a variable set but empty is unset). A program that keeps the keys in a file hands it over here, without loading it into its environment, where its child processes would see them. `--env-file` reads its file this way, and no longer changes the environment.
- `onebrowser/ledger-path`: `defaultLedgerPath({ env, envFile })` and `LEDGER_PATH_VARIABLES`, for a program that looks for the ledger without opening it; it loads no SQLite. Both are exported from `onebrowser` too.
- The ledger's place takes `~` for the home directory, as an env file holds it unexpanded, and ignores a relative `XDG_DATA_HOME`, as the XDG spec has it.

## 0.7.0

- `sessions({ since })`: the ledger's sessions one by one, as recorded, for a program that keeps its own record of them (such as a usage dashboard's collector).
- `ledgerId`: each ledger has an id of its own, given when it is made or first opened by this version and kept for its life; `usage --json` prints it. It lives in a table beside the schema, without a schema step, so a ledger this version has opened still opens in 0.6.

## 0.6.0

Breaking: sessions are opened with an account, one API key at a provider, instead of by provider name.

- `accounts(provider?)` lists the accounts with an API key; an account has `openSession(options)`, `readQuota({ maxAgeMs })`, `quota()` and `maxSessionCost(options)`, each for its own key. `checkReady()` and the provider-named methods of `OneBrowser` are gone.
- Several keys for one provider: `apiKeys` in its settings, or `<PROVIDER>_API_KEY` holding them separated by commas, spaces or line breaks, or one per line in the file `<PROVIDER>_API_KEY_FILE` names.
- An account's id is the provider's name and the key's fingerprint (`steel#3f9a1c`); a session has `account`. The ledger records each session's account, and `usage()` and `syncUsage()` report per account. Sessions recorded by earlier versions become the provider's only account's when it has one.
- The command line reads and reports per account; `quota` takes providers or account ids.

## 0.5.0

Breaking: `quota()` is synchronous and no longer reads the provider; a session's `closedAt` is when its provider released it.

- `readQuota(provider, { maxAgeMs })` reads the provider's quota; `quota(provider)` answers at once from the last reading, the sessions opened since counted as soon as they are in the ledger.
- A session is recorded closed once its provider has released it; one whose release fails keeps `closedAt` null and counts as lasting as long as it can. A reading and the sessions it does not show split the ledger at the same moment, so each session counts once.
- `Session.close()` answers every call as the first, so it throws every time when the release failed; `connect()` refuses once closing has begun.
- `minIdleTimeoutSec`: the shortest idle timeout a provider takes (Anchor: a minute), which bounds how long its sessions last.
- A ledger made by a later onebrowser is refused.

## 0.4.0

- `quota()` answers what is left once the sessions not billed yet are paid for: `remaining` is the provider's reading less `unbilled`, what the ledger's sessions that the reading may not show cost, open ones as if they lasted as long as they can. With `{ maxAgeMs }` it reuses a recent reading, a failed one too; the unbilled sessions are counted anew every time.
- `maxSessionCost(provider, options)`: what a session with these options costs at most, in the unit of the provider's quota.
- Every provider has a `price` and a `billingDelayMs`, settings a program can override for its plan.
- The ledger records when each session ends at the latest; a ledger of an earlier version is brought up to date when opened. A session's `openedAt` is when it was asked for.
- Lightpanda's quota counts a session no process closed as lasting as long as it could, not as nothing.

## 0.3.0

- Provider `firecrawl`: [Firecrawl](https://www.firecrawl.dev)'s Browser Sandbox, with its location for `proxyCountry` and its credits as the quota.

## 0.2.0

- Provider `anchor`: [Anchor Browser](https://anchorbrowser.io), with its residential proxy for `proxyCountry` and its credits as the quota.

## 0.1.1

The first release (0.1.0 was published from a pre-release commit and withdrawn).

- `OneBrowser`: sessions by provider name with one meaning of `proxyCountry`, `idleTimeoutSec` and `maxDurationMs` on every provider; Playwright or any CDP client; `await using` for sessions and for the `OneBrowser`.
- Providers: Steel, TinyFish, Hyperbrowser, Lightpanda, Kernel; further adapters through `adapters`.
- A ledger of every session, one per machine and shared by the programs on it; `syncUsage()` completes it with the providers' own records, `usage()` reports it.
- `quota()` in each provider's own unit, and `QuotaError` when a provider refuses a session for the account's quota.
- The `onebrowser` command: `quota` and `usage`, as text or `--json`.
