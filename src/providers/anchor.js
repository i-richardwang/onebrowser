import { QuotaError } from '../errors.js';
import { json } from './http.js';

/**
 * Anchor Browser (https://docs.anchorbrowser.io). Without a proxy a session uses the IP of the machine it runs on,
 * a different US datacenter IP per session; proxyCountry selects Anchor's residential proxy in that country.
 * Closing the CDP connection does not end a session: Anchor ends it idleTimeoutSec after its last connection
 * left (idle_timeout), and after maxDurationMs in any case (max_duration), both in whole minutes. idle_timeout is
 * rounded down, to at least 1: its timer runs only once the client is gone, so ending sooner cuts off no session
 * in use; max_duration is rounded up, as this process closes the session at maxDurationMs. Recording, on by
 * default, is turned off. Sessions are paid from the account's credits; with too few, creating one answers 402.
 */
export const defaults = {
  apiBase: 'https://api.anchorbrowser.io/v1',
  // credits ($1 each): $0.01 a browser and, by its docs, $0.05 an hour by the minute; the sessions' own records
  // (credits_used) bill more, about $0.06 an hour and a step of $0.003 in the second minute, which this covers
  price: { perSession: 0.01, perHour: 0.15, stepSec: 60 },
  billingDelayMs: 5 * 60_000, // seen within 10 s
  minIdleTimeoutSec: 60, // idle_timeout is in whole minutes, at least 1
};

const headers = (apiKey) => ({ 'anchor-api-key': apiKey });

export async function createSession(settings, apiKey, { proxyCountry, idleTimeoutSec, maxDurationMs }) {
  const session = {
    recording: { active: false },
    timeout: { idle_timeout: Math.max(1, Math.floor(idleTimeoutSec / 60)), max_duration: Math.ceil(maxDurationMs / 60_000) },
  };
  if (proxyCountry) session.proxy = { active: true, type: 'anchor_proxy', country_code: proxyCountry.toLowerCase() };
  let s;
  try {
    s = (await json(`${settings.apiBase}/sessions`, { method: 'POST', headers: headers(apiKey), body: { session }, timeoutMs: 90_000 })).data;
  } catch (e) {
    if (e.status === 402) throw new QuotaError(`credits used up: ${e.text}`);
    throw e;
  }
  return { id: s.id, cdpUrl: s.cdp_url, egress: proxyCountry ? `proxy ${proxyCountry}` : 'datacenter IP' };
}

/** Succeeds also for a session that has already ended */
export async function releaseSession(settings, apiKey, session) {
  await json(`${settings.apiBase}/sessions/${session.id}`, { method: 'DELETE', headers: headers(apiKey) });
}

/** The account's credits left, gifted ones included. Unlike the other endpoints, /billing answers without a `data` wrapper */
export async function quota(settings, apiKey) {
  const { credits } = await json(`${settings.apiBase}/billing`, { headers: headers(apiKey) });
  return { remaining: credits, unit: 'credits' };
}

/** Usage of the sessions among `sessions` that have ended, fetched by id: duration in whole seconds */
export async function sessionUsage(settings, apiKey, sessions) {
  const usage = [];
  for (const { id } of sessions) {
    const { data: s } = await json(`${settings.apiBase}/sessions/${id}`, { headers: headers(apiKey) });
    if (s.status !== 'running') usage.push({ id, durationMs: s.duration * 1000, proxyBytes: s.proxy_bytes });
  }
  return usage;
}
