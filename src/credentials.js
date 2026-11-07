import crypto from 'node:crypto';
import fs from 'node:fs';

/** The environment variable holding a provider's API keys: STEEL_API_KEY for `steel` */
export const apiKeyEnv = (provider) => `${provider.toUpperCase()}_API_KEY`;

/** What names the account an API key belongs to without telling the key: the first 6 hex digits of its SHA-256 */
export const fingerprint = (apiKey) => crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 6);

/** Keys written one after another, separated by commas, spaces or line breaks */
const split = (text) => text.split(/[\s,]+/).filter(Boolean);

/**
 * A provider's API keys, one per account: `apiKeys` as given in its settings, else those in the environment
 * variable apiKeyEnv(provider), else those in the file named by that variable with _FILE appended, in their
 * order and each once. Separators: commas, spaces or line breaks. None is fine; the file must exist.
 */
export function readApiKeys(provider, apiKeys) {
  const env = apiKeyEnv(provider);
  const file = process.env[`${env}_FILE`];
  let keys = apiKeys ?? split(process.env[env] ?? '');
  if (!keys.length && file) {
    if (!fs.existsSync(file)) throw new Error(`${provider} keys: ${env}_FILE names no file (${file})`);
    keys = split(fs.readFileSync(file, 'utf8'));
  }
  return [...new Set(keys.map((k) => k.trim()).filter(Boolean))];
}
