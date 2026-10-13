import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createAppAuth } from '@octokit/auth-app';
import { createTokenBroker } from './broker.js';
import { githubApi } from './github.js';

/**
 * Token broker for the reviewer runtimes.
 *
 * The runtimes build and run code from the pull request under review, so
 * they must not hold the GitHub App private key. Instead they invoke this
 * function (IAM lambda:InvokeFunction) and get a short-lived installation
 * token limited to the one repository being reviewed and to the
 * permissions a review needs. Repositories outside the routed set, and
 * installation ids that are not the App's installation on the requested
 * repository, are refused. The checks are in src/broker.ts.
 *
 * Input:  { installation_id: number, repo: "owner/name" }
 * Output: { token, expires_at } or { error }
 */

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const SECRET_ARN = required('GITHUB_SECRET_ARN');
const APP_ID = required('GITHUB_APP_ID');
const ALLOWED_REPOS = JSON.parse(required('ALLOWED_REPOS_JSON')) as string[];

const sm = new SecretsManagerClient({});
let cachedKey: { value: string; fetchedAt: number } | null = null;

async function privateKey(): Promise<string> {
  if (cachedKey && Date.now() - cachedKey.fetchedAt < 5 * 60_000) return cachedKey.value;
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ARN }));
  let key: unknown;
  try {
    key = (JSON.parse(SecretString ?? '') as { private_key?: unknown }).private_key;
  } catch {
    throw new Error('GitHub App secret is not valid JSON');
  }
  if (typeof key !== 'string' || !key) throw new Error('GitHub App secret has no private_key');
  cachedKey = { value: key, fetchedAt: Date.now() };
  return key;
}

const appAuth = async () => createAppAuth({ appId: APP_ID, privateKey: await privateKey() });

export const handler = createTokenBroker({
  allowedRepos: ALLOWED_REPOS,
  appApi: async () => githubApi((await (await appAuth())({ type: 'app' })).token),
  issueToken: async (request) => (await appAuth())({ type: 'installation', ...request }),
});
