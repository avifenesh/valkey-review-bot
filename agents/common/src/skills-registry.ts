import {
  AgentRegistryControlClient,
  CreateRegistryRecordCommand,
  GetRegistryRecordCommand,
  ListRegistryRecordsCommand,
  UpdateRegistryRecordCommand,
  type GetRegistryRecordCommandOutput,
  type RegistryRecordFilter,
  type RegistryRecordSummary,
} from '@aws-sdk/client-agent-registry-control';

/**
 * Skill records in AWS Agent Registry (the `agent-registry-control` API).
 *
 * Reviewers read skills from their registry at the start of each
 * review; the curator writes them on graduation. A skill is a record of
 * type SKILL whose markdown lives in
 * `descriptors.agentSkillsDefinition.additionalData.skillMd.data`.
 * The control-plane list/get calls return records in every status, so
 * loading does not depend on an approval workflow being configured.
 */

/** Service limit on descriptor payload data. */
export const SKILL_MD_MAX_CHARS = 102_400;

/** Combined markdown budget for the graduated skills a reviewer loads into its system prompt. */
export const GRADUATED_SKILLS_MAX_CHARS = 80_000;

/**
 * Largest skill markdown the curator may publish. It is half the
 * reviewers' budget, so every published skill can be loaded.
 */
export const GRADUATED_SKILL_MAX_CHARS = 40_000;

/** Statuses whose content must not reach a reviewer: still writing, failed, or retired. */
const UNUSABLE_STATUSES: ReadonlySet<string> = new Set([
  'CREATING', 'CREATE_FAILED', 'UPDATE_FAILED', 'DEPRECATED', 'REJECTED',
]);

export interface SkillRecord {
  readonly recordId: string;
  readonly recordArn: string;
  readonly name: string;
  readonly description: string;
  readonly status: string;
  readonly skillMd: string;
}

export function createRegistryClient(region: string): AgentRegistryControlClient {
  return new AgentRegistryControlClient({ region });
}

export function skillMdOf(record: GetRegistryRecordCommandOutput): string {
  return record.descriptors?.agentSkillsDefinition?.additionalData?.skillMd?.data ?? '';
}

/** Every SKILL record summary in the registry, following pagination. */
export async function listSkillSummaries(
  client: AgentRegistryControlClient,
  registryId: string,
  extraFilters: readonly RegistryRecordFilter[] = [],
  abortSignal?: AbortSignal,
): Promise<RegistryRecordSummary[]> {
  const filters: RegistryRecordFilter[] = [{ name: 'recordType', values: ['SKILL'] }, ...extraFilters];
  const out: RegistryRecordSummary[] = [];
  let nextToken: string | undefined;
  do {
    const page = await client.send(new ListRegistryRecordsCommand({ registryId, filters, maxResults: 100, nextToken }), { abortSignal });
    out.push(...(page.registryRecords ?? []));
    nextToken = page.nextToken;
  } while (nextToken);
  return out;
}

/**
 * Load usable skills with their markdown, most recently updated first.
 * `limit` caps how many records are fetched in full and `maxChars` caps
 * their combined markdown, since every loaded skill goes into the system
 * prompt. The caller is told how many were left out, so a cap never
 * silently reads as "all skills loaded".
 */
export async function loadSkills(
  client: AgentRegistryControlClient,
  registryId: string,
  limit: number,
  abortSignal?: AbortSignal,
  maxChars = Number.POSITIVE_INFINITY,
): Promise<{ skills: SkillRecord[]; skipped: number }> {
  const usable = (await listSkillSummaries(client, registryId, [], abortSignal))
    .filter((r) => r.recordId && !UNUSABLE_STATUSES.has(r.status ?? ''))
    .sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  const chosen = usable.slice(0, limit);
  const full = await Promise.all(chosen.map((r) =>
    client.send(new GetRegistryRecordCommand({ registryId, recordId: r.recordId! }), { abortSignal })));
  const withMarkdown = full
    .map((rec) => ({
      recordId: rec.recordId ?? '',
      recordArn: rec.recordArn ?? '',
      name: rec.name ?? '',
      description: rec.description ?? '',
      status: rec.status ?? '',
      skillMd: skillMdOf(rec),
    }))
    .filter((s) => s.skillMd.length > 0);
  const skills: SkillRecord[] = [];
  let chars = 0;
  for (const skill of withMarkdown) {
    if (chars + skill.skillMd.length > maxChars) continue;
    skills.push(skill);
    chars += skill.skillMd.length;
  }
  return { skills, skipped: usable.length - skills.length };
}

export interface UpsertSkillInput {
  readonly name: string;
  readonly description: string;
  readonly skillMd: string;
}

/**
 * The registry rejects skill markdown that does not open with a
 * `---`-delimited frontmatter block. Markdown that already has one is
 * kept as written; otherwise a minimal SKILL.md header is added.
 * Values are emitted as JSON strings, which are valid YAML scalars.
 */
export function withFrontmatter(name: string, description: string, skillMd: string): string {
  if (/^---\r?\n/.test(skillMd)) return skillMd;
  const oneLine = description.replace(/\s+/g, ' ').trim();
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(oneLine)}\n---\n\n${skillMd}`;
}

/**
 * A record is read-only while the service is still applying an earlier
 * create or update (ConflictException). Wait it out briefly rather than
 * failing a graduation that would succeed seconds later.
 */
async function retryWhileBusy<T>(call: () => Promise<T>, attempts = 6, delayMs = 5_000): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await call();
    } catch (err) {
      if ((err as { name?: string }).name !== 'ConflictException' || i >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * Create the skill record, or update it in place when a record with the
 * same name exists. The registry does not enforce unique names, so this
 * lookup is what keeps a re-graduation from adding a duplicate.
 */
export async function upsertSkill(
  client: AgentRegistryControlClient,
  registryId: string,
  input: UpsertSkillInput,
): Promise<{ action: 'created' | 'updated'; recordArn: string; status: string }> {
  const skillMd = withFrontmatter(input.name, input.description, input.skillMd);
  if (skillMd.length > SKILL_MD_MAX_CHARS) {
    throw new Error(`skill markdown is ${skillMd.length} chars; the registry limit is ${SKILL_MD_MAX_CHARS}`);
  }
  const existing = (await listSkillSummaries(client, registryId, [{ name: 'name', values: [input.name] }]))
    .find((r) => r.name === input.name && r.recordId);

  if (existing) {
    const resp = await retryWhileBusy(() => client.send(new UpdateRegistryRecordCommand({
      registryId,
      recordId: existing.recordId!,
      description: { optionalValue: input.description },
      descriptors: {
        optionalValue: {
          agentSkillsDefinition: {
            optionalValue: {
              additionalData: { optionalValue: { skillMd: { optionalValue: { data: { optionalValue: skillMd } } } } },
            },
          },
        },
      },
    })));
    return { action: 'updated', recordArn: resp.recordArn ?? existing.recordArn ?? '', status: resp.status ?? '' };
  }

  const resp = await client.send(new CreateRegistryRecordCommand({
    registryId,
    name: input.name,
    description: input.description,
    recordType: 'SKILL',
    descriptors: { agentSkillsDefinition: { additionalData: { skillMd: { data: skillMd } } } },
  }));
  return { action: 'created', recordArn: resp.recordArn ?? '', status: resp.status ?? '' };
}
