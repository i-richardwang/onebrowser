import { QuotaError } from '../errors.js';
import { json, request } from './http.js';
import { utcMonth } from './month.js';

/**
 * Kernel (https://www.kernel.sh/docs). Sessions are headless: Kernel's default is a headful browser, billed at
 * a higher rate. A session uses the IP of the Kernel machine it runs on, a different one per session. Kernel's
 * proxies are resources of their own, on paid plans, so proxyCountry is not supported. Closing the CDP
 * connection does not end a session: Kernel keeps it in standby, unbilled but counting toward the plan's
 * concurrent browsers, and deletes it idleTimeoutSec after its CDP client left (timeout_seconds), unless it is
 * released before. It takes no limit on a session's length. An account at its spending cap is refused new
 * sessions with 403.
 */
export const defaults = {
  apiBase: 'https://api.onkernel.com',
  monthlyHours: 80, // headless browser hours a month that the free plan's credits pay for, rounded down
  price: { perHour: 1 }, // the quota is in headless browser hours, billed by the second
  billingDelayMs: 5 * 60_000, // seen within 10 s
};

const headers = (apiKey) => ({ Authorization: `Bearer ${apiKey}` });

export async function createSession(settings, apiKey, { proxyCountry, idleTimeoutSec }) {
  if (proxyCountry) throw new Error('proxyCountry is not supported by the kernel provider');
  let s;
  try {
    s = await json(`${settings.apiBase}/browsers`, { method: 'POST', headers: headers(apiKey), body: { headless: true, timeout_seconds: idleTimeoutSec }, timeoutMs: 90_000 });
  } catch (e) {
    if (e.status === 403) throw new QuotaError(`spending cap reached: ${e.text}`);
    throw e;
  }
  return { id: s.session_id, cdpUrl: s.cdp_ws_url, egress: 'datacenter IP' };
}

/** 404: Kernel has deleted the session already */
export async function releaseSession(settings, apiKey, session) {
  try {
    await json(`${settings.apiBase}/browsers/${session.id}`, { method: 'DELETE', headers: headers(apiKey) });
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}

/**
 * Browser hours left of the month's monthlyHours, after the uptime of every session of the account this month:
 * Kernel's own records, which include sessions opened by any program. The sessions are listed newest first, so
 * the listing stops at a page that holds none of this month. Kernel counts usage from the first of each month,
 * 00:00 UTC (https://www.kernel.sh/docs/info/spending-caps), and has no API that reads what its credits leave.
 */
export async function quota(settings, apiKey) {
  const month = utcMonth();
  let usedMs = 0;
  for (let offset = 0; ; offset += 100) {
    const r = await request(`${settings.apiBase}/browsers?status=all&limit=100&offset=${offset}`, { headers: headers(apiKey) });
    const ofMonth = r.body.filter((s) => Date.parse(s.created_at) >= month.start);
    usedMs += ofMonth.reduce((ms, s) => ms + (s.usage?.uptime_ms ?? 0), 0);
    if (!ofMonth.length || r.headers.get('x-has-more') !== 'true') break;
  }
  return { remaining: settings.monthlyHours - usedMs / 3_600_000, unit: 'hours', renewsAt: month.next };
}

/** Usage of the sessions among `sessions` that Kernel has deleted and finished billing, fetched by id */
export async function sessionUsage(settings, apiKey, sessions) {
  const usage = [];
  for (const { id } of sessions) {
    const s = await json(`${settings.apiBase}/browsers/${id}?include_deleted=true`, { headers: headers(apiKey) });
    if (s.usage_status === 'ready') usage.push({ id, durationMs: s.usage.uptime_ms, proxyBytes: null });
  }
  return usage;
}
