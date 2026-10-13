import { createRegistryClient, loadSkills } from './skills-registry.js';

/**
 * Load the reviewer's graduated skills from its AWS Agent Registry
 * registry. Skills are curator-published records (see skills-registry.ts).
 *
 * Empty registry or any failure returns an empty list: the review goes
 * ahead on the baked-in prompt and skill file alone.
 */

export interface GraduatedSkill {
  readonly recordArn: string;
  readonly name: string;
  readonly description: string;
  readonly skillMd: string;
  readonly status: string;
}

export interface LoadGraduatedOpts {
  readonly registryId: string;
  readonly region: string;
  readonly limit?: number;
  /** Combined markdown budget for the system prompt. */
  readonly maxChars?: number;
  readonly timeoutMs?: number;
}

export async function loadGraduatedSkills(opts: LoadGraduatedOpts): Promise<readonly GraduatedSkill[]> {
  if (!opts.registryId) return [];
  const client = createRegistryClient(opts.region);
  const limit = opts.limit ?? 30;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // One deadline for every registry call in the load, so a slow registry
  // cannot hold up the review.
  const abortSignal = AbortSignal.timeout(timeoutMs);
  try {
    const maxChars = opts.maxChars ?? 80_000;
    const { skills, skipped } = await loadSkills(client, opts.registryId, limit, abortSignal, maxChars);
    if (skipped > 0) console.warn(`[graduated-skills] loaded ${skills.length}; ${skipped} older skill(s) left out by the limits (${limit} skills, ${maxChars} characters)`);
    return skills;
  } catch (err) {
    console.warn(`[graduated-skills] registry load failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    client.destroy();
  }
}

/**
 * Render graduated skills as a markdown block to append to the system
 * prompt's skill section. Each skill becomes its own subsection.
 */
export function renderGraduatedSkills(skills: readonly GraduatedSkill[]): string {
  if (skills.length === 0) return '';
  const lines: string[] = [];
  lines.push('---');
  lines.push('');
  lines.push('# Graduated skills (curator-published)');
  lines.push('');
  lines.push('These rules graduated from the concerns store after repeated reinforcement. Treat as established conventions for the area.');
  lines.push('');
  for (const s of skills) {
    lines.push(`## ${s.name}`);
    if (s.description) lines.push(`_${s.description}_`);
    lines.push('');
    lines.push(s.skillMd.trim());
    lines.push('');
  }
  return lines.join('\n');
}
