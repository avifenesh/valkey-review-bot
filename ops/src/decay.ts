import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, DeleteCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Daily decay pass over the concerns tables.
 *
 * A record's decay_score halves every DECAY_HALF_LIFE_SECONDS without
 * reinforcement. The curator sets the score to 1.0 and updated_at to
 * the current time on every reinforcement; this pass multiplies the
 * score by 0.5^(elapsed / half-life) since the score was last set and
 * stores the time in decayed_at. updated_at keeps meaning "last
 * reinforced".
 *
 * With the default 30-day half-life and 0.05 floor, a record nobody
 * reinforces is deleted after about 130 days (30 * log2(20)).
 *
 * Records that graduated into a skill (graduated_record_name set) decay
 * on DECAY_GRADUATED_HALF_LIFE_SECONDS instead and are never deleted:
 * they are the skill's provenance. A retired skill's record (retired_at
 * set) is a tombstone and is left as it is.
 *
 * Writes are conditioned on the updated_at, decayed_at and decay_score
 * the scan saw, so a record reinforced, or re-scored by the curator,
 * while the pass runs is skipped rather than decayed or deleted.
 */

export interface DecayConfig {
  /** reviewer_id -> concerns table name. */
  readonly tables: Readonly<Record<string, string>>;
  readonly halfLifeSeconds: number;
  /** Records that never graduated are deleted when their score falls below this. */
  readonly floor: number;
  /** Half-life of records that graduated into a skill. */
  readonly graduatedHalfLifeSeconds: number;
}

const DAY_SECONDS = 24 * 3600;
const DEFAULT_HALF_LIFE_SECONDS = 30 * DAY_SECONDS;
const DEFAULT_GRADUATED_HALF_LIFE_SECONDS = 180 * DAY_SECONDS;
const DEFAULT_FLOOR = 0.05;

type Env = Readonly<Record<string, string | undefined>>;

function positiveNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a number greater than 0, got "${raw}"`);
  return value;
}

export function loadDecayConfig(env: Env): DecayConfig {
  const json = env.CONCERNS_TABLES_JSON?.trim();
  if (!json) throw new Error('env CONCERNS_TABLES_JSON is required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`CONCERNS_TABLES_JSON is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('CONCERNS_TABLES_JSON must be a JSON object of reviewer id to table name');
  }
  const tables: Record<string, string> = {};
  for (const [reviewerId, table] of Object.entries(parsed)) {
    if (typeof table !== 'string' || !table.trim()) throw new Error(`CONCERNS_TABLES_JSON.${reviewerId} must be a table name`);
    tables[reviewerId] = table.trim();
  }

  const floor = positiveNumber(env, 'DECAY_FLOOR', DEFAULT_FLOOR);
  if (floor >= 1) throw new Error(`DECAY_FLOOR must be below 1, got ${floor}`);
  return {
    tables,
    halfLifeSeconds: positiveNumber(env, 'DECAY_HALF_LIFE_SECONDS', DEFAULT_HALF_LIFE_SECONDS),
    floor,
    graduatedHalfLifeSeconds: positiveNumber(env, 'DECAY_GRADUATED_HALF_LIFE_SECONDS', DEFAULT_GRADUATED_HALF_LIFE_SECONDS),
  };
}

/** Score after `elapsedSeconds` of half-life decay from `score`. */
export function decayedScore(score: number, elapsedSeconds: number, halfLifeSeconds: number): number {
  return score * Math.pow(0.5, Math.max(0, elapsedSeconds) / halfLifeSeconds);
}

interface SendClient {
  send(command: object): Promise<any>;
}

export interface Stats {
  readonly table: string;
  readonly scanned: number;
  readonly decayed: number;
  readonly deleted: number;
  /** Reinforced or decayed by someone else between the scan and the write. */
  readonly skipped: number;
  readonly errors: number;
  /** Tombstones of retired skills, left unwritten. */
  readonly keptRetired: number;
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

/**
 * Condition and values that match a record only in the state the scan
 * read: the same updated_at, decayed_at and decay_score, or each one
 * still absent. Uses #ua, #da and #ds.
 */
function stateAsRead(updatedAt: string, decayedAt: string, decayScore: unknown): { unchanged: string; seen: Record<string, unknown> } {
  const seen: Record<string, unknown> = { ':ua': updatedAt };
  const parts = ['#ua = :ua'];
  if (decayedAt) {
    parts.push('#da = :da');
    seen[':da'] = decayedAt;
  } else {
    parts.push('attribute_not_exists(#da)');
  }
  if (decayScore === undefined) {
    parts.push('attribute_not_exists(#ds)');
  } else {
    parts.push('#ds = :ds');
    seen[':ds'] = decayScore;
  }
  return { unchanged: parts.join(' AND '), seen };
}

const SCAN_ATTRIBUTES = {
  '#b': 'area_bucket',
  '#rid': 'record_id',
  '#ds': 'decay_score',
  '#ua': 'updated_at',
  '#da': 'decayed_at',
  '#grn': 'graduated_record_name',
  '#ret': 'retired_at',
} as const;

const stringOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');

export async function decayTable(ddb: SendClient, tableName: string, config: DecayConfig, nowMs: number): Promise<Stats> {
  let scanned = 0;
  let decayed = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;
  let keptRetired = 0;
  let cursor: Record<string, unknown> | undefined;
  const nowIso = new Date(nowMs).toISOString();

  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: tableName,
      ExclusiveStartKey: cursor,
      Limit: 200,
      ProjectionExpression: Object.keys(SCAN_ATTRIBUTES).join(', '),
      ExpressionAttributeNames: SCAN_ATTRIBUTES,
    }));
    cursor = resp.LastEvaluatedKey;

    for (const item of (resp.Items ?? []) as Record<string, unknown>[]) {
      scanned += 1;
      const areaBucket = item.area_bucket;
      const recordId = item.record_id;
      const updatedAt = stringOrEmpty(item.updated_at);
      const decayedAt = stringOrEmpty(item.decayed_at);
      const updatedMs = Date.parse(updatedAt);
      if (typeof areaBucket !== 'string' || typeof recordId !== 'string' || !Number.isFinite(updatedMs)) {
        errors += 1;
        console.warn(`[decay] ${tableName}: record without area_bucket, record_id or a valid updated_at: ${JSON.stringify(item).slice(0, 200)}`);
        continue;
      }

      const graduated = stringOrEmpty(item.graduated_record_name) !== '';
      if (graduated && item.retired_at !== undefined) {
        keptRetired += 1;
        continue;
      }

      // The score was last set at whichever is later: the last
      // reinforcement or the last decay pass.
      const decayedMs = Date.parse(decayedAt);
      const since = Number.isFinite(decayedMs) && decayedMs > updatedMs ? decayedMs : updatedMs;
      const score = typeof item.decay_score === 'number' ? item.decay_score : 1.0;
      const halfLife = graduated ? config.graduatedHalfLifeSeconds : config.halfLifeSeconds;
      const nextScore = decayedScore(score, (nowMs - since) / 1000, halfLife);

      const { unchanged, seen } = stateAsRead(updatedAt, decayedAt, item.decay_score);
      const key = { area_bucket: areaBucket, record_id: recordId };

      try {
        if (!graduated && nextScore < config.floor) {
          // A record that graduates between the scan and this write keeps
          // its provenance.
          await ddb.send(new DeleteCommand({
            TableName: tableName,
            Key: key,
            ConditionExpression: `${unchanged} AND attribute_not_exists(#grn)`,
            ExpressionAttributeNames: { '#ua': 'updated_at', '#da': 'decayed_at', '#ds': 'decay_score', '#grn': 'graduated_record_name' },
            ExpressionAttributeValues: seen,
          }));
          deleted += 1;
        } else {
          await ddb.send(new UpdateCommand({
            TableName: tableName,
            Key: key,
            UpdateExpression: 'SET #ds = :s, #da = :now',
            ConditionExpression: unchanged,
            ExpressionAttributeNames: { '#ds': 'decay_score', '#ua': 'updated_at', '#da': 'decayed_at' },
            ExpressionAttributeValues: { ...seen, ':s': nextScore, ':now': nowIso },
          }));
          decayed += 1;
        }
      } catch (err) {
        if (isConditionFailure(err)) {
          skipped += 1;
          continue;
        }
        errors += 1;
        console.warn(`[decay] write failed for ${tableName} ${areaBucket} ${recordId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } while (cursor);

  return { table: tableName, scanned, decayed, deleted, skipped, errors, keptRetired };
}

let client: DynamoDBDocumentClient | undefined;

export async function handler(): Promise<{ tables: readonly Stats[] }> {
  const config = loadDecayConfig(process.env);
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const now = Date.now();
  const out: Stats[] = [];
  for (const tableName of Object.values(config.tables)) {
    const s = await decayTable(client, tableName, config, now);
    console.log(`[decay] ${s.table} scanned=${s.scanned} decayed=${s.decayed} deleted=${s.deleted} skipped=${s.skipped} errors=${s.errors} kept_retired=${s.keptRetired}`);
    out.push(s);
  }
  return { tables: out };
}
