import fs from 'node:fs';

/** The environment variable holding a provider's API key: STEEL_API_KEY for `steel` */
export const apiKeyEnv = (provider) => `${provider.toUpperCase()}_API_KEY`;

/**
 * API key of a provider: `apiKey` as given in its settings, else the environment variable apiKeyEnv(provider),
 * else the file named by that variable with _FILE appended. An empty value counts as unset. Throws when there is
 * none.
 */
export function readApiKey(provider, apiKey) {
  if (apiKey?.trim()) return apiKey.trim();
  const env = apiKeyEnv(provider);
  const file = process.env[`${env}_FILE`];
  let key = process.env[env];
  if (!key && file) {
    if (!fs.existsSync(file)) throw new Error(`${provider} key: ${env}_FILE names no file (${file})`);
    key = fs.readFileSync(file, 'utf8');
  }
  if (!key?.trim()) throw new Error(`missing ${provider} key: set ${env} or ${env}_FILE`);
  return key.trim();
}
