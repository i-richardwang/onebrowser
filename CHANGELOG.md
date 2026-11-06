# Changelog

## 0.2.0

- Provider `anchor`: [Anchor Browser](https://anchorbrowser.io), with its residential proxy for `proxyCountry` and its credits as the quota.

## 0.1.1

The first release (0.1.0 was published from a pre-release commit and withdrawn).

- `OneBrowser`: sessions by provider name with one meaning of `proxyCountry`, `idleTimeoutSec` and `maxDurationMs` on every provider; Playwright or any CDP client; `await using` for sessions and for the `OneBrowser`.
- Providers: Steel, TinyFish, Hyperbrowser, Lightpanda, Kernel; further adapters through `adapters`.
- A ledger of every session, one per machine and shared by the programs on it; `syncUsage()` completes it with the providers' own records, `usage()` reports it.
- `quota()` in each provider's own unit, and `QuotaError` when a provider refuses a session for the account's quota.
- The `onebrowser` command: `quota` and `usage`, as text or `--json`.
