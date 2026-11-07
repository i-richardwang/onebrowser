import { KEEP_ALIVE_MS } from './session.js';

/** Session options when openSession() is not given them */
const SESSION_DEFAULTS = {
  proxyCountry: null,
  idleTimeoutSec: 60,
  maxDurationMs: 15 * 60_000,
};

/**
 * The session options of openSession() with the defaults filled in; throws when one is unknown or out of range,
 * so that a program can check its configuration before it opens any session:
 *   proxyCountry     country code: the provider's proxy there; null: its default egress
 *   idleTimeoutSec   a session whose client is gone ends this long after at the latest, or after the provider's
 *                    minIdleTimeoutSec if longer (≥ 2 × KEEP_ALIVE_MS)
 *   maxDurationMs    a session ends this long after it was opened at the latest
 */
export function sessionOptions(options = {}) {
  const unknown = Object.keys(options).filter((k) => !Object.hasOwn(SESSION_DEFAULTS, k));
  if (unknown.length) throw new Error(`unknown session option ${unknown.join(', ')} (expected ${Object.keys(SESSION_DEFAULTS).join(', ')})`);
  const o = { ...SESSION_DEFAULTS, ...options };
  if (!(Number.isFinite(o.idleTimeoutSec) && o.idleTimeoutSec * 1000 >= 2 * KEEP_ALIVE_MS)) {
    throw new Error(`idleTimeoutSec must be at least ${(2 * KEEP_ALIVE_MS) / 1000} (twice the keep-alive interval), not ${o.idleTimeoutSec}`);
  }
  if (!(Number.isFinite(o.maxDurationMs) && o.maxDurationMs > 0)) throw new Error(`maxDurationMs must be a number > 0, not ${o.maxDurationMs}`);
  return o;
}

/** How long a session lasts at most, whatever becomes of its process: closed at maxDurationMs, else ended by its provider once idle */
export const sessionMsAtMost = (o, settings) => o.maxDurationMs + Math.max(o.idleTimeoutSec, settings.minIdleTimeoutSec) * 1000;
