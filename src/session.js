/**
 * A CDP command this often while connected keeps a provider's idle timeout from ending a session that is in use
 * (also while a page waits long for an answer). OneBrowser requires idleTimeoutSec to be at least twice as long.
 */
export const KEEP_ALIVE_MS = 15_000;

/** Playwright errors carry a multi-line call log; the first line says what failed */
const firstLine = (e) => String(e.message).split('\n')[0];

/**
 * One remote browser session, as OneBrowser.openSession() opened it: created by its provider and recorded in the
 * ledger. Use it over CDP: through cdpUrl with any CDP client, or through connect() / newPage() with Playwright.
 * It ends at the latest maxDurationMs after it was opened: this process closes it then (a client using it sees
 * its connection drop). close() releases it; one never closed (its process was killed) is ended by its provider
 * idleTimeoutSec after its client left.
 *
 *   id, provider, egress     the provider's session id, its name, and the egress the session uses
 *   cdpUrl                   CDP WebSocket URL (it may carry the API key: never log it)
 *   openedAt, closedAt       ms; closedAt is null while open
 */
export class Session {
  #release;
  #browser = null; // the connection in progress or made: a promise of Playwright's Browser
  #keepAlive = null;
  #deadline;

  /** release(session): records the session closed and releases it at its provider (OneBrowser) */
  constructor({ provider, remote, maxDurationMs, release }) {
    this.provider = provider;
    this.id = remote.id;
    this.egress = remote.egress;
    this.cdpUrl = remote.cdpUrl;
    this.openedAt = Date.now();
    this.closedAt = null;
    this.#release = release;
    this.#deadline = setTimeout(() => this.close().catch(() => {}), maxDurationMs); // a release that fails here leaves the session to the provider's idle timeout
    this.#deadline.unref();
  }

  /** Playwright's Browser over this session's CDP connection, made once; the keep-alive runs while it is connected */
  connect() {
    if (this.closedAt) return Promise.reject(new Error(`${this.provider} session ${this.id} is closed`));
    this.#browser ??= this.#connect();
    return this.#browser;
  }

  async #connect() {
    const { chromium } = await import('playwright-core');
    let browser;
    try {
      browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 60_000 });
    } catch (e) {
      throw new Error(`failed to connect to the ${this.provider} browser: ${firstLine(e)}`);
    }
    try {
      const cdp = await browser.newBrowserCDPSession();
      if (this.closedAt) throw new Error(`${this.provider} session ${this.id} is closed`); // closed while connecting
      this.#keepAlive = setInterval(() => cdp.send('Browser.getVersion').catch(() => {}), KEEP_ALIVE_MS);
      this.#keepAlive.unref();
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
    return browser;
  }

  /**
   * A new page in the browser's default context. Always a new one: the page a remote browser starts with is not
   * always one that can be navigated.
   */
  async newPage() {
    const browser = await this.connect();
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return context.newPage();
  }

  /**
   * Disconnects and releases the session at its provider; only the first call does. The ledger records it closed
   * in any case. Throws when the provider could not release it: the provider then ends it by itself,
   * idleTimeoutSec after the disconnect.
   */
  async close() {
    if (this.closedAt) return;
    this.closedAt = Date.now();
    clearTimeout(this.#deadline);
    clearInterval(this.#keepAlive);
    const browser = this.#browser;
    this.#browser = null;
    await browser?.then((b) => b.close()).catch(() => {});
    await this.#release(this);
  }

  /** close(): `await using session = await browsers.openSession(…)` releases it at the end of the block */
  [Symbol.asyncDispose]() {
    return this.close();
  }
}
