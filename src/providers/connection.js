/**
 * The record of sessions that are each one CDP connection, at a provider whose API shows no record of them: the
 * ledger's timing, which is exact, as such a session lasts as long as its connection. A session no process
 * closed (its process was killed) has ended once the provider's maxSessionMs have passed, untimed.
 */
export function connectionUsage(sessions, maxSessionMs) {
  const usage = [];
  for (const { id, openedAt, closedAt } of sessions) {
    if (closedAt) usage.push({ id, durationMs: Date.parse(closedAt) - Date.parse(openedAt), proxyBytes: null });
    else if (Date.now() - Date.parse(openedAt) > maxSessionMs) usage.push({ id, durationMs: null, proxyBytes: null });
  }
  return usage;
}
