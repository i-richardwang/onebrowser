// Offline tests of the onebrowser command: fake adapters, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../src/cli.js';
import { apiKeyEnv, OneBrowser } from '../src/index.js';
import { ADAPTERS } from '../src/providers/index.js';

// The built-in providers have no API key here, so that no command reaches them
for (const p of Object.keys(ADAPTERS)) for (const v of [apiKeyEnv(p), `${apiKeyEnv(p)}_FILE`]) delete process.env[v];

let sessionIds = 0;
const adapter = (over = {}) => ({
  defaults: {},
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

/** A OneBrowser over an in-memory ledger with only the given adapters, every one with an API key */
const browsersWith = (adapters) =>
  new OneBrowser({ client: 'test', ledgerPath: ':memory:', adapters, providers: Object.fromEntries(Object.keys(adapters).map((p) => [p, { apiKey: 'key' }])) });

/** Runs the command: its exit status and what it wrote */
async function cli(argv, browsers) {
  const text = { out: '', err: '' };
  const sink = (k) => ({ write: (s) => (text[k] += s) });
  const status = await run(argv, { browsers, out: sink('out'), err: sink('err') });
  return { status, ...text };
}

test('quota reads every provider with an API key; a failed reading is shown and exits 1', async () => {
  const fakes = {
    a: adapter(),
    b: adapter({ quota: async () => ({ remaining: 3, unit: 'hours', renewsAt: Date.UTC(2026, 11, 1) }) }),
    c: adapter({ quota: async () => { throw new Error('HTTP 500'); } }),
  };
  const text = await cli(['quota', 'a', 'b'], browsersWith(fakes));
  assert.equal(text.status, 0);
  assert.match(text.out, /^a +12\.35 USD left\nb +3 hours left, renews 2026-12-01\n$/);

  const json = await cli(['quota', '--json'], browsersWith(fakes));
  assert.equal(json.status, 1);
  assert.deepEqual(JSON.parse(json.out), [
    { provider: 'a', remaining: 12.345, unit: 'USD', renewsAt: null },
    { provider: 'b', remaining: 3, unit: 'hours', renewsAt: Date.UTC(2026, 11, 1) },
    { provider: 'c', error: 'HTTP 500' },
  ]);
});

test('quota skips providers without an API key unless they are named; an unknown provider is a command line error', async () => {
  const keyless = () => new OneBrowser({ client: 'test', ledgerPath: ':memory:', adapters: { nokey: adapter() } });
  const none = await cli(['quota'], keyless());
  assert.equal(none.status, 1);
  assert.match(none.err, /no provider has an API key: set TINYFISH_API_KEY, .*, NOKEY_API_KEY\n$/);
  const named = await cli(['quota', 'nokey'], keyless());
  assert.equal(named.status, 1);
  assert.match(named.out, /^nokey +unknown \(missing nokey key: set NOKEY_API_KEY or NOKEY_API_KEY_FILE\)\n$/);
  const wrong = await cli(['quota', 'nope'], keyless());
  assert.equal(wrong.status, 2);
  assert.match(wrong.err, /unknown provider nope \(expected .*nokey\)\nsee onebrowser --help\n$/);
});

test("usage fetches the providers' records first, then reports per day, provider and client with totals", async () => {
  const browsers = browsersWith({ fake: adapter() });
  await (await browsers.openSession({ provider: 'fake' })).close();
  const today = new Date().toISOString().slice(0, 10);

  const json = await cli(['usage', '--days', '1', '--json'], browsers);
  assert.equal(json.status, 0);
  const report = JSON.parse(json.out);
  assert.equal(report.since, today);
  assert.deepEqual(report.sessions, [{ day: today, provider: 'fake', client: 'test', sessions: 1, minutes: 1.5, untimed: 0, unsynced: 0, proxyBytes: 2e6 }]);
  assert.deepEqual(report.failed, []);
});

test('usage as text, with totals for a provider with several rows; a provider whose records cannot be fetched is reported and exits 1', async () => {
  const ledgerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onebrowser-cli-')), 'sessions.db');
  const failing = { fake: adapter({ sessionUsage: async () => { throw new Error('HTTP 503'); } }) };
  for (const client of ['one', 'two']) {
    const b = new OneBrowser({ client, ledgerPath, adapters: failing, providers: { fake: { apiKey: 'key' } } });
    await (await b.openSession({ provider: 'fake' })).close();
    await b.close();
  }
  const text = await cli(['usage', '--days', '7'], new OneBrowser({ client: 'cli', ledgerPath, adapters: failing, providers: { fake: { apiKey: 'key' } } }));
  assert.equal(text.status, 1);
  assert.match(text.err, /^fake: the provider's records were not fetched \(HTTP 503\)\n$/);
  const lines = text.out.trimEnd().split('\n');
  const since = new Date(new Date().setUTCHours(0, 0, 0, 0) - 6 * 864e5).toISOString().slice(0, 10);
  assert.equal(lines[0], `sessions since ${since} in ${ledgerPath}:`);
  assert.match(lines[1], /^ {2}\d{4}-\d\d-\d\d fake one +1 sessions +\d+\.\d min +0\.0 MB proxy {2}\(1 not reported by the provider yet\)$/);
  assert.match(lines[2], /fake two +1 sessions/);
  assert.match(lines[3], /^ {2}total fake +2 sessions .* {2}\(2 not reported by the provider yet\)$/);
});

test('the command line: help, unknown commands and options, --days out of range', async () => {
  const b = () => browsersWith({ fake: adapter() });
  const helped = await cli(['--help'], b());
  assert.equal(helped.status, 0);
  assert.match(helped.out, /onebrowser quota \[PROVIDER\.\.\.\][\s\S]*FAKE_API_KEY +API key of fake/);
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
