import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { createAppAuth } from '@octokit/auth-app';

/**
 * Token broker for the reviewer runtimes.
 *
 * The runtimes build and run code from the pull request under review, so
 * they must not hold the GitHub App private key. Instead they invoke this
 * function (IAM lambda:InvokeFunction) and get a short-lived installation
 * token limited to the one repository being reviewed and to the
 * permissions a review needs. Repositories outside the routed set are
 * refused.
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
const ALLOWED_REPOS: ReadonlySet<string> = new Set(
  (JSON.parse(required('ALLOWED_REPOS_JSON')) as string[]).map((r) => r.toLowerCase()),
);

// pull_requests:write covers everything a review does: reading the PR and
// its comments, posting the review, and writing the state comment. The
// requested set must be a subset of what the installation grants.
const TOKEN_PERMISSIONS = { pull_requests: 'write', metadata: 'read' } as const;

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

export async function handler(event: { installation_id?: unknown; repo?: unknown }): Promise<{ token: string; expires_at: string } | { error: string }> {
  const installationId = Number(event.installation_id);
  const repo = typeof event.repo === 'string' ? event.repo : '';
  const [owner, name, extra] = repo.split('/');
  if (!Number.isSafeInteger(installationId) || installationId <= 0) return { error: 'invalid installation_id' };
  if (!owner || !name || extra !== undefined) return { error: 'repo must be "owner/name"' };
  if (!ALLOWED_REPOS.has(repo.toLowerCase())) {
    console.warn(`[token-broker] refused repo=${repo}`);
    return { error: `repo ${repo} is not a routed repository` };
  }

  const auth = createAppAuth({ appId: APP_ID, privateKey: await privateKey() });
  const result = await auth({
    type: 'installation',
    installationId,
    repositoryNames: [name],
    permissions: TOKEN_PERMISSIONS,
  });
  console.log(`[token-broker] issued repo=${repo} installation=${installationId} expires=${result.expiresAt}`);
  return { token: result.token, expires_at: result.expiresAt };
}
