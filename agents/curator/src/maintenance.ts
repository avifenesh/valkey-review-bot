import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { z } from 'zod';
import type { AgentConfig } from '@strands-agents/sdk';
import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { AgentRegistryControlClient } from '@aws-sdk/client-agent-registry-control';
import {
  deprecateSkill,
  getSkillByName,
  GRADUATED_SKILL_MAX_CHARS,
  listSkillSummaries,
  SKILL_MD_MAX_CHARS,
  upsertSkill,
  type SkillRecord,
  type UpsertSkillInput,
} from '../../common/src/skills-registry.js';
import { extractNames } from '../../common/src/skill-check/names.js';
import { areaFileCounts, checkSkill, confirmableCommit, type CheckResult } from '../../common/src/skill-check/check.js';
import {
  formatCitation,
  listSuppressedBlocks,
  releaseLabel,
  validateEdits,
  type EditContext,
  type SuppressedBlock,
} from '../../common/src/skill-check/edits.js';
import {
  createLineResolver,
  prepareUpstreamCheckout,
  removeCheckout,
  type PrepareOptions,
  type UpstreamCheckout,
} from '../../common/src/skill-check/upstream.js';
import { assembleCheckTools, CheckRun, renderCheckMessage, type CheckReport } from './check-run.js';
import { curate, type StreamFrame } from './curate.js';
import { requestSchema as feedbackRequestSchema } from './feedback.js';
import type { SkillPublisher } from './tools/submit-skill.js';

/**
 * The curator's maintenance mode: the skill lifecycle work the daily
 * decay job queues on the curator queue (ops/src/decay.ts, whose
 * MaintenanceMessage comments state the contract this follows).
 *
 *   retire       deprecate a graduated skill whose standing decayed, or
 *                whose subject a check found gone, and keep its record
 *                as a tombstone. No model.
 *   check        fact-check a graduated skill against the upstream
 *                default branch. A clean result is confirmed without a
 *                model; flagged names get a bounded read-only audit, and
 *                its edits are applied in suppress-and-add form only when
 *                they pass the edit contract and the settings allow it.
 *   repo_check   the same check of the reviewer's skill.md in this
 *                repository, which is never changed in place: its edits
 *                are proposed by pull request, or only reported.
 *
 * The claim. The decay job sets maintenance_id, maintenance_requested_at
 * and maintenance_reason on the record before it sends the message. A
 * run acts only while the record's maintenance_id is the message's
 * (read consistently): another value, or none, means the message is
 * stale or a duplicate, and nothing is written. Every write that changes
 * the skill's state is conditioned on maintenance_id and on the record's
 * graduated_record_name being the message's record_name. A terminal
 * outcome removes the three claim attributes in its last write; when it
 * has none, or that write loses its condition, a release write removes
 * them conditioned on maintenance_id alone. An outcome to retry later
 * (inconclusive, a registry record still being written, an ambiguous
 * deprecation, a run that throws) keeps the claim, and decay requests
 * again once it is 7 days old.
 *
 * Retirement marker. Before deprecating, a retire run sets
 * maintenance_deprecating to the record name. A DEPRECATED registry
 * record with that marker is the lifecycle's own retirement, from this
 * run or an earlier one; without it, someone else retired the skill
 * (retired_reason "operator", which submit_skill never undoes). The
 * marker is removed only in a tombstone write, or in a write made after
 * this run read the registry record as DRAFT, PENDING_APPROVAL or
 * APPROVED.
 *
 * Lost names. A name of the baseline (audit_names) that a check finds
 * absent is lost. It leaves audit_names, so its loss costs standing
 * once, and goes into lost_names, where it stays while the skill cites
 * it and the code lacks it: each later check reports it to the audit as
 * lost again, so an "accurate" verdict is refused while it is missing,
 * and it never goes into ignored_names. A check that finds it present
 * again, or a skill that no longer cites it (an applied revision
 * suppresses the piece that did), drops it.
 *
 * Report mode. A dry_run message, or a switch that is off
 * (CHECK_APPLY_EDITS, RETIRE_SKILLS, CHECK_OPEN_PULL_REQUESTS), never
 * writes the registry or opens a pull request. Every run logs one
 * "[maintenance] ..." report line, plus one line per proposed edit. A
 * dry run also writes nothing the feedback path or the decay job acts
 * on: no tombstone, no outcome, verification, names or standing. It
 * records only the audit's result for the operator (pending_revision,
 * reason "dry run", never in place of a real check's), and releases
 * the claim, so the next real pass checks again. Its decision is
 * would-<outcome>: what a real run would record.
 */

const RECORD_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REVIEWER_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
/** RELEASE_TAG_RE in ops/src/releases.ts. */
const RELEASE_TAG_RE = /^v?([0-9]{1,4})[.]([0-9]{1,4})[.]([0-9]{1,4})$/;

/** REPO_SKILL_KEY in ops/src/decay.ts. */
export const REPO_SKILL_KEY = { area_bucket: '#maintenance', record_id: 'repo-skill' } as const;

const base = {
  maintenance_id: z.string().min(1).max(200),
  reviewer_id: z.string().regex(REVIEWER_ID_RE),
  record_id: z.string().min(1).max(100),
  dry_run: z.boolean(),
};
const concernBucket = z.string().min(1).max(200).refine((b) => !b.startsWith('#'), 'a reserved bucket holds no concern record');

const checkSchema = z.object({
  ...base,
  reason: z.literal('check'),
  area_bucket: concernBucket,
  record_name: z.string().regex(RECORD_NAME_RE),
  release_tag: z.string().refine((t) => t === '' || RELEASE_TAG_RE.test(t), 'release_tag must be empty or a GA tag'),
  seen_updated_at: z.string().max(100),
});
const retireSchema = z.object({
  ...base,
  reason: z.literal('retire'),
  area_bucket: concernBucket,
  record_name: z.string().regex(RECORD_NAME_RE),
  retire_reason: z.enum(['decayed', 'obsolete']),
  seen_updated_at: z.string().max(100),
});
const repoCheckSchema = z.object({
  ...base,
  reason: z.literal('repo_check'),
  area_bucket: z.literal(REPO_SKILL_KEY.area_bucket),
  record_id: z.literal(REPO_SKILL_KEY.record_id),
  release_tag: z.string().regex(RELEASE_TAG_RE),
});

/** A maintenance message from the decay job (MaintenanceMessage in ops/src/decay.ts). */
export const maintenanceRequestSchema = z.discriminatedUnion('reason', [checkSchema, retireSchema, repoCheckSchema]);
export type MaintenanceRequest = z.infer<typeof maintenanceRequestSchema>;
export type CheckRequest = z.infer<typeof checkSchema>;
export type RetireRequest = z.infer<typeof retireSchema>;
export type RepoCheckRequest = z.infer<typeof repoCheckSchema>;

/**
 * Every message the curator runtime accepts: a feedback event from the
 * webhook receiver, or a maintenance message. A message is maintenance
 * when it has a maintenance_id (isMaintenanceRequest).
 */
export const curatorRequestSchema = z.union([feedbackRequestSchema, maintenanceRequestSchema]);
export type CuratorMessage = z.infer<typeof curatorRequestSchema>;

export function isMaintenanceRequest(req: CuratorMessage): req is MaintenanceRequest {
  return typeof (req as { maintenance_id?: unknown }).maintenance_id === 'string';
}

// The skills-repo pull request module (repo-skill-pr.ts) and its token
// source (skills-repo-token.ts) belong to their own package. These types
// mirror the interface both packages build to.

export interface RepoSkillProposal {
  readonly reviewerId: string;
  readonly releaseLabel: string;
  readonly path: string;
  readonly baseSha: string;
  readonly baseContent: string;
  readonly newContent: string;
  readonly summary: string;
  readonly evidence: readonly string[];
}

export interface RepoSkillPrResult {
  readonly action: 'opened' | 'updated' | 'unchanged' | 'base-moved' | 'refused';
  readonly branch: string;
  readonly url?: string;
  readonly reason?: string;
}

/** What a repo check needs of the skills repository, bound to its settings by the entrypoint. */
export interface RepoSkillApi {
  /** Anonymous read of a file at a branch; sha is the commit the content came from. */
  fetchRepoFile(repo: string, ref: string, path: string): Promise<{ sha: string; content: string } | null>;
  /** Open or update the pull request of a proposal. Called only when proposals are on. */
  propose(p: RepoSkillProposal): Promise<RepoSkillPrResult>;
}

/** The registry calls of maintenance runs, on one reviewer's registry. */
export interface MaintenanceRegistry {
  /** The record with exactly this name, in any status, preferring a live one; null when none. */
  get(name: string): Promise<SkillRecord | null>;
  /** Update an existing record's content; never creates one, and refuses a retired one. */
  update(input: UpsertSkillInput): Promise<{ status: string }>;
  /** UpdateRegistryRecordStatus DEPRECATED; returns the new status. */
  deprecate(recordId: string, reason: string): Promise<string>;
}

/**
 * The feedback tools' registry calls on one reviewer's registry: upsert,
 * exists, and get, which get_skill and submit_skill need to read a
 * published skill. Nothing here changes a record's status.
 */
export function skillPublisher(client: AgentRegistryControlClient, registryId: string): SkillPublisher {
  return {
    upsert: (input) => upsertSkill(client, registryId, input),
    // The name filter is not documented as an exact match, so compare the names too.
    exists: async (name) => (await listSkillSummaries(client, registryId, [{ name: 'name', values: [name] }]))
      .some((r) => r.name === name),
    get: (name) => getSkillByName(client, registryId, name),
  };
}

/** Maintenance runs' registry calls on one reviewer's registry: read, update-only, deprecate. */
export function maintenanceRegistry(client: AgentRegistryControlClient, registryId: string): MaintenanceRegistry {
  return {
    get: (name) => getSkillByName(client, registryId, name),
    update: (input) => upsertSkill(client, registryId, input, { updateOnly: true }),
    deprecate: (recordId, reason) => deprecateSkill(client, registryId, recordId, reason),
  };
}

export interface MaintenanceSettings {
  readonly upstreamRepos: Readonly<Record<string, string>>;
  readonly checkApplyEdits: boolean;
  readonly retireSkills: boolean;
  readonly checkOpenPullRequests: boolean;
  /** The bot's repository; null when not configured. */
  readonly skillsRepo: { readonly repo: string; readonly baseBranch: string; readonly tokenFunction: string } | null;
  readonly checkDir: string;
  readonly checkMaxRounds: number;
}

export interface MaintenanceDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, 'send'>;
  /** The reviewer's concerns table. */
  readonly table: string;
  readonly registry: MaintenanceRegistry;
  readonly settings: MaintenanceSettings;
  /** A model for one audit, and its system prompt (config/skill-check.md); '' means no audit can run. */
  readonly audit: { readonly model: () => AgentConfig['model']; readonly systemPrompt: string };
  /** The skills repository's file reader and pull requests, loaded on first use. */
  readonly repoSkills?: () => Promise<RepoSkillApi>;
  /** Default prepareUpstreamCheckout. */
  readonly checkout?: (opts: PrepareOptions) => Promise<UpstreamCheckout>;
  /** URL of an upstream; default anonymous https://github.com/<repo>.git. */
  readonly upstreamUrl?: (repo: string) => string;
  readonly now?: () => Date;
  /** Wall clock of an audit from the start of the run; default CHECK_DEADLINE_MS. */
  readonly auditDeadlineMs?: number;
  /** Echo model output to stdout. */
  readonly printer?: boolean;
}

export interface MaintenanceResult {
  readonly status: 'completed' | 'skipped';
  /** The outcome: a check_outcome, or retired, refused, would-retire, proposed and the like. */
  readonly decision: string;
}

/** Wall clock of one run's audit, below the worker's 15 minutes. */
export const CHECK_DEADLINE_MS = 12 * 60_000;
/** Caps on what a check stores on the record (spec data model). */
const STALE_NAMES_MAX = 50;
const IGNORED_NAMES_MAX = 100;
const AUDIT_NAMES_MAX = 300;
const CHECK_NOTE_MAX = 500;
const PENDING_SUMMARY_MAX = 400;
const PENDING_PROBLEMS_MAX = 10;
/** A name stored in stale_names or shown in check_note: a token of the skill's own text. */
const STORED_NAME_RE = /^[A-Za-z0-9_./:*>-]{1,120}$/;
/** Statuses of a record still being written; the check or retirement waits. */
const BUSY_STATUSES: ReadonlySet<string> = new Set(['CREATING', 'UPDATING']);
/** Statuses whose read lets a write remove the retirement marker. */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);
/** Checkouts older than this are left over from a run that died; any live run is younger. */
const STALE_CHECKOUT_MS = 30 * 60_000;

const CLAIM = ['maintenance_id', 'maintenance_requested_at', 'maintenance_reason'] as const;
const MARKER = 'maintenance_deprecating';

type Item = Record<string, unknown>;
type Key = { readonly area_bucket: string; readonly record_id: string };

// --- Log lines -------------------------------------------------------------

/** Characters a log line never shows, as in ops/src/decay.ts. */
const INVISIBLE_RE = /[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu;
const quoted = (value: string): string => JSON.stringify(value.replace(INVISIBLE_RE, ''));

/** One report line: key=value pairs, every string JSON-quoted so text from a table or a model cannot break it. */
function reportLine(kind: string, fields: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? quoted(v) : String(v)}`);
  return `[maintenance] ${kind} ${parts.join(' ')}`;
}

/** The entrypoint's line at the end of a maintenance run. A decision can be a sentence, so it is quoted like the report lines' strings. */
export function maintenanceDoneLine(req: MaintenanceRequest, result: MaintenanceResult): string {
  return `[curator] maintenance ${result.status} reason=${req.reason} reviewer=${req.reviewer_id} decision=${quoted(result.decision)} dry_run=${req.dry_run} maintenance=${quoted(req.maintenance_id)}`;
}

function errorText(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  const message = err instanceof Error ? err.message : String(err);
  return name && name !== 'Error' ? `${name}: ${message}` : message;
}

const isConditionFailure = (err: unknown): boolean =>
  (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';

// --- DynamoDB writes -------------------------------------------------------

/** One UpdateItem: SET and REMOVE per attribute (the last call for an attribute wins), and AND-ed conditions. */
class Write {
  private readonly ops = new Map<string, { value: unknown } | null>();
  private readonly conditions: string[] = [];
  private readonly names: Record<string, string> = {};
  private readonly values: Record<string, unknown> = {};

  private name(attr: string): string {
    const p = `#${attr.replace(/_/g, '')}`;
    this.names[p] = attr;
    return p;
  }

  private value(v: unknown): string {
    const p = `:v${Object.keys(this.values).length}`;
    this.values[p] = v;
    return p;
  }

  set(attr: string, value: unknown): this {
    this.ops.set(attr, { value });
    return this;
  }

  remove(...attrs: readonly string[]): this {
    for (const a of attrs) this.ops.set(a, null);
    return this;
  }

  /** A string set, REMOVEd when empty (DynamoDB stores no empty set). */
  setNames(attr: string, names: Iterable<string>): this {
    const s = new Set(names);
    return s.size > 0 ? this.set(attr, s) : this.remove(attr);
  }

  /** attr = value, or attribute_not_exists(attr) when value is undefined. */
  is(attr: string, value: unknown): this {
    this.conditions.push(value === undefined ? `attribute_not_exists(${this.name(attr)})` : `${this.name(attr)} = ${this.value(value)}`);
    return this;
  }

  absent(attr: string): this {
    this.conditions.push(`attribute_not_exists(${this.name(attr)})`);
    return this;
  }

  exists(attr: string): this {
    this.conditions.push(`attribute_exists(${this.name(attr)})`);
    return this;
  }

  /** attr is absent or holds anything but value. */
  isNot(attr: string, value: unknown): this {
    const n = this.name(attr);
    this.conditions.push(`(attribute_not_exists(${n}) OR ${n} <> ${this.value(value)})`);
    return this;
  }

  command(table: string, key: Key): UpdateCommand {
    const sets: string[] = [];
    const removes: string[] = [];
    for (const [attr, op] of this.ops) {
      if (op) sets.push(`${this.name(attr)} = ${this.value(op.value)}`);
      else removes.push(this.name(attr));
    }
    const expression = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : ''].filter(Boolean).join(' ');
    return new UpdateCommand({
      TableName: table,
      Key: { area_bucket: key.area_bucket, record_id: key.record_id },
      UpdateExpression: expression,
      ...(this.conditions.length ? { ConditionExpression: this.conditions.join(' AND ') } : {}),
      ExpressionAttributeNames: this.names,
      ...(Object.keys(this.values).length ? { ExpressionAttributeValues: this.values } : {}),
    });
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function names(value: unknown): string[] {
  if (value instanceof Set) return [...value].map(String);
  return Array.isArray(value) ? value.map(String) : [];
}

/** State of one maintenance run: the message, the record as last read, and the writes it makes. */
class Run {
  readonly deps: MaintenanceDeps;
  readonly req: MaintenanceRequest;
  readonly key: Key;
  readonly now: Date;
  readonly nowIso: string;
  item: Item | undefined;
  /** This run read the registry record as DRAFT, PENDING_APPROVAL or APPROVED. */
  liveRead = false;

  constructor(deps: MaintenanceDeps, req: MaintenanceRequest) {
    this.deps = deps;
    this.req = req;
    this.key = { area_bucket: req.area_bucket, record_id: req.record_id };
    this.now = deps.now?.() ?? new Date();
    this.nowIso = this.now.toISOString();
  }

  get name(): string {
    return this.req.reason === 'repo_check' ? '' : this.req.record_name;
  }

  async read(): Promise<Item | undefined> {
    const resp = await this.deps.ddb.send(new GetCommand({ TableName: this.deps.table, Key: { ...this.key }, ConsistentRead: true }));
    this.item = resp.Item;
    return this.item;
  }

  /** The record holds this message's claim. */
  holds(item: Item | undefined): boolean {
    return item !== undefined && item.maintenance_id === this.req.maintenance_id && item.maintenance_reason === this.req.reason;
  }

  private async send(w: Write): Promise<boolean> {
    try {
      await this.deps.ddb.send(w.command(this.deps.table, this.key));
      return true;
    } catch (err) {
      if (isConditionFailure(err)) return false;
      throw err;
    }
  }

  /** The release write: REMOVE the claim, conditioned on maintenance_id alone. False when another claim owns the record. */
  async release(): Promise<boolean> {
    return this.send(new Write().remove(...CLAIM).is('maintenance_id', this.req.maintenance_id));
  }

  /**
   * Send a write that changes the skill's state, under the claim and the
   * record name of a live record. False when it lost its condition.
   */
  async attempt(w: Write): Promise<boolean> {
    w.is('maintenance_id', this.req.maintenance_id);
    if (this.req.reason !== 'repo_check') w.is('graduated_record_name', this.name).absent('retired_at');
    return this.send(w);
  }

  /** attempt(), releasing the claim instead when the write lost its condition. True when it was written. */
  async state(w: Write): Promise<boolean> {
    if (await this.attempt(w)) return true;
    await this.release();
    return false;
  }

  /** A write conditioned on `revised_at` = `at` and the record name: the claim is gone once an edit is being applied. */
  async afterEdit(w: Write, at: string): Promise<boolean> {
    w.is('revised_at', at).is('graduated_record_name', this.name);
    return this.send(w);
  }

  log(kind: string, fields: LogFields): void {
    console.log(reportLine(kind, {
      reviewer: this.req.reviewer_id,
      ...(this.req.reason === 'repo_check' ? {} : { bucket: this.req.area_bucket, id: this.req.record_id, name: this.name }),
      ...fields,
      dry_run: this.req.dry_run,
      maintenance: this.req.maintenance_id,
    }));
  }
}

// --- Entry point -----------------------------------------------------------

export async function* handleMaintenance(req: MaintenanceRequest, deps: MaintenanceDeps): AsyncGenerator<StreamFrame, MaintenanceResult> {
  yield { event: 'status', data: { phase: 'maintenance', reason: req.reason, reviewer: req.reviewer_id, maintenance: req.maintenance_id } };
  const run = new Run(deps, req);
  if (req.reason === 'retire') return yield* retire(run, req);
  if (req.reason === 'check') return yield* check(run, req);
  return yield* repoCheck(run, req);
}

const skipped = (decision: string): MaintenanceResult => ({ status: 'skipped', decision });
const completed = (decision: string): MaintenanceResult => ({ status: 'completed', decision });

type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

/** A check's report line, and its result: skipped when its write lost to another writer and nothing was recorded. */
function ended(run: Run, outcome: string, recorded: boolean, fields: LogFields): MaintenanceResult {
  run.log(run.req.reason, { outcome, ...fields, recorded });
  return recorded ? completed(outcome) : skipped('changed');
}

/** The message's claim is not on the record: stale or a duplicate. Nothing is written. */
function notClaimed(run: Run): MaintenanceResult {
  run.log(run.req.reason, { outcome: 'skipped', why: run.item ? 'the record holds another claim or none' : 'no such record' });
  return skipped('not-claimed');
}

/** A skip after the claim was read: release it, and say why. */
async function skipWithRelease(run: Run, why: string): Promise<MaintenanceResult> {
  await run.release();
  run.log(run.req.reason, { outcome: 'skipped', why });
  return skipped(why);
}

// --- Retire ----------------------------------------------------------------

function statusReason(reason: string, today: string, item: Item): string {
  const reinforced = /^\d{4}-\d{2}-\d{2}/.exec(str(item.updated_at))?.[0] ?? 'unknown';
  return `valkey-reviewer: retired (${reason}) ${today}; last reinforced ${reinforced}`;
}

/**
 * What a tombstone's reason was decided from, which its write pins:
 *   marker      the marker was read: the lifecycle's own reason needs it still there;
 *   no-marker   it was not: "operator" needs it still absent;
 *   decay       the retire message's own decision, for a registry record that is
 *               gone: the state the decay job decided from (updated_at as seen for
 *               decayed, obsolete_release for obsolete), as the marker write pins it;
 *   null        a reason that holds whatever the record says (REJECTED is "operator").
 *
 * A gone record gets different reasons in the two runs. A retire run
 * carries the decay job's decision, so the message's reason stands
 * (flow 4.2) while the record is still as the job saw it. A check has
 * no such decision: only the marker tells the lifecycle's retirement
 * from someone else's.
 */
type Pin = 'marker' | 'no-marker' | 'decay' | null;

/** The condition that the record is still as the decay job saw it when it asked for this retirement. */
function decayPin(w: Write, req: RetireRequest): Write {
  return req.retire_reason === 'decayed' ? w.is('updated_at', req.seen_updated_at) : w.exists('obsolete_release');
}

/** The tombstone: the skill is retired and the record stays as its provenance. */
async function tombstone(run: Run, reason: string, fromStatus: string | undefined, pin: Pin): Promise<boolean> {
  const w = new Write()
    .set('retired_at', run.nowIso)
    .set('retired_reason', reason)
    .remove(...CLAIM, MARKER, 'retire_refused_at');
  if (fromStatus) w.set('retired_from_status', fromStatus);
  if (pin === 'marker') w.is(MARKER, run.name);
  else if (pin === 'no-marker') w.isNot(MARKER, run.name);
  else if (pin === 'decay' && run.req.reason === 'retire') decayPin(w, run.req);
  const ok = await run.state(w);
  run.log(run.req.reason, ok
    ? { outcome: 'retired', retired_reason: reason, registry_status: fromStatus ?? 'none' }
    : { outcome: 'skipped', why: 'the record changed before the tombstone was written' });
  return ok;
}

/**
 * Record a retirement the registry already shows (the skill is
 * DEPRECATED, REJECTED or gone). A dry run writes no tombstone: it
 * releases the claim and reports what it would have recorded.
 */
async function retirement(run: Run, reason: string, fromStatus: string | undefined, pin: Pin): Promise<MaintenanceResult> {
  if (run.req.dry_run) {
    await run.release();
    run.log(run.req.reason, { outcome: 'would-record-retirement', retired_reason: reason, registry_status: fromStatus ?? 'none', mode: 'report' });
    return completed('would-record-retirement');
  }
  return await tombstone(run, reason, fromStatus, pin) ? completed('retired') : skipped('changed');
}

/** A retirement the registry refused: back off (decay waits RETIRE_REFUSED_BACKOFF_SECONDS) and release the claim. */
async function refused(run: Run, status: string): Promise<MaintenanceResult> {
  const w = new Write().set('retire_refused_at', run.nowIso).remove(...CLAIM);
  if (LIVE_STATUSES.has(status)) w.remove(MARKER);
  await run.state(w);
  console.warn(`[maintenance] retire-refused ${quoted(run.name)} status=${quoted(status)}`);
  run.log('retire', { outcome: 'refused', registry_status: status });
  return completed('refused');
}

async function* retire(run: Run, req: RetireRequest): AsyncGenerator<StreamFrame, MaintenanceResult> {
  const item = await run.read();
  if (!run.holds(item)) return notClaimed(run);
  if (str(item!.graduated_record_name) !== req.record_name) return skipWithRelease(run, 'renamed');
  if (item!.retired_at !== undefined) return skipWithRelease(run, 'already retired');
  if (req.retire_reason === 'decayed' && str(item!.updated_at) !== req.seen_updated_at) return skipWithRelease(run, 'reinforced since the request');
  if (req.retire_reason === 'obsolete' && item!.obsolete_release === undefined) return skipWithRelease(run, 'no longer obsolete');

  const markerRead = item![MARKER] === req.record_name;
  const skill = await run.deps.registry.get(req.record_name);
  if (!skill) return retirement(run, req.retire_reason, undefined, 'decay');
  if (skill.status === 'DEPRECATED' || skill.status === 'REJECTED') {
    // DEPRECATED with the marker: this lifecycle's own deprecation, from a run that died before its tombstone.
    const own = skill.status === 'DEPRECATED' && markerRead;
    return retirement(run, own ? req.retire_reason : 'operator', skill.status, own ? 'marker' : skill.status === 'DEPRECATED' ? 'no-marker' : null);
  }
  if (BUSY_STATUSES.has(skill.status)) {
    run.log('retire', { outcome: 'pending', registry_status: skill.status, why: 'the registry record is being written; the claim is kept' });
    return completed('pending');
  }
  run.liveRead = LIVE_STATUSES.has(skill.status);

  if (req.dry_run || !run.deps.settings.retireSkills) {
    await run.release();
    run.log('retire', { outcome: 'would-retire', retired_reason: req.retire_reason, registry_status: skill.status, mode: 'report' });
    return completed('would-retire');
  }

  // The marker first, so a deprecation that lands but is never recorded
  // here is still told apart from an operator's.
  if (await run.state(decayPin(new Write().set(MARKER, req.record_name), req)) === false) {
    run.log('retire', { outcome: 'skipped', why: 'the record changed before the deprecation' });
    return skipped('changed');
  }
  yield { event: 'status', data: { phase: 'deprecate', name: req.record_name } };

  try {
    await run.deps.registry.deprecate(skill.recordId, statusReason(req.retire_reason, run.nowIso.slice(0, 10), item!));
  } catch (err) {
    // Anything but a refusal is ambiguous: the claim and the marker stay,
    // and the redelivered message finds out what happened.
    if ((err as { name?: string } | null)?.name !== 'ValidationException') throw err;
    const fresh = await run.deps.registry.get(req.record_name);
    if (!fresh) return await tombstone(run, req.retire_reason, skill.status, 'decay') ? completed('retired') : skipped('changed');
    if (fresh.status === 'REJECTED') return await tombstone(run, 'operator', 'REJECTED', null) ? completed('retired') : skipped('changed');
    if (BUSY_STATUSES.has(fresh.status)) {
      run.log('retire', { outcome: 'pending', registry_status: fresh.status, why: 'the deprecation was refused while the record is being written; the claim is kept' });
      return completed('pending');
    }
    if (fresh.status !== 'DEPRECATED') return refused(run, fresh.status);
    // DEPRECATED after all: a duplicate of this message got there first.
  }
  return await tombstone(run, req.retire_reason, skill.status, 'marker') ? completed('retired') : skipped('changed');
}

// --- Check -----------------------------------------------------------------

/** What a check found and what it will record. */
interface Outcome {
  /** check_outcome; a repo check can also end 'proposed' or 'skipped'. */
  readonly outcome: 'clean' | 'accurate' | 'revised' | 'suspect' | 'obsolete' | 'inconclusive' | 'error' | 'proposed' | 'skipped';
  readonly note: string;
}

/** A check's deterministic result with what the record needs to store it. */
interface Checked {
  /** The checkout's directory, the audit tools' workspace root. */
  readonly dir: string;
  readonly co: UpstreamCheckout;
  readonly upstream: string;
  /** The commit of the last check the diff starts from, or null for a first check. */
  readonly base: string | null;
  /** The library's result, against the baseline: its lost names are this check's new losses. */
  readonly result: CheckResult;
  /**
   * The result as the audit and the record see it: `lost` also holds the
   * names of lost_names still cited and absent (`carried`), and
   * `newAbsent` no longer does.
   */
  readonly view: CheckResult;
  readonly baseline: readonly string[];
  /** Names lost at an earlier check that are still cited and absent. */
  readonly carried: readonly string[];
  /** ignored_names as the check used them: never a lost name. */
  readonly ignored: readonly string[];
  readonly ref: string;
  readonly label: string;
  readonly skillMd: string;
}

/** `names` in backticks, as many as fit in `room` characters, then "and N more". */
function nameList(list: readonly string[], room: number): string {
  const shown: string[] = [];
  let used = 0;
  for (const n of list.filter((x) => STORED_NAME_RE.test(x))) {
    const part = `\`${n}\``;
    if (used + part.length + 2 > room - 16) break;
    shown.push(part);
    used += part.length + 2;
  }
  const rest = list.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? `${shown.length ? ', ' : ''}and ${rest} more` : ''}`;
}

/** A check_note: code-generated from counts and the skill's own names, at most CHECK_NOTE_MAX characters. */
function note(head: string, list: readonly string[] = []): string {
  const text = list.length ? `${head}: ${nameList(list, CHECK_NOTE_MAX - head.length - 2)}` : head;
  return text.slice(0, CHECK_NOTE_MAX);
}

/** The note of a check with nothing flagged whose diff was not examined in full. */
function notExamined(c: Checked): string {
  return `the diff since the last check was not examined in full at ${c.ref} (${c.result.incomplete.length} reason(s)); the skill was not confirmed`;
}

/** The flagged names: lost, then new and absent, then touched. */
function flaggedNames(r: CheckResult): string[] {
  return [...new Set([...r.lost, ...r.newAbsent, ...r.touched])];
}

function storedNames(list: Iterable<string>, max: number): string[] {
  return [...new Set(list)].filter((n) => STORED_NAME_RE.test(n)).slice(0, max);
}

/** The citations of a proposed edit, at the checked commit. */
const citations = (c: Checked, e: CheckReport['edits'][number]): string[] =>
  e.evidence.map((x) => formatCitation({ repo: c.upstream, sha: c.co.tipSha, path: x.path, line: x.line }));

/** pending_revision: the audit's result for the operator, never shown to a model. */
function pendingRevision(at: string, c: Checked, report: CheckReport, reason: string): Record<string, unknown> {
  return {
    at,
    verdict: report.verdict,
    reason,
    summary: report.summary.slice(0, PENDING_SUMMARY_MAX),
    edits: report.edits.map((e) => ({ original: e.original, replacement: e.replacement, evidence: citations(c, e) })),
    ...(report.problems.length > 0 ? { problems: report.problems.slice(0, PENDING_PROBLEMS_MAX).map((p) => p.slice(0, 300)) } : {}),
  };
}

/** pending_revision.reason of a dry run's audit result. */
const DRY_RUN_REASON = 'dry run';

/**
 * A dry run's end after an audit: the claim is released, and the audit's
 * result goes into pending_revision, unless that holds a real check's
 * result the operator still needs. True when it was written.
 */
async function dryRunEnd(run: Run, c: Checked, report: CheckReport): Promise<boolean> {
  const held = run.item?.pending_revision as { reason?: unknown } | null | undefined;
  const real = held != null && held.reason !== DRY_RUN_REASON;
  const w = new Write().remove(...CLAIM);
  if (!real) w.set('pending_revision', pendingRevision(run.nowIso, c, report, DRY_RUN_REASON));
  await run.state(w);
  return !real;
}

/** Log each proposed edit of a report, for the operator's review. */
function logEdits(run: Run, c: Checked, report: CheckReport, applied: boolean): void {
  report.edits.forEach((e, i) => run.log('edit', {
    n: i + 1,
    of: report.edits.length,
    applied,
    evidence: citations(c, e).join(', '),
    original: e.original,
    replacement: e.replacement,
  }));
}

/**
 * The standing penalty for lost names: decay_score times the kept
 * fraction, conditioned on the score and updated_at as read. Without a
 * loss, or in a dry run, nothing.
 */
function penalize(w: Write, item: Item, keptFraction: number, lost: number): void {
  if (lost === 0 || keptFraction >= 1) return;
  const score = typeof item.decay_score === 'number' ? item.decay_score : 1;
  w.set('decay_score', score * keptFraction).is('decay_score', item.decay_score).is('updated_at', item.updated_at);
}

/**
 * A state write built from the record as read. One that loses its
 * condition is built again once from a fresh read, with `unchanged`
 * false when a reinforcement won (updated_at changed). A record that no
 * longer holds the claim gets nothing; when the second write loses too,
 * the claim is released.
 */
async function writeRetried(run: Run, build: (item: Item, unchanged: boolean) => Write): Promise<boolean> {
  const first = run.item!;
  if (await run.attempt(build(first, true))) return true;
  const fresh = await run.read();
  if (!run.holds(fresh)) return false;
  return run.state(build(fresh!, fresh!.updated_at === first.updated_at));
}

/**
 * The terminal write of a check that is not a dry run: the outcome, the
 * verification, the names, and the claim released, retried as
 * writeRetried does. `penalty` is false after a reinforcement, so the
 * standing penalty is dropped.
 */
async function finishCheck(run: Run, build: (item: Item, penalty: boolean) => Write): Promise<boolean> {
  return writeRetried(run, (item, penalty) => {
    const w = build(item, penalty);
    if (run.liveRead) w.remove(MARKER);
    return w;
  });
}

/** pending_revision.reason of an obsolete finding a reinforcement overtook. */
const REINFORCED_SINCE = 'reinforced since the check';

/** Fields every completed check sets: outcome, note, release and time; the claim goes. */
function outcomeWrite(run: Run, v: Outcome): Write {
  const tag = run.req.reason === 'repo_check' || run.req.reason === 'check' ? run.req.release_tag : '';
  return new Write()
    .set('check_outcome', v.outcome)
    .set('check_note', v.note)
    .set('verified_release', tag)
    .set('verified_at', run.nowIso)
    .remove(...CLAIM);
}

// Partial checks. A check whose diff since the base was examined only in
// part (the diff budget ran out, or a file's diff was cut) does not
// confirm by itself. The record counts such checks in a row in
// partial_checks, and check.ts's confirmableCommit lets the check after
// enough of them confirm, so a skill whose diff never fits still moves
// on. Each maintenance message counts once: partial_check_id names the
// message that counted last, so a redelivered copy adds nothing, and its
// own count is not one of the checks before it. A write that moves
// verified_sha removes both.

const PARTIAL = ['partial_checks', 'partial_check_id'] as const;

/** isPartial in check.ts (wp/fu2-skill-check): the diff since the base was examined, but only in part. */
function isPartial(result: CheckResult): boolean {
  return result.compared && result.incomplete.length > 0;
}

/**
 * confirmableCommit with the ConfirmOptions of wp/fu2-skill-check. A
 * library from before that change ignores the count, and a partial
 * result then never confirms.
 */
const confirmable: (result: CheckResult, opts?: { readonly partialBefore?: number }) => string | null = confirmableCommit;

function partialCount(item: Item): number {
  const n = item.partial_checks;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0;
}

/** Earlier partial checks in a row, without the one this message recorded on an earlier receive. */
function partialBefore(item: Item, id: string): number {
  const n = partialCount(item);
  return item.partial_check_id === id ? Math.max(0, n - 1) : n;
}

/** Count a partial result whose verification does not move, once per message. */
function countPartial(w: Write, run: Run, c: Checked, item: Item): void {
  if (!isPartial(c.result) || item.partial_check_id === run.req.maintenance_id) return;
  w.set('partial_checks', partialCount(item) + 1).set('partial_check_id', run.req.maintenance_id);
}

interface Verification {
  /** The commit the verification may move to; null when it stays. */
  readonly commit: string | null;
  /** The earlier partial checks counted. */
  readonly before: number;
  /** The commit was allowed past a partial diff. */
  readonly escaped: boolean;
}

/**
 * Whether the check's result may move the verification: decided once per
 * check, from the original result (never an edited body's re-check) and
 * the record as read.
 */
function verification(run: Run, c: Checked, item: Item): Verification {
  const before = partialBefore(item, run.req.maintenance_id);
  const commit = confirmable(c.result, { partialBefore: before });
  return { commit, before, escaped: commit !== null && c.result.incomplete.length > 0 };
}

/** The note of an outcome that went past a partial diff says so first. */
function advanced(ver: Verification, c: Checked, text: string): string {
  if (!ver.escaped) return text;
  return `advanced past a partial diff after ${ver.before} partial checks (${c.result.incomplete.join('; ')}); ${text}`.slice(0, CHECK_NOTE_MAX);
}

function logAdvance(run: Run, c: Checked, ver: Verification): void {
  if (!ver.escaped) return;
  console.log(`[maintenance] partial-advance ${quoted(subjectOf(run))} base=${(c.base ?? '').slice(0, 12)} tip=${c.co.tipSha.slice(0, 12)} partial_checks=${ver.before}`);
}

/**
 * The confirmation: verification moves to the checked commit, with
 * `present` as the new baseline, when `ver` allows it. Otherwise the
 * baseline stays and a partial result is counted.
 */
function confirm(w: Write, run: Run, c: Checked, present: readonly string[], item: Item, ver: Verification): void {
  if (ver.commit) w.set('verified_sha', ver.commit).set('verified_ref', c.ref).setNames('audit_names', storedAudit(present)).remove(...PARTIAL);
  else notMoved(w, run, c, item);
}

/** The verification stays: the baseline keeps all but this check's lost names, and a partial result is counted. */
function notMoved(w: Write, run: Run, c: Checked, item: Item): void {
  keepBaseline(w, item, c.result.lost);
  countPartial(w, run, c, item);
}

/** The baseline stays at the old commit; only lost names leave it, so each loss is penalised once. */
function keepBaseline(w: Write, item: Item, lost: readonly string[]): void {
  const gone = new Set(lost);
  w.setNames('audit_names', storedAudit(names(item.audit_names).filter((n) => !gone.has(n))));
}

function storedAudit(list: Iterable<string>): string[] {
  return [...new Set(list)].filter((n) => n.length <= 120).slice(0, AUDIT_NAMES_MAX);
}

/** lost_names: the lost names a check found that the skill still cites (see the module comment). */
function lostNames(w: Write, list: Iterable<string>): void {
  w.setNames('lost_names', storedAudit(list));
}

/** stale_names and stale_since: since stays at the first check that found them. */
function stale(w: Write, item: Item, list: readonly string[], nowIso: string): void {
  const kept = storedNames(list, STALE_NAMES_MAX);
  w.setNames('stale_names', kept);
  if (kept.length === 0) w.remove('stale_since');
  else w.set('stale_since', str(item.stale_since) || nowIso);
}

/** A check that ends without a result to act on: the claim is kept and the check is retried once it ages out. */
async function inconclusive(run: Run, why: string, fields: LogFields = {}, c?: Checked): Promise<MaintenanceResult> {
  if (run.req.dry_run) {
    await run.release();
    run.log(run.req.reason, { outcome: 'inconclusive', ...fields, note: why, mode: 'report' });
    return completed('inconclusive');
  }
  const recorded = await writeRetried(run, (it) => {
    const w = new Write().set('check_outcome', 'inconclusive').set('check_note', note(why));
    // A check that ran: a partial result counts, since the verification does not move.
    if (c) countPartial(w, run, c, it);
    return w;
  });
  return ended(run, 'inconclusive', recorded, { ...fields, note: why });
}

/**
 * A check that cannot succeed by retrying: recorded, with the release
 * and time, so it is due only at the next trigger. It comes before any
 * live read of the registry record, so the marker stays.
 */
async function failedForGood(run: Run, why: string): Promise<MaintenanceResult> {
  if (run.req.dry_run) await run.release();
  else await run.state(outcomeWrite(run, { outcome: 'error', note: note(why) }));
  run.log(run.req.reason, { outcome: 'error', note: why });
  return completed('error');
}

/** Clear checkouts a dead run left behind. */
async function sweepCheckouts(dir: string, nowMs: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    try {
      if (nowMs - (await stat(full)).mtimeMs > STALE_CHECKOUT_MS) await removeCheckout(full);
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

/**
 * Check out the upstream default branch into a fresh directory, run the
 * deterministic check of `skillMd` and pass it to `body`. The checkout
 * is removed afterwards, whatever happens. A failed checkout or check
 * gives `onError`.
 */
async function* withCheckout<T>(
  run: Run,
  upstream: string,
  skillMd: string,
  baselineFrom: Item,
  onError: (why: string) => Promise<T>,
  body: (c: Checked) => AsyncGenerator<StreamFrame, T>,
): AsyncGenerator<StreamFrame, T> {
  const { settings } = run.deps;
  await sweepCheckouts(settings.checkDir, run.now.getTime());
  const dir = path.join(settings.checkDir, `${run.req.reviewer_id}-${randomBytes(8).toString('hex')}`);
  try {
    yield { event: 'status', data: { phase: 'checkout', upstream } };
    // A verified_sha that is not a full SHA counts as no earlier check.
    const verified = str(baselineFrom.verified_sha);
    const base = SHA_RE.test(verified) ? verified : null;
    let co: UpstreamCheckout;
    try {
      co = await (run.deps.checkout ?? prepareUpstreamCheckout)({
        dir,
        url: (run.deps.upstreamUrl ?? ((r: string) => `https://github.com/${r}.git`))(upstream),
        ...(base ? { verifiedSha: base } : {}),
      });
    } catch (err) {
      console.warn(`[maintenance] checkout of ${upstream} failed: ${errorText(err)}`);
      return await onError('the upstream checkout failed');
    }
    let checked: Checked;
    try {
      const cited = extractNames(skillMd);
      const citedSet = new Set(cited.map((n) => n.token));
      const baseline = names(baselineFrom.audit_names).filter((n) => citedSet.has(n));
      const lostBefore = new Set(names(baselineFrom.lost_names));
      const ignored = names(baselineFrom.ignored_names).filter((n) => !lostBefore.has(n));
      // The base and the checkout whenever there is a base (the check.ts
      // contract of wp/fu2-skill-check): a base that could not be fetched
      // is then incomplete and never confirms, and only one the remote no
      // longer has (baseGone) gives a presence check that may.
      const input = { names: cited, baseline, ignored, ...(base ? { baseSha: base, checkout: co } : {}) };
      const result = await checkSkill(co.git, input);
      if (base && !co.baseAvailable) {
        const gone = (co as { readonly baseGone?: boolean }).baseGone === true;
        console.log(`[maintenance] ${gone ? 'base-gone' : 'base-unavailable'} ${quoted(subjectOf(run))} base=${base.slice(0, 12)}`);
      }
      // A name lost before is outside the baseline, so the library calls it new and absent.
      const carried = result.newAbsent.filter((n) => lostBefore.has(n));
      const view: CheckResult = {
        ...result,
        lost: [...result.lost, ...carried],
        newAbsent: result.newAbsent.filter((n) => !lostBefore.has(n)),
      };
      const tag = run.req.reason === 'retire' ? '' : run.req.release_tag;
      checked = {
        dir, co, upstream, base, result, view, baseline, carried, ignored, skillMd,
        ref: `${co.defaultBranch}@${co.tipSha.slice(0, 12)}`,
        label: releaseLabel(tag, co.defaultBranch, co.tipSha),
      };
    } catch (err) {
      console.warn(`[maintenance] check of ${upstream} failed: ${errorText(err)}`);
      return await onError('the deterministic check failed');
    }
    return yield* body(checked);
  } finally {
    await removeCheckout(dir).catch((err) => console.warn(`[maintenance] could not remove ${dir}: ${errorText(err)}`));
  }
}

/**
 * Run the audit: a bounded read-only model loop over the checkout that
 * ends with an accepted report_skill_check, or with null.
 */
async function* audit(
  run: Run,
  c: Checked,
  kind: 'registry' | 'repo',
  maxChars: number,
  startMs: number,
): AsyncGenerator<StreamFrame, { report: CheckReport | null; why: string }> {
  const { deps } = run;
  const r = c.view;
  const ctx: EditContext = {
    flagged: flaggedNames(r),
    release: c.label,
    date: run.nowIso.slice(0, 10),
    upstream: { repo: c.upstream, sha: c.co.tipSha },
    maxChars,
  };
  const resolve = createLineResolver(c.co.git, ctx.upstream);
  const checkRun = new CheckRun({
    lost: r.lost,
    allowObsolete: kind === 'registry',
    upstream: ctx.upstream,
    validate: (edits) => validateEdits(c.skillMd, edits, ctx, resolve),
  });
  const marker = randomBytes(12).toString('hex');
  const tag = run.req.reason === 'retire' ? '' : run.req.release_tag;
  yield { event: 'status', data: { phase: 'audit', flagged: ctx.flagged.length } };
  try {
    const result = yield* curate({
      model: deps.audit.model(),
      systemPrompt: deps.audit.systemPrompt,
      tools: await assembleCheckTools({ workspaceRoot: c.dir, run: checkRun }),
      run: checkRun,
      maxIterations: deps.settings.checkMaxRounds,
      deadlineMs: startMs + (deps.auditDeadlineMs ?? CHECK_DEADLINE_MS),
      printer: deps.printer ?? true,
      message: renderCheckMessage({
        kind,
        skillName: kind === 'registry' ? run.name : repoSkillPath(run.req.reviewer_id),
        upstream: c.upstream,
        branch: c.co.defaultBranch,
        tipSha: c.co.tipSha,
        baseSha: r.compared ? c.base : null,
        releaseTag: tag,
        releaseLabel: c.label,
        skillMd: c.skillMd,
        result: r,
        marker,
      }),
    });
    console.log(`[maintenance] audit ${result.status} rounds=${result.rounds} refusals=${checkRun.refusals} actions=${quoted(checkRun.actions.join('; '))}`);
    if (checkRun.done) return { report: checkRun.done, why: '' };
    const why = result.status === 'deadline' ? 'the audit reached its deadline without a report'
      : result.status === 'iteration_limit' ? `the audit used its ${deps.settings.checkMaxRounds} tool rounds without a report`
        : 'the audit ended without a report';
    return { report: null, why };
  } catch (err) {
    console.warn(`[maintenance] audit model failed: ${errorText(err)}`);
    return { report: null, why: 'the audit model failed' };
  }
}

/**
 * Whether the skill's subject is gone on deterministic evidence: most of
 * the baseline lost, counting the names earlier checks lost, or no file
 * left in its area.
 */
async function obsoleteCorroborated(c: Checked, area: readonly string[]): Promise<boolean> {
  const baseline = c.baseline.length + c.carried.length;
  const kept = c.baseline.length - c.result.lost.length;
  if (baseline >= 3 && kept / baseline < 0.5) return true;
  if (area.length === 0) return false;
  const counts = await areaFileCounts(c.co.git, area);
  return counts.every((n) => n === 0);
}

function areaGlobs(item: Item): string[] {
  const area = item.area instanceof Set ? [...item.area] : Array.isArray(item.area) ? item.area : [];
  return area.filter((g): g is string => typeof g === 'string' && g.length > 0);
}

async function* check(run: Run, req: CheckRequest): AsyncGenerator<StreamFrame, MaintenanceResult> {
  const startMs = Date.now();
  const item = await run.read();
  if (!run.holds(item)) return notClaimed(run);
  if (str(item!.graduated_record_name) !== req.record_name) return skipWithRelease(run, 'renamed');
  if (item!.retired_at !== undefined) return skipWithRelease(run, 'already retired');

  const skill = await run.deps.registry.get(req.record_name);
  const markerRead = item![MARKER] === req.record_name;
  // No graduated_at: submit_skill claimed the name but never published.
  if (!skill && item!.graduated_at === undefined) {
    return failedForGood(run, `the registry has no skill named ${req.record_name}; its publication never finished`);
  }
  if (!skill || skill.status === 'DEPRECATED') {
    // With the marker the lifecycle retired it; without it someone else did.
    const reason = markerRead ? (item!.obsolete_release !== undefined ? 'obsolete' : 'decayed') : 'operator';
    return retirement(run, reason, skill?.status, markerRead ? 'marker' : 'no-marker');
  }
  if (skill.status === 'REJECTED') return retirement(run, 'operator', skill.status, null);
  if (BUSY_STATUSES.has(skill.status)) return inconclusive(run, `the registry record is ${skill.status}`);
  if (!LIVE_STATUSES.has(skill.status)) return failedForGood(run, `the registry record is ${skill.status || 'in no status'}`);
  run.liveRead = true;

  // A deployment gap, fixed by configuration: skip and leave the check due.
  const upstream = run.deps.settings.upstreamRepos[req.reviewer_id];
  if (!upstream) return skipWithRelease(run, `no upstream repository is configured for ${req.reviewer_id}`);

  return yield* withCheckout(run, upstream, skill.skillMd, item!, (why) => inconclusive(run, why), (c) => checkBody(run, req, c, skill, startMs));
}

async function* checkBody(run: Run, req: CheckRequest, c: Checked, skill: SkillRecord, startMs: number): AsyncGenerator<StreamFrame, MaintenanceResult> {
  // Lost names include those of earlier checks; the penalty counts this check's new losses only (c.result).
  const r = c.view;
  const item = run.item!;
  const ver = verification(run, c, item);
  const counts = `${r.lost.length} lost, ${r.newAbsent.length} new and absent, ${r.touched.length} touched`;
  const fields = { release: c.label, ref: c.ref, lost: r.lost.length, new_absent: r.newAbsent.length, touched: r.touched.length };

  const flagged = flaggedNames(r);
  if (flagged.length === 0 && !ver.commit) {
    // Nothing flagged, but part of the diff went unexamined: no audit can
    // confirm it, so the claim is kept and the check runs again once it ages out.
    return inconclusive(run, notExamined(c), { ...fields, incomplete: r.incomplete.join('; ') }, c);
  }
  if (flagged.length === 0) {
    // Clean, or a partial diff the count lets past.
    const v: Outcome = { outcome: 'clean', note: advanced(ver, c, note(`${r.present.length} cited names present at ${c.ref}${r.compared ? ', no rare name touched since the last check' : ''}`)) };
    if (req.dry_run) {
      await run.release();
      run.log('check', { outcome: 'clean', ...fields, mode: 'report', note: v.note });
      return completed('clean');
    }
    const recorded = await finishCheck(run, (it) => {
      const w = outcomeWrite(run, v).remove('pending_revision');
      confirm(w, run, c, r.present, it, ver);
      stale(w, it, [], run.nowIso);
      lostNames(w, []);
      return w;
    });
    if (recorded) logAdvance(run, c, ver);
    return ended(run, 'clean', recorded, { ...fields, mode: 'apply', note: v.note });
  }

  if (!run.deps.audit.systemPrompt) return inconclusive(run, `${counts} at ${c.ref}; no audit prompt is configured`, {}, c);

  const { report, why } = yield* audit(run, c, 'registry', GRADUATED_SKILL_MAX_CHARS, startMs);
  if (!report) return inconclusive(run, `${counts} at ${c.ref}; ${why}`, {}, c);

  const valid = report.problems.length === 0;
  const unresolved = [...r.lost, ...r.newAbsent];
  const flaggedNote = (head: string) => note(`${head} at ${c.ref}`, unresolved.length ? unresolved : flagged);

  // Dry run: report what a real run would record, keep the audit's result for the operator, and leave everything else.
  if (req.dry_run) {
    const would = report.verdict === 'accurate' && valid ? 'would-accurate'
      : report.verdict === 'obsolete' && valid && await obsoleteCorroborated(c, areaGlobs(item)) ? 'would-obsolete'
        : report.verdict === 'revise' && valid && report.skillMd !== null ? 'would-revise'
          : 'would-suspect';
    const written = await dryRunEnd(run, c, report);
    logEdits(run, c, report, false);
    run.log('check', { outcome: would, verdict: report.verdict, ...fields, mode: 'report', valid, pending_revision: written ? 'written' : 'kept', summary: report.summary });
    return completed(would);
  }

  if (report.verdict === 'accurate' && valid) {
    const v: Outcome = { outcome: 'accurate', note: advanced(ver, c, flaggedNote(`${flagged.length} flagged name(s) judged accurate`)) };
    const recorded = await finishCheck(run, (it) => {
      const w = outcomeWrite(run, v).remove('pending_revision');
      confirm(w, run, c, r.present, it, ver);
      stale(w, it, [], run.nowIso);
      lostNames(w, []);
      // Never a name that was in the baseline: those are lost, not accurate.
      const audited = new Set([...names(it.audit_names), ...names(it.lost_names)]);
      const ignored = new Set([...names(it.ignored_names), ...r.newAbsent.filter((n) => !audited.has(n))]);
      w.setNames('ignored_names', storedNames(ignored, IGNORED_NAMES_MAX));
      return w;
    });
    if (recorded) logAdvance(run, c, ver);
    return ended(run, 'accurate', recorded, { ...fields, note: v.note, summary: report.summary });
  }

  if (report.verdict === 'obsolete' && valid && await obsoleteCorroborated(c, areaGlobs(item))) {
    const v: Outcome = { outcome: 'obsolete', note: flaggedNote(`the skill's subject is gone (${r.lost.length} of ${c.baseline.length + c.carried.length} names lost)`) };
    // What was written: a reinforcement since the read turns the finding into a suspect one.
    const written: { outcome: 'obsolete' | 'suspect' } = { outcome: 'obsolete' };
    const recorded = await finishCheck(run, (it, notReinforced) => {
      written.outcome = notReinforced ? 'obsolete' : 'suspect';
      if (!notReinforced) {
        // The record stays live and unverified; the finding waits for the operator.
        const w = outcomeWrite(run, { outcome: 'suspect', note: v.note }).set('pending_revision', pendingRevision(run.nowIso, c, report, REINFORCED_SINCE));
        notMoved(w, run, c, it);
        stale(w, it, unresolved, run.nowIso);
        lostNames(w, r.lost);
        return w;
      }
      const w = outcomeWrite(run, { outcome: 'obsolete', note: advanced(ver, c, v.note) }).remove('pending_revision');
      confirm(w, run, c, r.present, it, ver);
      stale(w, it, unresolved, run.nowIso);
      lostNames(w, r.lost);
      return w.set('obsolete_release', c.label).set('decay_score', 0).is('updated_at', it.updated_at);
    });
    if (recorded && written.outcome === 'obsolete') logAdvance(run, c, ver);
    return ended(run, written.outcome, recorded, {
      ...fields,
      ...(written.outcome === 'suspect' ? { why: REINFORCED_SINCE } : {}),
      note: v.note,
      summary: report.summary,
    });
  }

  if (report.verdict === 'revise' && valid && report.skillMd !== null && run.deps.settings.checkApplyEdits) {
    return yield* applyRevision(run, c, skill, report, fields, ver);
  }

  // Suspect: the edits wait for the operator, or there are none.
  const reason = report.verdict === 'revise' && valid ? 'CHECK_APPLY_EDITS is off'
    : !valid ? 'the report broke the rules and was accepted after refusals'
      : report.verdict === 'obsolete' ? 'obsolete without deterministic evidence'
        : report.verdict === 'accurate' ? 'accurate while names are missing'
          : 'the audit was unsure';
  const v: Outcome = { outcome: 'suspect', note: flaggedNote(`${counts}`) };
  const recorded = await finishCheck(run, (it, penalty) => {
    const w = outcomeWrite(run, v).set('pending_revision', pendingRevision(run.nowIso, c, report, reason));
    // The verification does not move.
    notMoved(w, run, c, it);
    stale(w, it, unresolved, run.nowIso);
    lostNames(w, r.lost);
    if (penalty) penalize(w, it, c.result.keptFraction, c.result.lost.length);
    return w;
  });
  logEdits(run, c, report, false);
  return ended(run, 'suspect', recorded, { ...fields, why: reason, note: v.note, summary: report.summary });
}

/**
 * Apply validated edits to the registry skill. The first write takes
 * the claim's id off the record together with the old text, so of two
 * copies of the message only one reaches the registry; the later writes
 * are conditioned on its revised_at.
 */
async function* applyRevision(
  run: Run,
  c: Checked,
  skill: SkillRecord,
  report: CheckReport,
  fields: Readonly<Record<string, string | number>>,
  ver: Verification,
): AsyncGenerator<StreamFrame, MaintenanceResult> {
  const revisedAt = run.nowIso;
  const claimed = await run.state(new Write()
    .set('previous_skill_md', skill.skillMd)
    .set('revised_at', revisedAt)
    .remove('maintenance_id'));
  if (!claimed) {
    run.log('check', { outcome: 'skipped', why: 'another run holds the record' });
    return skipped('changed');
  }
  yield { event: 'status', data: { phase: 'apply', edits: report.edits.length } };
  const edited = report.skillMd!;
  try {
    await run.deps.registry.update({ name: run.name, description: skill.description, skillMd: edited });
  } catch (err) {
    console.warn(`[maintenance] registry update of ${quoted(run.name)} failed: ${errorText(err)}`);
    const v: Outcome = { outcome: 'error', note: note(`the edited skill could not be written to the registry at ${c.ref}`) };
    // The record was read live, so a leftover marker goes, as in every terminal write after a live read.
    const w = outcomeWrite(run, v).set('pending_revision', pendingRevision(run.nowIso, c, report, 'the registry update failed')).remove(MARKER);
    countPartial(w, run, c, run.item!);
    await run.afterEdit(w, revisedAt);
    run.log('check', { outcome: 'error', ...fields, note: v.note });
    return completed('error');
  }

  // The new text's names, checked in the same checkout.
  const cited = extractNames(edited);
  const citedSet = new Set(cited.map((n) => n.token));
  const item = run.item!;
  const baseline = c.baseline.filter((n) => citedSet.has(n));
  let after: CheckResult;
  try {
    after = await checkSkill(c.co.git, { names: cited, baseline, ignored: c.ignored });
  } catch (err) {
    console.warn(`[maintenance] re-check of ${quoted(run.name)} failed: ${errorText(err)}`);
    after = { ...c.result, lost: [], newAbsent: [], keptFraction: 1 };
  }
  const remaining = [...after.lost, ...after.newAbsent];
  // A lost name the edits suppressed is no longer cited, and stops being lost.
  const stillLost = c.view.lost.filter((n) => citedSet.has(n));
  const v: Outcome = {
    outcome: 'revised',
    note: advanced(ver, c, remaining.length
      ? note(`${report.edits.length} edit(s) applied at ${c.ref}; still missing`, remaining)
      : note(`${report.edits.length} edit(s) applied at ${c.ref}`)),
  };
  const build = (it: Item, penalty: boolean): Write => {
    const w = outcomeWrite(run, v).remove('pending_revision');
    // Decided from the original check, never the re-check of the edited body.
    confirm(w, run, c, after.present, it, ver);
    stale(w, it, remaining, run.nowIso);
    lostNames(w, stillLost);
    if (run.liveRead) w.remove(MARKER);
    if (penalty) penalize(w, it, after.keptFraction, after.lost.length);
    return w;
  };
  let written = await run.afterEdit(build(item, true), revisedAt);
  if (!written) {
    const fresh = await run.read();
    if (fresh && fresh.revised_at === revisedAt && str(fresh.graduated_record_name) === run.name) {
      written = await run.afterEdit(build(fresh, fresh.updated_at === item.updated_at), revisedAt);
    }
  }
  logEdits(run, c, report, true);
  if (written) logAdvance(run, c, ver);
  run.log('check', { outcome: 'revised', ...fields, recorded: written, note: v.note, summary: report.summary });
  return completed('revised');
}

// --- Repo check ------------------------------------------------------------

/** What a run checks, for log lines: the registry record's name, or the repo skill file. */
function subjectOf(run: Run): string {
  return run.req.reason === 'repo_check' ? repoSkillPath(run.req.reviewer_id) : run.name;
}

/** The reviewer's built-in skill file in the bot's repository. */
export function repoSkillPath(reviewerId: string): string {
  return `agents/${reviewerId}/config/skill.md`;
}

/** The suppressed blocks `next` has and `previous` does not: the ones this check's edits added. */
function addedBlocks(previous: string, next: string): SuppressedBlock[] {
  const key = (b: SuppressedBlock) => `${b.release}\n${b.date}\n${b.reason}\n${b.original}`;
  const old = new Set(listSuppressedBlocks(previous).map(key));
  return listSuppressedBlocks(next).filter((b) => !old.has(key(b)));
}

/** Lines of a proposal's summary; each block's reason is at most 300 characters. */
const SUMMARY_LINES_MAX = 20;

/** The pull request's summary and evidence, generated from the validated blocks only: no model text. */
function proposalText(c: Checked, file: string, blocks: readonly SuppressedBlock[]): { summary: string; evidence: string[] } {
  const lines = [
    `The release check of ${c.upstream} at ${c.label} (${c.ref}) found ${blocks.length} stale piece(s) in ${file}:`,
    ...blocks.slice(0, SUMMARY_LINES_MAX).map((b) => `- ${b.reason}`),
  ];
  const evidence = [...new Set(blocks.flatMap((b) => b.evidence.map(formatCitation)))];
  return { summary: lines.join('\n'), evidence };
}

async function* repoCheck(run: Run, req: RepoCheckRequest): AsyncGenerator<StreamFrame, MaintenanceResult> {
  const startMs = Date.now();
  const item = await run.read();
  if (!run.holds(item)) return notClaimed(run);
  const filePath = repoSkillPath(req.reviewer_id);
  const { settings } = run.deps;

  /** Record a repo check's end on the item (not in a dry run) and log it. */
  const finish = async (v: Outcome, extra: (w: Write, it: Item) => void = () => {}, fields: LogFields = {}): Promise<MaintenanceResult> => {
    if (req.dry_run) {
      const w = new Write().remove(...CLAIM);
      extra(w, item!);
      await run.state(w);
      run.log('repo_check', { file: filePath, outcome: v.outcome, ...fields, note: v.note });
      return completed(v.outcome);
    }
    const recorded = await finishCheck(run, (it) => {
      const w = outcomeWrite(run, v);
      extra(w, it);
      return w;
    });
    return ended(run, v.outcome, recorded, { file: filePath, ...fields, note: v.note });
  };
  const keep = (why: string, fields: LogFields = {}, c?: Checked): Promise<MaintenanceResult> => inconclusive(run, why, { file: filePath, ...fields }, c);

  const upstream = settings.upstreamRepos[req.reviewer_id];
  if (!upstream) return skipWithRelease(run, `no upstream repository is configured for ${req.reviewer_id}`);
  // skillsRepo is optional: without it this release's check is recorded as skipped.
  if (!settings.skillsRepo) return finish({ outcome: 'skipped', note: 'no skills repository (SKILLS_REPO) is configured, so the file cannot be read' });
  if (!run.deps.repoSkills) return finish({ outcome: 'error', note: 'this curator cannot read the skills repository' });
  const skillsRepo = settings.skillsRepo;

  let api: RepoSkillApi;
  let file: { sha: string; content: string } | null;
  try {
    api = await run.deps.repoSkills();
    file = await api.fetchRepoFile(skillsRepo.repo, skillsRepo.baseBranch, filePath);
  } catch (err) {
    console.warn(`[maintenance] reading ${filePath} from ${skillsRepo.repo} failed: ${errorText(err)}`);
    return keep(`reading ${filePath} from ${skillsRepo.repo} failed`);
  }
  if (!file) return finish({ outcome: 'error', note: `${filePath} is not in ${skillsRepo.repo} at ${skillsRepo.baseBranch}` });
  const fetched = file;

  return yield* withCheckout(run, upstream, fetched.content, item!, keep, async function* (c) {
    const r = c.view;
    const fields = { release: c.label, ref: c.ref, lost: r.lost.length, new_absent: r.newAbsent.length, touched: r.touched.length, file_sha: fetched.sha.slice(0, 12) };
    const unresolved = [...r.lost, ...r.newAbsent];
    const flagged = flaggedNames(r);
    const counts = `${r.lost.length} lost, ${r.newAbsent.length} new and absent, ${r.touched.length} touched`;
    const ver = verification(run, c, item!);
    const confirmed = (w: Write, it: Item) => {
      confirm(w, run, c, r.present, it, ver);
      stale(w, it, [], run.nowIso);
      lostNames(w, []);
      w.set('skills_repo_sha', fetched.sha).remove('pending_revision');
    };
    /** A confirming outcome's end: a recorded one that went past a partial diff says so. */
    const confirming = async (v: Outcome, extra: (w: Write, it: Item) => void, logged: LogFields): Promise<MaintenanceResult> => {
      const result = await finish({ ...v, note: advanced(ver, c, v.note) }, req.dry_run ? undefined : extra, logged);
      if (!req.dry_run && result.status === 'completed') logAdvance(run, c, ver);
      return result;
    };
    const notConfirmed = (w: Write, it: Item, report: CheckReport | null, reason: string) => {
      notMoved(w, run, c, it);
      stale(w, it, unresolved, run.nowIso);
      lostNames(w, r.lost);
      w.set('skills_repo_sha', fetched.sha);
      if (report) w.set('pending_revision', pendingRevision(run.nowIso, c, report, reason));
    };

    if (flagged.length === 0 && !ver.commit) return keep(notExamined(c), { ...fields, incomplete: r.incomplete.join('; ') }, c);
    if (flagged.length === 0) return confirming({ outcome: 'clean', note: note(`${r.present.length} cited names present at ${c.ref}`) }, confirmed, fields);
    if (!run.deps.audit.systemPrompt) return keep(`${counts} at ${c.ref}; no audit prompt is configured`, {}, c);

    const { report, why } = yield* audit(run, c, 'repo', SKILL_MD_MAX_CHARS, startMs);
    if (!report) return keep(`${counts} at ${c.ref}; ${why}`, {}, c);
    const valid = report.problems.length === 0;
    const fieldsWith = { ...fields, verdict: report.verdict, valid, summary: report.summary };

    if (req.dry_run) {
      const would = report.verdict === 'accurate' && valid ? 'would-accurate'
        : report.verdict === 'revise' && valid && report.skillMd !== null ? 'would-revise'
          : 'would-suspect';
      const written = await dryRunEnd(run, c, report);
      logEdits(run, c, report, false);
      run.log('repo_check', { file: filePath, outcome: would, ...fieldsWith, mode: 'report', pending_revision: written ? 'written' : 'kept', note: note(`${counts} at ${c.ref}`, unresolved) });
      return completed(would);
    }
    if (report.verdict === 'accurate' && valid) {
      return confirming({ outcome: 'accurate', note: note(`${flagged.length} flagged name(s) judged accurate at ${c.ref}`, flagged) }, (w, it) => {
        confirmed(w, it);
        const audited = new Set([...names(it.audit_names), ...names(it.lost_names)]);
        w.setNames('ignored_names', storedNames(new Set([...names(it.ignored_names), ...r.newAbsent.filter((n) => !audited.has(n))]), IGNORED_NAMES_MAX));
      }, fieldsWith);
    }

    const proposing = report.verdict === 'revise' && valid && report.skillMd !== null
      && settings.checkOpenPullRequests && skillsRepo.tokenFunction !== '';
    if (!proposing) {
      const reason = report.verdict === 'revise' && valid ? 'pull requests are off (CHECK_OPEN_PULL_REQUESTS or SKILLS_REPO_TOKEN_FUNCTION)'
        : !valid ? 'the report broke the rules and was accepted after refusals' : `the audit reported ${report.verdict}`;
      logEdits(run, c, report, false);
      return finish({ outcome: 'suspect', note: note(`${counts} at ${c.ref}`, unresolved) }, (w, it) => notConfirmed(w, it, report, reason), { ...fieldsWith, why: reason });
    }

    const blocks = addedBlocks(fetched.content, report.skillMd!);
    const { summary, evidence } = proposalText(c, filePath, blocks);
    let pr: RepoSkillPrResult;
    try {
      yield { event: 'status', data: { phase: 'pull_request', file: filePath } };
      pr = await api.propose({
        reviewerId: req.reviewer_id,
        releaseLabel: c.label,
        path: filePath,
        baseSha: fetched.sha,
        baseContent: fetched.content,
        newContent: report.skillMd!,
        summary,
        evidence,
      });
    } catch (err) {
      console.warn(`[maintenance] pull request for ${filePath} failed: ${errorText(err)}`);
      logEdits(run, c, report, false);
      return keep(`${counts} at ${c.ref}; the pull request could not be opened`, {}, c);
    }
    logEdits(run, c, report, pr.action !== 'refused' && pr.action !== 'base-moved');
    const prFields = { ...fieldsWith, pr: pr.action, branch: pr.branch, url: pr.url ?? '' };
    if (pr.action === 'base-moved') {
      // The file changed under the proposal: release without recording, so the next pass checks the new text.
      await run.release();
      run.log('repo_check', { file: filePath, outcome: 'inconclusive', ...prFields, note: 'the base branch moved; checked again at the next pass' });
      return completed('inconclusive');
    }
    if (pr.action === 'refused') {
      return finish({ outcome: 'error', note: note(`the pull request was refused: ${(pr.reason ?? '').slice(0, 200)}`) },
        (w, it) => notConfirmed(w, it, report, 'the pull request was refused'), prFields);
    }
    return finish({ outcome: 'proposed', note: note(`pull request ${pr.action} on ${pr.branch}${pr.url ? `: ${pr.url}` : ''}`) },
      (w, it) => notConfirmed(w, it, report, `proposed by pull request on ${pr.branch}`), prFields);
  });
}
