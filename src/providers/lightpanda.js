import { randomUUID } from 'node:crypto';
import { connectionUsage } from './connection.js';
import { utcMonth } from './month.js';

/**
 * Lightpanda Cloud (https://lightpanda.io/docs). It has no session API: a session is one CDP connection to
 * connectBase, and it ends when that connection closes, which meets any idleTimeoutSec, and at the latest after
 * maxSessionMs, when Lightpanda closes it. Its `datacenter` proxy gives each session one IP from a shared pool, a
 * different one per session; proxyCountry asks the pool for IPs in that country. Its engine is Lightpanda's own,
 * not Chromium.
 */
export const defaults = {
  connectBase: 'wss://euwest.cloud.lightpanda.io/ws',
  monthlyHours: 10, // browser hours a month on the free plan
  price: { perHour: 1 }, // the quota is in browser hours, billed by the second
  billingDelayMs: 0, // the quota is the ledger's record
  maxSessionMs: 15 * 60_000, // Lightpanda closes a CDP connection after this long
};

export async function createSession(settings, apiKey, { proxyCountry }) {
  const query = new URLSearchParams({ token: apiKey, proxy: 'datacenter' });
  if (proxyCountry) query.set('country', proxyCountry.toLowerCase());
  return {
    id: randomUUID(),
    cdpUrl: `${settings.connectBase}?${query}`,
    egress: proxyCountry ? `datacenter IP, ${proxyCountry}` : 'datacenter IP',
  };
}

/** Closing the CDP connection has ended the session */
export async function releaseSession() {}

/**
 * Browser hours left of the month's monthlyHours. Lightpanda's console shows the month's usage, but the token
 * cannot read it: the month's usage is the ledger's record of the sessions that have ended (history), which is
 * all of it while the account is used through ledgers of this machine only. The hours are assumed to renew with
 * each calendar month (UTC).
 */
export async function quota(settings, apiKey, history) {
  const month = utcMonth();
  const usedHours = history.endedSessionMsSince(month.start) / 3_600_000;
  return { remaining: settings.monthlyHours - usedHours, unit: 'hours', renewsAt: month.next, total: settings.monthlyHours };
}

/** Lightpanda shows its records of sessions only in its console, which the token cannot read, so a session's record is the ledger's timing (connection.js) */
export async function sessionUsage(settings, apiKey, sessions) {
  return connectionUsage(sessions, settings.maxSessionMs);
}
