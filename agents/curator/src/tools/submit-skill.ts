import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GRADUATED_SKILL_MAX_CHARS, type UpsertSkillInput } from '../../../common/src/skills-registry.js';
import { getRecord, type ConcernsDeps } from './concerns-ddb.js';
import { errorText, fail, ok } from './run.js';

/**
 * Graduate a concern into the reviewer's skills registry.
 *
 * The gate is enforced here, not by the prompt: the source must be the
 * record this run bumped or merged into, and its stored
 * reinforcement_count must reach the threshold. The record name is
 * written onto the source record before publishing, so a later
 * graduation of the same record updates that skill (upsert by name)
 * instead of adding a second one under a different slug.
 *
 * Upsert updates whatever record has the name, so a record graduating
 * for the first time must not take a name another record's skill
 * already holds. When its subject slugs to such a name, it gets the
 * slug with a suffix derived from its record_id. The check and the
 * upsert are not atomic: two records with one slug graduating in the
 * same few seconds can still meet on one name.
 */

export interface SkillPublisher {
  upsert(input: UpsertSkillInput): Promise<{ action: 'created' | 'updated'; recordArn: string; status: string }>;
  /** Whether the registry has a skill record with exactly this name, in any status. */
  exists(name: string): Promise<boolean>;
}

export interface SubmitSkillDeps extends ConcernsDeps {
  readonly registry: SkillPublisher;
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

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

export function buildSubmitSkillTool(deps: SubmitSkillDeps) {
  const threshold = deps.run.graduationThreshold;
  return tool({
    name: 'submit_skill',
    description:
`Publish a graduated skill to this reviewer's skills registry. Allowed once per run, only for the record this run bumped or merged into, and only when that record's reinforcement_count is at least ${threshold}; the tool checks both against the store.

Inputs:
- \`area_bucket\`, \`source_record_id\`: the record being graduated.
- \`subject\`: 3-8 word title. If the record graduated before, its graduated_record_name is kept and that skill is updated. Otherwise the subject's slug becomes the registry record name, with a short suffix when another record's skill already has that name.
- \`description\`: the imperative trigger sentence(s), the same text as the skill_md frontmatter description.
- \`skill_md\`: the full SKILL.md, frontmatter included, at most ${GRADUATED_SKILL_MAX_CHARS} characters. The tool sets the frontmatter \`name\` to the record name it returns.

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
      const busy = run.take('skill_submit', 'submit_skill');
      if (busy) return fail(busy);
      let published = false;
      try {
        const reinforced = run.reinforced;
        if (!reinforced || reinforced.areaBucket !== input.area_bucket || reinforced.recordId !== input.source_record_id) {
          return fail('submit_skill: only the record this run bumped or merged into can graduate');
        }
        const source = await getRecord(deps, input.area_bucket, input.source_record_id);
        if (!source) return fail(`submit_skill: record ${input.source_record_id} does not exist in ${input.area_bucket}`);
        const count = typeof source.reinforcement_count === 'number' ? source.reinforcement_count : 0;
        if (count < threshold) {
          return fail(`submit_skill: record ${input.source_record_id} has ${count} reinforcements; graduation needs ${threshold}`);
        }

        let recordName = typeof source.graduated_record_name === 'string' ? source.graduated_record_name : '';
        if (!recordName) {
          const slug = slugify(input.subject);
          const candidates = [slug, suffixedName(slug, input.source_record_id)];
          recordName = (await firstFreeName(deps.registry, candidates)) ?? '';
          if (!recordName) {
            return fail(`submit_skill: other skills already use the registry names ${candidates.map((n) => `"${n}"`).join(' and ')}; submit again with a different subject`);
          }
        }
        const key = { area_bucket: input.area_bucket, record_id: input.source_record_id };

        // Claim the name first: two runs graduating the same record at
        // once then agree on one registry record.
        await deps.ddb.send(new UpdateCommand({
          TableName: deps.table,
          Key: key,
          UpdateExpression: 'SET #grn = :name',
          ConditionExpression: 'attribute_exists(#rid) AND #rc >= :t AND (attribute_not_exists(#grn) OR #grn = :name)',
          ExpressionAttributeNames: { '#grn': 'graduated_record_name', '#rid': 'record_id', '#rc': 'reinforcement_count' },
          ExpressionAttributeValues: { ':name': recordName, ':t': threshold },
        }));

        const result = await deps.registry.upsert({
          name: recordName,
          description: `${input.description}\n\nGraduated from concern record_id=${input.source_record_id}.`,
          skillMd: withRecordName(input.skill_md, recordName),
        });
        published = true;

        try {
          await deps.ddb.send(new UpdateCommand({
            TableName: deps.table,
            Key: key,
            UpdateExpression: 'SET #ga = :now',
            ConditionExpression: '#grn = :name',
            ExpressionAttributeNames: { '#ga': 'graduated_at', '#grn': 'graduated_record_name' },
            ExpressionAttributeValues: { ':now': new Date().toISOString(), ':name': recordName },
          }));
        } catch (err) {
          // The skill is live; a missing timestamp is not worth failing the graduation over.
          console.warn(`[submit_skill] graduated_at not recorded on ${input.source_record_id}: ${errorText(err)}`);
        }

        return ok({
          record_name: recordName,
          action: result.action,
          record_arn: result.recordArn,
          status: result.status,
          reinforcement_count: count,
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
