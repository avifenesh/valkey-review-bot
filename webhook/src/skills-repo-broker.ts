import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createAppAuth } from '@octokit/auth-app';
import { createAppSecretSource, fetchRepoInstallation, githubApi, type GitHubApi } from './github.js';

/**
 * Skills-repo token broker.
 *
 * The curator's maintenance mode proposes repo-skill edits
 * (agents/<reviewer>/config/skill.md) as pull requests against the bot's
 * own repository. It never holds the App key: it invokes this function
 * (IAM lambda:InvokeFunction, granted to the curator role only) and gets
 * an installation token limited to that one repository, with contents
 * and pull_requests write.
 *
 * The repository comes from SKILLS_REPO, and the installation is the
 * App's installation on it, looked up as the App. Nothing in the payload
 * picks a repository or an installation; only an optional purpose string
 * is read, for the log line. The token itself is never logged.
 *
 * Env:    SKILLS_REPO ("owner/name"), SKILLS_REPO_APP_SECRET_NAME (a
 *         Secrets Manager secret of the same JSON shape as the main App
 *         secret: app_id and private_key)
 * Input:  { purpose?: string }
 * Output: { token, expires_at } or { error }
 */

// Contents write for the branch and commit, pull_requests write for the
// pull request. The installation must grant both, or GitHub refuses.
export const SKILLS_REPO_TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write', metadata: 'read' } as const;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const PURPOSE_MAX_CHARS = 80;

export interface SkillsRepoTokenRequest {
  readonly installationId: number;
  readonly repositoryNames: string[];
  readonly permissions: typeof SKILLS_REPO_TOKEN_PERMISSIONS;
}

export type SkillsRepoBrokerResult = { token: string; expires_at: string } | { error: string };

export interface SkillsRepoBrokerDeps {
  /** The bot's repository, "owner/name". */
  readonly repo: string;
  /** GitHub REST authenticated as the App itself (JWT). */
  readonly appApi: () => Promise<GitHubApi>;
  /** An installation token, as @octokit/auth-app returns it. */
  readonly issueToken: (request: SkillsRepoTokenRequest) => Promise<{ token: string; expiresAt: string }>;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

/** The purpose as it may appear in a log line: printable, short, no spaces. */
function logPurpose(event: unknown): string {
  const raw = (event as { purpose?: unknown } | null | undefined)?.purpose;
  if (typeof raw !== 'string' || !raw) return '-';
  return raw.slice(0, PURPOSE_MAX_CHARS).replace(/[^\w.:#@/-]/g, '_');
}

export function createSkillsRepoBroker(deps: SkillsRepoBrokerDeps): (event: unknown) => Promise<SkillsRepoBrokerResult> {
  if (!REPO_RE.test(deps.repo)) throw new Error(`SKILLS_REPO must be "owner/name", got ${JSON.stringify(deps.repo)}`);
  const repo = deps.repo;
  const [owner, name] = repo.split('/') as [string, string];
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;

  return async (event) => {
    const purpose = logPurpose(event);
    const installation = await fetchRepoInstallation(await deps.appApi(), repo);
    if (!installation) {
      warn(`[skills-repo-broker] refused repo=${repo} purpose=${purpose}: the App is not installed there`);
      return { error: `the App is not installed on ${repo}` };
    }
    // The account check catches a repository GitHub redirects to a new owner.
    if (installation.account.toLowerCase() !== owner.toLowerCase()) {
      warn(`[skills-repo-broker] refused repo=${repo} purpose=${purpose}: the App's installation ${installation.id} is on ${installation.account}`);
      return { error: `the App's installation for ${repo} belongs to ${installation.account}` };
    }

    const result = await deps.issueToken({
      installationId: installation.id,
      repositoryNames: [name],
      permissions: SKILLS_REPO_TOKEN_PERMISSIONS,
    });
    log(`[skills-repo-broker] issued repo=${repo} installation=${installation.id} expires=${result.expiresAt} purpose=${purpose}`);
    return { token: result.token, expires_at: result.expiresAt };
  };
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

/**
 * The broker wired to the App secret. `secretString` returns the secret
 * JSON; it is cached for five minutes. A new auth instance per token
 * keeps @octokit/auth-app from handing out a cached token that is close
 * to expiry.
 */
export function skillsRepoBrokerFromEnv(
  env: Env,
  secretString: () => Promise<string | undefined>,
  opts: { createAuth?: typeof createAppAuth; fetch?: typeof fetch } = {},
): (event: unknown) => Promise<SkillsRepoBrokerResult> {
  const repo = required(env, 'SKILLS_REPO');
  const createAuth = opts.createAuth ?? createAppAuth;
  const secrets = createAppSecretSource(secretString);
  const appAuth = async () => {
    const { appId, privateKey } = await secrets.get();
    if (!appId || !privateKey) throw new Error('skills-repo App secret has no app_id or private_key');
    return createAuth({ appId, privateKey });
  };
  return createSkillsRepoBroker({
    repo,
    appApi: async () => githubApi((await (await appAuth())({ type: 'app' })).token, opts.fetch),
    issueToken: async (request) => (await appAuth())({ type: 'installation', ...request }),
  });
}

let broker: ((event: unknown) => Promise<SkillsRepoBrokerResult>) | null = null;

export async function handler(event: unknown): Promise<SkillsRepoBrokerResult> {
  if (!broker) {
    const secretId = required(process.env, 'SKILLS_REPO_APP_SECRET_NAME');
    const sm = new SecretsManagerClient({});
    broker = skillsRepoBrokerFromEnv(process.env, async () =>
      (await sm.send(new GetSecretValueCommand({ SecretId: secretId }))).SecretString);
  }
  return broker(event);
}
