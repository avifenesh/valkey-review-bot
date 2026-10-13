import { createRegistryClient, GRADUATED_SKILLS_MAX_CHARS, loadSkills } from './skills-registry.js';

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
    const maxChars = opts.maxChars ?? GRADUATED_SKILLS_MAX_CHARS;
    const { skills, skipped } = await loadSkills(client, opts.registryId, limit, abortSignal, maxChars);
    if (skipped > 0) console.warn(`[graduated-skills] loaded ${skills.length}; ${skipped} skill(s) left out by the limits (${limit} skills, ${maxChars} characters)`);
    return skills;
  } catch (err) {
    console.warn(`[graduated-skills] registry load failed: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    client.destroy();
  }
}

const INTRO = 'These rules graduated from the concerns store after repeated reinforcement. '
  + 'Several maintainers confirmed each of these rules, and each is re-checked against the upstream default branch after releases. '
  + 'A rule is a reason to look; the code at the PR head wins. '
  + 'Confirm that the files and names a rule cites exist in this checkout before relying on it.';

/** The provenance sentence submit_skill appends to a description, for operators. */
const RECORD_ID_SENTENCE_RE = /\s*Graduated from concern record_id=\S*\s*$/;

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^( {0,3})(#{1,5})(?=\s|$)/;

/** Whether each line belongs to a fenced code block, fence lines included. */
function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const m = FENCE_RE.exec(line);
    if (open !== null) {
      out.push(true);
      // A fence closes on the same character, at least as long, with nothing after it.
      if (m && m[1][0] === open[0] && m[1].length >= open.length && m[2].trim() === '') open = null;
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      out.push(true);
      open = m[1];
    } else {
      out.push(false);
    }
  }
  return out;
}

/** The markdown without its leading `---` frontmatter block, when it has a complete one. */
function stripFrontmatter(skillMd: string): string {
  if (!/^---\r?\n/.test(skillMd)) return skillMd;
  const lines = skillMd.split('\n');
  const end = lines.findIndex((line, i) => i > 0 && line.trimEnd() === '---');
  return end < 0 ? skillMd : lines.slice(end + 1).join('\n');
}

/*
 * A release check that finds a stale piece of a skill keeps it in place
 * between suppression markers and adds the replacement after them:
 *
 *   <!-- suppressed: superseded in <tag>, <YYYY-MM-DD>; <reason>; evidence: <repo>@<sha>:<path>:<line> -->
 *   <the original piece>
 *   <!-- /suppressed -->
 *   <the replacement>
 *
 * The piece can still hold on release lines older than <tag>, so it stays
 * for backport reviews, labelled so it is not applied to the current
 * head. Only the tag reaches the label; the reason and evidence are for
 * maintainers reading the record.
 */
const CITATION = String.raw`[\w.-]+/[\w.-]+@[0-9a-f]{7,40}:[^\s,]+:\d+`;
const SUPPRESSED_OPEN_RE = new RegExp(
  String.raw`^(\s*)<!-- suppressed: superseded in ([A-Za-z0-9][\w.+/@-]{0,63}), \d{4}-\d{2}-\d{2}; (?:(?!-->).)+; evidence: ${CITATION}(?:, ${CITATION})* -->\s*$`,
);
const SUPPRESSED_CLOSE_RE = /^(\s*)<!-- \/suppressed -->\s*$/;

function suppressedOpenLabel(tag: string): string {
  return `**Superseded in ${tag}.** The text from here to "End of superseded text" describes code before ${tag}. `
    + 'It can still hold on older release lines, so it matters for backports to them; do not apply it to the current head.';
}

const SUPPRESSED_CLOSE_LABEL = '**End of superseded text.**';

/**
 * Labels for the marker lines of each well-formed suppressed block, by
 * line index. A block is an open marker and the next close marker, both
 * outside fenced blocks. Markers that do not pair up, or do not have the
 * exact form, are left as written.
 */
function suppressedLabels(lines: readonly string[], fenced: readonly boolean[]): Map<number, string> {
  const labels = new Map<number, string>();
  let open: { at: number; indent: string; tag: string } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const opening = SUPPRESSED_OPEN_RE.exec(lines[i]);
    if (opening) {
      // Suppression does not nest: a second open marker leaves the first unpaired.
      open = { at: i, indent: opening[1], tag: opening[2] };
      continue;
    }
    const closing = SUPPRESSED_CLOSE_RE.exec(lines[i]);
    if (closing && open) {
      labels.set(open.at, open.indent + suppressedOpenLabel(open.tag));
      labels.set(i, closing[1] + SUPPRESSED_CLOSE_LABEL);
      open = null;
    }
  }
  return labels;
}

function rewriteLines(markdown: string, demoteHeadings: boolean): string {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  const labels = suppressedLabels(lines, fenced);
  return lines
    .map((line, i) => labels.get(i) ?? (demoteHeadings && !fenced[i] ? line.replace(HEADING_RE, '$1#$2') : line))
    .join('\n');
}

/**
 * Replace the suppression markers in skill markdown with labels that
 * say which release superseded the piece. For skill text that goes into
 * a prompt as it is, such as the baked-in skill file.
 */
export function labelSuppressedPieces(markdown: string): string {
  return rewriteLines(markdown, false);
}

/**
 * A skill's body as it sits under its own `##` heading: no frontmatter,
 * its headings one level down, so its `## Patterns` does not read as a
 * sibling of the skill, and its superseded pieces labelled. Lines in
 * fenced blocks are left alone.
 */
function renderSkillBody(skillMd: string): string {
  return rewriteLines(stripFrontmatter(skillMd), true).trim();
}

/** The description on one line, without the record id sentence that means nothing to a reviewer. */
function scopeLine(description: string): string {
  return description.replace(RECORD_ID_SENTENCE_RE, '').replace(/\s+/g, ' ').trim();
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
  lines.push(INTRO);
  lines.push('');
  for (const s of skills) {
    lines.push(`## ${s.name}`);
    const scope = scopeLine(s.description);
    if (scope) lines.push(`Scope: ${scope}`);
    lines.push('');
    lines.push(renderSkillBody(s.skillMd));
    lines.push('');
  }
  return lines.join('\n');
}
