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
 * Report mode. A dry_run message, or a switch that is off
 * (CHECK_APPLY_EDITS, RETIRE_SKILLS, CHECK_OPEN_PULL_REQUESTS), never
 * writes the registry or opens a pull request. Every run logs one
 * "[maintenance] ..." report line, plus one line per proposed edit. A
 * dry run also leaves the verification and the standing as they are:
 * it records only the audit's result (pending_revision) and releases
 * the claim, so the next real pass checks again.
 */

const RECORD_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
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

  log(kind: string, fields: Readonly<Record<string, string | number | boolean | undefined>>): void {
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
 * The tombstone: the skill is retired and the record stays as its
 * provenance. `markerRead` pins the reason it decided: the lifecycle's
 * own reasons need the marker, "operator" needs its absence.
 */
async function tombstone(run: Run, reason: string, fromStatus: string | undefined, markerRead: boolean | null): Promise<boolean> {
  const w = new Write()
    .set('retired_at', run.nowIso)
    .set('retired_reason', reason)
    .remove(...CLAIM, MARKER, 'retire_refused_at');
  if (fromStatus) w.set('retired_from_status', fromStatus);
  if (markerRead === true) w.is(MARKER, run.name);
  else if (markerRead === false) w.isNot(MARKER, run.name);
  const ok = await run.state(w);
  run.log(run.req.reason, ok
    ? { outcome: 'retired', retired_reason: reason, registry_status: fromStatus ?? 'none' }
    : { outcome: 'skipped', why: 'the record changed before the tombstone was written' });
  return ok;
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
  if (!skill) return completed(await tombstone(run, req.retire_reason, undefined, null) ? 'retired' : 'skipped');
  if (skill.status === 'DEPRECATED' || skill.status === 'REJECTED') {
    // DEPRECATED with the marker: this lifecycle's own deprecation, from a run that died before its tombstone.
    const own = skill.status === 'DEPRECATED' && markerRead;
    return completed(await tombstone(run, own ? req.retire_reason : 'operator', skill.status, own ? true : skill.status === 'DEPRECATED' ? false : null) ? 'retired' : 'skipped');
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
  const mark = new Write().set(MARKER, req.record_name);
  if (req.retire_reason === 'decayed') mark.is('updated_at', req.seen_updated_at);
  else mark.exists('obsolete_release');
  if (await run.state(mark) === false) {
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
    if (!fresh) return completed(await tombstone(run, req.retire_reason, skill.status, null) ? 'retired' : 'skipped');
    if (fresh.status === 'REJECTED') return completed(await tombstone(run, 'operator', 'REJECTED', null) ? 'retired' : 'skipped');
    if (BUSY_STATUSES.has(fresh.status)) {
      run.log('retire', { outcome: 'pending', registry_status: fresh.status, why: 'the deprecation was refused while the record is being written; the claim is kept' });
      return completed('pending');
    }
    if (fresh.status !== 'DEPRECATED') return refused(run, fresh.status);
    // DEPRECATED after all: a duplicate of this message got there first.
  }
  return completed(await tombstone(run, req.retire_reason, skill.status, true) ? 'retired' : 'skipped');
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
  readonly result: CheckResult;
  readonly baseline: readonly string[];
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
 * The terminal write of a check that is not a dry run: the outcome, the
 * verification, the names, and the claim released. A write that loses
 * its condition is built again once from a fresh read, without the
 * standing penalty when a reinforcement won (updated_at changed). A
 * record that no longer holds the claim gets nothing; when the second
 * write loses too, the claim is released.
 */
async function finishCheck(run: Run, build: (item: Item, penalty: boolean) => Write): Promise<boolean> {
  const first = run.item!;
  const terminal = (item: Item, penalty: boolean) => {
    const w = build(item, penalty);
    if (run.liveRead) w.remove(MARKER);
    return w;
  };
  if (await run.attempt(terminal(first, true))) return true;
  const fresh = await run.read();
  if (!run.holds(fresh)) return false;
  return run.state(terminal(fresh!, fresh!.updated_at === first.updated_at));
}

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

/** The confirmation: verification moves to the checked commit unless the result was incomplete. */
function confirm(w: Write, c: Checked, present: readonly string[], item: Item, lost: readonly string[]): void {
  const commit = confirmableCommit(c.result);
  if (commit) {
    w.set('verified_sha', commit).set('verified_ref', c.ref).setNames('audit_names', storedAudit(present));
  } else {
    // The baseline stays at the old commit; only lost names leave it, so each loss is penalised once.
    const lostSet = new Set(lost);
    w.setNames('audit_names', storedAudit(names(item.audit_names).filter((n) => !lostSet.has(n))));
  }
}

function storedAudit(list: Iterable<string>): string[] {
  return [...new Set(list)].filter((n) => n.length <= 120).slice(0, AUDIT_NAMES_MAX);
}

/** stale_names and stale_since: since stays at the first check that found them. */
function stale(w: Write, item: Item, list: readonly string[], nowIso: string): void {
  const kept = storedNames(list, STALE_NAMES_MAX);
  w.setNames('stale_names', kept);
  if (kept.length === 0) w.remove('stale_since');
  else w.set('stale_since', str(item.stale_since) || nowIso);
}

/** A check that ends without a result to act on: the claim is kept and the check is retried once it ages out. */
async function inconclusive(run: Run, why: string): Promise<MaintenanceResult> {
  if (run.req.dry_run) await run.release();
  else await run.state(new Write().set('check_outcome', 'inconclusive').set('check_note', note(why)));
  run.log(run.req.reason, { outcome: 'inconclusive', note: why });
  return completed('inconclusive');
}

/** A check that cannot succeed by retrying: recorded, with the release and time, so it is due only at the next trigger. */
async function failedForGood(run: Run, why: string): Promise<MaintenanceResult> {
  if (run.req.dry_run) await run.release();
  else {
    const w = outcomeWrite(run, { outcome: 'error', note: note(why) });
    if (run.liveRead) w.remove(MARKER);
    await run.state(w);
  }
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
    let co: UpstreamCheckout;
    try {
      const verifiedSha = str(baselineFrom.verified_sha) || undefined;
      co = await (run.deps.checkout ?? prepareUpstreamCheckout)({
        dir,
        url: (run.deps.upstreamUrl ?? ((r: string) => `https://github.com/${r}.git`))(upstream),
        ...(verifiedSha ? { verifiedSha } : {}),
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
      const result = await checkSkill(co.git, {
        names: cited,
        baseline,
        ignored: names(baselineFrom.ignored_names),
        ...(co.baseAvailable ? { baseSha: str(baselineFrom.verified_sha) } : {}),
      });
      const tag = run.req.reason === 'retire' ? '' : run.req.release_tag;
      checked = {
        dir, co, upstream, result, baseline, skillMd,
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
  const r = c.result;
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
        baseSha: r.compared ? str(run.item?.verified_sha) || null : null,
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

/** Whether the skill's subject is gone on deterministic evidence: most of the baseline lost, or no file left in its area. */
async function obsoleteCorroborated(c: Checked, area: readonly string[]): Promise<boolean> {
  if (c.baseline.length >= 3 && c.result.keptFraction < 0.5) return true;
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
    return completed(await tombstone(run, reason, skill?.status, markerRead) ? 'retired' : 'skipped');
  }
  if (skill.status === 'REJECTED') return completed(await tombstone(run, 'operator', skill.status, null) ? 'retired' : 'skipped');
  if (BUSY_STATUSES.has(skill.status)) return inconclusive(run, `the registry record is ${skill.status}`);
  if (!LIVE_STATUSES.has(skill.status)) return failedForGood(run, `the registry record is ${skill.status || 'in no status'}`);
  run.liveRead = true;

  // A deployment gap, fixed by configuration: skip and leave the check due.
  const upstream = run.deps.settings.upstreamRepos[req.reviewer_id];
  if (!upstream) return skipWithRelease(run, `no upstream repository is configured for ${req.reviewer_id}`);

  return yield* withCheckout(run, upstream, skill.skillMd, item!, (why) => inconclusive(run, why), (c) => checkBody(run, req, c, skill, startMs));
}

async function* checkBody(run: Run, req: CheckRequest, c: Checked, skill: SkillRecord, startMs: number): AsyncGenerator<StreamFrame, MaintenanceResult> {
  const r = c.result;
  const item = run.item!;
  const counts = `${r.lost.length} lost, ${r.newAbsent.length} new and absent, ${r.touched.length} touched`;
  const fields = { release: c.label, ref: c.ref, lost: r.lost.length, new_absent: r.newAbsent.length, touched: r.touched.length };

  if (r.clean) {
    const v: Outcome = { outcome: 'clean', note: note(`${r.present.length} cited names present at ${c.ref}${r.compared ? ', no rare name touched since the last check' : ''}`) };
    if (req.dry_run) await run.release();
    else {
      await finishCheck(run, () => {
        const w = outcomeWrite(run, v).remove('pending_revision');
        confirm(w, c, r.present, item, []);
        stale(w, item, [], run.nowIso);
        return w;
      });
    }
    run.log('check', { outcome: 'clean', ...fields, mode: req.dry_run ? 'report' : 'apply', note: v.note });
    return completed('clean');
  }

  const flagged = flaggedNames(r);
  if (flagged.length === 0) {
    // Nothing flagged, but part of the diff went unexamined: no audit can confirm it.
    const v: Outcome = { outcome: 'suspect', note: note(`the diff since the last check was not examined in full at ${c.ref} (${r.incomplete.length} reason(s)); the skill was not confirmed`) };
    if (req.dry_run) await run.release();
    else {
      await finishCheck(run, () => {
        const w = outcomeWrite(run, v);
        confirm(w, c, r.present, item, []);
        return w;
      });
    }
    run.log('check', { outcome: 'suspect', ...fields, incomplete: r.incomplete.join('; '), note: v.note });
    return completed('suspect');
  }

  if (!run.deps.audit.systemPrompt) return inconclusive(run, `${counts} at ${c.ref}; no audit prompt is configured`);

  const { report, why } = yield* audit(run, c, 'registry', GRADUATED_SKILL_MAX_CHARS, startMs);
  if (!report) return inconclusive(run, `${counts} at ${c.ref}; ${why}`);

  const valid = report.problems.length === 0;
  const unresolved = [...r.lost, ...r.newAbsent];
  const flaggedNote = (head: string) => note(`${head} at ${c.ref}`, unresolved.length ? unresolved : flagged);

  // Dry run: record the audit's result for the operator and leave everything else.
  if (req.dry_run) {
    await run.state(new Write().set('pending_revision', pendingRevision(run.nowIso, c, report, 'dry run')).remove(...CLAIM));
    logEdits(run, c, report, false);
    run.log('check', { outcome: `would-${report.verdict}`, ...fields, mode: 'report', valid, summary: report.summary });
    return completed(report.verdict === 'revise' && valid ? 'would-revise' : 'suspect');
  }

  if (report.verdict === 'accurate' && valid) {
    const v: Outcome = { outcome: 'accurate', note: flaggedNote(`${flagged.length} flagged name(s) judged accurate`) };
    await finishCheck(run, () => {
      const w = outcomeWrite(run, v).remove('pending_revision');
      confirm(w, c, r.present, item, []);
      stale(w, item, [], run.nowIso);
      const ignored = new Set([...names(item.ignored_names), ...r.newAbsent]);
      w.setNames('ignored_names', storedNames(ignored, IGNORED_NAMES_MAX));
      return w;
    });
    run.log('check', { outcome: 'accurate', ...fields, note: v.note, summary: report.summary });
    return completed('accurate');
  }

  if (report.verdict === 'obsolete' && valid && await obsoleteCorroborated(c, areaGlobs(item))) {
    const v: Outcome = { outcome: 'obsolete', note: flaggedNote(`the skill's subject is gone (${r.lost.length} of ${c.baseline.length} names lost)`) };
    await finishCheck(run, (it, reinforcedNot) => {
      const w = outcomeWrite(run, reinforcedNot ? v : { outcome: 'suspect', note: v.note }).remove('pending_revision');
      confirm(w, c, r.present, it, r.lost);
      stale(w, it, unresolved, run.nowIso);
      // A reinforcement since the read wins: the record stays live and only the finding is kept.
      if (reinforcedNot) w.set('obsolete_release', c.label).set('decay_score', 0).is('updated_at', it.updated_at);
      return w;
    });
    run.log('check', { outcome: 'obsolete', ...fields, note: v.note, summary: report.summary });
    return completed('obsolete');
  }

  if (report.verdict === 'revise' && valid && report.skillMd !== null && run.deps.settings.checkApplyEdits) {
    return yield* applyRevision(run, c, skill, report, fields);
  }

  // Suspect: the edits wait for the operator, or there are none.
  const reason = report.verdict === 'revise' && valid ? 'CHECK_APPLY_EDITS is off'
    : !valid ? 'the report broke the rules and was accepted after refusals'
      : report.verdict === 'obsolete' ? 'obsolete without deterministic evidence'
        : report.verdict === 'accurate' ? 'accurate while names are missing'
          : 'the audit was unsure';
  const v: Outcome = { outcome: 'suspect', note: flaggedNote(`${counts}`) };
  await finishCheck(run, (it, penalty) => {
    const w = outcomeWrite(run, v).set('pending_revision', pendingRevision(run.nowIso, c, report, reason));
    // The verification does not move: the baseline stays, less the lost names.
    w.setNames('audit_names', storedAudit(names(it.audit_names).filter((n) => !r.lost.includes(n))));
    stale(w, it, unresolved, run.nowIso);
    if (penalty) penalize(w, it, r.keptFraction, r.lost.length);
    return w;
  });
  logEdits(run, c, report, false);
  run.log('check', { outcome: 'suspect', ...fields, why: reason, note: v.note, summary: report.summary });
  return completed('suspect');
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
    await run.afterEdit(outcomeWrite(run, v).set('pending_revision', pendingRevision(run.nowIso, c, report, 'the registry update failed')), revisedAt);
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
    after = await checkSkill(c.co.git, { names: cited, baseline, ignored: names(item.ignored_names) });
  } catch (err) {
    console.warn(`[maintenance] re-check of ${quoted(run.name)} failed: ${errorText(err)}`);
    after = { ...c.result, lost: [], newAbsent: [], keptFraction: 1 };
  }
  const remaining = [...after.lost, ...after.newAbsent];
  const v: Outcome = {
    outcome: 'revised',
    note: remaining.length
      ? note(`${report.edits.length} edit(s) applied at ${c.ref}; still missing`, remaining)
      : note(`${report.edits.length} edit(s) applied at ${c.ref}`),
  };
  const build = (it: Item, penalty: boolean): Write => {
    const w = outcomeWrite(run, v).remove('pending_revision');
    const commit = confirmableCommit(c.result);
    if (commit) w.set('verified_sha', commit).set('verified_ref', c.ref).setNames('audit_names', storedAudit(after.present));
    else w.setNames('audit_names', storedAudit(names(it.audit_names).filter((n) => !after.lost.includes(n))));
    stale(w, it, remaining, run.nowIso);
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
  run.log('check', { outcome: 'revised', ...fields, recorded: written, note: v.note, summary: report.summary });
  return completed('revised');
}

// --- Repo check ------------------------------------------------------------

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

/** The pull request's summary and evidence, generated from the validated blocks only. */
function proposalText(c: Checked, path_: string, blocks: readonly SuppressedBlock[]): { summary: string; evidence: string[] } {
  const reasons = blocks.map((b) => b.reason);
  const summary = `The release check of ${c.upstream} at ${c.label} (${c.ref}) found ${blocks.length} stale piece(s) in ${path_}: ${reasons.join('; ')}`;
  const evidence = [...new Set(blocks.flatMap((b) => b.evidence.map(formatCitation)))];
  return { summary: summary.slice(0, 2_000), evidence };
}

async function* repoCheck(run: Run, req: RepoCheckRequest): AsyncGenerator<StreamFrame, MaintenanceResult> {
  const startMs = Date.now();
  const item = await run.read();
  if (!run.holds(item)) return notClaimed(run);
  const filePath = repoSkillPath(req.reviewer_id);
  const { settings } = run.deps;

  /** Record a repo check's end on the item (not in a dry run) and log it. */
  const finish = async (v: Outcome, extra: (w: Write) => void = () => {}, fields: Record<string, string | number | boolean> = {}): Promise<MaintenanceResult> => {
    if (req.dry_run) {
      const w = new Write().remove(...CLAIM);
      extra(w);
      await run.state(w);
    } else {
      const w = outcomeWrite(run, v);
      extra(w);
      await run.state(w);
    }
    run.log('repo_check', { file: filePath, outcome: v.outcome, ...fields, note: v.note });
    return completed(v.outcome);
  };
  const keep = async (why: string): Promise<MaintenanceResult> => {
    if (req.dry_run) await run.release();
    else await run.state(new Write().set('check_outcome', 'inconclusive').set('check_note', note(why)));
    run.log('repo_check', { file: filePath, outcome: 'inconclusive', note: why });
    return completed('inconclusive');
  };

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
    const r = c.result;
    const fields = { release: c.label, ref: c.ref, lost: r.lost.length, new_absent: r.newAbsent.length, touched: r.touched.length, file_sha: fetched.sha.slice(0, 12) };
    const unresolved = [...r.lost, ...r.newAbsent];
    const flagged = flaggedNames(r);
    const counts = `${r.lost.length} lost, ${r.newAbsent.length} new and absent, ${r.touched.length} touched`;
    const confirmed = (w: Write) => {
      confirm(w, c, r.present, item!, []);
      stale(w, item!, [], run.nowIso);
      w.set('skills_repo_sha', fetched.sha).remove('pending_revision');
    };
    const notConfirmed = (w: Write, report: CheckReport | null, reason: string) => {
      w.setNames('audit_names', storedAudit(names(item!.audit_names).filter((n) => !r.lost.includes(n))));
      stale(w, item!, unresolved, run.nowIso);
      w.set('skills_repo_sha', fetched.sha);
      if (report) w.set('pending_revision', pendingRevision(run.nowIso, c, report, reason));
    };

    if (r.clean) {
      return finish({ outcome: 'clean', note: note(`${r.present.length} cited names present at ${c.ref}`) }, req.dry_run ? undefined : confirmed, fields);
    }
    if (flagged.length === 0) {
      return finish({ outcome: 'suspect', note: note(`the diff since the last check was not examined in full at ${c.ref}`) },
        req.dry_run ? undefined : (w) => confirm(w, c, r.present, item!, []), fields);
    }
    if (!run.deps.audit.systemPrompt) return keep(`${counts} at ${c.ref}; no audit prompt is configured`);

    const { report, why } = yield* audit(run, c, 'repo', SKILL_MD_MAX_CHARS, startMs);
    if (!report) return keep(`${counts} at ${c.ref}; ${why}`);
    const valid = report.problems.length === 0;
    const fieldsWith = { ...fields, verdict: report.verdict, valid, summary: report.summary };

    if (req.dry_run) {
      logEdits(run, c, report, false);
      return finish({ outcome: 'suspect', note: note(`${counts} at ${c.ref}`, unresolved) },
        (w) => w.set('pending_revision', pendingRevision(run.nowIso, c, report, 'dry run')), { ...fieldsWith, mode: 'report' });
    }
    if (report.verdict === 'accurate' && valid) {
      return finish({ outcome: 'accurate', note: note(`${flagged.length} flagged name(s) judged accurate at ${c.ref}`, flagged) }, (w) => {
        confirmed(w);
        w.setNames('ignored_names', storedNames(new Set([...names(item!.ignored_names), ...r.newAbsent]), IGNORED_NAMES_MAX));
      }, fieldsWith);
    }

    const proposing = report.verdict === 'revise' && valid && report.skillMd !== null
      && settings.checkOpenPullRequests && skillsRepo.tokenFunction !== '';
    if (!proposing) {
      const reason = report.verdict === 'revise' && valid ? 'pull requests are off (CHECK_OPEN_PULL_REQUESTS or SKILLS_REPO_TOKEN_FUNCTION)'
        : !valid ? 'the report broke the rules and was accepted after refusals' : `the audit reported ${report.verdict}`;
      logEdits(run, c, report, false);
      return finish({ outcome: 'suspect', note: note(`${counts} at ${c.ref}`, unresolved) }, (w) => notConfirmed(w, report, reason), { ...fieldsWith, why: reason });
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
      return keep(`${counts} at ${c.ref}; the pull request could not be opened`);
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
        (w) => notConfirmed(w, report, 'the pull request was refused'), prFields);
    }
    return finish({ outcome: 'proposed', note: note(`pull request ${pr.action} on ${pr.branch}${pr.url ? `: ${pr.url}` : ''}`) },
      (w) => notConfirmed(w, report, `proposed by pull request on ${pr.branch}`), prFields);
  });
}
