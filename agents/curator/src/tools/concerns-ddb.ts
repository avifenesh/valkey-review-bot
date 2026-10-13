import { z } from 'zod';
import { tool, type Tool } from '@strands-agents/sdk';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { CancellationReason } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';
import { errorText, fail, ok, type CuratorRun } from './run.js';

/**
 * Concerns-store tools for one reviewer's table.
 *
 * The model reads records and decides what the feedback means; these
 * tools list, read and apply one change. There is no similarity search.
 *
 * Records are keyed by (area_bucket, record_id). record_id is a random
 * UUID assigned by create_concern. Every write carries a condition on
 * the state it was computed from, so two curator runs touching the same
 * record cannot overwrite each other or count one person twice.
 *
 * Attributes:
 *   area, subject, concern, context   the concern; a graduated skill is written from these
 *   reinforcement_count               number of distinct reinforcements
 *   reinforcers                       string set of actor#repo#pr keys behind the count
 *   decay_score, updated_at           1.0 and the time of the last reinforcement; ops/src/decay.ts lowers the score
 *   edited_at                         last area/context edit that was not a reinforcement
 *   graduated_record_name, graduated_at   set by submit_skill
 */

export interface ConcernsDeps {
  readonly ddb: Pick<DynamoDBDocumentClient, 'send'>;
  readonly table: string;
  readonly run: CuratorRun;
}

/** Records list_concerns returns, after sorting the whole bucket. */
export const LIST_LIMIT = 20;
/**
 * area_bucket values that start with this are reserved for items the
 * skill lifecycle keeps in the table, such as the repo skill check item
 * (RESERVED_BUCKET_PREFIX in ops/src/decay.ts). They are not concern
 * records: every tool refuses such a bucket, and no tool output shows
 * their items.
 */
export const RESERVED_BUCKET_PREFIX = '#';
/** Upper bound on a record's context, so repeated additions cannot grow it without limit. */
export const CONTEXT_MAX_CHARS = 4000;

type Item = Record<string, unknown>;

const NAMES = {
  '#rid': 'record_id',
  '#area': 'area',
  '#subject': 'subject',
  '#concern': 'concern',
  '#ctx': 'context',
  '#rc': 'reinforcement_count',
  '#rs': 'reinforcers',
  '#ds': 'decay_score',
  '#ua': 'updated_at',
  '#ea': 'edited_at',
  '#grn': 'graduated_record_name',
} as const;

type NameKey = keyof typeof NAMES;

/** ExpressionAttributeNames for exactly the placeholders an expression uses; DynamoDB rejects unused ones. */
function names(...keys: NameKey[]): Record<string, string> {
  return Object.fromEntries(keys.map((k) => [k, NAMES[k]]));
}

function namesIn(...expressions: string[]): Record<string, string> {
  const used = new Set<NameKey>();
  for (const expr of expressions) {
    for (const m of expr.matchAll(/#[a-z]+/g)) {
      if (m[0] in NAMES) used.add(m[0] as NameKey);
    }
  }
  return names(...used);
}

function count(item: Item): number {
  return typeof item.reinforcement_count === 'number' ? item.reinforcement_count : 0;
}

function reinforcers(item: Item): Set<string> {
  return item.reinforcers instanceof Set ? (item.reinforcers as Set<string>) : new Set();
}

function graduatedName(item: Item): string {
  return typeof item.graduated_record_name === 'string' ? item.graduated_record_name : '';
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

export function isReservedBucket(areaBucket: unknown): boolean {
  return typeof areaBucket === 'string' && areaBucket.startsWith(RESERVED_BUCKET_PREFIX);
}

/** The refusal for a tool given a reserved area_bucket, or null. */
export function reservedBucketError(toolName: string, areaBucket: string): string | null {
  return isReservedBucket(areaBucket)
    ? fail(`${toolName}: area_bucket values starting with "${RESERVED_BUCKET_PREFIX}" are reserved and hold no concern records`)
    : null;
}

/**
 * What the model sees of a record. The reinforcers set holds GitHub
 * logins, which must not end up in records or skills, so only its size
 * is shown.
 */
export function recordView(item: Item): Record<string, unknown> {
  return {
    record_id: item.record_id,
    area_bucket: item.area_bucket,
    area: item.area instanceof Set ? [...item.area] : item.area ?? [],
    subject: item.subject ?? '',
    concern: item.concern ?? '',
    context: item.context ?? '',
    reinforcement_count: count(item),
    distinct_reinforcers: reinforcers(item).size,
    decay_score: item.decay_score,
    updated_at: item.updated_at,
    ...(graduatedName(item) ? { graduated_record_name: graduatedName(item), graduated_at: item.graduated_at } : {}),
  };
}

export async function getRecord(deps: ConcernsDeps, areaBucket: string, recordId: string): Promise<Item | undefined> {
  const resp = await deps.ddb.send(new GetCommand({
    TableName: deps.table,
    Key: { area_bucket: areaBucket, record_id: recordId },
    ConsistentRead: true,
  }));
  return resp.Item;
}

interface WriteOutcome {
  /** True when the store changed; the run's write slot is then used up. */
  readonly changed: boolean;
  readonly text: string;
}

/** Run a concerns write under the one-write-per-run limit. */
async function oneWrite(
  deps: ConcernsDeps,
  toolName: string,
  opts: { structural: boolean; action: string; areaBucket: string },
  write: () => Promise<WriteOutcome>,
): Promise<string> {
  const { run } = deps;
  const reserved = reservedBucketError(toolName, opts.areaBucket);
  if (reserved) return reserved;
  if (opts.structural && !run.allowsStructuralChange) {
    return fail(`${toolName}: feedback of kind "${run.kind}" can only bump an existing record`);
  }
  const busy = run.take('concern_write', toolName);
  if (busy) return fail(busy);
  try {
    const outcome = await write();
    if (outcome.changed) run.commit('concern_write', opts.action);
    else run.release('concern_write');
    return outcome.text;
  } catch (err) {
    run.release('concern_write');
    return fail(`${toolName}: ${errorText(err)}`);
  }
}

const areaBucketField = z.string().min(1).max(200)
  .describe('Partition key, e.g. "glide-core" or "src/replication.c"');
const recordIdField = z.string().min(1).max(100);
const areaField = z.array(z.string().min(1).max(300)).min(1).max(10)
  .describe('File-glob patterns the record applies to, e.g. ["glide-core/src/client/**"]');

const concernShape = z.object({
  area: areaField,
  subject: z.string().min(1).max(200).describe('Short domain label, e.g. "condvar usage in watchdog loop"'),
  concern: z.string().min(1).max(2000).describe('What the reviewer should check or avoid, 1-4 sentences'),
  context: z.string().max(CONTEXT_MAX_CHARS)
    .describe('Off-code "why" quoted from the feedback: past incident, maintainer decision. Empty if none.'),
});

const editFields = {
  area: areaField.optional()
    .describe('Replacement glob list when the feedback widens or narrows the record\'s scope. List every glob to keep.'),
  context_addition: z.string().min(1).max(2000).optional()
    .describe('Off-code context from the feedback, in the person\'s own words. Appended to the existing context.'),
};

interface Edit {
  readonly area?: readonly string[];
  readonly context_addition?: string;
}

interface UpdateParts {
  readonly sets: string[];
  readonly conditions: string[];
  readonly values: Record<string, unknown>;
}

/**
 * Add the SET clauses for an area/context edit. Appending context is a
 * read-modify-write, so the update is conditioned on the context it
 * read: a concurrent addition makes the write fail instead of being lost.
 */
function addEdit(current: Item, edit: Edit, parts: UpdateParts): string | null {
  if (edit.area) {
    parts.values[':area'] = [...new Set(edit.area)];
    parts.sets.push('#area = :area');
  }
  if (edit.context_addition) {
    const old = typeof current.context === 'string' ? current.context.trim() : '';
    const next = old ? `${old}\n\n${edit.context_addition.trim()}` : edit.context_addition.trim();
    if (next.length > CONTEXT_MAX_CHARS) {
      return `context would grow to ${next.length} characters (limit ${CONTEXT_MAX_CHARS}); add only what is new`;
    }
    parts.values[':ctx'] = next;
    parts.sets.push('#ctx = :ctx');
    if (typeof current.context === 'string') {
      parts.values[':oldCtx'] = current.context;
      parts.conditions.push('#ctx = :oldCtx');
    } else {
      parts.conditions.push('attribute_not_exists(#ctx)');
    }
  }
  return null;
}

const CHANGED_UNDERNEATH = 'the record changed while this call ran; read it again with get_concern and retry';

/**
 * Add conditions that hold only while the record is as it was read.
 * Every concerns write moves one of these attributes: a reinforcement
 * sets reinforcement_count and updated_at, an edit sets edited_at.
 */
function unchangedSince(read: Item, parts: UpdateParts): void {
  const tracked = [
    ['#rc', ':readRc', read.reinforcement_count],
    ['#ua', ':readUa', read.updated_at],
    ['#ea', ':readEa', read.edited_at],
  ] as const;
  for (const [name, placeholder, value] of tracked) {
    if (value === undefined) {
      parts.conditions.push(`attribute_not_exists(${name})`);
    } else {
      parts.conditions.push(`${name} = ${placeholder}`);
      parts.values[placeholder] = value;
    }
  }
}

/**
 * reinforcement_count of the merged record. A person who reinforced
 * both records on the same pull request counts once. Reinforcements
 * counted before records kept a reinforcers set have no key to match,
 * so they are counted in full; for a record without the set this is
 * the plain sum.
 */
function mergedCount(target: Item, source: Item): number {
  const targetKeys = reinforcers(target);
  let shared = 0;
  for (const key of reinforcers(source)) {
    if (targetKeys.has(key)) shared += 1;
  }
  return count(target) + count(source) - shared;
}

/** Retry advice for a cancelled merge, naming the record whose condition failed when DynamoDB says which. */
function mergeConflictText(err: unknown, targetId: string, sourceId: string): string {
  const reasons = (err as { CancellationReasons?: CancellationReason[] }).CancellationReasons ?? [];
  const changed = [`target ${targetId}`, `source ${sourceId}`].filter((_, i) => reasons[i]?.Code === 'ConditionalCheckFailed');
  const cause = changed.length > 0
    ? `${changed.join(' and ')} changed while the merge ran`
    : 'a concurrent write cancelled the transaction';
  return `merge_concerns: ${cause}, so nothing was merged; read both records again with get_concern and retry`;
}

export function buildListConcernsTool(deps: ConcernsDeps) {
  return tool({
    name: 'list_concerns',
    description:
`List the concern records in one area_bucket, most reinforced first. Returns up to ${LIST_LIMIT} records and the bucket's total.

Call it with each candidate bucket derived from the anchor path and the touched files, and read the records before deciding.`,
    inputSchema: z.object({ area_bucket: areaBucketField }),
    callback: async (input) => {
      const reserved = reservedBucketError('list_concerns', input.area_bucket);
      if (reserved) return reserved;
      try {
        const items: Item[] = [];
        let startKey: Record<string, any> | undefined;
        do {
          const page = await deps.ddb.send(new QueryCommand({
            TableName: deps.table,
            KeyConditionExpression: 'area_bucket = :b',
            ExpressionAttributeValues: { ':b': input.area_bucket },
            ExclusiveStartKey: startKey,
          }));
          items.push(...(page.Items ?? []).filter((item) => !isReservedBucket(item.area_bucket)));
          startKey = page.LastEvaluatedKey;
        } while (startKey);
        items.sort((a, b) => count(b) - count(a) || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')));
        return ok({ area_bucket: input.area_bucket, total: items.length, records: items.slice(0, LIST_LIMIT).map(recordView) });
      } catch (err) {
        return fail(`list_concerns: ${errorText(err)}`);
      }
    },
  });
}

export function buildGetConcernTool(deps: ConcernsDeps) {
  return tool({
    name: 'get_concern',
    description: 'Read one concern record in full. Returns `record: null` when it does not exist.',
    inputSchema: z.object({ area_bucket: areaBucketField, record_id: recordIdField }),
    callback: async (input) => {
      const reserved = reservedBucketError('get_concern', input.area_bucket);
      if (reserved) return reserved;
      try {
        const item = await getRecord(deps, input.area_bucket, input.record_id);
        return ok({ record: item ? recordView(item) : null });
      } catch (err) {
        return fail(`get_concern: ${errorText(err)}`);
      }
    },
  });
}

export function buildCreateConcernTool(deps: ConcernsDeps) {
  return tool({
    name: 'create_concern',
    description:
`Create a concern record when no record in the bucket covers what the feedback teaches. The feedback counts as the first reinforcement (reinforcement_count 1). record_id is generated.

\`area_bucket\` is the partition list_concerns reads; \`record.area\` lists the globs the record applies to, which can be narrower or wider than the bucket.`,
    inputSchema: z.object({ area_bucket: areaBucketField, record: concernShape }),
    callback: (input) => oneWrite(deps, 'create_concern', { structural: true, action: 'create_concern', areaBucket: input.area_bucket }, async () => {
      const recordId = randomUUID();
      const now = new Date().toISOString();
      await deps.ddb.send(new PutCommand({
        TableName: deps.table,
        Item: {
          area_bucket: input.area_bucket,
          record_id: recordId,
          area: [...new Set(input.record.area)],
          subject: input.record.subject,
          concern: input.record.concern,
          context: input.record.context.trim(),
          reinforcement_count: 1,
          reinforcers: new Set([deps.run.reinforcer]),
          decay_score: 1.0,
          created_at: now,
          updated_at: now,
        },
        ConditionExpression: 'attribute_not_exists(#rid)',
        ExpressionAttributeNames: names('#rid'),
      }));
      return { changed: true, text: ok({ record_id: recordId, area_bucket: input.area_bucket }) };
    }),
  });
}

export function buildBumpConcernTool(deps: ConcernsDeps) {
  return tool({
    name: 'bump_concern',
    description:
`Reinforce an existing record the feedback agrees with: reinforcement_count goes up by one, decay_score resets to 1.0. Each person counts once per pull request; a repeat returns \`reinforced: false\` and changes nothing.

Optional \`area\` and \`context_addition\` apply in the same write, for a reinforcement that also widens the scope or explains why.

The result says whether the record is now eligible for graduation (reinforcement_count >= ${deps.run.graduationThreshold}).`,
    inputSchema: z.object({ area_bucket: areaBucketField, record_id: recordIdField, ...editFields }),
    callback: (input) => oneWrite(deps, 'bump_concern', { structural: false, action: `bump_concern ${input.record_id}`, areaBucket: input.area_bucket }, async () => {
      const { run } = deps;
      if ((input.area || input.context_addition) && !run.allowsStructuralChange) {
        return { changed: false, text: fail(`bump_concern: feedback of kind "${run.kind}" can bump a record but not edit it`) };
      }
      const key = { area_bucket: input.area_bucket, record_id: input.record_id };
      const parts: UpdateParts = {
        sets: ['#ds = :full', '#ua = :now'],
        conditions: ['attribute_exists(#rid)', 'NOT contains(#rs, :r)'],
        values: { ':one': 1, ':r': run.reinforcer, ':rset': new Set([run.reinforcer]), ':full': 1.0, ':now': new Date().toISOString() },
      };
      if (input.area || input.context_addition) {
        const current = await getRecord(deps, input.area_bucket, input.record_id);
        if (!current) return { changed: false, text: fail(`bump_concern: record ${input.record_id} does not exist in ${input.area_bucket}`) };
        const invalid = addEdit(current, input, parts);
        if (invalid) return { changed: false, text: fail(`bump_concern: ${invalid}`) };
      }
      const update = `SET ${parts.sets.join(', ')} ADD #rc :one, #rs :rset`;
      const condition = parts.conditions.join(' AND ');
      try {
        const resp = await deps.ddb.send(new UpdateCommand({
          TableName: deps.table,
          Key: key,
          UpdateExpression: update,
          ConditionExpression: condition,
          ExpressionAttributeNames: namesIn(update, condition),
          ExpressionAttributeValues: parts.values,
          ReturnValues: 'ALL_NEW',
        }));
        const record = resp.Attributes ?? {};
        run.reinforced = { areaBucket: input.area_bucket, recordId: input.record_id };
        return {
          changed: true,
          text: ok({ reinforced: true, record: recordView(record), eligible_for_graduation: count(record) >= run.graduationThreshold }),
        };
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        const current = await getRecord(deps, input.area_bucket, input.record_id);
        if (!current) return { changed: false, text: fail(`bump_concern: record ${input.record_id} does not exist in ${input.area_bucket}`) };
        if (reinforcers(current).has(run.reinforcer)) {
          return {
            changed: false,
            text: ok({
              reinforced: false,
              reason: 'this person already reinforced the record on this pull request; the count is unchanged. Use update_concern if the feedback adds new context.',
              record: recordView(current),
            }),
          };
        }
        return { changed: false, text: fail(`bump_concern: ${CHANGED_UNDERNEATH}`) };
      }
    }),
  });
}

export function buildUpdateConcernTool(deps: ConcernsDeps) {
  return tool({
    name: 'update_concern',
    description:
`Change an existing record's area or add to its context without reinforcing it. Use it when the feedback corrects the record's scope or supplies the off-code reason behind it (often pushback such as "this is intentional because ..."), but does not confirm the concern itself.

\`area\` replaces the glob list; \`context_addition\` is appended to the existing context. Give at least one. reinforcement_count, decay_score and updated_at do not change.`,
    inputSchema: z.object({ area_bucket: areaBucketField, record_id: recordIdField, ...editFields }),
    callback: (input) => oneWrite(deps, 'update_concern', { structural: true, action: `update_concern ${input.record_id}`, areaBucket: input.area_bucket }, async () => {
      if (!input.area && !input.context_addition) {
        return { changed: false, text: fail('update_concern: give area, context_addition, or both') };
      }
      const current = await getRecord(deps, input.area_bucket, input.record_id);
      if (!current) return { changed: false, text: fail(`update_concern: record ${input.record_id} does not exist in ${input.area_bucket}`) };
      const parts: UpdateParts = { sets: ['#ea = :now'], conditions: ['attribute_exists(#rid)'], values: { ':now': new Date().toISOString() } };
      const invalid = addEdit(current, input, parts);
      if (invalid) return { changed: false, text: fail(`update_concern: ${invalid}`) };
      const update = `SET ${parts.sets.join(', ')}`;
      const condition = parts.conditions.join(' AND ');
      try {
        const resp = await deps.ddb.send(new UpdateCommand({
          TableName: deps.table,
          Key: { area_bucket: input.area_bucket, record_id: input.record_id },
          UpdateExpression: update,
          ConditionExpression: condition,
          ExpressionAttributeNames: namesIn(update, condition),
          ExpressionAttributeValues: parts.values,
          ReturnValues: 'ALL_NEW',
        }));
        return { changed: true, text: ok({ record: recordView(resp.Attributes ?? {}) }) };
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        return { changed: false, text: fail(`update_concern: ${CHANGED_UNDERNEATH}`) };
      }
    }),
  });
}

export function buildMergeConcernsTool(deps: ConcernsDeps) {
  return tool({
    name: 'merge_concerns',
    description:
`Fold two records in the same bucket that describe one concern. \`target_record_id\` keeps the fields you pass in \`merged\` and gains the source's reinforcements, counting a person who reinforced both records once; \`source_record_id\` is deleted. Both changes happen in one transaction, and it fails if either record changed after it was read.

A record that has graduated to a skill can only be the target. Use this only after reading both records and confirming the overlap.`,
    inputSchema: z.object({
      area_bucket: areaBucketField,
      target_record_id: recordIdField,
      source_record_id: recordIdField,
      merged: concernShape,
    }),
    callback: async (input) => {
      if (input.target_record_id === input.source_record_id) {
        return fail('merge_concerns: target_record_id and source_record_id are the same record');
      }
      return oneWrite(deps, 'merge_concerns', { structural: true, action: `merge_concerns ${input.source_record_id} -> ${input.target_record_id}`, areaBucket: input.area_bucket }, async () => {
        const [target, source] = await Promise.all([
          getRecord(deps, input.area_bucket, input.target_record_id),
          getRecord(deps, input.area_bucket, input.source_record_id),
        ]);
        if (!target) return { changed: false, text: fail(`merge_concerns: target ${input.target_record_id} does not exist in ${input.area_bucket}`) };
        if (!source) return { changed: false, text: fail(`merge_concerns: source ${input.source_record_id} does not exist in ${input.area_bucket}`) };
        if (graduatedName(source)) {
          return {
            changed: false,
            text: fail(`merge_concerns: source ${input.source_record_id} graduated as skill "${graduatedName(source)}"; make it the target instead`),
          };
        }

        // The merged fields and count are computed from the reads, so the
        // target is written only in the state that was read. Otherwise a
        // reinforcement or edit that lands on it meanwhile is overwritten.
        const total = mergedCount(target, source);
        const sourceReinforcers = reinforcers(source);
        const targetParts: UpdateParts = {
          sets: ['#area = :area', '#subject = :subject', '#concern = :concern', '#ctx = :ctx', '#rc = :rc', '#ds = :full', '#ua = :now'],
          conditions: ['attribute_exists(#rid)'],
          values: {
            ':area': [...new Set(input.merged.area)],
            ':subject': input.merged.subject,
            ':concern': input.merged.concern,
            ':ctx': input.merged.context.trim(),
            ':rc': total,
            ':full': 1.0,
            ':now': new Date().toISOString(),
            ...(sourceReinforcers.size > 0 ? { ':rset': sourceReinforcers } : {}),
          },
        };
        unchangedSince(target, targetParts);
        const targetUpdate = `SET ${targetParts.sets.join(', ')}${sourceReinforcers.size > 0 ? ' ADD #rs :rset' : ''}`;
        const targetCondition = targetParts.conditions.join(' AND ');

        // The source is deleted only in the state that was read, so a
        // reinforcement or edit that lands on it meanwhile is not lost.
        const sourceParts: UpdateParts = { sets: [], conditions: ['attribute_exists(#rid)', 'attribute_not_exists(#grn)'], values: {} };
        unchangedSince(source, sourceParts);
        const sourceCondition = sourceParts.conditions.join(' AND ');

        try {
          await deps.ddb.send(new TransactWriteCommand({
            TransactItems: [
              {
                Update: {
                  TableName: deps.table,
                  Key: { area_bucket: input.area_bucket, record_id: input.target_record_id },
                  UpdateExpression: targetUpdate,
                  ConditionExpression: targetCondition,
                  ExpressionAttributeNames: namesIn(targetUpdate, targetCondition),
                  ExpressionAttributeValues: targetParts.values,
                },
              },
              {
                Delete: {
                  TableName: deps.table,
                  Key: { area_bucket: input.area_bucket, record_id: input.source_record_id },
                  ConditionExpression: sourceCondition,
                  ExpressionAttributeNames: namesIn(sourceCondition),
                  ...(Object.keys(sourceParts.values).length > 0 ? { ExpressionAttributeValues: sourceParts.values } : {}),
                },
              },
            ],
          }));
        } catch (err) {
          if ((err as { name?: string } | null)?.name !== 'TransactionCanceledException') throw err;
          return { changed: false, text: fail(mergeConflictText(err, input.target_record_id, input.source_record_id)) };
        }

        deps.run.reinforced = { areaBucket: input.area_bucket, recordId: input.target_record_id };
        // The write was conditioned on the state the count came from, so it is what the target now holds.
        return {
          changed: true,
          text: ok({
            target_record_id: input.target_record_id,
            deleted_record_id: input.source_record_id,
            reinforcement_count: total,
            eligible_for_graduation: total >= deps.run.graduationThreshold,
          }),
        };
      });
    },
  });
}

export function buildDeleteConcernTool(deps: ConcernsDeps) {
  return tool({
    name: 'delete_concern',
    description:
`Delete a record that should not exist: it states a curator-level style rule rather than a code concern, or a maintainer has said the concern itself is wrong. Records that graduated to a skill cannot be deleted; decay removes them later.

Do not use it for feedback that is merely unhelpful; make no change instead.`,
    inputSchema: z.object({ area_bucket: areaBucketField, record_id: recordIdField }),
    callback: (input) => oneWrite(deps, 'delete_concern', { structural: true, action: `delete_concern ${input.record_id}`, areaBucket: input.area_bucket }, async () => {
      const condition = 'attribute_exists(#rid) AND attribute_not_exists(#grn)';
      try {
        await deps.ddb.send(new DeleteCommand({
          TableName: deps.table,
          Key: { area_bucket: input.area_bucket, record_id: input.record_id },
          ConditionExpression: condition,
          ExpressionAttributeNames: namesIn(condition),
        }));
        return { changed: true, text: ok({ deleted_record_id: input.record_id }) };
      } catch (err) {
        if (!isConditionFailure(err)) throw err;
        const current = await getRecord(deps, input.area_bucket, input.record_id);
        if (!current) return { changed: false, text: fail(`delete_concern: record ${input.record_id} does not exist in ${input.area_bucket}`) };
        return { changed: false, text: fail(`delete_concern: record ${input.record_id} graduated as skill "${graduatedName(current)}" and is kept as its source`) };
      }
    }),
  });
}

export function buildConcernsTools(deps: ConcernsDeps): Tool[] {
  return [
    buildListConcernsTool(deps),
    buildGetConcernTool(deps),
    buildCreateConcernTool(deps),
    buildBumpConcernTool(deps),
    buildUpdateConcernTool(deps),
    buildMergeConcernsTool(deps),
    buildDeleteConcernTool(deps),
  ];
}
