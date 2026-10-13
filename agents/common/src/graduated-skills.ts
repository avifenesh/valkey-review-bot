import { createRegistryClient, GRADUATED_SKILLS_MAX_CHARS, loadSkills } from './skills-registry.js';
import { parseSuppressed, skillLayout } from './skill-check/edits.js';

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

/**
 * The provenance sentence submit_skill appends to a description, for
 * operators. Matched after whitespace is collapsed, so ' ?' stands in
 * for a leading \s*, which would take quadratic time on a long run.
 */
const RECORD_ID_SENTENCE_RE = / ?Graduated from concern record_id=\S*$/;
/**
 * The citation the curator ends a skill body with, `_(graduated from concern record_id=<id>)_`.
 * No leading `\s*`: retried at every space of a long run, it takes
 * quadratic time. withoutCitation trims the space before it instead.
 */
const RECORD_ID_CITATION_RE = /[_*]?\(graduated from concern record_id=[^)\s]*\)[_*]?[ \t]*(?=\r?$)/i;

/** `line` without the record id citation at its end and the whitespace before it. */
function withoutCitation(line: string): string {
  const m = RECORD_ID_CITATION_RE.exec(line);
  if (!m) return line;
  return line.slice(0, m.index).trimEnd() + line.slice(m.index + m[0].length);
}

const HEADING_RE = /^( {0,3})(#{1,5})(?=\s|$)/;

/*
 * A release check that finds a stale piece of a skill keeps it in place
 * between suppression markers and adds the replacement after them:
 *
 *   <!-- suppressed: superseded in <release>, <YYYY-MM-DD>; <reason>; evidence: <repo>@<sha>:<path>:<line> -->
 *   <the original piece>
 *   <!-- /suppressed -->
 *   <the replacement>
 *
 * The piece can still hold on release lines older than <release>, so it
 * stays for backport reviews, labelled so it is not applied to the
 * current head. Only the release reaches the label; the reason and
 * evidence are for maintainers reading the record.
 *
 * The blocks are the ones parseSuppressed (skill-check/edits.ts) reads,
 * the same grammar the release check writes and its name check skips,
 * so a piece is labelled for reviewers exactly when the check treats it
 * as suppressed. Markers it does not accept are left as written.
 */
function suppressedOpenLabel(release: string): string {
  return `**Superseded in ${release}.** The text from here to "End of superseded text" describes code before ${release}. `
    + 'It can still hold on older release lines, so it matters for backports to them; do not apply it to the current head.';
}

const SUPPRESSED_CLOSE_LABEL = '**End of superseded text.**';

/** `label` in place of the marker `line`: the marker's indentation and line ending are kept. */
function inPlaceOf(line: string, label: string): string {
  const indent = line.slice(0, line.length - line.trimStart().length);
  return `${indent}${label}${line.endsWith('\r') ? '\r' : ''}`;
}

/** Labels for the marker lines of each suppressed block, by line index in `markdown`. */
function suppressedLabels(markdown: string, lines: readonly string[]): Map<number, string> {
  const labels = new Map<number, string>();
  for (const block of parseSuppressed(markdown).blocks) {
    const open = block.startLine - 1;
    const close = block.endLine - 1;
    labels.set(open, inPlaceOf(lines[open], suppressedOpenLabel(block.release)));
    labels.set(close, inPlaceOf(lines[close], SUPPRESSED_CLOSE_LABEL));
  }
  return labels;
}

/**
 * Label the suppressed pieces. For a graduated skill (`graduated`), also
 * drop a complete frontmatter block, and outside fenced blocks demote
 * headings and drop the record id citation.
 */
function rewriteLines(markdown: string, graduated: boolean): string {
  const all = markdown.split('\n');
  // Markers, frontmatter and fences as the release check reads them, so
  // a line it treats as code is left as written here too.
  const labels = suppressedLabels(markdown, all);
  const layout = skillLayout(markdown);
  const bodyStart = graduated ? layout.bodyStart : 0;
  return all.slice(bodyStart)
    .flatMap((line, i) => {
      const label = labels.get(bodyStart + i);
      if (label !== undefined) return [label];
      if (!graduated || layout.fenced[bodyStart + i]) return [line];
      // The record id means nothing to a reviewer. A line that held only
      // the citation goes with it.
      const uncited = withoutCitation(line);
      if (uncited !== line && uncited.trim() === '') return [];
      return [uncited.replace(HEADING_RE, '$1#$2')];
    })
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
 * sibling of the skill, no record id citation, and its superseded pieces
 * labelled. Lines in fenced blocks are left alone.
 */
function renderSkillBody(skillMd: string): string {
  return rewriteLines(skillMd, true).trim();
}

/** The description on one line, without the record id sentence that means nothing to a reviewer. */
function scopeLine(description: string): string {
  return description.replace(/\s+/g, ' ').trim().replace(RECORD_ID_SENTENCE_RE, '');
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
