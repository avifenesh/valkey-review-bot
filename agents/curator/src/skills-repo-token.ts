import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';

/**
 * GitHub token for pull requests against the bot's own repository.
 *
 * The curator never holds a GitHub App key. It invokes the skills-repo
 * token broker (webhook/src/skills-repo-broker.ts), which issues an
 * installation token for that one repository with contents and
 * pull_requests write. The broker takes no repository or installation
 * from the caller, so the payload only names the purpose, for its logs.
 *
 * The token is cached until five minutes before it expires. It is never
 * logged, and no error message carries it.
 */

export interface SkillsRepoTokenSource {
  /** A token valid for at least the next five minutes. */
  get(): Promise<string>;
}

const REFRESH_BEFORE_EXPIRY_MS = 5 * 60_000;
const ERROR_MAX_CHARS = 200;

function invokeBroker(functionName: string, region: string): (payload: object) => Promise<unknown> {
  const lambda = new LambdaClient({ region });
  return async (payload) => {
    const resp = await lambda.send(new InvokeCommand({
      FunctionName: functionName,
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
    if (resp.FunctionError) throw new Error(`skills-repo token broker failed (${resp.FunctionError})`);
    try {
      return JSON.parse(Buffer.from(resp.Payload ?? new Uint8Array()).toString('utf8')) as unknown;
    } catch {
      throw new Error('skills-repo token broker returned a payload that is not JSON');
    }
  };
}

export function createSkillsRepoTokenSource(opts: {
  functionName: string;
  region: string;
  /** Invokes the broker and returns its parsed response. Defaults to a Lambda Invoke of functionName. */
  invoke?: (payload: object) => Promise<unknown>;
  /** Clock in milliseconds, for tests. */
  now?: () => number;
}): SkillsRepoTokenSource {
  const invoke = opts.invoke ?? invokeBroker(opts.functionName, opts.region);
  const now = opts.now ?? Date.now;
  let current: { token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const out = await invoke({ purpose: 'curator repo skill pull request' });
    const { token, expires_at: expiresAt, error } = (typeof out === 'object' && out !== null ? out : {}) as
      { token?: unknown; expires_at?: unknown; error?: unknown };
    const expiry = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
    if (typeof token !== 'string' || !token || !Number.isFinite(expiry)) {
      const why = typeof error === 'string' && error ? error.slice(0, ERROR_MAX_CHARS) : 'no token and expiry returned';
      throw new Error(`skills-repo token broker refused: ${why}`);
    }
    current = { token, expiresAt: expiry };
    return token;
  }

  return {
    async get(): Promise<string> {
      if (current && current.expiresAt - now() > REFRESH_BEFORE_EXPIRY_MS) return current.token;
      // One fetch at a time; concurrent callers share it.
      pending ??= fetchToken().finally(() => { pending = null; });
      return pending;
    },
  };
}
