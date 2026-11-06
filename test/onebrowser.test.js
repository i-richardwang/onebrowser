// Offline tests of onebrowser: fake adapters and fetch, no network, no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apiKeyEnv, OneBrowser, QuotaError, sessionOptions } from '../src/index.js';
import { ADAPTERS } from '../src/providers/index.js';
import { utcMonth } from '../src/providers/month.js';

const { hyperbrowser, kernel, lightpanda, steel, tinyfish } = ADAPTERS;
const options = { proxyCountry: null, idleTimeoutSec: 60, maxDurationMs: 15 * 60_000 };

/** Runs fn with fetch answered offline by answer(url) → { status, body, headers }: what fn returned, and the requests it made */
async function withFetch(answer, fn) {
  const saved = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ method: init.method ?? 'GET', url: String(url), body: init.body && JSON.parse(init.body) });
    const { status = 200, body = null, headers } = answer(String(url));
    return new Response(body === null ? null : JSON.stringify(body), { status, headers });
  };
  try {
    return { value: await fn(), requests };
  } finally {
    globalThis.fetch = saved;
  }
}

/** A fake adapter that records what it is asked; `over` replaces its functions */
function fakeAdapter(over = {}) {
  const a = {
    defaults: { apiBase: 'https://fake' },
    created: [], // { settings, apiKey, options }
    released: [], // session ids
    async createSession(settings, apiKey, options) {
      a.created.push({ settings, apiKey, options });
      return { id: `s${a.created.length}`, cdpUrl: 'wss://fake/cdp', egress: 'fake IP' };
    },
    async releaseSession(settings, apiKey, session) {
      a.released.push(session.id);
    },
    async sessionUsage() {
      return [];
    },
    async quota() {
      return { remaining: 5, unit: 'USD' };
    },
    ...over,
  };
  return a;
}

/** A OneBrowser over an in-memory ledger whose provider `fake` is `adapter` */
const browsersWith = (adapter, more = {}) => new OneBrowser({ client: 'test', ledgerPath: ':memory:', adapters: { fake: adapter, ...more.adapters }, providers: { fake: { apiKey: 'key' }, ...more.providers } });

// ---------------- construction and credentials ----------------

test('a OneBrowser names its client; settings and adapters must be for known providers with the whole contract', () => {
  assert.throws(() => new OneBrowser({ ledgerPath: ':memory:' }), /client must name/);
  assert.throws(() => new OneBrowser({ client: 'x', ledgerPath: ':memory:', providers: { nope: {} } }), /no adapter for provider nope/);
  assert.throws(() => new OneBrowser({ client: 'x', ledgerPath: ':memory:', adapters: { half: { createSession() {} } } }), /half: its adapter lacks releaseSession, sessionUsage, quota/);
  const b = new OneBrowser({ client: 'x', ledgerPath: ':memory:' });
  assert.deepEqual(b.providers, ['tinyfish', 'steel', 'hyperbrowser', 'lightpanda', 'kernel']);
  assert.throws(() => b.checkReady('nope'), /unknown provider nope/);
});

test('API key from the settings, the environment or <env>_FILE; a provider is not ready without one', () => {
  const saved = { key: process.env.STEEL_API_KEY, file: process.env.STEEL_API_KEY_FILE };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onebrowser-key-'));
  delete process.env.STEEL_API_KEY;
  delete process.env.STEEL_API_KEY_FILE;
  const b = new OneBrowser({ client: 'x', ledgerPath: ':memory:' });
  try {
    assert.equal(apiKeyEnv('steel'), 'STEEL_API_KEY');
    assert.throws(() => b.checkReady('steel'), /missing steel key: set STEEL_API_KEY or STEEL_API_KEY_FILE/);
    assert.doesNotThrow(() => new OneBrowser({ client: 'x', ledgerPath: ':memory:', providers: { steel: { apiKey: 'k0' } } }).checkReady('steel'));
    process.env.STEEL_API_KEY = ' k1 ';
    assert.doesNotThrow(() => b.checkReady('steel'));

    fs.writeFileSync(path.join(dir, 'steel'), 'k2\n');
    process.env.STEEL_API_KEY = ''; // an empty value (`STEEL_API_KEY=` in .env) is unset
    process.env.STEEL_API_KEY_FILE = path.join(dir, 'steel');
    assert.doesNotThrow(() => b.checkReady('steel'));
    process.env.STEEL_API_KEY_FILE = path.join(dir, 'gone');
    assert.throws(() => b.checkReady('steel'), /STEEL_API_KEY_FILE names no file/);
  } finally {
    fs.rmSync(dir, { recursive: true });
    for (const [k, v] of [['STEEL_API_KEY', saved.key], ['STEEL_API_KEY_FILE', saved.file]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------------- sessions ----------------

test('a session is created with the provider\'s settings, its API key and the shared options, recorded with its client, and released and recorded closed once', async () => {
  const adapter = fakeAdapter({ defaults: { apiBase: 'https://fake', region: 'eu' } });
  const b = browsersWith(adapter, { providers: { fake: { apiKey: 'key', apiBase: 'https://other' } } });
  const s = await b.openSession({ provider: 'fake', proxyCountry: 'DE' });
  assert.deepEqual(adapter.created, [{ settings: { apiBase: 'https://other', region: 'eu' }, apiKey: 'key', options: { ...options, proxyCountry: 'DE' } }]);
  assert.deepEqual([s.provider, s.id, s.egress, s.cdpUrl, s.closedAt], ['fake', 's1', 'fake IP', 'wss://fake/cdp', null]);
  const [open] = b.usage({ since: 0 });
  assert.deepEqual([open.provider, open.client, open.sessions, open.untimed, open.unsynced], ['fake', 'test', 1, 1, 1]);

  await s.close();
  await s[Symbol.asyncDispose](); // what `await using` calls: a second close
  assert.deepEqual(adapter.released, ['s1']);
  assert.ok(s.closedAt >= s.openedAt);
  assert.equal(b.usage({ since: 0 })[0].untimed, 0); // timed by its open and close
  await assert.rejects(s.connect(), /fake session s1 is closed/);
  await b.close();
});

test('a session the provider refuses is not recorded: QuotaError as is, other failures with the provider named', async () => {
  const b = browsersWith(fakeAdapter({ createSession: async () => { throw new QuotaError('wallet too low'); } }), {
    adapters: { broken: fakeAdapter({ createSession: async () => { throw new Error('HTTP 500'); } }) },
    providers: { broken: { apiKey: 'k' } },
  });
  await assert.rejects(b.openSession({ provider: 'fake' }), QuotaError);
  await assert.rejects(b.openSession({ provider: 'broken' }), /^Error: failed to create a broken session: HTTP 500$/);
  await assert.rejects(b.openSession({ provider: 'fake', idleTimeoutSec: 10 }), /idleTimeoutSec must be at least 30/);
  await assert.rejects(b.openSession({ provider: 'fake', maxDurationMs: 0 }), /maxDurationMs must be a number > 0/);
  await assert.rejects(b.openSession({ provider: 'fake', idleTimeout: 60 }), /unknown session option idleTimeout \(expected proxyCountry, idleTimeoutSec, maxDurationMs\)/);
  assert.deepEqual(sessionOptions({ proxyCountry: 'DE' }), { ...options, proxyCountry: 'DE' }); // what a program checks its configuration with
  assert.deepEqual(b.usage({ since: 0 }), []);
  await b.close();
});

test('a session that the provider cannot release is recorded closed; close() says so', async () => {
  const b = browsersWith(fakeAdapter({ releaseSession: async () => { throw new Error('HTTP 502'); } }));
  const s = await b.openSession({ provider: 'fake' });
  await assert.rejects(s.close(), /HTTP 502/);
  assert.ok(s.closedAt);
  assert.equal(b.usage({ since: 0 })[0].untimed, 0);
  await b.close();
});

test('a session ends after maxDurationMs, and disposing of the OneBrowser closes those still open', async () => {
  const adapter = fakeAdapter();
  const b = browsersWith(adapter);
  const short = await b.openSession({ provider: 'fake', maxDurationMs: 20 });
  const long = await b.openSession({ provider: 'fake' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual([Boolean(short.closedAt), long.closedAt], [true, null]);
  await b[Symbol.asyncDispose](); // what `await using` calls
  assert.ok(long.closedAt);
  assert.deepEqual(adapter.released, ['s1', 's2']);
});

// ---------------- quota and usage ----------------

test('a quota reading renews only on a top-up unless the provider says when; one without a number left is a failed reading', async () => {
  const b = browsersWith(fakeAdapter(), {
    adapters: { monthly: fakeAdapter({ quota: async () => ({ remaining: 3, unit: 'hours', renewsAt: 42 }) }), changed: fakeAdapter({ quota: async () => ({ remaining: Number(undefined), unit: 'USD' }) }) },
    providers: { monthly: { apiKey: 'k' }, changed: { apiKey: 'k' } },
  });
  assert.deepEqual(await b.quota('fake'), { remaining: 5, unit: 'USD', renewsAt: null });
  assert.deepEqual(await b.quota('monthly'), { remaining: 3, unit: 'hours', renewsAt: 42 });
  await assert.rejects(b.quota('changed'), /changed answered no quota/); // a changed response shape
  await b.close();
});

test('syncUsage stores the providers\' records of ended sessions; running ones wait; a provider that fails is reported', async () => {
  const asked = [];
  const a = fakeAdapter({
    async sessionUsage(settings, apiKey, sessions) {
      asked.push([apiKey, sessions.map((x) => x.id)]);
      return [{ id: 's1', durationMs: 120_000, proxyBytes: 5_000 }]; // s2 is still running
    },
  });
  const b = browsersWith(a, { adapters: { down: fakeAdapter({ sessionUsage: async () => { throw new Error('HTTP 503'); } }) }, providers: { down: { apiKey: 'k' } } });
  const s1 = await b.openSession({ provider: 'fake' });
  await b.openSession({ provider: 'fake' });
  await b.openSession({ provider: 'down' });
  await s1.close();

  assert.deepEqual(await b.syncUsage(), { reported: 1, failed: [{ provider: 'down', error: 'HTTP 503' }] });
  assert.deepEqual(asked, [['key', ['s1', 's2']]]);
  const rows = b.usage({ since: 0 }).map(({ provider, client, sessions, minutes, untimed, unsynced, proxyBytes }) => [provider, client, sessions, minutes, untimed, unsynced, proxyBytes]);
  assert.deepEqual(rows, [['down', 'test', 1, 0, 1, 1, 0], ['fake', 'test', 2, 2, 1, 1, 5_000]]);
  assert.deepEqual(b.usage({ since: Date.now() + 864e5 }), []);
  await b.close();
});

test("every program sharing a ledger file is recorded under its own client; one syncs only the providers it has adapters for", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onebrowser-ledger-'));
  const ledgerPath = path.join(dir, 'sub', 'sessions.db');
  try {
    for (const [client, provider] of [['crawler', 'fake'], ['other', 'own']]) {
      const adapter = fakeAdapter({ createSession: async () => ({ id: `${client}-1`, cdpUrl: 'wss://fake/cdp', egress: 'fake IP' }) });
      const b = new OneBrowser({ client, ledgerPath, adapters: { [provider]: adapter }, providers: { [provider]: { apiKey: 'k' } } });
      await (await b.openSession({ provider })).close();
      await b.close();
    }
    const b = new OneBrowser({ client: 'reader', ledgerPath, adapters: { fake: fakeAdapter() }, providers: { fake: { apiKey: 'k' } } });
    assert.deepEqual(await b.syncUsage(), { reported: 0, failed: [] }); // `own` is the other program's to sync
    assert.deepEqual(b.usage({ since: 0 }).map((r) => [r.provider, r.client, r.sessions]), [['fake', 'crawler', 1], ['own', 'other', 1]]);
    await b.close();
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

// ---------------- adapters: the shared session options on each provider's API ----------------

test('steel, tinyfish and hyperbrowser take the shared session options in their own parameters', async () => {
  const created = { steel: { id: 'st1' }, tinyfish: { session_id: 'tf1', cdp_url: 'wss://tf' }, hyperbrowser: { id: 'hb1', wsEndpoint: 'wss://hb' } };
  const asked = {};
  for (const [name, adapter] of Object.entries({ steel, tinyfish, hyperbrowser })) {
    const { value, requests } = await withFetch(() => ({ body: created[name] }), () => adapter.createSession(adapter.defaults, 'key', { ...options, proxyCountry: 'CN', maxDurationMs: 90_000 }));
    asked[name] = { body: requests[0].body, egress: value.egress };
  }
  assert.deepEqual(asked.steel, { body: { timeout: 90_000, inactivityTimeout: 60_000, optimizeBandwidth: true, useProxy: { geolocation: { country: 'CN' } } }, egress: 'proxy CN' });
  assert.deepEqual(asked.tinyfish, { body: { timeout_seconds: 60, proxy_config: { country_code: 'CN' } }, egress: 'proxy CN' });
  assert.deepEqual(asked.hyperbrowser, { body: { timeoutMinutes: 2, useProxy: true, proxyCountry: 'CN' }, egress: 'proxy CN' });
  await withFetch(() => ({ status: 402, body: { code: 'INSUFFICIENT_CREDITS' } }), () => assert.rejects(tinyfish.createSession(tinyfish.defaults, 'key', options), QuotaError));
});

test('a Lightpanda session is a CDP URL with the token and the datacenter proxy; its sessions are timed by the ledger', async () => {
  const a = await lightpanda.createSession(lightpanda.defaults, 'tok', options);
  const b = await lightpanda.createSession(lightpanda.defaults, 'tok', { ...options, proxyCountry: 'DE' });
  assert.notEqual(a.id, b.id);
  assert.equal(a.cdpUrl, `${lightpanda.defaults.connectBase}?token=tok&proxy=datacenter`);
  assert.equal(b.cdpUrl, `${lightpanda.defaults.connectBase}?token=tok&proxy=datacenter&country=de`);

  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const usage = await lightpanda.sessionUsage(lightpanda.defaults, 'tok', [
    { id: 'closed', openedAt: at(10), closedAt: at(7) },
    { id: 'open', openedAt: at(5), closedAt: null }, // may still be running
    { id: 'left', openedAt: at(20), closedAt: null }, // its process was killed; past 15 minutes, Lightpanda has ended it
  ]);
  assert.deepEqual(usage, [
    { id: 'closed', durationMs: 180_000, proxyBytes: null },
    { id: 'left', durationMs: null, proxyBytes: null },
  ]);

  const browsers = new OneBrowser({ client: 'test', ledgerPath: ':memory:', providers: { lightpanda: { apiKey: 'tok' } } });
  const s = await browsers.openSession({ provider: 'lightpanda' }); // no request: the session is its connection
  await s.close();
  assert.deepEqual(await browsers.syncUsage(), { reported: 1, failed: [] });
  const [row] = browsers.usage({ since: 0 });
  assert.deepEqual([row.provider, row.sessions, row.untimed, row.unsynced], ['lightpanda', 1, 0, 0]);
  await browsers.close();
});

test('Lightpanda quota is the monthly hours less the session time the ledger has of this month; it renews with the next month', async () => {
  const month = utcMonth();
  const asked = [];
  const history = { sessionMsSince: (since) => (asked.push(since), 1.5 * 3_600_000) };
  assert.deepEqual(await lightpanda.quota(lightpanda.defaults, 'tok', history), { remaining: lightpanda.defaults.monthlyHours - 1.5, unit: 'hours', renewsAt: month.next });
  assert.deepEqual(asked, [month.start]);
});

test('a Kernel session is headless with the idle timeout; 403 is the spending cap; a deleted session is released', async () => {
  const settings = kernel.defaults;
  const { requests } = await withFetch(
    (url) => (url.endsWith('/browsers') ? { body: { session_id: 'k1', cdp_ws_url: 'wss://k/cdp?jwt=x' } } : { status: 404, body: { code: 'not_found' } }),
    async () => {
      assert.deepEqual(await kernel.createSession(settings, 'key', options), { id: 'k1', cdpUrl: 'wss://k/cdp?jwt=x', egress: 'datacenter IP' });
      await kernel.releaseSession(settings, 'key', { id: 'k1' }); // 404: Kernel has deleted it already
    },
  );
  assert.deepEqual(requests, [
    { method: 'POST', url: `${settings.apiBase}/browsers`, body: { headless: true, timeout_seconds: 60 } },
    { method: 'DELETE', url: `${settings.apiBase}/browsers/k1`, body: undefined },
  ]);
  await withFetch(() => ({ status: 403, body: { code: 'forbidden' } }), () => assert.rejects(kernel.createSession(settings, 'key', options), QuotaError));
  await withFetch(() => ({ status: 500 }), () => assert.rejects(kernel.releaseSession(settings, 'key', { id: 'k1' }), /HTTP 500/));
  await assert.rejects(kernel.createSession(settings, 'key', { ...options, proxyCountry: 'DE' }), /proxyCountry is not supported/);
});

test('Kernel reports the uptime of deleted sessions whose billing is final', async () => {
  const records = { done: { usage_status: 'ready', usage: { uptime_ms: 90_000 } }, billing: { usage_status: 'pending', usage: { uptime_ms: 1 } }, running: { usage: { uptime_ms: 5 } } };
  const { value: usage } = await withFetch(
    (url) => ({ body: records[new URL(url).pathname.split('/').pop()] }),
    () => kernel.sessionUsage(kernel.defaults, 'key', ['done', 'billing', 'running'].map((id) => ({ id }))),
  );
  assert.deepEqual(usage, [{ id: 'done', durationMs: 90_000, proxyBytes: null }]);
});

test("Kernel quota is the monthly hours less the uptime of this month's sessions, listed newest first", async () => {
  const month = utcMonth();
  const at = (ms) => new Date(ms).toISOString();
  const pages = [
    [{ created_at: at(Date.now()), usage: { uptime_ms: 3_600_000 } }, { created_at: at(month.start), usage: { uptime_ms: 1_800_000 } }],
    [{ created_at: at(month.start + 1), usage: { uptime_ms: 1_800_000 } }, { created_at: at(month.start - 1), usage: { uptime_ms: 9e9 } }],
    [{ created_at: at(month.start - 2), usage: { uptime_ms: 9e9 } }],
  ];
  const { value: q, requests } = await withFetch(
    (url) => ({ body: pages[Number(new URL(url).searchParams.get('offset')) / 100], headers: { 'X-Has-More': 'true' } }),
    () => kernel.quota(kernel.defaults, 'key'),
  );
  assert.deepEqual(q, { remaining: kernel.defaults.monthlyHours - 2, unit: 'hours', renewsAt: month.next });
  assert.deepEqual(requests.map((r) => new URL(r.url).search), ['?status=all&limit=100&offset=0', '?status=all&limit=100&offset=100', '?status=all&limit=100&offset=200']);
});
