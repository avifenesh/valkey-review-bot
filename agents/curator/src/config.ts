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

export function loadEnv(env: Env = process.env): CuratorEnv {
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

/** Load prompt.md and, when configured, skill.md. Both are read once per container. */
export async function loadAssets(env: CuratorEnv): Promise<{ prompt: string; skill: string }> {
  const s3 = new S3Client({ region: env.region });
  try {
    const [prompt, skill] = await Promise.all([
      fetchS3(s3, env.assetsBucket, env.promptKey),
      env.skillKey ? fetchS3(s3, env.assetsBucket, env.skillKey) : Promise.resolve(''),
    ]);
    return { prompt, skill };
  } finally {
    s3.destroy();
  }
}
