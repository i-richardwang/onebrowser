# Changelog

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
