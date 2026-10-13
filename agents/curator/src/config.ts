import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

export interface CuratorEnv {
  readonly modelId: string;
  readonly fallbackModelId: string;
  readonly mantleRegion: string;
  readonly reasoningEffort: string;
  readonly fallbackReasoningEffort: string;
  readonly region: string;
  readonly assetsBucket: string;
  readonly promptKey: string;
  /** S3 key of the curator's skill.md. Empty means the curator runs on the prompt alone. */
  readonly skillKey: string;
  /** reviewer_id -> concerns table name. */
  readonly concernsTables: Readonly<Record<string, string>>;
  /** reviewer_id -> skills registry id, the registry submit_skill writes to. */
  readonly skillsRegistries: Readonly<Record<string, string>>;
  /**
   * The curator's own skills registry, read by list_skill_authoring.
   * Empty means not configured; the curator then follows the prompt's
   * inline authoring rules.
   */
  readonly curatorSkillsRegistryId: string;
  /** reinforcement_count a concern needs before submit_skill accepts it. */
  readonly graduationThreshold: number;
  /** Tool-call rounds before the run is stopped. */
  readonly maxIterations: number;
  readonly maxTokens: number;

  // Skill maintenance (maintenance.ts). Every switch that changes a
  // skill or opens a pull request is off unless set: report mode.

  /**
   * reviewer_id -> public upstream "owner/name" whose default branch the
   * release check reads. A reviewer without one gets no checks.
   */
  readonly upstreamRepos: Readonly<Record<string, string>>;
  /** S3 key of the audit prompt, config/skill-check.md. Empty: a flagged skill ends inconclusive. */
  readonly checkPromptKey: string;
  /** Tool rounds of one audit. */
  readonly checkMaxRounds: number;
  /** Write validated edits to registry skills. Off: they are kept in pending_revision. */
  readonly checkApplyEdits: boolean;
  /** Deprecate a skill on a retire message. Off: the retirement is only reported. */
  readonly retireSkills: boolean;
  /** Propose edits to the reviewers' repo skill files by pull request. Off: report only. */
  readonly checkOpenPullRequests: boolean;
  /** The bot's own repository, where repo skill files live; null when not configured. */
  readonly skillsRepo: SkillsRepoSettings | null;
  /** Directory the per-run upstream checkouts are made in. */
  readonly checkDir: string;
}

export interface SkillsRepoSettings {
  /** "owner/name" of the bot's repository. */
  readonly repo: string;
  readonly baseBranch: string;
  /** "Name <email>" for the commit's sign-off line; empty for the App's bot identity. */
  readonly signOff: string;
  /** The skills-repo token broker Lambda; empty when not configured, and then no pull request is opened. */
  readonly tokenFunction: string;
}

type Env = Readonly<Record<string, string | undefined>>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`required env var ${key} is not set`);
  return value;
}

/** Integer setting with a default, rejected outside [min, max] instead of becoming NaN. */
export function intSetting(env: Env, key: string, fallback: number, min: number, max: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${key} must be an integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) throw new Error(`${key} must be between ${min} and ${max}, got ${value}`);
  return value;
}

/** A JSON object whose values are all non-empty strings, keyed by reviewer id. */
export function parseReviewerMap(key: string, json: string): Record<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`${key} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object of reviewer id to name`);
  }
  const out: Record<string, string> = {};
  for (const [reviewerId, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`${key}.${reviewerId} must be a non-empty string`);
    }
    out[reviewerId] = value.trim();
  }
  if (Object.keys(out).length === 0) throw new Error(`${key} has no entries`);
  return out;
}

/** 'true' or 'false'; unset is false. */
export function boolSetting(env: Env, key: string): boolean {
  const raw = env[key]?.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${key} must be "true" or "false", got "${raw}"`);
}

/** A GitHub "owner/name", the shape the deployment config and ops/src/releases.ts accept. */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isRepoName(repo: string): boolean {
  if (!REPO_RE.test(repo)) return false;
  const name = repo.slice(repo.indexOf('/') + 1);
  return name !== '.' && name !== '..';
}

/**
 * UPSTREAM_REPOS_JSON: reviewer_id -> "owner/name". Unlike the other
 * reviewer maps it may be unset or empty, and an empty value means the
 * reviewer has no upstream, so its skills get no checks.
 */
export function parseUpstreamRepos(json: string | undefined): Record<string, string> {
  if (!json?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`UPSTREAM_REPOS_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('UPSTREAM_REPOS_JSON must be a JSON object of reviewer id to owner/name');
  }
  const out: Record<string, string> = {};
  for (const [reviewerId, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') throw new Error(`UPSTREAM_REPOS_JSON.${reviewerId} must be a string`);
    const repo = value.trim();
    if (!repo) continue;
    if (!isRepoName(repo)) throw new Error(`UPSTREAM_REPOS_JSON.${reviewerId} must look like "owner/name", got "${value}"`);
    out[reviewerId] = repo;
  }
  return out;
}

/** A branch name git accepts and a marker or URL can carry. */
const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\/$)(?!.*\.$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
/** "Name <email>", one line. */
const SIGN_OFF_RE = /^[^<>\r\n]{1,100} <[^<>\s@]{1,64}@[^<>\s@]{1,190}>$/;
/** A Lambda function name or ARN. */
const FUNCTION_RE = /^(?:arn:aws[a-z-]*:lambda:[a-z0-9-]+:\d{12}:function:)?[A-Za-z0-9_-]{1,64}(?::[A-Za-z0-9_$-]{1,128})?$/;

function skillsRepoSettings(env: Env, openPullRequests: boolean): SkillsRepoSettings | null {
  const repo = env.SKILLS_REPO?.trim() ?? '';
  if (!repo) return null;
  if (!isRepoName(repo)) throw new Error(`SKILLS_REPO must look like "owner/name", got "${repo}"`);
  const baseBranch = env.SKILLS_REPO_BASE_BRANCH?.trim() || 'main';
  if (!BRANCH_RE.test(baseBranch)) throw new Error(`SKILLS_REPO_BASE_BRANCH is not a branch name: "${baseBranch}"`);
  const signOff = env.SKILLS_REPO_SIGN_OFF?.trim() ?? '';
  if (signOff && !SIGN_OFF_RE.test(signOff)) throw new Error(`SKILLS_REPO_SIGN_OFF must look like "Name <email>", got "${signOff}"`);
  const tokenFunction = env.SKILLS_REPO_TOKEN_FUNCTION?.trim() ?? '';
  if (tokenFunction && !FUNCTION_RE.test(tokenFunction)) throw new Error(`SKILLS_REPO_TOKEN_FUNCTION is not a Lambda function name: "${tokenFunction}"`);
  if (openPullRequests && !tokenFunction) {
    throw new Error('SKILLS_REPO_TOKEN_FUNCTION is required when CHECK_OPEN_PULL_REQUESTS is true and SKILLS_REPO is set');
  }
  return { repo, baseBranch, signOff, tokenFunction };
}

function checkDir(env: Env): string {
  const dir = env.SKILL_CHECK_DIR?.trim() || '/tmp/skill-check';
  if (!dir.startsWith('/') || dir === '/' || dir.split('/').includes('..')) {
    throw new Error(`SKILL_CHECK_DIR must be an absolute directory other than /, got "${dir}"`);
  }
  return dir.replace(/\/+$/, '');
}

export function loadEnv(env: Env = process.env): CuratorEnv {
  const checkOpenPullRequests = boolSetting(env, 'CHECK_OPEN_PULL_REQUESTS');
  return {
    modelId: required(env, 'BEDROCK_MODEL_ID'),
    fallbackModelId: required(env, 'FALLBACK_MODEL_ID'),
    mantleRegion: required(env, 'MANTLE_REGION'),
    reasoningEffort: env.REASONING_EFFORT?.trim() || 'medium',
    fallbackReasoningEffort: env.FALLBACK_REASONING_EFFORT?.trim() || 'high',
    region: required(env, 'AWS_REGION'),
    assetsBucket: required(env, 'ASSETS_BUCKET'),
    promptKey: required(env, 'PROMPT_S3_KEY'),
    skillKey: env.SKILL_S3_KEY?.trim() ?? '',
    concernsTables: parseReviewerMap('CONCERNS_TABLES_JSON', required(env, 'CONCERNS_TABLES_JSON')),
    skillsRegistries: parseReviewerMap('SKILLS_REGISTRIES_JSON', required(env, 'SKILLS_REGISTRIES_JSON')),
    curatorSkillsRegistryId: env.CURATOR_SKILLS_REGISTRY_ID?.trim() ?? '',
    // A threshold of 1 would turn a single comment into a reviewer skill.
    graduationThreshold: intSetting(env, 'GRADUATION_THRESHOLD', 4, 2, 100),
    maxIterations: intSetting(env, 'MAX_ITERATIONS', 40, 1, 500),
    maxTokens: intSetting(env, 'MAX_TOKENS', 16384, 1024, 200_000),
    upstreamRepos: parseUpstreamRepos(env.UPSTREAM_REPOS_JSON),
    checkPromptKey: env.CHECK_PROMPT_S3_KEY?.trim() ?? '',
    checkMaxRounds: intSetting(env, 'CHECK_MAX_ROUNDS', 25, 5, 100),
    checkApplyEdits: boolSetting(env, 'CHECK_APPLY_EDITS'),
    retireSkills: boolSetting(env, 'RETIRE_SKILLS'),
    checkOpenPullRequests,
    skillsRepo: skillsRepoSettings(env, checkOpenPullRequests),
    checkDir: checkDir(env),
  };
}

/**
 * Replace `{{NAME}}` placeholders. A placeholder without a value is an
 * error, so a typo in prompt.md fails at boot instead of reaching the
 * model as literal braces.
 */
export function renderTemplate(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`no value for template placeholder {{${name}}}`);
    return value;
  });
}

async function fetchS3(s3: S3Client, bucket: string, key: string): Promise<string> {
  const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!resp.Body) throw new Error(`empty S3 object ${bucket}/${key}`);
  const chunks: Uint8Array[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Load prompt.md and, when configured, skill.md and the release check's
 * audit prompt (skill-check.md). All are read once per container.
 */
export async function loadAssets(env: CuratorEnv): Promise<{ prompt: string; skill: string; checkPrompt: string }> {
  const s3 = new S3Client({ region: env.region });
  const optional = (key: string) => (key ? fetchS3(s3, env.assetsBucket, key) : Promise.resolve(''));
  try {
    const [prompt, skill, checkPrompt] = await Promise.all([
      fetchS3(s3, env.assetsBucket, env.promptKey),
      optional(env.skillKey),
      optional(env.checkPromptKey),
    ]);
    return { prompt, skill, checkPrompt };
  } finally {
    s3.destroy();
  }
}
