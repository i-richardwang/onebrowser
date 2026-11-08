import fs from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * The variables onebrowser reads its configuration from, the API keys (credentials.js) and the ledger's place
 * (ledger-path.js): those set in `env`, over those of the env file at `envFile` if one is named, parsed as Node
 * parses env files. A variable set but empty is unset, as onebrowser reads every variable, so it hides none of the
 * file's.
 */
export function readVariables(env, envFile) {
  if (envFile === undefined) return env;
  let text;
  try {
    text = fs.readFileSync(envFile, 'utf8');
  } catch (e) {
    throw new Error(`cannot read the env file ${envFile}: ${e.message}`);
  }
  return { ...parseEnv(text), ...Object.fromEntries(Object.entries(env).filter(([, value]) => value)) };
}
