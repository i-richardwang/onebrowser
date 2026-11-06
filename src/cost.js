/**
 * A provider's price (its adapter's `price` setting, providers/index.js), in the unit its quota is read in:
 *   perHour     for the session time
 *   perSession  for each session, however short (default 0)
 *   stepSec     the session time is billed in whole steps of this, rounded up (default 1)
 *   minSec      and at least this much of it (default 0)
 * Where a provider's documentation does not say how it rounds, its adapter takes the minute, rounded up: the
 * price is used to bound what sessions cost, so it errs on the high side.
 */
export function checkPrice(price) {
  const { perHour, perSession = 0, stepSec = 1, minSec = 0, ...unknown } = price ?? {};
  const fine = [perHour, perSession, minSec].every((x) => Number.isFinite(x) && x >= 0) && Number.isFinite(stepSec) && stepSec > 0;
  if (!fine || Object.keys(unknown).length) throw new Error(`price must be { perHour, perSession, stepSec, minSec } of numbers ≥ 0 (stepSec > 0), not ${JSON.stringify(price)}`);
}

/** What a session that lasts durationMs costs at `price` */
export function sessionCost({ perHour, perSession = 0, stepSec = 1, minSec = 0 }, durationMs) {
  const billedSec = Math.max(minSec, Math.ceil(durationMs / 1000 / stepSec) * stepSec);
  return perSession + (perHour * billedSec) / 3600;
}
