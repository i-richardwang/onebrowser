import { json } from './http.js';

/**
 * Steel.dev (https://docs.steel.dev). Without a proxy a session uses one of Steel's US datacenter IPs,
 * a different one per session; proxyCountry selects a Steel residential proxy. Steel ends a session after
 * idleTimeoutSec without CDP commands (inactivityTimeout), and after maxDurationMs in any case (timeout).
 */
export const defaults = {
  apiBase: 'https://api.steel.dev/v1',
  connectBase: 'wss://connect.steel.dev',
  includedQuota: 30, // USD: the Launch plan's one-time credits, valid for 90 days (steel.dev/pricing, 2026-11)
  price: { perHour: 0.1, stepSec: 60 }, // USD on the Launch plan, by the minute rounded up
  billingDelayMs: 5 * 60_000, // seen within 11 s
};

const headers = (apiKey) => ({ 'steel-api-key': apiKey });

export async function createSession(settings, apiKey, { proxyCountry, idleTimeoutSec, maxDurationMs }) {
  const body = { timeout: maxDurationMs, inactivityTimeout: idleTimeoutSec * 1000, optimizeBandwidth: true };
  if (proxyCountry) body.useProxy = { geolocation: { country: proxyCountry } };
  const s = await json(`${settings.apiBase}/sessions`, { method: 'POST', headers: headers(apiKey), body, timeoutMs: 90_000 });
  return {
    id: s.id,
    cdpUrl: `${settings.connectBase}?apiKey=${apiKey}&sessionId=${s.id}`,
    egress: proxyCountry ? `proxy ${proxyCountry}` : 'datacenter IP',
  };
}

export async function releaseSession(settings, apiKey, session) {
  await json(`${settings.apiBase}/sessions/${session.id}/release`, { method: 'POST', headers: headers(apiKey), body: {} });
}

/** The account's balance in USD, as Steel's dashboard reads it (the endpoint is not in Steel's API docs) */
export async function quota(settings, apiKey) {
  const { balanceCents } = await json(`${settings.apiBase}/credits/balance`, { headers: headers(apiKey) });
  return { remaining: balanceCents / 100, unit: 'USD', total: settings.includedQuota };
}

/** Usage of the sessions among `sessions` that have ended, fetched by id: the session list cannot be filtered by time */
export async function sessionUsage(settings, apiKey, sessions) {
  const usage = [];
  for (const { id } of sessions) {
    const s = await json(`${settings.apiBase}/sessions/${id}`, { headers: headers(apiKey) });
    if (s.status !== 'live') usage.push({ id, durationMs: s.duration, proxyBytes: s.proxyBytesUsed });
  }
  return usage;
}
