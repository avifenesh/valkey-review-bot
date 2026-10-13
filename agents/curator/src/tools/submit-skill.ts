import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GRADUATED_SKILL_MAX_CHARS, isRetiredStatus, type UpsertSkillInput } from '../../../common/src/skills-registry.js';
import { getRecord, reservedBucketError, type ConcernsDeps } from './concerns-ddb.js';
import { errorText, fail, ok, type TouchedRecord } from './run.js';

/**
 * Graduate a concern into the reviewer's skills registry, or update the
 * skill a record published before.
 *
 * The gate is enforced here, not by the prompt: the source must be the
 * record this run bumped or merged into, or a graduated record whose
 * live skill this run's update_concern corrected (an update, never a
 * first graduation), and its stored reinforcement_count must reach the
 * threshold.
 *
 * Names. A first graduation takes the subject's slug. Upsert updates
 * whatever record has the name, so when another record's skill holds
 * the slug, the record gets the slug with a suffix derived from its
 * record_id. The check and the upsert are not atomic: two records with
 * one slug graduating in the same few seconds can still meet on one
 * name. The name is written onto the source record before publishing,
 * so a later submit updates that skill instead of adding a second one.
 *
 * Retired skills. The skill lifecycle retires a skill by deprecating its
 * registry record and setting retired_at on the source record, which
 * stays as a tombstone. DEPRECATED is terminal: the record can never be
 * updated or revived. A reinforcement of a tombstone therefore
 * re-publishes under a generation name, the subject's slug with a
 * suffix derived from "<record_id>#g<n>". A skill an operator retired
 * (retired_reason "operator") is never published again by the curator.
 */

/** A skill record in the reviewer's registry, as getSkillByName returns it. */
export interface PublishedSkill {
  readonly name: string;
  readonly status: string;
  readonly description: string;
  readonly skillMd: string;
}

export interface SkillPublisher {
  upsert(input: UpsertSkillInput): Promise<{ action: 'created' | 'updated'; recordArn: string; status: string }>;
  /** Whether the registry has a skill record with exactly this name, in any status. */
  exists(name: string): Promise<boolean>;
  /**
   * The record with exactly this name, in any status, with its markdown;
   * null when there is none. Optional until the runtime wires it
   * (getSkillByName); without it get_skill reports that it cannot read
   * the registry.
   */
  get?(name: string): Promise<PublishedSkill | null>;
}

export interface SubmitSkillDeps extends ConcernsDeps {
  readonly registry: SkillPublisher;
}

/** The provenance sentence submit_skill appends to every description, for operators. */
const PROVENANCE_RE = /\s*Graduated from concern record_id=\S*\s*$/;

/** A registry description without the provenance sentence, as the model writes it. */
export function withoutProvenance(description: string): string {
  return description.replace(PROVENANCE_RE, '');
}

const SLUG_MAX = 60;
const SUFFIX_CHARS = 8;

/** Registry record name for a subject: lowercase words joined by '-', never empty, never ending in '-'. */
export function slugify(subject: string): string {
  const slug = subject
    // Split accented letters and drop the accent marks, so accented "e" becomes "e".
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  // A subject with no ASCII letters or digits still needs a stable name.
  return `skill-${createHash('sha256').update(subject).digest('hex').slice(0, 12)}`;
}

/**
 * The slug with a suffix from the source record id, for a slug another
 * record's skill holds. Stable, so a retry picks the same name, and no
 * longer than a slug.
 */
export function suffixedName(slug: string, recordId: string): string {
  const suffix = createHash('sha256').update(recordId).digest('hex').slice(0, SUFFIX_CHARS);
  return `${slug.slice(0, SLUG_MAX - SUFFIX_CHARS - 1).replace(/-+$/, '')}-${suffix}`;
}

/**
 * Set the frontmatter `name` to the registry record name, which can
 * differ from the slug the model wrote: an earlier graduation's name or
 * a suffixed one. Markdown without frontmatter is returned unchanged;
 * the registry module adds a header with the record name.
 */
export function withRecordName(skillMd: string, name: string): string {
  const lines = skillMd.split('\n');
  if (lines[0]?.trimEnd() !== '---') return skillMd;
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  if (end < 0) return skillMd;
  const at = lines.findIndex((line, i) => i > 0 && i < end && /^name\s*:/.test(line));
  if (at >= 0) lines[at] = `name: ${name}`;
  else lines.splice(1, 0, `name: ${name}`);
  return lines.join('\n');
}

/** The first candidate no registry record holds, or null when all are taken. */
async function firstFreeName(registry: SkillPublisher, candidates: readonly string[]): Promise<string | null> {
  for (const name of candidates) {
    if (!(await registry.exists(name))) return name;
  }
  return null;
}

/** Whether `touched` is the record the input names. */
function isRecord(touched: TouchedRecord | null, input: { area_bucket: string; source_record_id: string }): boolean {
  return touched !== null && touched.areaBucket === input.area_bucket && touched.recordId === input.source_record_id;
}

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

type Item = Record<string, unknown>;
type Key = { area_bucket: string; record_id: string };

/** Attribute names for every placeholder this module's expressions use. */
const NAMES: Readonly<Record<string, string>> = {
  '#rid': 'record_id',
  '#rc': 'reinforcement_count',
  '#grn': 'graduated_record_name',
  '#ga': 'graduated_at',
  '#sg': 'skill_generation',
  '#prn': 'previous_record_name',
  '#ret': 'retired_at',
  '#rr': 'retired_reason',
  '#rfs': 'retired_from_status',
  '#sn': 'stale_names',
  '#ss': 'stale_since',
  '#or': 'obsolete_release',
  '#pr': 'pending_revision',
  '#mid': 'maintenance_id',
  '#mra': 'maintenance_requested_at',
  '#mr': 'maintenance_reason',
  '#mdep': 'maintenance_deprecating',
};

/**
 * The release check's state for the published text, the retirement and
 * any maintenance claim. A successful publish clears them: the next
 * decay pass sees graduated_at after verified_at and queues a check of
 * the new text. audit_names, ignored_names and verified_* stay, so that
 * check compares against the old baseline.
 */
const CLEARED_ON_PUBLISH = '#sn, #ss, #or, #pr, #ret, #rr, #rfs, #mid, #mra, #mr';

/** A queued check or retirement of the old text is void once a new text is claimed. */
const CANCEL_MAINTENANCE = 'REMOVE #mid, #mra, #mr';

function updateCommand(table: string, key: Key, expression: string, conditions: readonly string[], values: Record<string, unknown>): UpdateCommand {
  const condition = conditions.join(' AND ');
  const used = new Set(`${expression} ${condition}`.match(/#[a-z]+/g) ?? []);
  return new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: expression,
    ConditionExpression: condition,
    ExpressionAttributeNames: Object.fromEntries([...used].map((p) => [p, NAMES[p]!])),
    ExpressionAttributeValues: values,
  });
}

function graduatedName(item: Item): string {
  return typeof item.graduated_record_name === 'string' ? item.graduated_record_name : '';
}

/** Where to publish, and the conditional write that claims the name on the source record first. */
interface Target {
  readonly name: string;
  readonly update: string;
  readonly conditions: readonly string[];
  readonly values: Record<string, unknown>;
  /** The retired name a new generation replaces. */
  readonly replaces?: string;
}

/**
 * The registry record `name` is retired while the source record still
 * calls its skill live, so it was deprecated outside this run. Record
 * that on the source record, best effort, and return the refusal.
 *
 * maintenance_deprecating = name means the lifecycle's own retire run
 * started the deprecation (ops/src/decay.ts); the reason is then
 * obsolete or decayed, and a reinforcement can publish the skill again
 * under a new name. Without that marker an operator retired it.
 */
async function markRetired(deps: SubmitSkillDeps, key: Key, name: string, reinforced: boolean): Promise<string> {
  let lifecycle = false;
  try {
    const current = await getRecord(deps, key.area_bucket, key.record_id);
    if (!current || graduatedName(current) !== name || current.retired_at !== undefined) {
      return `skill "${name}" was retired while this run worked; read the record again with get_concern`;
    }
    const marker = current.maintenance_deprecating;
    lifecycle = marker === name;
    const reason = lifecycle ? (current.obsolete_release !== undefined ? 'obsolete' : 'decayed') : 'operator';
    const conditions = ['#grn = :name', 'attribute_not_exists(#ret)'];
    const values: Record<string, unknown> = { ':name': name, ':now': new Date().toISOString(), ':reason': reason };
    if (lifecycle) {
      conditions.push('#mdep = :name');
    } else if (marker === undefined) {
      conditions.push('attribute_not_exists(#mdep)');
    } else {
      // A marker left by an older generation: the skill lifecycle did not retire this record.
      conditions.push('#mdep = :marker');
      values[':marker'] = marker;
    }
    await deps.ddb.send(updateCommand(deps.table, key, 'SET #ret = :now, #rr = :reason', conditions, values));
  } catch (err) {
    console.warn(`[submit_skill] retirement of "${name}" not recorded on ${key.record_id}: ${errorText(err)}`);
  }
  if (!lifecycle) return `skill "${name}" was retired by an operator; it is not published again`;
  return reinforced
    ? `skill "${name}" was retired by the skill lifecycle while this run worked; call submit_skill again to publish it under a new name`
    : `skill "${name}" was retired by the skill lifecycle while this run worked; only a reinforcement can publish it again`;
}

/** The name to publish under, or the refusal. */
async function chooseTarget(deps: SubmitSkillDeps, input: { subject: string; source_record_id: string }, source: Item): Promise<Target | string> {
  const threshold = deps.run.graduationThreshold;
  const gate = ['attribute_exists(#rid)', '#rc >= :t'];
  const current = graduatedName(source);

  if (!current) {
    const slug = slugify(input.subject);
    const candidates = [slug, suffixedName(slug, input.source_record_id)];
    const name = await firstFreeName(deps.registry, candidates);
    if (!name) {
      return `other skills already use the registry names ${candidates.map((n) => `"${n}"`).join(' and ')}; submit again with a different subject`;
    }
    // Two runs graduating one record at once: the second finds the name taken and reads the record again.
    return { name, update: 'SET #grn = :name', conditions: [...gate, 'attribute_not_exists(#grn)'], values: { ':name': name, ':t': threshold } };
  }

  const keep = (retired: boolean): Target => ({
    name: current,
    update: `SET #grn = :name ${CANCEL_MAINTENANCE}`,
    conditions: [...gate, '#grn = :name', retired ? 'attribute_exists(#ret)' : 'attribute_not_exists(#ret)'],
    values: { ':name': current, ':t': threshold },
  });
  if (source.retired_at === undefined) return keep(false);

  const reason = source.retired_reason;
  if (reason === 'operator') return `skill "${current}" was retired by an operator; it is not published again`;
  // An operator restores a retired skill by removing retired_reason.
  if (reason !== undefined && reason !== 'decayed' && reason !== 'obsolete') {
    return `skill "${current}" was retired (${JSON.stringify(reason)}); it is not published again`;
  }
  if (!deps.registry.get) return `cannot read the retired skill "${current}" (no registry reader is configured)`;
  const published = await deps.registry.get(current);
  // Not retired in the registry: an earlier re-publication claimed this
  // name and then failed. Finish it under the same name.
  if (!published || !isRetiredStatus(published.status)) return keep(true);

  const generation = (typeof source.skill_generation === 'number' ? source.skill_generation : 1) + 1;
  const name = suffixedName(slugify(input.subject), `${input.source_record_id}#g${generation}`);
  if (await deps.registry.exists(name)) {
    return `another skill already uses the registry name "${name}"; submit again with a different subject`;
  }
  return {
    name,
    update: `SET #grn = :name, #sg = :gen, #prn = :old ${CANCEL_MAINTENANCE}`,
    conditions: [...gate, '#grn = :old', 'attribute_exists(#ret)'],
    values: { ':name': name, ':gen': generation, ':old': current, ':t': threshold },
    replaces: current,
  };
}

export function buildSubmitSkillTool(deps: SubmitSkillDeps) {
  const threshold = deps.run.graduationThreshold;
  return tool({
    name: 'submit_skill',
    description:
`Publish a graduated skill to this reviewer's skills registry, or update the skill a record published before. Allowed once per run, for the record this run bumped or merged into, or for a graduated record with a live skill that this run changed with update_concern (an update only, never a first graduation). The record's reinforcement_count must be at least ${threshold}. The tool checks all of this against the store.

Inputs:
- \`area_bucket\`, \`source_record_id\`: the record being graduated.
- \`subject\`: 3-8 word title. If the record graduated before, its graduated_record_name is kept and that skill is updated. Otherwise the subject's slug becomes the registry record name, with a short suffix when another record's skill already has that name.
- \`description\`: the imperative trigger sentence(s), the same text as the skill_md frontmatter description.
- \`skill_md\`: the full SKILL.md, frontmatter included, at most ${GRADUATED_SKILL_MAX_CHARS} characters. The tool sets the frontmatter \`name\` to the record name it returns.

A record whose skill was retired (skill_state "retired") comes back only through a bump or merge in this run. A retired registry record cannot change, so the skill is published under a new name, which the tool returns. When retired_reason is "operator", the tool refuses: an operator's retirement is final.

Do not delete the source record afterwards; it stays as the skill's provenance.`,
    inputSchema: z.object({
      area_bucket: z.string().min(1).max(200),
      source_record_id: z.string().min(1).max(100),
      subject: z.string().min(3).max(120),
      description: z.string().min(1).max(512),
      skill_md: z.string().min(20).max(GRADUATED_SKILL_MAX_CHARS),
    }),
    callback: async (input) => {
      const { run } = deps;
      const reserved = reservedBucketError('submit_skill', input.area_bucket);
      if (reserved) return reserved;
      const busy = run.take('skill_submit', 'submit_skill');
      if (busy) return fail(busy);
      let published = false;
      try {
        const reinforced = isRecord(run.reinforced, input);
        if (!reinforced && !isRecord(run.edited, input)) {
          return fail('submit_skill: only the record this run bumped or merged into can graduate, or a graduated record this run changed with update_concern');
        }
        const source = await getRecord(deps, input.area_bucket, input.source_record_id);
        if (!source) return fail(`submit_skill: record ${input.source_record_id} does not exist in ${input.area_bucket}`);
        const count = typeof source.reinforcement_count === 'number' ? source.reinforcement_count : 0;
        if (count < threshold) {
          return fail(`submit_skill: record ${input.source_record_id} has ${count} reinforcements; graduation needs ${threshold}`);
        }
        if (!reinforced) {
          // update_concern is not a reinforcement: it can correct a live skill, not create or restore one.
          if (!graduatedName(source)) {
            return fail(`submit_skill: record ${input.source_record_id} never graduated; a first graduation needs a bump or merge in this run`);
          }
          if (source.retired_at !== undefined) {
            return fail(`submit_skill: the skill of record ${input.source_record_id} was retired; only a bump or merge in this run can publish it again`);
          }
        }

        const target = await chooseTarget(deps, input, source);
        if (typeof target === 'string') return fail(`submit_skill: ${target}`);
        const key = { area_bucket: input.area_bucket, record_id: input.source_record_id };

        // Claim the name first, conditioned on the state it was chosen
        // from, so two runs submitting the same record agree on one
        // registry record.
        await deps.ddb.send(updateCommand(deps.table, key, target.update, target.conditions, target.values));

        let result: Awaited<ReturnType<SkillPublisher['upsert']>>;
        try {
          result = await deps.registry.upsert({
            name: target.name,
            description: `${withoutProvenance(input.description)}\n\nGraduated from concern record_id=${input.source_record_id}.`,
            skillMd: withRecordName(input.skill_md, target.name),
          });
        } catch (err) {
          if ((err as { name?: string } | null)?.name !== 'SkillRetiredError') throw err;
          return fail(`submit_skill: ${await markRetired(deps, key, target.name, reinforced)}`);
        }
        published = true;

        // A marker naming another record is left over from an older
        // generation. One naming this record can belong to a retire run
        // still deprecating it, and tells that run's deprecation apart
        // from an operator's, so it stays.
        const marker = source.maintenance_deprecating;
        const cleared = typeof marker === 'string' && marker !== target.name ? `${CLEARED_ON_PUBLISH}, #mdep` : CLEARED_ON_PUBLISH;
        try {
          await deps.ddb.send(updateCommand(deps.table, key, `SET #ga = :now REMOVE ${cleared}`, ['#grn = :name'], {
            ':now': new Date().toISOString(),
            ':name': target.name,
          }));
        } catch (err) {
          // The skill is live; a missing timestamp is not worth failing the graduation over.
          console.warn(`[submit_skill] graduated_at not recorded on ${input.source_record_id}: ${errorText(err)}`);
        }

        return ok({
          record_name: target.name,
          action: result.action,
          record_arn: result.recordArn,
          status: result.status,
          reinforcement_count: count,
          ...(target.replaces ? { replaces: target.replaces } : {}),
        });
      } catch (err) {
        if (isConditionFailure(err)) {
          return fail('submit_skill: the record changed or graduated under another name while submitting; read it again with get_concern');
        }
        return fail(`submit_skill: ${errorText(err)}`);
      } finally {
        if (published) run.commit('skill_submit', `submit_skill ${input.source_record_id}`);
        else run.release('skill_submit');
      }
    },
  });
}
