import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, DeleteCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { isRepoName, latestReleaseTag, RELEASE_TAG_RE } from './releases.js';

/**
 * Daily decay pass over the concerns tables, and the scheduler of the
 * curator's skill maintenance.
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
 * For a live graduated record the pass queues work for the curator on
 * the curator queue (see MaintenanceMessage):
 * - "retire" when its score falls below the floor. With RETIRE_SKILLS
 *   off, or in a dry run, it only logs would-retire.
 * - "check" when a fact check is due: the record was never checked, it
 *   was re-published since its last check, the highest GA release of
 *   the reviewer's upstream differs from the one it was checked at, or
 *   the last check is older than SKILL_RECHECK_SECONDS.
 * The request is claimed on the record (maintenance_*) in the same write
 * that stores the decayed score, then sent. A record with a request
 * younger than MAINTENANCE_RETRY_DAYS gets no new one, so a request the
 * curator never finished is retried after that window. Per-pass caps
 * bound what lands on the queue, which also carries maintainer feedback.
 *
 * Once per reviewer and GA release the pass also queues a "repo_check"
 * of the reviewer's skill.md in this repository. The item at
 * REPO_SKILL_KEY in the reviewer's concerns table holds that claim and
 * the release the file was last checked at. Its area_bucket starts with
 * RESERVED_BUCKET_PREFIX: such items are not concern records, and the
 * pass never scores, deletes or queues them as records.
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
  /** reviewer_id -> upstream owner/name whose releases trigger checks. Reviewers without one get no checks. */
  readonly upstreamRepos: Readonly<Record<string, string>>;
  /** Queue the curator reads; '' when checks and retirement are both off. */
  readonly curatorQueueUrl: string;
  /** Check requests per reviewer per pass; 0 turns checks off. */
  readonly checksPerDay: number;
  /** A check is also due when the last one is older than this. */
  readonly recheckSeconds: number;
  /** Off: retirement candidates are logged as would-retire and nothing is queued for them. */
  readonly retireSkills: boolean;
  /** Retire requests per reviewer per pass. */
  readonly maxRetirementsPerDay: number;
}

const DAY_SECONDS = 24 * 3600;
const DEFAULT_HALF_LIFE_SECONDS = 30 * DAY_SECONDS;
const DEFAULT_GRADUATED_HALF_LIFE_SECONDS = 180 * DAY_SECONDS;
const DEFAULT_FLOOR = 0.05;
const DEFAULT_RECHECK_SECONDS = 90 * DAY_SECONDS;
const DEFAULT_CHECKS_PER_DAY = 10;
const DEFAULT_MAX_RETIREMENTS_PER_DAY = 3;

/** A maintenance request younger than this is in flight: the record gets no new one. */
export const MAINTENANCE_RETRY_DAYS = 7;
/** Check requests are spread out by this much each, so they do not crowd out feedback. */
const CHECK_STAGGER_SECONDS = 60;
/** The SQS maximum for DelaySeconds. */
const MAX_DELAY_SECONDS = 900;

type Env = Readonly<Record<string, string | undefined>>;

function positiveNumber(env: Env, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a number greater than 0, got "${raw}"`);
  return value;
}

function integerSetting(env: Env, key: string, fallback: number, min: number): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) throw new Error(`${key} must be an integer of at least ${min}, got "${raw}"`);
  return value;
}

function booleanSetting(env: Env, key: string): boolean {
  const raw = env[key]?.trim();
  if (!raw || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error(`${key} must be "true" or "false", got "${raw}"`);
}

/** A JSON object setting keyed by reviewer id; null when unset. */
function reviewerMap(env: Env, key: string, what: string): Record<string, unknown> | null {
  const json = env[key]?.trim();
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`${key} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${key} must be a JSON object of reviewer id to ${what}`);
  }
  return parsed as Record<string, unknown>;
}

export function loadDecayConfig(env: Env): DecayConfig {
  const tablesRaw = reviewerMap(env, 'CONCERNS_TABLES_JSON', 'table name');
  if (!tablesRaw) throw new Error('env CONCERNS_TABLES_JSON is required');
  const tables: Record<string, string> = {};
  for (const [reviewerId, table] of Object.entries(tablesRaw)) {
    if (typeof table !== 'string' || !table.trim()) throw new Error(`CONCERNS_TABLES_JSON.${reviewerId} must be a table name`);
    tables[reviewerId] = table.trim();
  }

  // An empty value, like an absent one, means no upstream: no checks for that reviewer.
  const upstreamRepos: Record<string, string> = {};
  for (const [reviewerId, repo] of Object.entries(reviewerMap(env, 'UPSTREAM_REPOS_JSON', 'owner/name') ?? {})) {
    if (typeof repo !== 'string') throw new Error(`UPSTREAM_REPOS_JSON.${reviewerId} must be a string`);
    if (!repo.trim()) continue;
    if (!isRepoName(repo.trim())) throw new Error(`UPSTREAM_REPOS_JSON.${reviewerId} must look like "owner/name", got "${repo}"`);
    upstreamRepos[reviewerId] = repo.trim();
  }

  const floor = positiveNumber(env, 'DECAY_FLOOR', DEFAULT_FLOOR);
  if (floor >= 1) throw new Error(`DECAY_FLOOR must be below 1, got ${floor}`);

  // Checks are on by default, so the queue is required unless the
  // deployment sets SKILL_CHECKS_PER_DAY=0 (and leaves RETIRE_SKILLS off).
  const checksPerDay = integerSetting(env, 'SKILL_CHECKS_PER_DAY', DEFAULT_CHECKS_PER_DAY, 0);
  const retireSkills = booleanSetting(env, 'RETIRE_SKILLS');
  const curatorQueueUrl = env.CURATOR_QUEUE_URL?.trim() ?? '';
  if ((checksPerDay > 0 || retireSkills) && !curatorQueueUrl) {
    throw new Error(`env CURATOR_QUEUE_URL is required when SKILL_CHECKS_PER_DAY is above 0 (default ${DEFAULT_CHECKS_PER_DAY}) or RETIRE_SKILLS is true`);
  }

  return {
    tables,
    halfLifeSeconds: positiveNumber(env, 'DECAY_HALF_LIFE_SECONDS', DEFAULT_HALF_LIFE_SECONDS),
    floor,
    graduatedHalfLifeSeconds: positiveNumber(env, 'DECAY_GRADUATED_HALF_LIFE_SECONDS', DEFAULT_GRADUATED_HALF_LIFE_SECONDS),
    upstreamRepos,
    curatorQueueUrl,
    checksPerDay,
    recheckSeconds: positiveNumber(env, 'SKILL_RECHECK_SECONDS', DEFAULT_RECHECK_SECONDS),
    retireSkills,
    maxRetirementsPerDay: integerSetting(env, 'MAX_RETIREMENTS_PER_DAY', DEFAULT_MAX_RETIREMENTS_PER_DAY, 1),
  };
}

/** Score after `elapsedSeconds` of half-life decay from `score`. */
export function decayedScore(score: number, elapsedSeconds: number, halfLifeSeconds: number): number {
  return score * Math.pow(0.5, Math.max(0, elapsedSeconds) / halfLifeSeconds);
}

/**
 * Maintenance messages, the body of each SQS message this pass sends to
 * the curator queue. Only identifiers and a GA tag: no skill text, no
 * repository and no URL. The curator maps reviewer_id to its upstream.
 *
 * maintenance_id is also stored on the record (with
 * maintenance_requested_at and maintenance_reason) before the send. The
 * curator acts only while the record's maintenance_id equals the
 * message's, and removes the three attributes when it is done.
 *
 * dry_run: report only. The curator runs the check and records and logs
 * the outcome, but makes no registry change and opens no pull request,
 * whatever its own settings say. Retire messages are never sent in a
 * dry run, so they always carry false.
 */
export interface CheckMessage {
  /** "check#<reviewer_id>#<record_id>#<ISO time of the pass>", at most 200 characters. */
  readonly maintenance_id: string;
  readonly reason: 'check';
  readonly reviewer_id: string;
  readonly area_bucket: string;
  readonly record_id: string;
  /** graduated_record_name: the registry record to check. */
  readonly record_name: string;
  /** Highest GA release of the upstream (RELEASE_TAG_RE), or '' when unknown. */
  readonly release_tag: string;
  /** updated_at as the pass read it. */
  readonly seen_updated_at: string;
  readonly dry_run: boolean;
}

export interface RetireMessage {
  /** "retire#<reviewer_id>#<record_id>#<ISO time of the pass>", at most 200 characters. */
  readonly maintenance_id: string;
  readonly reason: 'retire';
  readonly reviewer_id: string;
  readonly area_bucket: string;
  readonly record_id: string;
  readonly record_name: string;
  /** 'obsolete' when a check found the subject gone (obsolete_release set), else 'decayed'. */
  readonly retire_reason: 'decayed' | 'obsolete';
  /** updated_at as the pass read it; a decayed retirement is void once the record was reinforced. */
  readonly seen_updated_at: string;
  readonly dry_run: boolean;
}

/**
 * area_bucket values that start with this are reserved for items the
 * skill lifecycle keeps in a concerns table, such as REPO_SKILL_KEY. They
 * are not concern records: the decay pass never scores, deletes or
 * queues them as records, and the curator's feedback tools refuse such
 * buckets and never show their items to the model.
 */
export const RESERVED_BUCKET_PREFIX = '#';

/** Whether an area_bucket is reserved (RESERVED_BUCKET_PREFIX). */
export const isReservedBucket = (areaBucket: unknown): boolean =>
  typeof areaBucket === 'string' && areaBucket.startsWith(RESERVED_BUCKET_PREFIX);

/**
 * Key of the item that tracks the reviewer's repo skill.md check in its
 * concerns table. Its bucket is reserved, so no concern record can share
 * it, and the decay pass never scores or deletes it.
 */
export const REPO_SKILL_KEY = { area_bucket: '#maintenance', record_id: 'repo-skill' } as const;

/**
 * A check of the reviewer's skill.md in this repository
 * (agents/<reviewer_id>/config/skill.md). The curator reports stale facts
 * or proposes a pull request; it never edits the file in place. Queued
 * once per GA release: area_bucket and record_id name the REPO_SKILL_KEY
 * item, which holds the claim and, once the curator is done, the
 * verified_release it checked.
 */
export interface RepoCheckMessage {
  /** "repo_check#<reviewer_id>#repo-skill#<ISO time of the pass>". */
  readonly maintenance_id: string;
  readonly reason: 'repo_check';
  readonly reviewer_id: string;
  readonly area_bucket: typeof REPO_SKILL_KEY.area_bucket;
  readonly record_id: typeof REPO_SKILL_KEY.record_id;
  /** Highest GA release of the upstream (RELEASE_TAG_RE); never empty. */
  readonly release_tag: string;
  readonly dry_run: boolean;
}

export type MaintenanceMessage = CheckMessage | RetireMessage | RepoCheckMessage;

/**
 * A value read from a concerns table, for a log line. The curator model
 * chooses area_bucket and can put any text in it, so every such value is
 * JSON-quoted: it cannot break the line or pose as another field of the
 * operator's report.
 */
const quoted = (value: string): string => JSON.stringify(value);

/** A record's table and key, for a log line. */
const recordRef = (tableName: string, key: { readonly area_bucket: string; readonly record_id: string }): string =>
  `${tableName} bucket=${quoted(key.area_bucket)} id=${quoted(key.record_id)}`;

/** The curator's limits on message fields; a record outside them is never queued. */
const RECORD_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_MAINTENANCE_ID = 200;
const MAX_REVIEWER_ID = 100;
const MAX_AREA_BUCKET = 200;
const MAX_RECORD_ID = 100;

const maintenanceId = (reason: MaintenanceMessage['reason'], reviewerId: string, recordId: string, nowIso: string): string =>
  `${reason}#${reviewerId}#${recordId}#${nowIso}`;

/** Why a record cannot be put in a message, or null. */
function messageProblem(reviewerId: string, areaBucket: string, recordId: string, name: string, nowIso: string): string | null {
  if (!reviewerId || reviewerId.length > MAX_REVIEWER_ID) return 'reviewer id is empty or too long';
  if (!areaBucket || areaBucket.length > MAX_AREA_BUCKET) return 'area_bucket is empty or too long';
  if (!recordId || recordId.length > MAX_RECORD_ID) return 'record_id is empty or too long';
  if (!RECORD_NAME_RE.test(name)) return `graduated_record_name ${quoted(name.slice(0, 120))} is not a registry record name`;
  if (maintenanceId('retire', reviewerId, recordId, nowIso).length > MAX_MAINTENANCE_ID) return 'maintenance id would be too long';
  return null;
}

/** The manual event: {"recheck_all": true} and/or {"dry_run": true}. The schedule's event sets neither. */
export interface DecayRequest {
  /** Every live graduated record is due for a check, still within the per-pass cap. */
  readonly recheckAll: boolean;
  /** Report mode: retirement candidates are only logged, and check messages carry dry_run: true. */
  readonly dryRun: boolean;
}

export function parseDecayEvent(event: unknown): DecayRequest {
  const e = typeof event === 'object' && event !== null ? event as Record<string, unknown> : {};
  return { recheckAll: e.recheck_all === true, dryRun: e.dry_run === true };
}

/** What decayTable needs to queue maintenance for one reviewer's table. */
export interface MaintenanceContext extends DecayRequest {
  readonly reviewerId: string;
  /** Highest GA release of the reviewer's upstream; null when unknown or the reviewer has none. */
  readonly releaseTag: string | null;
  /** Client for the curator queue. Without it nothing is queued. */
  readonly sqs?: SendClient;
}

const NO_MAINTENANCE: MaintenanceContext = { reviewerId: '', releaseTag: null, recheckAll: false, dryRun: false };

interface SendClient {
  send(command: object): Promise<any>;
}

export interface Stats {
  readonly table: string;
  readonly scanned: number;
  /** Score writes, including those that also claimed a maintenance request. */
  readonly decayed: number;
  readonly deleted: number;
  /** Reinforced or decayed by someone else between the scan and the write. */
  readonly skipped: number;
  readonly errors: number;
  /** Tombstones of retired skills, left unwritten. */
  readonly keptRetired: number;
  readonly checksRequested: number;
  readonly retireRequested: number;
  /** Retirement candidates only logged: RETIRE_SKILLS off or a dry run. */
  readonly wouldRetire: number;
  /** Candidates over a per-pass cap; they are due again at the next pass. */
  readonly deferred: number;
}

export function summaryLine(s: Stats): string {
  return `[decay] ${s.table} scanned=${s.scanned} decayed=${s.decayed} deleted=${s.deleted} skipped=${s.skipped} errors=${s.errors}`
    + ` kept_retired=${s.keptRetired} checks_requested=${s.checksRequested} retire_requested=${s.retireRequested}`
    + ` would_retire=${s.wouldRetire} deferred=${s.deferred}`;
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

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
  '#ga': 'graduated_at',
  '#ret': 'retired_at',
  '#obs': 'obsolete_release',
  '#va': 'verified_at',
  '#vr': 'verified_release',
  '#mra': 'maintenance_requested_at',
} as const;

const stringOrEmpty = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A record as the scan read it, with the score this pass gives it. */
interface Scanned {
  readonly key: { readonly area_bucket: string; readonly record_id: string };
  readonly updatedAt: string;
  readonly nextScore: number;
  readonly unchanged: string;
  readonly seen: Readonly<Record<string, unknown>>;
}

interface Graduated extends Scanned {
  readonly name: string;
}

interface RetireCandidate extends Graduated {
  readonly retireReason: RetireMessage['retire_reason'];
}

interface CheckCandidate extends Graduated {
  /** 0 never checked, 1 re-published since its check, 2 anything else. */
  readonly rank: number;
  /** verified_at, or graduated_at when never checked; older goes first. */
  readonly sinceMs: number;
}

const byKey = (a: Scanned, b: Scanned): number =>
  a.key.area_bucket.localeCompare(b.key.area_bucket) || a.key.record_id.localeCompare(b.key.record_id);

/** Whether a live graduated record is due for a check, and where it sorts. */
function checkDue(
  item: Readonly<Record<string, unknown>>,
  releaseTag: string | null,
  config: DecayConfig,
  recheckAll: boolean,
  nowMs: number,
): { rank: number; sinceMs: number } | null {
  const verifiedMs = Date.parse(stringOrEmpty(item.verified_at));
  const graduatedMs = Date.parse(stringOrEmpty(item.graduated_at));
  if (!Number.isFinite(verifiedMs)) return { rank: 0, sinceMs: Number.isFinite(graduatedMs) ? graduatedMs : 0 };
  if (Number.isFinite(graduatedMs) && graduatedMs > verifiedMs) return { rank: 1, sinceMs: verifiedMs };
  const due = (releaseTag !== null && releaseTag !== stringOrEmpty(item.verified_release))
    || nowMs - verifiedMs > config.recheckSeconds * 1000
    || recheckAll;
  return due ? { rank: 2, sinceMs: verifiedMs } : null;
}

/** Whether the repo skill.md is due for a check at `releaseTag`. */
function repoCheckDue(item: Readonly<Record<string, unknown>> | undefined, releaseTag: string, recheckAll: boolean, nowMs: number): boolean {
  if (!item) return true;
  const requestedMs = Date.parse(stringOrEmpty(item.maintenance_requested_at));
  if (Number.isFinite(requestedMs) && nowMs - requestedMs < MAINTENANCE_RETRY_DAYS * DAY_SECONDS * 1000) return false;
  return recheckAll || stringOrEmpty(item.verified_release) !== releaseTag;
}

export async function decayTable(
  ddb: SendClient,
  tableName: string,
  config: DecayConfig,
  nowMs: number,
  ctx: MaintenanceContext = NO_MAINTENANCE,
): Promise<Stats> {
  let scanned = 0;
  let decayed = 0;
  let deleted = 0;
  let skipped = 0;
  let errors = 0;
  let keptRetired = 0;
  let checksRequested = 0;
  let retireRequested = 0;
  let wouldRetire = 0;
  let deferred = 0;
  let cursor: Record<string, unknown> | undefined;
  const nowIso = new Date(nowMs).toISOString();

  const sqs = config.curatorQueueUrl ? ctx.sqs : undefined;
  const releaseTag = ctx.releaseTag !== null && RELEASE_TAG_RE.test(ctx.releaseTag) ? ctx.releaseTag : null;
  const checksOn = sqs !== undefined && config.checksPerDay > 0 && Boolean(config.upstreamRepos[ctx.reviewerId]);
  const retireOn = sqs !== undefined && config.retireSkills && !ctx.dryRun;
  const retirements: RetireCandidate[] = [];
  const checks: CheckCandidate[] = [];
  let repoSkill: Readonly<Record<string, unknown>> | undefined;

  /** Whether the curator would accept a message for the record; logs and counts an error when not. */
  function queueable(r: Scanned, name: string): boolean {
    const problem = messageProblem(ctx.reviewerId, r.key.area_bucket, r.key.record_id, name, nowIso);
    if (!problem) return true;
    errors += 1;
    console.warn(`[decay] cannot queue maintenance for ${recordRef(tableName, r.key)}: ${problem}`);
    return false;
  }

  /** Runs one conditional write; false when it was skipped or failed (and counted). */
  async function write(command: object, what: string, key: Scanned['key']): Promise<boolean> {
    try {
      await ddb.send(command);
      return true;
    } catch (err) {
      if (isConditionFailure(err)) {
        skipped += 1;
        return false;
      }
      errors += 1;
      console.warn(`[decay] ${what} failed for ${recordRef(tableName, key)}: ${errorText(err)}`);
      return false;
    }
  }

  async function writeScore(r: Scanned): Promise<void> {
    const ok = await write(new UpdateCommand({
      TableName: tableName,
      Key: r.key,
      UpdateExpression: 'SET #ds = :s, #da = :now',
      ConditionExpression: r.unchanged,
      ExpressionAttributeNames: { '#ds': 'decay_score', '#ua': 'updated_at', '#da': 'decayed_at' },
      ExpressionAttributeValues: { ...r.seen, ':s': r.nextScore, ':now': nowIso },
    }), 'write', r.key);
    if (ok) decayed += 1;
  }

  /** Stores the decayed score and claims the request in one write. */
  async function claim(r: Graduated, reason: MaintenanceMessage['reason'], id: string): Promise<boolean> {
    const ok = await write(new UpdateCommand({
      TableName: tableName,
      Key: r.key,
      UpdateExpression: 'SET #ds = :s, #da = :now, #mid = :mid, #mra = :now, #mr = :mr',
      ConditionExpression: `${r.unchanged} AND #grn = :grn AND attribute_not_exists(#ret)`,
      ExpressionAttributeNames: {
        '#ds': 'decay_score', '#ua': 'updated_at', '#da': 'decayed_at', '#grn': 'graduated_record_name', '#ret': 'retired_at',
        '#mid': 'maintenance_id', '#mra': 'maintenance_requested_at', '#mr': 'maintenance_reason',
      },
      ExpressionAttributeValues: { ...r.seen, ':s': r.nextScore, ':now': nowIso, ':mid': id, ':mr': reason, ':grn': r.name },
    }), 'claim', r.key);
    if (ok) decayed += 1;
    return ok;
  }

  /**
   * Claims the repo skill check on the REPO_SKILL_KEY item, creating it
   * on the first check, in the state the scan read.
   */
  async function claimRepoSkill(item: Readonly<Record<string, unknown>> | undefined, id: string): Promise<boolean> {
    const names: Record<string, string> = { '#mid': 'maintenance_id', '#mra': 'maintenance_requested_at', '#mr': 'maintenance_reason' };
    const values: Record<string, unknown> = { ':mid': id, ':now': nowIso, ':mr': 'repo_check' };
    let condition: string;
    if (!item) {
      names['#rid'] = 'record_id';
      condition = 'attribute_not_exists(#rid)';
    } else {
      names['#vr'] = 'verified_release';
      const { verified_release: verified, maintenance_requested_at: requested } = item;
      condition = [
        verified === undefined ? 'attribute_not_exists(#vr)' : '#vr = :vr',
        requested === undefined ? 'attribute_not_exists(#mra)' : '#mra = :mra',
      ].join(' AND ');
      if (verified !== undefined) values[':vr'] = verified;
      if (requested !== undefined) values[':mra'] = requested;
    }
    return write(new UpdateCommand({
      TableName: tableName,
      Key: REPO_SKILL_KEY,
      UpdateExpression: 'SET #mid = :mid, #mra = :now, #mr = :mr',
      ConditionExpression: condition,
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    }), 'claim', REPO_SKILL_KEY);
  }

  /** Sends a claimed request; on failure releases the claim so the next pass can retry. */
  async function send(key: Scanned['key'], message: MaintenanceMessage, delaySeconds: number): Promise<boolean> {
    try {
      await sqs!.send(new SendMessageCommand({
        QueueUrl: config.curatorQueueUrl,
        MessageBody: JSON.stringify(message),
        DelaySeconds: delaySeconds,
        MessageAttributes: {
          reviewer_id: { DataType: 'String', StringValue: message.reviewer_id },
          maintenance_id: { DataType: 'String', StringValue: message.maintenance_id },
          reason: { DataType: 'String', StringValue: message.reason },
        },
      }));
      return true;
    } catch (err) {
      errors += 1;
      console.warn(`[decay] send failed for ${recordRef(tableName, key)} maintenance=${quoted(message.maintenance_id)}: ${errorText(err)}`);
    }
    // Best effort: a claim left behind only delays the retry by MAINTENANCE_RETRY_DAYS.
    try {
      await ddb.send(new UpdateCommand({
        TableName: tableName,
        Key: key,
        UpdateExpression: 'REMOVE #mid, #mra, #mr',
        ConditionExpression: '#mid = :mid',
        ExpressionAttributeNames: { '#mid': 'maintenance_id', '#mra': 'maintenance_requested_at', '#mr': 'maintenance_reason' },
        ExpressionAttributeValues: { ':mid': message.maintenance_id },
      }));
    } catch (err) {
      if (!isConditionFailure(err)) {
        console.warn(`[decay] could not release maintenance=${quoted(message.maintenance_id)}; it is retried after ${MAINTENANCE_RETRY_DAYS} days: ${errorText(err)}`);
      }
    }
    return false;
  }

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
      if (areaBucket === REPO_SKILL_KEY.area_bucket && recordId === REPO_SKILL_KEY.record_id) {
        repoSkill = item;
        continue;
      }
      // Any other item in a reserved bucket is not a concern record either.
      if (isReservedBucket(areaBucket)) continue;
      const updatedAt = stringOrEmpty(item.updated_at);
      const decayedAt = stringOrEmpty(item.decayed_at);
      const updatedMs = Date.parse(updatedAt);
      if (typeof areaBucket !== 'string' || typeof recordId !== 'string' || !Number.isFinite(updatedMs)) {
        errors += 1;
        console.warn(`[decay] ${tableName}: record without area_bucket, record_id or a valid updated_at: ${JSON.stringify(item).slice(0, 200)}`);
        continue;
      }

      const name = stringOrEmpty(item.graduated_record_name);
      if (name && item.retired_at !== undefined) {
        keptRetired += 1;
        continue;
      }

      // The score was last set at whichever is later: the last
      // reinforcement or the last decay pass.
      const decayedMs = Date.parse(decayedAt);
      const since = Number.isFinite(decayedMs) && decayedMs > updatedMs ? decayedMs : updatedMs;
      const score = typeof item.decay_score === 'number' ? item.decay_score : 1.0;
      const halfLife = name ? config.graduatedHalfLifeSeconds : config.halfLifeSeconds;
      const nextScore = decayedScore(score, (nowMs - since) / 1000, halfLife);
      const key = { area_bucket: areaBucket, record_id: recordId };
      const record: Scanned = { key, updatedAt, nextScore, ...stateAsRead(updatedAt, decayedAt, item.decay_score) };

      if (!name) {
        if (nextScore < config.floor) {
          // A record that graduates between the scan and this write keeps
          // its provenance.
          const ok = await write(new DeleteCommand({
            TableName: tableName,
            Key: key,
            ConditionExpression: `${record.unchanged} AND attribute_not_exists(#grn)`,
            ExpressionAttributeNames: { '#ua': 'updated_at', '#da': 'decayed_at', '#ds': 'decay_score', '#grn': 'graduated_record_name' },
            ExpressionAttributeValues: record.seen,
          }), 'write', key);
          if (ok) deleted += 1;
        } else {
          await writeScore(record);
        }
        continue;
      }

      // Live graduated record: never deleted. Candidates for a request
      // are written after the scan, once they are ranked against the caps.
      const requestedMs = Date.parse(stringOrEmpty(item.maintenance_requested_at));
      const inFlight = Number.isFinite(requestedMs) && nowMs - requestedMs < MAINTENANCE_RETRY_DAYS * DAY_SECONDS * 1000;
      if (!inFlight && nextScore < config.floor) {
        if (!retireOn || queueable(record, name)) {
          retirements.push({ ...record, name, retireReason: stringOrEmpty(item.obsolete_release) ? 'obsolete' : 'decayed' });
          continue;
        }
      } else if (!inFlight && checksOn) {
        const due = checkDue(item, releaseTag, config, ctx.recheckAll, nowMs);
        if (due && queueable(record, name)) {
          checks.push({ ...record, name, ...due });
          continue;
        }
      }
      await writeScore(record);
    }
  } while (cursor);

  // Retirements, lowest score first.
  retirements.sort((a, b) => a.nextScore - b.nextScore || byKey(a, b));
  let retireClaims = 0;
  for (const r of retirements) {
    const line = `${recordRef(tableName, r.key)} name=${quoted(r.name)} score=${r.nextScore.toFixed(4)} reason=${r.retireReason}`;
    if (!retireOn) {
      console.log(`[decay] would-retire ${line}`);
      wouldRetire += 1;
      await writeScore(r);
      continue;
    }
    if (retireClaims >= config.maxRetirementsPerDay) {
      console.log(`[decay] deferred ${line}`);
      deferred += 1;
      await writeScore(r);
      continue;
    }
    const id = maintenanceId('retire', ctx.reviewerId, r.key.record_id, nowIso);
    if (!(await claim(r, 'retire', id))) continue;
    retireClaims += 1;
    const sent = await send(r.key, {
      maintenance_id: id,
      reason: 'retire',
      reviewer_id: ctx.reviewerId,
      area_bucket: r.key.area_bucket,
      record_id: r.key.record_id,
      record_name: r.name,
      retire_reason: r.retireReason,
      seen_updated_at: r.updatedAt,
      dry_run: false,
    }, 0);
    if (sent) {
      retireRequested += 1;
      console.log(`[decay] retire-requested ${line} maintenance=${quoted(id)}`);
    }
  }

  let checkClaims = 0;

  // The repo skill.md: once per release, ahead of the records.
  if (checksOn && releaseTag !== null && repoCheckDue(repoSkill, releaseTag, ctx.recheckAll, nowMs)) {
    const id = maintenanceId('repo_check', ctx.reviewerId, REPO_SKILL_KEY.record_id, nowIso);
    if (await claimRepoSkill(repoSkill, id)) {
      checkClaims += 1;
      const sent = await send(REPO_SKILL_KEY, {
        maintenance_id: id,
        reason: 'repo_check',
        reviewer_id: ctx.reviewerId,
        area_bucket: REPO_SKILL_KEY.area_bucket,
        record_id: REPO_SKILL_KEY.record_id,
        release_tag: releaseTag,
        dry_run: ctx.dryRun,
      }, 0);
      if (sent) {
        checksRequested += 1;
        console.log(`[decay] repo-check-requested ${tableName} release=${releaseTag} dry_run=${ctx.dryRun} maintenance=${quoted(id)}`);
      }
    }
  }

  // Checks: never checked, then re-published, then the oldest check.
  checks.sort((a, b) => a.rank - b.rank || a.sinceMs - b.sinceMs || byKey(a, b));
  for (const c of checks) {
    if (checkClaims >= config.checksPerDay) {
      deferred += 1;
      await writeScore(c);
      continue;
    }
    const id = maintenanceId('check', ctx.reviewerId, c.key.record_id, nowIso);
    if (!(await claim(c, 'check', id))) continue;
    const delaySeconds = Math.min(MAX_DELAY_SECONDS, CHECK_STAGGER_SECONDS * checkClaims);
    checkClaims += 1;
    const sent = await send(c.key, {
      maintenance_id: id,
      reason: 'check',
      reviewer_id: ctx.reviewerId,
      area_bucket: c.key.area_bucket,
      record_id: c.key.record_id,
      record_name: c.name,
      release_tag: releaseTag ?? '',
      seen_updated_at: c.updatedAt,
      dry_run: ctx.dryRun,
    }, delaySeconds);
    if (sent) {
      checksRequested += 1;
      console.log(`[decay] check-requested ${recordRef(tableName, c.key)} name=${quoted(c.name)} release=${releaseTag ?? 'unknown'} delay=${delaySeconds}s dry_run=${ctx.dryRun} maintenance=${quoted(id)}`);
    }
  }

  return { table: tableName, scanned, decayed, deleted, skipped, errors, keptRetired, checksRequested, retireRequested, wouldRetire, deferred };
}

/**
 * Highest GA release per reviewer with an upstream, one lookup per
 * distinct repository, in parallel. Skipped when checks are off, since
 * the tag only triggers checks.
 */
export async function releaseTags(
  config: DecayConfig,
  lookup: (repo: string) => Promise<string | null> = latestReleaseTag,
): Promise<Record<string, string | null>> {
  if (config.checksPerDay === 0) return {};
  const reviewers = Object.keys(config.tables).filter((id) => config.upstreamRepos[id]);
  const byRepo = new Map<string, Promise<string | null>>();
  for (const id of reviewers) {
    const repo = config.upstreamRepos[id];
    if (!byRepo.has(repo)) byRepo.set(repo, lookup(repo));
  }
  const out: Record<string, string | null> = {};
  for (const id of reviewers) out[id] = await byRepo.get(config.upstreamRepos[id])!;
  return out;
}

export interface DecayResult {
  /** reviewer_id -> highest GA release of its upstream, null when unknown. Empty when checks are off. */
  readonly releases: Readonly<Record<string, string | null>>;
  readonly tables: readonly Stats[];
}

let client: DynamoDBDocumentClient | undefined;
let sqsClient: SQSClient | undefined;

export async function handler(event?: unknown): Promise<DecayResult> {
  const config = loadDecayConfig(process.env);
  const request = parseDecayEvent(event);
  client ??= DynamoDBDocumentClient.from(new DynamoDBClient({}));
  if (config.curatorQueueUrl) sqsClient ??= new SQSClient({});
  if (request.recheckAll || request.dryRun) console.log(`[decay] manual pass recheck_all=${request.recheckAll} dry_run=${request.dryRun}`);

  const releases = await releaseTags(config);
  const now = Date.now();
  const out: Stats[] = [];
  for (const [reviewerId, tableName] of Object.entries(config.tables)) {
    const s = await decayTable(client, tableName, config, now, {
      ...request,
      reviewerId,
      releaseTag: releases[reviewerId] ?? null,
      sqs: sqsClient,
    });
    console.log(summaryLine(s));
    out.push(s);
  }
  return { releases, tables: out };
}
