import { fullPrice } from '../cost.js';
import * as anchor from './anchor.js';
import * as firecrawl from './firecrawl.js';
import * as hyperbrowser from './hyperbrowser.js';
import * as kernel from './kernel.js';
import * as lightpanda from './lightpanda.js';
import * as steel from './steel.js';
import * as tinyfish from './tinyfish.js';

/**
 * Provider adapters by name: the only provider-specific code. Each exports:
 *   defaults   its settings, which OneBrowser's `providers` option overrides:
 *     price               what its sessions cost, in the unit of its quota (cost.js)
 *     billingDelayMs      how long after a session has ended its quota reading shows it, at the latest
 *     minIdleTimeoutSec   the shortest idle timeout it takes (default 0)
 *     and its own         API base URLs, plan facts such as monthlyHours
 *   createSession(settings, apiKey, { proxyCountry, idleTimeoutSec, maxDurationMs }) → { id, cdpUrl, egress }
 *       throws QuotaError (errors.js) when the provider refuses the session for the account's quota
 *   releaseSession(settings, apiKey, session)
 *   sessionUsage(settings, apiKey, [{ id, openedAt, closedAt }]) → [{ id, durationMs, proxyBytes }]
 *       the provider's record of those that have ended, or the ledger's timing where its API key cannot read one
 *   quota(settings, apiKey, history) → { remaining, unit, renewsAt? }
 *       what the account has left in the provider's unit, and when it renews by itself (ms); history: the
 *       ledger's sessions that the reading shows (Ledger.history), for a provider that cannot count its usage
 * Every function throws when it fails. Requests go through http.js, which throws HttpError for a status other
 * than 2xx.
 */
export const ADAPTERS = { tinyfish, steel, hyperbrowser, lightpanda, kernel, anchor, firecrawl };

const CONTRACT = ['createSession', 'releaseSession', 'sessionUsage', 'quota'];

/** Throws unless `adapter` has the whole contract */
export function checkAdapter(name, adapter) {
  const missing = CONTRACT.filter((f) => typeof adapter?.[f] !== 'function');
  if (missing.length) throw new Error(`provider ${name}: its adapter lacks ${missing.join(', ')}`);
}

/** An adapter's settings with the defaults of those every adapter has; throws when one of them is missing or wrong */
export function fullSettings(name, { price, billingDelayMs, minIdleTimeoutSec = 0, ...own }) {
  const atLeast0 = (x) => Number.isFinite(x) && x >= 0;
  try {
    const full = fullPrice(price);
    if (!atLeast0(billingDelayMs)) throw new Error(`billingDelayMs must be a number ≥ 0, not ${billingDelayMs}`);
    if (!atLeast0(minIdleTimeoutSec)) throw new Error(`minIdleTimeoutSec must be a number ≥ 0, not ${minIdleTimeoutSec}`);
    return { ...own, price: full, billingDelayMs, minIdleTimeoutSec };
  } catch (e) {
    throw new Error(`provider ${name}: ${e.message}`);
  }
}
