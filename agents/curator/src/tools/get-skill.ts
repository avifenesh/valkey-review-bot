import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { areaBucketField, getRecord, recordIdField, reservedBucketError, type ConcernsDeps } from './concerns-ddb.js';
import { withoutProvenance, type SkillPublisher } from './submit-skill.js';
import { errorText, fail, ok } from './run.js';

/**
 * Read the skill a graduated record published, as the reviewer's
 * registry holds it now. The release check may have edited that text
 * since it was submitted (suppress-and-add, see
 * agents/common/src/skill-check/edits.ts), so a rewrite starts from
 * here, not from the record.
 *
 * Read-only: it takes no run slot, and the registry calls are the
 * Get/List the curator already holds on the reviewer registries.
 */

export interface GetSkillDeps extends ConcernsDeps {
  readonly registry: SkillPublisher;
}

export function buildGetSkillTool(deps: GetSkillDeps) {
  return tool({
    name: 'get_skill',
    description:
`Read the skill a graduated record published: record_name, status, description and skill_md as the reviewer's registry holds them now. The release check can correct a skill after it was submitted, so call this before rewriting a graduated record's skill, and edit the text it returns rather than writing the skill again from the record.

skill_md may hold suppressed blocks: a \`<!-- suppressed: ... -->\` line, the superseded lines, and a \`<!-- /suppressed -->\` line, followed by the text that replaced them. Keep every block exactly as returned. Never write such markers yourself.

It also reads a retired skill (status DEPRECATED). Read-only: it uses neither the run's store change nor its submit.`,
    inputSchema: z.object({ area_bucket: areaBucketField, record_id: recordIdField }),
    callback: async (input) => {
      const reserved = reservedBucketError('get_skill', input.area_bucket);
      if (reserved) return reserved;
      try {
        const item = await getRecord(deps, input.area_bucket, input.record_id);
        if (!item) return fail(`get_skill: record ${input.record_id} does not exist in ${input.area_bucket}`);
        const name = typeof item.graduated_record_name === 'string' ? item.graduated_record_name : '';
        if (!name) return fail(`get_skill: record ${input.record_id} has not graduated, so it has no published skill`);
        if (!deps.registry.get) return fail('get_skill: no registry reader is configured');
        // A generation submit_skill claimed but never published, on a
        // record that is still a tombstone: show the skill it replaces,
        // whose suppressed blocks the new text keeps, as submit_skill does.
        const previous = item.retired_at !== undefined && typeof item.previous_record_name === 'string' ? item.previous_record_name : '';
        const skill = (await deps.registry.get(name)) ?? (previous ? await deps.registry.get(previous) : null);
        if (!skill) return fail(`get_skill: the registry has no skill named "${name}"`);
        return ok({
          record_name: skill.name,
          status: skill.status,
          description: withoutProvenance(skill.description),
          skill_md: skill.skillMd,
        });
      } catch (err) {
        return fail(`get_skill: ${errorText(err)}`);
      }
    },
  });
}
