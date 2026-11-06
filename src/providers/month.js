/** The current calendar month (UTC): its first ms, and the first ms of the next month */
export function utcMonth() {
  const d = new Date();
  return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), next: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
}
