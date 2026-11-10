import { QuotaError } from '../errors.js';
import { json } from './http.js';

const TTL_SEC = { min: 30, max: 3600 }; // what Firecrawl takes for ttl; activityTtl has the same maximum

/**
 * Firecrawl's Browser Sandbox (https://docs.firecrawl.dev/features/browser). A session browses from a US ISP IP
 * by default, a different one per session; proxyCountry selects Firecrawl's location in that country (location).
 * Closing the CDP connection does not end a session: Firecrawl ends it idleTimeoutSec after its last CDP command
 * (activityTtl), and maxDurationMs after it was created in any case (ttl), both in whole seconds and at most 1 h.
 * activityTtl is rounded down and ttl cut to 1 h, so that neither ends a session later than asked; ttl is rounded
 * up, to at least 30 s, as this process closes the session at maxDurationMs. Its live view stream and its ad
 * blocking, both on by default, are turned off. Sessions are paid from the account's credits; with too few,
 * creating one answers 402.
 */
export const defaults = {
  apiBase: 'https://api.firecrawl.dev/v2',
  price: { perHour: 120, stepSec: 30, minSec: 60 }, // credits: 2 a minute, in whole credits rounded up, at least 1 minute
  billingDelayMs: 5 * 60_000, // seen within 10 s
  maxSessionMs: TTL_SEC.max * 1000, // ttl's maximum
};

const headers = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });

export async function createSession(settings, apiKey, { proxyCountry, idleTimeoutSec, maxDurationMs }) {
  const body = {
    ttl: Math.min(TTL_SEC.max, Math.max(TTL_SEC.min, Math.ceil(maxDurationMs / 1000))),
    activityTtl: Math.min(TTL_SEC.max, Math.floor(idleTimeoutSec)),
    streamWebView: false,
    blockAds: false,
  };
  if (proxyCountry) body.location = { country: proxyCountry };
  let s;
  try {
    s = await json(`${settings.apiBase}/interact`, { method: 'POST', headers: headers(apiKey), body, timeoutMs: 90_000 });
  } catch (e) {
    if (e.status === 402) throw new QuotaError(`credits used up: ${e.text}`);
    throw e;
  }
  return { id: s.id, cdpUrl: s.cdpUrl, egress: `proxy ${proxyCountry ?? 'US'}` };
}

/** Succeeds also for a session that has already ended */
export async function releaseSession(settings, apiKey, session) {
  await json(`${settings.apiBase}/interact/${session.id}`, { method: 'DELETE', headers: headers(apiKey) });
}

/**
 * The team's credits left, coupon credits included; the plan's credits (planCredits, without coupon or
 * pay-as-you-go ones) renew at the end of its billing period
 */
export async function quota(settings, apiKey) {
  const { data } = await json(`${settings.apiBase}/team/credit-usage`, { headers: headers(apiKey) });
  return { remaining: data.remainingCredits, unit: 'credits', renewsAt: data.billingPeriodEnd ? Date.parse(data.billingPeriodEnd) : null, total: data.planCredits };
}

/** Usage of the sessions among `sessions` that have ended, fetched by id: the session list has no durations (GET /interact/{id} is not in Firecrawl's API docs) */
export async function sessionUsage(settings, apiKey, sessions) {
  const usage = [];
  for (const { id } of sessions) {
    const s = await json(`${settings.apiBase}/interact/${id}`, { headers: headers(apiKey) });
    if (s.status !== 'running') usage.push({ id, durationMs: s.sessionDurationMs, proxyBytes: null });
  }
  return usage;
}
