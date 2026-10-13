import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { errorText } from './run.js';

/**
 * Skill-writing guidance from the curator's own skills registry.
 *
 * The registry holds a few curator-only skills (the source files are
 * agents/curator/skills/*.md, published with
 * scripts/publish-curator-skills.mjs). The tool returns all of them;
 * the registry is small enough that there is nothing to search.
 *
 * When the registry is not configured or cannot be read, the tool says
 * so and the curator graduates with the prompt's inline rules.
 */

export interface AuthoringSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

export interface SkillAuthoringDeps {
  /** Loads the curator registry's skills; undefined when no registry is configured. */
  readonly load?: () => Promise<readonly AuthoringSkill[]>;
}

const FALLBACK = 'Follow the inline skill rules in the prompt (Phase 2).';

export function buildListSkillAuthoringTool(deps: SkillAuthoringDeps) {
  return tool({
    name: 'list_skill_authoring',
    description:
`Return the curator's guidance on writing skill_md: frontmatter rules, body template, mandatory "Skip unless" gates, "Do NOT flag" carve-outs, length budget and failure modes. Call it once when a record becomes eligible for graduation, before writing skill_md, and follow it where it is more specific than the prompt.

Not needed for any other decision. If it returns ok:false, use the prompt's inline rules; do not hold back the graduation.`,
    inputSchema: z.object({}),
    callback: async () => {
      if (!deps.load) {
        return JSON.stringify({ ok: false, reason: 'no curator skills registry is configured', fallback: FALLBACK });
      }
      try {
        const skills = await deps.load();
        if (skills.length === 0) {
          return JSON.stringify({ ok: false, reason: 'the curator skills registry has no usable skills', fallback: FALLBACK });
        }
        return JSON.stringify({ ok: true, skills });
      } catch (err) {
        return JSON.stringify({ ok: false, reason: `registry read failed: ${errorText(err)}`, fallback: FALLBACK });
      }
    },
  });
}
