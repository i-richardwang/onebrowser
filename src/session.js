/** A CDP command this often keeps a provider's idle timeout from ending a session in use; idleTimeoutSec must be at least twice as long */
export const KEEP_ALIVE_MS = 15_000;

/** Playwright errors carry a multi-line call log; the first line says what failed */
const firstLine = (e) => String(e.message).split('\n')[0];

/**
 * A remote browser session (OneBrowser.openSession), used over CDP: cdpUrl with any client (it may carry the API
 * key: never log it), or connect() / newPage() with Playwright. This process closes it maxDurationMs after it was
 * opened; one whose process died is ended by its provider idleTimeoutSec (at least its minIdleTimeoutSec) after
 * its client left.
 * openedAt: when it was asked for; closedAt: when its provider released it, null until then.
 */
export class Session {
  #release;
  #closing = null;
  #browser = null; // a promise of Playwright's Browser
  #keepAlive = null;
  #deadline;

  /** release(session) → closedAt: releases it at its provider and records it closed (OneBrowser) */
  constructor({ provider, remote, openedAt, maxDurationMs, release }) {
    this.provider = provider;
    this.id = remote.id;
    this.egress = remote.egress;
    this.cdpUrl = remote.cdpUrl;
    this.openedAt = openedAt;
    this.closedAt = null;
    this.#release = release;
    this.#deadline = setTimeout(() => this.close().catch(() => {}), openedAt + maxDurationMs - Date.now());
    this.#deadline.unref();
  }

  /** Playwright's Browser over this session's CDP connection, made once; a keep-alive runs while it is connected */
  connect() {
    if (this.#closing) return Promise.reject(new Error(`${this.provider} session ${this.id} is closed`));
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
      if (this.#closing) throw new Error(`${this.provider} session ${this.id} is closed`);
      this.#keepAlive = setInterval(() => cdp.send('Browser.getVersion').catch(() => {}), KEEP_ALIVE_MS);
      this.#keepAlive.unref();
    } catch (e) {
      await browser.close().catch(() => {});
      throw e;
    }
    return browser;
  }

  /** A new page in the default context: the page a remote browser starts with cannot always be navigated */
  async newPage() {
    const browser = await this.connect();
    const context = browser.contexts()[0] ?? (await browser.newContext());
    return context.newPage();
  }

  /**
   * Disconnects and releases the session; every call answers as the first. Throws when its provider could not
   * release it: the ledger then counts it as lasting as long as it can, as its provider ends it by itself.
   */
  close() {
    return (this.#closing ??= this.#close());
  }

  async #close() {
    clearTimeout(this.#deadline);
    clearInterval(this.#keepAlive);
    await this.#browser?.then((b) => b.close()).catch(() => {});
    this.closedAt = await this.#release(this);
  }

  [Symbol.asyncDispose]() {
    return this.close();
  }
}
