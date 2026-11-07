// Offline tests of the onebrowser command: fake adapters, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';
import { fingerprint } from '../src/credentials.js';
import { apiKeyEnv, OneBrowser } from '../src/index.js';
import { ADAPTERS } from '../src/providers/index.js';

// The built-in providers have no API key here, so that no command reaches them
for (const p of Object.keys(ADAPTERS)) for (const v of [apiKeyEnv(p), `${apiKeyEnv(p)}_FILE`]) delete process.env[v];

let sessionIds = 0;
const adapter = (over = {}) => ({
  defaults: { price: { perHour: 0.6, stepSec: 60 }, billingDelayMs: 0 },
  async createSession() {
    return { id: `s${++sessionIds}`, cdpUrl: 'wss://fake/cdp', egress: 'fake IP' };
  },
  async releaseSession() {},
  async sessionUsage(settings, apiKey, rows) {
    return rows.filter((r) => r.closedAt).map((r) => ({ id: r.id, durationMs: 90_000, proxyBytes: 2e6 }));
  },
  async quota() {
    return { remaining: 12.345, unit: 'USD' };
  },
  ...over,
});

/** A OneBrowser over an in-memory ledger with only the given adapters, every one with an account (API key 'key') */
const browsersWith = (adapters) =>
  new OneBrowser({ client: 'test', ledgerPath: ':memory:', adapters, providers: Object.fromEntries(Object.keys(adapters).map((p) => [p, { apiKeys: ['key'] }])) });

/** The id of the account with API key 'key' at `provider` */
const id = (provider) => `${provider}#${fingerprint('key')}`;

/** Runs the command: its exit status and what it wrote */
async function cli(argv, browsers) {
  const text = { out: '', err: '' };
  const sink = (k) => ({ write: (s) => (text[k] += s) });
  const status = await run(argv, { browsers, out: sink('out'), err: sink('err') });
  return { status, ...text };
}

test('quota reads every account, named by provider or by id; a failed reading is shown and exits 1', async () => {
  const fakes = {
    a: adapter(),
    b: adapter({ quota: async () => ({ remaining: 3, unit: 'hours', renewsAt: Date.UTC(2026, 11, 1) }) }),
    c: adapter({ quota: async () => { throw new Error('HTTP 500'); } }),
  };
  const text = await cli(['quota', 'a', id('b')], browsersWith(fakes));
  assert.equal(text.status, 0);
  assert.equal(text.out, `${id('a').padEnd(21)} 12.35 USD left\n${id('b').padEnd(21)} 3 hours left, renews 2026-12-01\n`);

  const two = new OneBrowser({ client: 'test', ledgerPath: ':memory:', adapters: { a: fakes.a }, providers: { a: { apiKeys: ['key', 'other'] } } });
  await two.accounts('a')[0].openSession(); // 16 minutes at most, at $0.01 a minute
  assert.equal((await cli(['quota', 'a'], two)).out, `${id('a').padEnd(21)} 12.19 USD left (after 0.16 not billed yet)\n${`a#${fingerprint('other')}`.padEnd(21)} 12.35 USD left\n`);

  const json = await cli(['quota', '--json'], browsersWith(fakes));
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.out), [
    { account: id('a'), provider: 'a', remaining: 12.345, unbilled: 0, unit: 'USD', renewsAt: null },
    { account: id('b'), provider: 'b', remaining: 3, unbilled: 0, unit: 'hours', renewsAt: Date.UTC(2026, 11, 1) },
    { account: id('c'), provider: 'c', error: 'HTTP 500' },
  ]);
});

test('quota with no account at all, a named provider without a key, and an unknown name', async () => {
  const keyless = () => new OneBrowser({ client: 'test', ledgerPath: ':memory:', adapters: { nokey: adapter() } });
  const none = await cli(['quota'], keyless());
  assert.equal(none.status, 1);
  assert.match(none.err, /no provider has an API key: set TINYFISH_API_KEY, .*, NOKEY_API_KEY\n$/);
  const named = await cli(['quota', 'nokey'], keyless());
  assert.equal(named.status, 1);
  assert.equal(named.err, 'onebrowser: nokey has no API key: set NOKEY_API_KEY or NOKEY_API_KEY_FILE\n');
  const wrong = await cli(['quota', 'nope'], keyless());
  assert.equal(wrong.status, 2);
  assert.match(wrong.err, /unknown provider or account nope \(expected .*nokey, or an account id\)\nsee onebrowser --help\n$/);
});

test("usage fetches the providers' records first, then reports per day, account and client with totals", async () => {
  const browsers = browsersWith({ fake: adapter() });
  await (await browsers.accounts('fake')[0].openSession()).close();
  const today = new Date().toISOString().slice(0, 10);

  const json = await cli(['usage', '--days', '1', '--json'], browsers);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.out);
  assert.equal(report.since, today);
  assert.deepEqual(report.sessions, [{ day: today, provider: 'fake', account: id('fake'), client: 'test', sessions: 1, minutes: 1.5, untimed: 0, unsynced: 0, proxyBytes: 2e6 }]);
  assert.deepEqual(report.failed, []);
});

test('usage as text, with totals for an account with several rows; an account whose records cannot be fetched is reported and exits 1', async () => {
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onebrowser-cli-')), 'sessions.db');
  const failing = { fake: adapter({ sessionUsage: async () => { throw new Error('HTTP 503'); } }) };
  for (const client of ['one', 'two']) {
    const b = new OneBrowser({ client, ledgerPath, adapters: failing, providers: { fake: { apiKeys: ['key'] } } });
    await (await b.accounts('fake')[0].openSession()).close();
    await b.close();
  }
  const text = await cli(['usage', '--days', '7'], new OneBrowser({ client: 'cli', ledgerPath, adapters: failing, providers: { fake: { apiKeys: ['key'] } } }));
  assert.equal(text.status, 1);
  assert.equal(text.err, `${id('fake')}: the provider's records were not fetched (HTTP 503)\n`);
  const lines = text.out.trimEnd().split('\n');
  const since = new Date(new Date().setUTCHours(0, 0, 0, 0) - 6 * 864e5).toISOString().slice(0, 10);
  assert.equal(lines[0], `sessions since ${since} in ${ledgerPath}:`);
  assert.match(lines[1], new RegExp(`^ {2}\\d{4}-\\d\\d-\\d\\d ${id('fake')} one +1 sessions +\\d+\\.\\d min +0\\.0 MB proxy {2}\\(1 not reported by the provider yet\\)$`));
  assert.match(lines[2], new RegExp(`${id('fake')} two +1 sessions`));
  assert.match(lines[3], new RegExp(`^ {2}total ${id('fake')} +2 sessions .* {2}\\(2 not reported by the provider yet\\)$`));
});

test('the command line: help, unknown commands and options, --days out of range', async () => {
  const b = () => browsersWith({ fake: adapter() });
  const helped = await cli(['--help'], b());
  assert.equal(helped.status, 0);
  assert.match(helped.out, /onebrowser quota \[NAME\.\.\.\][\s\S]*FAKE_API_KEY +API keys of fake, one per account/);
  assert.equal((await cli([], b())).status, 2);
  for (const [argv, message] of [
    [['nope'], /unknown command nope \(expected quota, usage\)/],
    [['usage', '--days', '0'], /--days must be a whole number ≥ 1, not 0/],
    [['quota', '--days', '3'], /Unknown option '--days'/],
    [['usage', 'extra'], /usage takes no arguments, not extra/],
    [['quota', '--nope'], /Unknown option '--nope'/],
  ]) {
    const r = await cli(argv, b());
    assert.equal(r.status, 2, argv.join(' '));
    assert.match(r.err, message);
    assert.match(r.err, /\nsee onebrowser --help\n$/);
  }
});
