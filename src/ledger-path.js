import os from 'node:os';
import path from 'node:path';
import { readVariables } from './variables.js';

// Where the ledger lives: the one part of onebrowser a program needs to find the ledger without opening it. The
// package exports it on its own (onebrowser/ledger-path), which loads no SQLite.

/** The variables that place the ledger, in the order they are read */
export const LEDGER_PATH_VARIABLES = ['ONEBROWSER_DB', 'XDG_DATA_HOME'];

/** A path as a variable holds it, `~` standing for the home directory: an env file's are not expanded by a shell */
const expandHome = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/**
 * Where the ledger lives unless a path is given, by onebrowser's variables (variables.js): ONEBROWSER_DB, else
 * onebrowser/sessions.db in the user's data directory: XDG_DATA_HOME, which the XDG spec ignores when relative,
 * else ~/.local/share. One ledger per machine is shared by every project on it, so that the record of an
 * account's sessions is whole, whichever project opened them.
 */
export function ledgerPathIn(variables) {
  if (variables.ONEBROWSER_DB) return expandHome(variables.ONEBROWSER_DB);
  const data = variables.XDG_DATA_HOME && expandHome(variables.XDG_DATA_HOME);
  return path.join(data && path.isAbsolute(data) ? data : path.join(os.homedir(), '.local', 'share'), 'onebrowser', 'sessions.db');
}

/** Where a OneBrowser given `env` and `envFile` (as its options) keeps its ledger unless it is given a path */
export const defaultLedgerPath = ({ env = process.env, envFile } = {}) => ledgerPathIn(readVariables(env, envFile));
