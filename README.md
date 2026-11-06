# onebrowser

One interface to remote browser providers. A session is asked for by provider name, the way an LLM request names its model. Every session is recorded in a ledger, which each provider account's usage and quota are read from.

```sh
npm install onebrowser
```

```js
import { OneBrowser, QuotaError } from 'onebrowser';

const browsers = new OneBrowser({ client: 'my-crawler' });
const session = await browsers.openSession({ provider: 'steel', proxyCountry: 'DE' });
const page = await session.newPage(); // Playwright; or any CDP client on session.cdpUrl
await page.goto('https://example.com');
await session.close();

await browsers.quota('steel'); // { remaining, unit: 'USD', renewsAt: null }
await browsers.syncUsage(); // fetches the providers' records of ended sessions into the ledger
browsers.usage({ since: Date.parse('2026-11-01') }); // [{ day, provider, client, sessions, minutes, … }]
await browsers.close();
```

**What it does not do**: choose a provider, cap the sessions held at once, spread sessions over providers, or stop using a provider whose quota runs low. Those are policy, and belong to the program using it. onebrowser opens the session it is asked for, and tells the program what it needs to decide: the quota, and `QuotaError` when a provider refuses a session for the account's quota.

Built in: [Steel](https://steel.dev), [TinyFish](https://tinyfish.ai), [Hyperbrowser](https://hyperbrowser.ai), [Lightpanda](https://lightpanda.io), [Kernel](https://www.kernel.sh) and [Anchor Browser](https://anchorbrowser.io); a program can add its own (see [Adding a provider](#adding-a-provider)). Node 22.13 or later.

## Interface

`new OneBrowser({ client, ledgerPath, providers, adapters })`

| Option | |
|---|---|
| `client` | The program using it, recorded with each session; required |
| `ledgerPath` | SQLite file of the ledger (default below; `':memory:'` for tests). Opened when first needed |
| `providers` | Settings per provider name, on top of its adapter's `defaults`: `apiKey`, and the adapter's own settings (API base URLs, plan facts such as `monthlyHours`) |
| `adapters` | Further adapters by provider name, or replacements of built-in ones |

| Method | |
|---|---|
| `providers` | Names of the providers it can open sessions with |
| `checkReady(provider)` | Throws when the provider is unknown or has no API key |
| `openSession({ provider, proxyCountry, idleTimeoutSec, maxDurationMs })` | A new session, recorded in the ledger once the provider has created it. Throws `QuotaError` when the provider refuses it for the account's quota |
| `quota(provider)` | `{ remaining, unit, renewsAt }` in the provider's own unit; `renewsAt` (ms) when it renews by itself, `null` when only a top-up renews it. Throws when it cannot be read |
| `syncUsage()` | Stores the providers' records (duration, proxy traffic) of the ended sessions that have none yet: `{ reported, failed: [{ provider, error }] }`. Sessions of a provider it has no adapter for (another program's own) are left to the programs that have one |
| `usage({ since })` | Sessions opened since `since` (ms) per UTC day, provider and client: `sessions`, `minutes` (the provider's record, else the open-to-close timing), `untimed`, `unsynced`, `proxyBytes` |
| `close()` | Closes the sessions still open and the ledger |

A session (`openSession`) has `id`, `provider`, `egress`, `cdpUrl` (it may carry the API key: never log it), `openedAt`, `closedAt`, and:

- `connect()`: Playwright's `Browser` over its CDP connection, made once. A keep-alive command every 15 s keeps the provider's idle timeout from ending a session that is in use.
- `newPage()`: always a new page in the default context: the page a remote browser starts with is not always one that can be navigated.
- `close()`: disconnects and releases it; only the first call does. The ledger records it closed in any case. Throws when the provider could not release it: the provider then ends it by itself.

A session and a `OneBrowser` are async-disposable: `await using session = await browsers.openSession({ provider: 'steel' })` closes the session at the end of its block (Node 24 or later; on Node 22 call `close()`).

### Session options: one meaning on every provider

| Option | Default | Meaning |
|---|---|---|
| `proxyCountry` | `null` | A country code: the provider's proxy in that country. `null`: its default egress |
| `idleTimeoutSec` | 60 | A session whose client is gone (its process was killed) ends this long after at the latest. At least 30 (twice the keep-alive interval) |
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

### Quota

| Provider | Quota, unit | Read from |
|---|---|---|
| `steel` | balance, USD | `GET /v1/credits/balance`, the endpoint of Steel's dashboard (not in its API docs) |
| `tinyfish` | wallet, USD | [`GET /v1/wallet`](https://docs.tinyfish.ai/wallet); a session refused with 402 throws `QuotaError` |
| `hyperbrowser` | credits | `GET /api/team/credit-info`, the endpoint of Hyperbrowser's SDK (not in its API docs) |
| `lightpanda` | browser hours of the calendar month (`monthlyHours`, default: the free plan's) | the ledger's record of its sessions: its console shows the month's usage, but its token cannot read it. So the reading is whole while the account is used only through ledgers of this machine |
| `kernel` | browser hours of the calendar month (`monthlyHours`, default: what the free plan's credits pay for) | the uptime of the account's sessions this month, from `GET /browsers`; a session refused with 403 (spending cap) throws `QuotaError` |
| `anchor` | credits | `GET /v1/billing`; a session refused with 402 throws `QuotaError` |

### API keys

`apiKey` in the provider's settings, else the environment variable `<PROVIDER>_API_KEY` (`STEEL_API_KEY`, …; `apiKeyEnv(provider)` names it), else the file named by `<PROVIDER>_API_KEY_FILE`. An empty value counts as unset.

### The ledger

One SQLite file per machine by default: `$ONEBROWSER_DB`, else `onebrowser/sessions.db` in `$XDG_DATA_HOME` (default `~/.local/share`). Every program that uses onebrowser on the machine shares it, each under its own `client`, so the record of a provider account's sessions is whole whichever program opened them; several processes may write to it at once. Each session is recorded when its provider has created it (it is billed from then on, also when connecting fails afterwards), closed when released, and completed with the provider's own record by `syncUsage()` once it has ended.

## Command line

The provider accounts and the ledger belong to the machine rather than to one program, so the `onebrowser` command reads them without a program of your own. It opens no sessions.

```sh
npx onebrowser quota                 # what each provider account with an API key has left
npx onebrowser quota steel kernel    # only these; one without an API key is a failed reading
npx onebrowser usage --days 7        # the ledger's sessions per UTC day, provider and client, today included
npx onebrowser usage --json --env-file .env
```

`usage` first fetches the providers' records of the sessions that have ended, as `syncUsage()` does. With `--json`, `quota` prints an array of what `quota()` returns, with the provider: `{ provider, remaining, unit, renewsAt }`, or `{ provider, error }` for a failed reading; `usage` prints `{ ledger, since, sessions, failed }`, where `sessions` is what `usage()` returns and `failed` what `syncUsage()` could not fetch. API keys are read as by the library, from the environment (`--env-file PATH` loads a file into it first). Exit status: 0 done, 1 a reading failed, 2 the command line is wrong.

## Adding a provider

Write `src/providers/<name>.js` and register it in `ADAPTERS` (`src/providers/index.js`, where the contract is):

- `defaults`: its settings (API base URLs, plan facts).
- `createSession(settings, apiKey, { proxyCountry, idleTimeoutSec, maxDurationMs }) → { id, cdpUrl, egress }`: maps the session options onto the provider's parameters; throws `QuotaError` when the provider refuses the session for the account's quota.
- `releaseSession(settings, apiKey, session)`.
- `sessionUsage(settings, apiKey, [{ id, openedAt, closedAt }]) → [{ id, durationMs, proxyBytes }]`: the record of those sessions that have ended: the provider's own, or the ledger's timing for a provider whose records its API key cannot read.
- `quota(settings, apiKey, history) → { remaining, unit, renewsAt? }`: `history.sessionMsSince(ms)` is the ledger's record of the provider's sessions, for a provider that cannot report its own usage.

Requests go through `src/providers/http.js`: every status other than 2xx is an `HttpError` (with `status`), so an adapter handles only the statuses that mean something of their own, such as a quota refusal.

A program can also pass an adapter of its own in `adapters`, without changing onebrowser.

## Development

`npm test` runs offline: fake adapters and fetch, no network, no browser.

A release is a tag: bump `version` in `package.json` and add its entry to [CHANGELOG.md](CHANGELOG.md), then push the tag `vX.Y.Z`. The release workflow checks the tag against the version, runs the tests and publishes to npm with trusted publishing (no token stored).

## License

[MIT](LICENSE)
