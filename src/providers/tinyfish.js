import { QuotaError } from '../errors.js';
import { json } from './http.js';

/**
 * TinyFish Browser API (https://docs.tinyfish.ai/browser-api): residential proxy per session, country chosen by
 * proxy_config.country_code. TinyFish ends a session after idleTimeoutSec without CDP commands (timeout_seconds);
 * it takes no limit on a session's length. Sessions are paid from the account's wallet; with too little in it,
 * creating one answers 402.
 */
export const defaults = {
  apiBase: 'https://api.browser.tinyfish.ai',
  walletUrl: 'https://agent.tinyfish.ai/v1/wallet',
};

const headers = (apiKey) => ({ 'X-API-Key': apiKey });

export async function createSession(settings, apiKey, { proxyCountry, idleTimeoutSec }) {
  const body = { timeout_seconds: idleTimeoutSec };
  if (proxyCountry) body.proxy_config = { country_code: proxyCountry };
  let s;
  try {
    s = await json(settings.apiBase, { method: 'POST', headers: headers(apiKey), body, timeoutMs: 90_000 });
  } catch (e) {
    if (e.status === 402) throw new QuotaError(`wallet too low: ${e.text}`);
    throw e;
  }
  return { id: s.session_id, cdpUrl: s.cdp_url, egress: proxyCountry ? `proxy ${proxyCountry}` : 'default egress' };
}

export async function releaseSession(settings, apiKey, session) {
  await json(`${settings.apiBase}/${session.id}`, { method: 'DELETE', headers: headers(apiKey) });
}

/** The wallet's balance (https://docs.tinyfish.ai/wallet) */
export async function quota(settings, apiKey) {
  const w = await json(settings.walletUrl, { headers: headers(apiKey) });
  return { remaining: Number(w.available_balance), unit: w.currency };
}

/**
 * Usage of the sessions among `sessions` that have ended, from the paged usage list of the account. The list
 * starts a minute before the earliest was opened: the provider's start time precedes the ledger's.
 */
export async function sessionUsage(settings, apiKey, sessions) {
  const wanted = new Set(sessions.map((s) => s.id));
  const since = new Date(Math.min(...sessions.map((s) => Date.parse(s.openedAt))) - 60_000).toISOString();
  const usage = [];
  for (let page = 1; ; page++) {
    const body = await json(`${settings.apiBase}/usage?start_after=${since}&status=ended&limit=1000&page=${page}`, { headers: headers(apiKey) });
    for (const s of body.items) {
      if (wanted.has(s.session_id)) usage.push({ id: s.session_id, durationMs: s.duration_ms, proxyBytes: (s.proxy_trg_rx_bytes ?? 0) + (s.proxy_trg_tx_bytes ?? 0) });
    }
    if (!body.has_more) return usage;
  }
}
