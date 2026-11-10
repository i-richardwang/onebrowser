import { randomUUID } from 'node:crypto';
import { connectionUsage } from './connection.js';
import { json } from './http.js';

/**
 * Browserless (https://docs.browserless.io), the browsers of its cloud over CDP. A session is one CDP connection
 * to connectBase, a region's host with the path of a browser route if not its default one (`/stealth`: its
 * stealth browser); Browserless's session API, which keeps a browser's data between connections, is not used. A
 * session ends when its connection closes, which meets any idleTimeoutSec, and after maxDurationMs in any case
 * (timeout), or after the plan's longest session (maxSessionMs) if that is shorter: Browserless refuses a longer
 * timeout. Without a proxy a session uses the IP of the machine it runs on, a datacenter IP of Browserless's
 * pool, a different one per session; proxyCountry selects its residential proxy in that country, with one IP for
 * the session (proxySticky). An account out of units, or at its plan's concurrent browsers, is refused when the
 * session connects (401, 429), not when it is created.
 */
export const defaults = {
  connectBase: 'wss://production-sfo.browserless.io',
  usageUrl: 'https://api.browserless.io/v1/account/usage',
  price: { perHour: 120, stepSec: 30 }, // units: one for every 30 s of a connection, rounded up
  billingDelayMs: 5 * 60_000, // seen within 10 s
  maxSessionMs: 2 * 60_000, // the free plan's longest session (browserless.io/pricing, 2026-11)
};

export async function createSession(settings, apiKey, { proxyCountry, maxDurationMs }) {
  const query = new URLSearchParams({ token: apiKey, timeout: Math.min(Math.ceil(maxDurationMs), settings.maxSessionMs) });
  if (proxyCountry) {
    query.set('proxy', 'residential');
    query.set('proxyCountry', proxyCountry.toLowerCase());
    query.set('proxySticky', 'true');
  }
  return { id: randomUUID(), cdpUrl: `${settings.connectBase}?${query}`, egress: proxyCountry ? `proxy ${proxyCountry}` : 'datacenter IP' };
}

/** Closing the CDP connection has ended the session */
export async function releaseSession() {}

/** The units left of those the plan includes, which renew at the end of the billing period (https://docs.browserless.io/overview/unit-consumption) */
export async function quota(settings, apiKey) {
  const { units, billingPeriod } = await json(`${settings.usageUrl}?token=${apiKey}`);
  return { remaining: units.remaining, unit: 'units', renewsAt: Date.parse(billingPeriod.end), total: units.included };
}

/** Browserless shows its records of sessions only in its dashboard, so a session's record is the ledger's timing (connection.js) */
export async function sessionUsage(settings, apiKey, sessions) {
  return connectionUsage(sessions, settings.maxSessionMs);
}
