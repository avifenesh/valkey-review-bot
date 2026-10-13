import { fetchRepoInstallation, type GitHubApi } from './github.js';

/**
 * The token broker's checks. src/token-broker.ts wires them to the App
 * key in Secrets Manager.
 *
 * GitHub resolves repository names inside the installation a token is
 * requested from. So the caller's installation_id is checked against the
 * App's installation on the requested repository; otherwise another
 * installation of the App would give a token for a same-named repository
 * of another owner.
 */

// pull_requests:write covers everything a review does: reading the PR and
// its comments, posting the review, and writing the state comment. The
// requested set must be a subset of what the installation grants.
export const TOKEN_PERMISSIONS = { pull_requests: 'write', metadata: 'read' } as const;

export interface TokenRequest {
  readonly installationId: number;
  readonly repositoryNames: string[];
  readonly permissions: typeof TOKEN_PERMISSIONS;
}

export interface BrokerEvent {
  readonly installation_id?: unknown;
  readonly repo?: unknown;
}

export type BrokerResult = { token: string; expires_at: string } | { error: string };

export interface TokenBrokerDeps {
  /** Repositories ("owner/name") a token may be issued for. */
  readonly allowedRepos: readonly string[];
  /** GitHub REST authenticated as the App itself (JWT). */
  readonly appApi: () => Promise<GitHubApi>;
  /** An installation token, as @octokit/auth-app returns it. */
  readonly issueToken: (request: TokenRequest) => Promise<{ token: string; expiresAt: string }>;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
}

export function createTokenBroker(deps: TokenBrokerDeps): (event: BrokerEvent) => Promise<BrokerResult> {
  const allowed: ReadonlySet<string> = new Set(deps.allowedRepos.map((r) => r.toLowerCase()));
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;

  return async (event) => {
    const installationId = Number(event.installation_id);
    const repo = typeof event.repo === 'string' ? event.repo : '';
    const [owner, name, extra] = repo.split('/');
    if (!Number.isSafeInteger(installationId) || installationId <= 0) return { error: 'invalid installation_id' };
    if (!owner || !name || extra !== undefined) return { error: 'repo must be "owner/name"' };
    if (!allowed.has(repo.toLowerCase())) {
      warn(`[token-broker] refused repo=${repo}`);
      return { error: `repo ${repo} is not a routed repository` };
    }

    const installation = await fetchRepoInstallation(await deps.appApi(), repo);
    if (!installation) {
      warn(`[token-broker] refused repo=${repo}: the App is not installed there`);
      return { error: `the App is not installed on ${repo}` };
    }
    // The account check catches a repository GitHub redirects to a new owner.
    if (installation.id !== installationId || installation.account.toLowerCase() !== owner.toLowerCase()) {
      warn(`[token-broker] refused repo=${repo} installation=${installationId}: the App's installation is ${installation.id} on ${installation.account}`);
      return { error: `installation ${installationId} is not the App's installation on ${repo}` };
    }

    const result = await deps.issueToken({ installationId, repositoryNames: [name], permissions: TOKEN_PERMISSIONS });
    log(`[token-broker] issued repo=${repo} installation=${installationId} expires=${result.expiresAt}`);
    return { token: result.token, expires_at: result.expiresAt };
  };
}
