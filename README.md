# onebrowser

One interface to remote browser providers. A provider is an adapter; an account is one API key at a provider, and sessions are opened with an account. Every session is recorded in a ledger, which each account's usage and quota are read from.

```sh
npm install onebrowser
```

```js
import { OneBrowser, QuotaError } from 'onebrowser';

const browsers = new OneBrowser({ client: 'my-crawler' });
const [steel] = browsers.accounts('steel'); // one account per key in STEEL_API_KEY
const session = await steel.openSession({ proxyCountry: 'DE' });
const page = await session.newPage(); // Playwright; or any CDP client on session.cdpUrl
await page.goto('https://example.com');
await session.close();

await steel.readQuota(); // { remaining, unbilled, unit: 'USD', renewsAt: null }
steel.quota(); // the same now, from that reading: sessions opened since count at once
steel.maxSessionCost(); // what a session with the default options costs at most, in USD
await browsers.syncUsage(); // stores the providers' records of ended sessions in the ledger
browsers.usage({ since: Date.parse('2026-11-01') }); // [{ day, provider, account, client, sessions, minutes, … }]
await browsers.close();
```

Choosing an account, capping sessions and stopping before a quota runs out are the program's policy. onebrowser opens the sessions it is asked for and gives the program what it needs to decide: the accounts it has keys for, what each quota has left, what a session costs at most, and `QuotaError` when a provider refuses a session for the account's quota.

Built in: [Steel](https://steel.dev), [TinyFish](https://tinyfish.ai), [Hyperbrowser](https://hyperbrowser.ai), [Lightpanda](https://lightpanda.io), [Kernel](https://www.kernel.sh), [Anchor Browser](https://anchorbrowser.io) and [Firecrawl](https://www.firecrawl.dev); a program can add its own (see [Adding a provider](#adding-a-provider)). Node 22.13 or later.

## Interface

`new OneBrowser({ client, ledgerPath, providers, adapters })`

| Option | |
|---|---|
| `client` | The program using it, recorded with each session; required |
| `ledgerPath` | SQLite file of the ledger (default below; `':memory:'` for tests). Opened when first needed |
| `providers` | Settings per provider name, on top of its adapter's `defaults`: `apiKeys` (see [Accounts](#accounts)), `price`, `billingDelayMs`, `minIdleTimeoutSec` (see [Quota](#quota)) and the adapter's own (API base URLs, plan facts such as `monthlyHours`) |
| `adapters` | Further adapters by provider name, or replacements of built-in ones |

| Method | |
|---|---|
| `providers` | Names of the providers it has adapters for |
| `accounts(provider?)` | The accounts with an API key, in the providers' order and then the keys': all of them, or the provider's (throws for an unknown provider) |
| `syncUsage()` | Stores the providers' records (duration, proxy traffic) of ended sessions: `{ reported, failed: [{ account, error }] }` |
| `usage({ since })` | Sessions opened since `since` (ms) per UTC day, account and client: `sessions`, `minutes` (the provider's record, else the open-to-close timing), `untimed`, `unsynced`, `proxyBytes` |
| `close()` | Closes the sessions still open and the ledger |

An account has `id` (`steel#3f9a1c`: the provider's name and the key's fingerprint), `provider`, `fingerprint`, and:

| Method | |
|---|---|
| `openSession({ proxyCountry, idleTimeoutSec, maxDurationMs })` | A new session, in the ledger from when the provider has created it. Throws `QuotaError` when the provider refuses it for the account's quota |
| `readQuota({ maxAgeMs })` | Reads the account's quota from the provider, unless a reading in progress or started at most `maxAgeMs` ago (default 0) can be used, a failed one too; then answers as `quota()` |
| `quota()` | What is left now, from the last reading: `{ remaining, unbilled, unit, renewsAt }` (see [Quota](#quota)). Throws until the account has been read, and while its last reading failed |
| `maxSessionCost(options)` | What a session with these options costs at most, in the unit of the quota |

A session has `id`, `account`, `egress`, `cdpUrl` (it may carry the API key: never log it), `openedAt` (when it was asked for), `closedAt` (when its provider released it), and:

- `connect()`: Playwright's `Browser` over its CDP connection, made once. A keep-alive command every 15 s keeps the provider's idle timeout from ending a session in use.
- `newPage()`: a new page in the default context: the page a remote browser starts with cannot always be navigated.
- `close()`: disconnects and releases it; every call answers as the first. Throws when the provider could not release it: the provider ends it by itself, and the ledger counts it as lasting as long as it can.

A session and a `OneBrowser` are async-disposable: `await using session = await steel.openSession()` closes the session at the end of its block (Node 24 or later; on Node 22 call `close()`).

### Session options: one meaning on every provider

| Option | Default | Meaning |
|---|---|---|
| `proxyCountry` | `null` | A country code: the provider's proxy in that country. `null`: its default egress |
| `idleTimeoutSec` | 60 | A session whose client is gone (its process was killed) ends this long after at the latest, or after the provider's `minIdleTimeoutSec` if longer. At least 30 (twice the keep-alive interval) |
| `maxDurationMs` | 15 min | The session ends this long after it was opened at the latest: this process closes it then, and the provider's own limit is set to it where its API takes one |

`sessionOptions(options)` returns them with the defaults filled in and throws when one is unknown or out of range, so that a program can check its configuration before it opens any session.

How each provider meets them:

| Provider | `proxyCountry` | `idleTimeoutSec` | `maxDurationMs` |
|---|---|---|---|
| `steel` | residential proxy | `inactivityTimeout` (no CDP commands) | `timeout` |
| `tinyfish` | residential proxy | `timeout_seconds` (no CDP commands) | this process only |
| `hyperbrowser` | residential proxy, paid plans | at once: a session ends with its CDP connection | `timeoutMinutes`, in whole minutes |
| `lightpanda` | its datacenter pool in that country | at once: a session is its CDP connection | Lightpanda's own limit is 15 min |
| `kernel` | not supported (throws) | `timeout_seconds` after the CDP client left; until then a disconnected session stays in standby, counting toward the plan's concurrent browsers | this process only |
| `anchor` | residential proxy | `idle_timeout` after the last CDP connection left, in whole minutes rounded down (at least 1) | `max_duration`, in whole minutes |
| `firecrawl` | its `location` in that country (default: the US) | `activityTtl` (no CDP commands), in whole seconds rounded down, at most 1 h | `ttl`, in whole seconds, at least 30 s and at most 1 h |

### Quota

`quota()` is the last reading less `unbilled`: what the ledger's sessions of the account that the reading does not show cost at the provider's `price`. A reading shows the sessions that ended `billingDelayMs` before it; the others are open ones, counted as lasting as long as they can (`maxDurationMs`, then `idleTimeoutSec`, at least the provider's `minIdleTimeoutSec`), and those ended since, counted as long as they lasted. So each session counts once from when its provider has created it, whichever program on the machine opened it, and a program can check before each session that the account pays for it (`maxSessionCost`). A provider that bills a session while it runs has part of it counted twice, on the safe side. Not counted: sessions opened through another machine's ledger, until the provider bills them, and proxy traffic billed by the GB.

`price` is in the quota's unit: `perHour`, `perSession` (default 0), the session time billed in whole `stepSec`, rounded up (default 1), and at least `minSec` (default 0). Where a provider does not document its rounding, the adapter takes the minute. `renewsAt` (ms) is when the quota renews by itself; `null` when only a top-up renews it. `price` and `billingDelayMs` are settings: a program on another plan sets its own.

| Provider | Quota, unit | Read from | `price` | `billingDelayMs` |
|---|---|---|---|---|
| `steel` | balance, USD | `GET /v1/credits/balance`, the endpoint of Steel's dashboard (not in its API docs) | $0.10 an hour (Launch plan), by the minute | 5 min |
| `tinyfish` | wallet, USD | [`GET /v1/wallet`](https://docs.tinyfish.ai/wallet); a session refused with 402 throws `QuotaError` | $0.002 a minute, by the minute | 5 min |
| `hyperbrowser` | credits | `GET /api/team/credit-info`, the endpoint of Hyperbrowser's SDK (not in its API docs) | 100 an hour, by the minute | 5 min |
| `lightpanda` | browser hours of the calendar month (`monthlyHours`, default: the free plan's) | the ledger's record of its sessions that have ended: its console shows the month's usage, but its token cannot read it. So the reading is whole while the account is used only through ledgers of this machine | 1 per browser hour, by the second | 0 |
| `kernel` | browser hours of the calendar month (`monthlyHours`, default: what the free plan's credits pay for), counted from the first of the month, 00:00 UTC | the uptime of the account's sessions this month, from `GET /browsers` (Kernel has no API for what its credits leave); a session refused with 403 (spending cap) throws `QuotaError` | 1 per browser hour, by the second | 5 min |
| `anchor` | credits | `GET /v1/billing`; a session refused with 402 throws `QuotaError` | 0.01 a session and 0.15 an hour, by the minute: above what its sessions' records bill (its docs: 0.05 an hour) | 5 min |
| `firecrawl` | credits; the plan's credits renew at the end of each billing period | [`GET /v2/team/credit-usage`](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage); a session refused with 402 throws `QuotaError` | 2 a minute, in 30 s steps, at least a minute | 5 min |

Every provider read from its API showed a session's cost within about a minute of its end (2026-11); `billingDelayMs` leaves room for more.

### Accounts

An account is one API key at a provider: the quota, the plan's limits and the bill are the key's. The keys of a provider are `apiKeys` in its settings, else those in the environment variable `<PROVIDER>_API_KEY` (`STEEL_API_KEY`, …; `apiKeyEnv(provider)` names it), else those in the file named by `<PROVIDER>_API_KEY_FILE`, separated by commas, spaces or line breaks; each key makes one account, in that order, and a key given twice makes one. A provider without a key has no account.

An account is known by its `id`, the provider's name and the first 6 hex digits of the key's SHA-256 (`steel#3f9a1c`): the same for the same key in every program and run, without telling the key. The ledger records sessions under it, so an account's usage is whole however many programs open sessions with its key.

### The ledger

One SQLite file per machine by default: `$ONEBROWSER_DB`, else `onebrowser/sessions.db` in `$XDG_DATA_HOME` (default `~/.local/share`), shared by every program on the machine under its own `client`. A session is recorded when its provider has created it (it is billed from then on), with its account and when it ends at the latest; closed when its provider has released it; and completed with the provider's own record by `syncUsage()`. A ledger made by an earlier onebrowser is brought up to date when opened; one made by a later onebrowser is refused. Sessions recorded by onebrowser 0.5 or earlier have no account: they become the provider's only account's when it has one here, and stay without one while it has several.

## Command line

The accounts and the ledger belong to the machine rather than to one program, so the `onebrowser` command reads them without a program of your own. It opens no sessions.

```sh
npx onebrowser quota                 # what each account has left, once its sessions not billed yet are paid for
npx onebrowser quota steel kernel#a81f2c   # only these: a provider's accounts, or one account by id
npx onebrowser usage --days 7        # the ledger's sessions per UTC day, account and client, today included
npx onebrowser usage --json --env-file .env
```

`usage` first fetches the providers' records of the sessions that have ended, as `syncUsage()` does. With `--json`, `quota` prints an array of what `readQuota()` returns, with the account: `{ account, provider, remaining, unbilled, unit, renewsAt }`, or `{ account, provider, error }` for a failed reading; `usage` prints `{ ledger, since, sessions, failed }`, where `sessions` is what `usage()` returns and `failed` what `syncUsage()` could not fetch. API keys are read as by the library, from the environment (`--env-file PATH` loads a file into it first). Exit status: 0 done, 1 a reading failed, 2 the command line is wrong.

## Adding a provider

Write `src/providers/<name>.js` and register it in `ADAPTERS` (`src/providers/index.js`, where the contract is):

- `defaults`: `price`, `billingDelayMs`, `minIdleTimeoutSec` if the provider takes no idle timeout as short as asked (see [Quota](#quota)), and its own settings (API base URLs, plan facts).
- `createSession(settings, apiKey, { proxyCountry, idleTimeoutSec, maxDurationMs }) → { id, cdpUrl, egress }`: maps the session options onto the provider's parameters; throws `QuotaError` when the provider refuses the session for the account's quota.
- `releaseSession(settings, apiKey, session)`.
- `sessionUsage(settings, apiKey, [{ id, openedAt, closedAt }]) → [{ id, durationMs, proxyBytes }]`: the record of those sessions that have ended: the provider's own, or the ledger's timing for a provider whose records its API key cannot read.
- `quota(settings, apiKey, history) → { remaining, unit, renewsAt? }`: for a provider that cannot report its usage, `history.endedSessionMsSince(ms)` is the session time of the ledger's sessions that the reading shows.

Requests go through `src/providers/http.js`: every status other than 2xx is an `HttpError` (with `status`), so an adapter handles only the statuses that mean something of their own, such as a quota refusal.

A program can also pass an adapter of its own in `adapters`, without changing onebrowser.

## Development

`npm test` runs offline: fake adapters and fetch, no network, no browser.

A release is a tag: bump `version` in `package.json`, carry it into `package-lock.json` with `npm install --package-lock-only`, add its entry to [CHANGELOG.md](CHANGELOG.md), then push the tag `vX.Y.Z`. The release workflow checks the tag against the version, runs the tests and publishes to npm with trusted publishing (no token stored).

## License

[MIT](LICENSE)
