/**
 * A provider's price (its `price` setting), in the unit its quota is read in:
 *   perHour     for the session time
 *   perSession  for each session, however short (default 0)
 *   stepSec     the session time is billed in whole steps of this, rounded up (default 1)
 *   minSec      and at least this much of it (default 0)
 * It bounds what sessions cost, so where a provider does not document its rounding the adapter takes the minute.
 */

/** The price with its defaults filled in; throws when it is not one */
export function fullPrice(price) {
  const { perHour, perSession = 0, stepSec = 1, minSec = 0, ...unknown } = price ?? {};
  const fine = [perHour, perSession, minSec].every((x) => Number.isFinite(x) && x >= 0) && Number.isFinite(stepSec) && stepSec > 0;
  if (!fine || Object.keys(unknown).length) throw new Error(`price must be { perHour, perSession, stepSec, minSec } of numbers ≥ 0 (stepSec > 0), not ${JSON.stringify(price)}`);
  return { perHour, perSession, stepSec, minSec };
}

/** What a session that lasts durationMs costs at `price` (fullPrice) */
export function sessionCost({ perHour, perSession, stepSec, minSec }, durationMs) {
  const billedSec = Math.max(minSec, Math.ceil(durationMs / 1000 / stepSec) * stepSec);
  return perSession + (perHour * billedSec) / 3600;
}
