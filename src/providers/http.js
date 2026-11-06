/** A provider API answered with a status other than 2xx; text: the start of its answer */
export class HttpError extends Error {
  constructor(status, answer) {
    const text = answer.slice(0, 300);
    super(`HTTP ${status}: ${text}`);
    this.status = status;
    this.text = text;
  }
}

/**
 * One request to a provider API: { body (its JSON; null when empty), headers }. `body` is sent as JSON. Throws
 * HttpError for a status other than 2xx, so that an adapter handles only the statuses that mean something of
 * their own (a quota refusal, a session already gone).
 */
export async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 30_000 } = {}) {
  const r = await fetch(url, {
    method,
    headers: body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  if (!r.ok) throw new HttpError(r.status, text);
  return { body: text ? JSON.parse(text) : null, headers: r.headers };
}

/** request() → the response's JSON */
export async function json(url, options) {
  return (await request(url, options)).body;
}
