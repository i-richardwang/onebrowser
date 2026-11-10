import { QuotaError } from '../errors.js';
import { json } from './http.js';

const TIMEOUT_SEC = { min: 60, max: 21_600 }; // what Browserbase takes for timeout

/**
 * Browserbase (https://docs.browserbase.com). Without a proxy a session browses from Browserbase's US datacenter
 * IPs, a pool its sessions share: the IP can change within a session. proxyCountry selects Browserbase's
 * residential proxy in that country (paid plans only). It has no idle timeout: a session ends when its CDP
 * connection closes, which meets any idleTimeoutSec, and after maxDurationMs in any case (timeout), in whole
 * seconds rounded up, from 1 min to 6 h; one that no client connects to runs until then. Its recording and
 * logging of sessions, both on by default, are turned off. A session the plan does not pay for, such as one with
 * a proxy on the free plan, is refused with 402.
 */
export const defaults = {
  apiBase: 'https://api.browserbase.com/v1',
  monthlyHours: 1, // browser hours a month on the free plan (browserbase.com/pricing, 2026-11)
  price: { perHour: 1, stepSec: 60, minSec: 60 }, // the quota is in browser hours; billed to the nearest minute, at least one
  billingDelayMs: 5 * 60_000, // seen within 10 s
  maxSessionMs: TIMEOUT_SEC.max * 1000, // timeout's maximum
};

const headers = (apiKey) => ({ 'X-BB-API-Key': apiKey });

export async function createSession(settings, apiKey, { proxyCountry, maxDurationMs }) {
  const body = {
    timeout: Math.min(TIMEOUT_SEC.max, Math.max(TIMEOUT_SEC.min, Math.ceil(maxDurationMs / 1000))),
    browserSettings: { recordSession: false, logSession: false },
  };
  if (proxyCountry) body.proxies = [{ type: 'browserbase', geolocation: { country: proxyCountry } }];
  let s;
  try {
    s = await json(`${settings.apiBase}/sessions`, { method: 'POST', headers: headers(apiKey), body, timeoutMs: 90_000 });
  } catch (e) {
    if (e.status === 402) throw new QuotaError(`not paid for by the plan: ${e.text}`);
    throw e;
  }
  return { id: s.id, cdpUrl: s.connectUrl, egress: proxyCountry ? `proxy ${proxyCountry}` : 'datacenter IP' };
}

/** Succeeds also for a session that has already ended (its CDP connection closed first) */
export async function releaseSession(settings, apiKey, session) {
  await json(`${settings.apiBase}/sessions/${session.id}`, { method: 'POST', headers: headers(apiKey), body: { status: 'REQUEST_RELEASE' } });
}

/**
 * Browser hours left of the plan's monthlyHours, after the browser minutes Browserbase counts for the projects
 * of the key, which include sessions opened by any program. Its API says neither what the plan includes nor when
 * its hours renew.
 */
export async function quota(settings, apiKey) {
  const projects = await json(`${settings.apiBase}/projects`, { headers: headers(apiKey) });
  let usedMinutes = 0;
  for (const { id } of projects) {
    const { browserMinutes } = await json(`${settings.apiBase}/projects/${id}/usage`, { headers: headers(apiKey) });
    usedMinutes += browserMinutes;
  }
  return { remaining: settings.monthlyHours - usedMinutes / 60, unit: 'hours', total: settings.monthlyHours };
}

/** Usage of the sessions among `sessions` that have ended (have an endedAt), fetched by id */
export async function sessionUsage(settings, apiKey, sessions) {
  const usage = [];
  for (const { id } of sessions) {
    const s = await json(`${settings.apiBase}/sessions/${id}`, { headers: headers(apiKey) });
    if (s.endedAt) usage.push({ id, durationMs: Date.parse(s.endedAt) - Date.parse(s.startedAt), proxyBytes: s.proxyBytes });
  }
  return usage;
}
