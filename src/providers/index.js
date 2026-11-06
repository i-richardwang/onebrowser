import * as hyperbrowser from './hyperbrowser.js';
import * as kernel from './kernel.js';
import * as lightpanda from './lightpanda.js';
import * as steel from './steel.js';
import * as tinyfish from './tinyfish.js';

/**
 * Provider adapters, by provider name: the only provider-specific code. Each exports:
 *   defaults                 its settings (API base URLs, plan facts such as monthlyHours); OneBrowser's
 *                            `providers` option overrides them per provider. The API key is not among them:
 *                            each function gets it as its own argument
 *   createSession(settings, apiKey, options) → { id, cdpUrl, egress }
 *       options: { proxyCountry, idleTimeoutSec, maxDurationMs } (OneBrowser.openSession), mapped onto the
 *       provider's own parameters. Throws on failure; QuotaError (errors.js) when the provider refuses the
 *       session because the account's quota is used up
 *   releaseSession(settings, apiKey, session)   ends the session; throws on failure
 *   sessionUsage(settings, apiKey, [{ id, openedAt, closedAt }]) → [{ id, durationMs, proxyBytes }]
 *       the record of those sessions that have ended: the provider's own, or, for a provider whose records the
 *       API key cannot read, the ledger's timing (closedAt is empty for a session no process closed); throws on
 *       failure
 *   quota(settings, apiKey, history) → { remaining, unit, renewsAt? }
 *       what is left of the account's quota, in the provider's own unit (USD, credits, hours, …), and when it
 *       renews if it does by itself (ms); history: the ledger's record of the provider's sessions
 *       (Ledger.history). Throws when it cannot be read
 *
 * Their requests go through http.js, which turns every status other than 2xx into an HttpError: an adapter
 * handles only the statuses that mean something of their own.
 */
export const ADAPTERS = { tinyfish, steel, hyperbrowser, lightpanda, kernel };

const CONTRACT = ['createSession', 'releaseSession', 'sessionUsage', 'quota'];

/** Throws unless `adapter` has the whole contract */
export function checkAdapter(name, adapter) {
  const missing = CONTRACT.filter((f) => typeof adapter?.[f] !== 'function');
  if (missing.length) throw new Error(`provider ${name}: its adapter lacks ${missing.join(', ')}`);
}
