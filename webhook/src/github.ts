import { createAppAuth } from '@octokit/auth-app';
import type { GitHubUser } from './config.js';

/** The webhook payload fields this package reads. GitHub sends many more. */
export interface WebhookPayload {
  readonly action?: string;
  readonly installation?: { readonly id?: number };
  readonly repository?: { readonly full_name?: string };
  readonly sender?: GitHubUser;
  readonly pull_request?: {
    readonly number?: number;
    readonly user?: GitHubUser;
    readonly head?: { readonly sha?: string };
    readonly draft?: boolean;
  };
  readonly issue?: {
    readonly number?: number;
    readonly user?: GitHubUser;
    /** Present only when the issue is a pull request. */
    readonly pull_request?: unknown;
  };
  readonly comment?: {
    readonly id?: number;
    readonly body?: string | null;
    readonly user?: GitHubUser;
    readonly author_association?: string;
    /** Review comments only: the id of the thread's first comment. */
    readonly in_reply_to_id?: number;
    readonly path?: string;
    readonly line?: number | null;
    readonly original_line?: number | null;
  };
  readonly review?: {
    readonly id?: number;
    readonly body?: string | null;
    readonly user?: GitHubUser;
    readonly author_association?: string;
  };
}

/** The GitHub App secret in Secrets Manager. Fields are checked where they are used. */
export interface AppSecret {
  readonly webhookSecret?: string;
  readonly privateKey?: string;
  readonly appId?: string;
}

/**
 * Parses the secret JSON. JSON.parse errors quote part of the input, so
 * they are replaced with a message that carries none of the secret.
 */
export function parseAppSecret(secretString: string | undefined): AppSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString ?? '');
  } catch {
    throw new Error('GitHub App secret is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('GitHub App secret is not a JSON object');
  const s = parsed as { webhook_secret?: unknown; private_key?: unknown; app_id?: unknown };
  return {
    ...(typeof s.webhook_secret === 'string' && s.webhook_secret ? { webhookSecret: s.webhook_secret } : {}),
    ...(typeof s.private_key === 'string' && s.private_key ? { privateKey: s.private_key } : {}),
    ...(typeof s.app_id === 'string' || typeof s.app_id === 'number' ? { appId: String(s.app_id) } : {}),
  };
}

export interface AppSecretSource {
  /** The cached secret, fetched when older than five minutes. */
  get(): Promise<AppSecret>;
  /**
   * Fetches the secret again, for example after a signature mismatch
   * that may mean the webhook secret was rotated. At most once a minute,
   * so a stream of forged requests cannot turn into a stream of Secrets
   * Manager calls; inside that window it returns the cached secret.
   */
  refresh(): Promise<AppSecret>;
}

export function createAppSecretSource(
  fetchSecretString: () => Promise<string | undefined>,
  now: () => number = Date.now,
): AppSecretSource {
  const maxAgeMs = 5 * 60_000;
  const minRefreshMs = 60_000;
  let cached: { secret: AppSecret; fetchedAt: number } | null = null;
  const load = async (): Promise<AppSecret> => {
    const secret = parseAppSecret(await fetchSecretString());
    cached = { secret, fetchedAt: now() };
    return secret;
  };
  return {
    get: () => (cached && now() - cached.fetchedAt < maxAgeMs ? Promise.resolve(cached.secret) : load()),
    refresh: () => (cached && now() - cached.fetchedAt < minRefreshMs ? Promise.resolve(cached.secret) : load()),
  };
}

/** Installation tokens, cached until a minute before they expire. */
export function createInstallationTokens(secrets: AppSecretSource): (installationId: number) => Promise<string> {
  const cache = new Map<number, { token: string; expiresAt: number }>();
  return async (installationId) => {
    const hit = cache.get(installationId);
    if (hit && hit.expiresAt - Date.now() > 60_000) return hit.token;
    const { privateKey, appId } = await secrets.get();
    if (!privateKey || !appId) throw new Error('GitHub App secret has no private_key or app_id');
    const auth = createAppAuth({ appId, privateKey, installationId });
    const { token, expiresAt } = await auth({ type: 'installation' });
    cache.set(installationId, { token, expiresAt: new Date(expiresAt).getTime() });
    return token;
  };
}

export interface GitHubResponse {
  readonly status: number;
  /** Parsed JSON body, or {} when the body is empty or not JSON. */
  readonly json: unknown;
}

/** A REST call against api.github.com, authenticated as one installation. */
export type GitHubApi = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<GitHubResponse>;

/** The receiver has 30 seconds per delivery; no single GitHub call may use most of it. */
const GITHUB_TIMEOUT_MS = 8_000;

export function githubApi(token: string, fetchImpl: typeof fetch = fetch): GitHubApi {
  return async (method, path, body) => {
    const resp = await fetchImpl(`https://api.github.com/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    let json: unknown = {};
    try {
      json = await resp.json();
    } catch {
      // Empty or non-JSON body; callers go by the status.
    }
    return { status: resp.status, json };
  };
}

export interface ReviewComment {
  readonly body: string;
  readonly author?: string;
  readonly path?: string;
  readonly line?: number;
}

/** One pull request review comment, or undefined when GitHub does not return it. */
export async function fetchReviewComment(api: GitHubApi, repo: string, commentId: number): Promise<ReviewComment | undefined> {
  const { status, json } = await api('GET', `repos/${repo}/pulls/comments/${commentId}`);
  if (status !== 200) return undefined;
  const c = json as { body?: string | null; user?: GitHubUser; path?: string; line?: number | null; original_line?: number | null };
  const line = c.line ?? c.original_line;
  return {
    body: c.body ?? '',
    ...(c.user?.login ? { author: c.user.login } : {}),
    ...(c.path ? { path: c.path } : {}),
    ...(typeof line === 'number' ? { line } : {}),
  };
}
