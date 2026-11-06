import { json } from './http.js';

/**
 * Hyperbrowser (https://hyperbrowser.ai/docs). Without a proxy a session uses one of Hyperbrowser's US
 * datacenter IPs, drawn from a pool: consecutive sessions usually differ, but an IP can come back.
 * proxyCountry selects its residential proxy (paid plans only). It has no idle timeout: a session ends when its
 * CDP connection closes, which meets any idleTimeoutSec, and after maxDurationMs in any case, which Hyperbrowser
 * takes in whole minutes.
 */
export const defaults = {
  apiBase: 'https://api.hyperbrowser.ai/api',
  price: { perHour: 100, stepSec: 60 }, // credits; its rounding is not documented
  billingDelayMs: 5 * 60_000, // billed while the session runs, seen within 10 s of its end
};

const headers = (apiKey) => ({ 'x-api-key': apiKey });

export async function createSession(settings, apiKey, { proxyCountry, maxDurationMs }) {
  const body = { timeoutMinutes: Math.ceil(maxDurationMs / 60_000) };
  if (proxyCountry) Object.assign(body, { useProxy: true, proxyCountry });
  const s = await json(`${settings.apiBase}/session`, { method: 'POST', headers: headers(apiKey), body, timeoutMs: 90_000 });
  return { id: s.id, cdpUrl: s.wsEndpoint, egress: proxyCountry ? `proxy ${proxyCountry}` : 'datacenter IP' };
}

/** Succeeds also for a session that has already ended (its CDP connection closed first) */
export async function releaseSession(settings, apiKey, session) {
  await json(`${settings.apiBase}/session/${session.id}/stop`, { method: 'PUT', headers: headers(apiKey) });
}

/** The team's credits left (the endpoint of Hyperbrowser's SDK; it is not in Hyperbrowser's API docs) */
export async function quota(settings, apiKey) {
  const { remaining } = await json(`${settings.apiBase}/team/credit-info`, { headers: headers(apiKey) });
  return { remaining, unit: 'credits' };
}

/** Usage of the sessions among `sessions` that have ended (have an endTime), fetched by id. Times are epoch ms, as numbers or strings */
export async function sessionUsage(settings, apiKey, sessions) {
  const usage = [];
  for (const { id } of sessions) {
    const s = await json(`${settings.apiBase}/session/${id}`, { headers: headers(apiKey) });
    if (s.endTime) usage.push({ id, durationMs: Number(s.endTime) - Number(s.startTime), proxyBytes: Number(s.proxyDataConsumed) });
  }
  return usage;
}
