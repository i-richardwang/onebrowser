import { parseArgs } from 'node:util';
import { apiKeyEnv } from './credentials.js';
import { OneBrowser } from './index.js';

const DAY_MS = 864e5;

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

const round = (x) => Number(x.toFixed(2));

/** The command line is wrong: exit status 2 */
class CommandLineError extends Error {}

/** Options of every command */
const GLOBAL_OPTIONS = {
  json: { type: 'boolean' },
  'env-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

/** The accounts `names` ask for: each name a provider's (it must have an API key) or one account's id */
function askedAccounts(browsers, names) {
  return names.flatMap((name) => {
    const own = browsers.accounts().find((a) => a.id === name);
    if (own) return [own];
    if (!browsers.providers.includes(name)) throw new CommandLineError(`unknown provider or account ${name} (expected ${browsers.providers.join(', ')}, or an account id)`);
    const accounts = browsers.accounts(name);
    if (!accounts.length) throw new Error(`${name} has no API key: set ${apiKeyEnv(name)} or ${apiKeyEnv(name)}_FILE`);
    return accounts;
  });
}

/**
 * The commands: their own options, whether they take arguments, and run(browsers, values, args, { out, err })
 * → exit status
 */
const COMMANDS = {
  quota: {
    positionals: true,
    async run(browsers, { json }, names, { out }) {
      const accounts = names.length ? askedAccounts(browsers, names) : browsers.accounts();
      if (!accounts.length) throw new Error(`no provider has an API key: set ${browsers.providers.map(apiKeyEnv).join(', ')}`);
      const quotas = await Promise.all(
        accounts.map((a) => a.readQuota().then((q) => ({ account: a.id, provider: a.provider, ...q }), (e) => ({ account: a.id, provider: a.provider, error: e.message }))),
      );
      if (json) out.write(`${JSON.stringify(quotas, null, 2)}\n`);
      else {
        for (const q of quotas) {
          const text = q.error ? `unknown (${q.error})` : `${round(q.remaining)}${q.total ? ` of ${round(q.total)}` : ''} ${q.unit} left${q.unbilled ? ` (after ${round(q.unbilled)} not billed yet)` : ''}${q.renewsAt ? `, renews ${day(q.renewsAt)}` : ''}`;
          out.write(`${q.account.padEnd(21)} ${text}\n`);
        }
      }
      return quotas.some((q) => q.error) ? 1 : 0;
    },
  },

  usage: {
    options: { days: { type: 'string', default: '30' } },
    async run(browsers, { days, json }, args, { out, err }) {
      const n = Number(days);
      if (!(Number.isInteger(n) && n >= 1)) throw new CommandLineError(`--days must be a whole number ≥ 1, not ${days}`);
      const since = new Date().setUTCHours(0, 0, 0, 0) - (n - 1) * DAY_MS;
      const { failed } = await browsers.syncUsage();
      for (const f of failed) err.write(`${f.account}: the provider's records were not fetched (${f.error})\n`);
      const sessions = browsers.usage({ since });
      if (json) out.write(`${JSON.stringify({ ledger: browsers.ledgerPath, ledgerId: browsers.ledgerId, since: day(since), sessions, failed }, null, 2)}\n`);
      else {
        out.write(`sessions since ${day(since)} in ${browsers.ledgerPath}:\n`);
        if (!sessions.length) out.write('  none\n');
        for (const r of sessions) out.write(usageLine(`${r.day} ${r.account} ${r.client}`, r));
        for (const [account, rows] of Map.groupBy(sessions, (r) => r.account)) {
          if (rows.length > 1) out.write(usageLine(`total ${account}`, sumUsage(rows)));
        }
      }
      return failed.length ? 1 : 0;
    },
  },
};

const help = (providers) => `onebrowser: the quotas of remote browser provider accounts, and the sessions in this machine's ledger

Usage:
  onebrowser quota [NAME...]       what each account has left, less what the sessions in the ledger that it has
                                   not billed yet cost; NAME: a provider (every account with its API key) or an
                                   account id such as steel#3f9a1c; default: every account
  onebrowser usage [--days N]      sessions per UTC day, account and client in the last N UTC days, today
                                   included (default 30), after fetching the providers' records of ended sessions

Options:
  --json             JSON on stdout instead of text
  --env-file PATH    read the variables below from PATH too; those set in the environment win
  -h, --help

Environment:
${providers.map((p) => `  ${apiKeyEnv(p).padEnd(22)} API keys of ${p}, one per account, or ${apiKeyEnv(p)}_FILE naming a file that holds them`).join('\n')}
                         (keys are separated by commas, spaces or line breaks)
  ONEBROWSER_DB          the ledger file (default: onebrowser/sessions.db in $XDG_DATA_HOME, else ~/.local/share)

Exit status: 0 done, 1 a reading failed, 2 the command line is wrong.
`;

const USAGE_FIELDS = ['sessions', 'minutes', 'untimed', 'unsynced', 'proxyBytes'];

const sumUsage = (rows) => Object.fromEntries(USAGE_FIELDS.map((k) => [k, rows.reduce((t, r) => t + r[k], 0)]));

const usageLine = (label, r) =>
  `  ${label.padEnd(40)} ${String(r.sessions).padStart(5)} sessions ${r.minutes.toFixed(1).padStart(8)} min` +
  ` ${(r.proxyBytes / 1e6).toFixed(1).padStart(7)} MB proxy` +
  (r.untimed ? `  (${r.untimed} untimed)` : '') +
  (r.unsynced ? `  (${r.unsynced} not reported by the provider yet)` : '') +
  '\n';

/** The command and its parsed options: parsed once to find the command, then again with only its own options */
function parseCommandLine(argv) {
  const every = Object.assign({}, GLOBAL_OPTIONS, ...Object.values(COMMANDS).map((c) => c.options));
  const [name] = parseArgs({ args: argv, options: every, allowPositionals: true }).positionals;
  if (name !== undefined && !Object.hasOwn(COMMANDS, name)) throw new CommandLineError(`unknown command ${name} (expected ${Object.keys(COMMANDS).join(', ')})`);
  const command = COMMANDS[name]; // none without a name: the help
  const { values, positionals } = parseArgs({ args: argv, options: { ...GLOBAL_OPTIONS, ...command?.options }, allowPositionals: true });
  const args = positionals.slice(1);
  if (args.length && !command?.positionals) throw new CommandLineError(`${name} takes no arguments, not ${args.join(' ')}`);
  return { command, values, args };
}

/**
 * The onebrowser command (bin/onebrowser.js): runs `argv` and returns the exit status. browsers: the OneBrowser
 * to read (default: one with the built-in providers and the default ledger); it is closed when done.
 */
export async function run(argv, { out = process.stdout, err = process.stderr, browsers } = {}) {
  try {
    const { command, values, args } = parseCommandLine(argv);
    browsers ??= new OneBrowser({ client: 'onebrowser', envFile: values['env-file'] });
    if (values.help || !command) {
      (values.help ? out : err).write(help(browsers.providers));
      return values.help ? 0 : 2;
    }
    return await command.run(browsers, values, args, { out, err });
  } catch (e) {
    const misuse = e instanceof CommandLineError || e.code?.startsWith('ERR_PARSE_ARGS');
    err.write(`onebrowser: ${e.message}\n${misuse ? 'see onebrowser --help\n' : ''}`);
    return misuse ? 2 : 1;
  } finally {
    await browsers?.close();
  }
}
