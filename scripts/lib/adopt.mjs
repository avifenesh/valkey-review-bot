// Concern records for registry skills that no concern record names, so
// the skill lifecycle reaches them (registry-skills.mjs adopt). The
// record is the one the curator would hold had it graduated the skill:
// what create_concern writes (agents/curator/src/tools/concerns-ddb.ts)
// plus what submit_skill adds (agents/curator/src/tools/submit-skill.ts).

import { createHash } from 'node:crypto';
import { extractNames } from '../../agents/common/src/skill-check/names.ts';
import { toItem } from './aws-cli.mjs';
import { RECORD_NAME_RE } from './check-queue.mjs';
import { RESERVED_BUCKET_PREFIX } from './skill-records.mjs';

/**
 * Registry statuses the release check acts on (LIVE_STATUSES in
 * agents/curator/src/maintenance.ts). A record in any other status that
 * is not retired is still being written or failed to be.
 */
export const CHECKABLE_STATUSES = new Set(['DRAFT', 'PENDING_APPROVAL', 'APPROVED']);

/** The curator's graduation threshold when GRADUATION_THRESHOLD is unset (agents/curator/src/config.ts), and its bounds. */
export const DEFAULT_THRESHOLD = 4;
export const THRESHOLD_MIN = 2;
export const THRESHOLD_MAX = 100;

/** The area of a skill that cites no file path, directory or path glob: everything. */
export const WHOLE_TREE = '**';
/** The area_bucket of such a skill unless --bucket names another. */
export const DEFAULT_FALLBACK_BUCKET = WHOLE_TREE;

// The curator's limits on a concern record (concernShape in concerns-ddb.ts).
export const MAX_AREA_GLOBS = 10;
export const MAX_BUCKET_CHARS = 200;
const MAX_SUBJECT_CHARS = 200;
const MAX_CONCERN_CHARS = 2000;

/** The provenance sentence submit_skill appends to a description (PROVENANCE_RE in submit-skill.ts). */
const PROVENANCE_RE = /\s*Graduated from concern record_id=\S*\s*$/;

const AREA_KINDS = new Set(['path', 'dir', 'glob']);

/** `text` cut to at most `max` UTF-16 code units, never in the middle of a surrogate pair. */
function cut(text, max) {
  if (text.length <= max) return text;
  const high = text.charCodeAt(max - 1);
  return text.slice(0, high >= 0xd800 && high <= 0xdbff ? max - 1 : max);
}

/**
 * The file globs a skill applies to: the file paths, directories and path
 * globs it cites (agents/common/src/skill-check/names.ts), in document
 * order, a directory as `<dir>/**`, at most MAX_AREA_GLOBS. A skill that
 * cites none gets WHOLE_TREE. The release check counts the files each glob
 * matches upstream; only when every glob matches none does an "obsolete"
 * verdict count as corroborated by the tree.
 */
export function adoptionArea(skillMd) {
  const globs = [];
  for (const { token, kind } of extractNames(skillMd)) {
    if (!AREA_KINDS.has(kind)) continue;
    const glob = kind === 'dir' ? `${token}**` : token;
    if (!globs.includes(glob)) globs.push(glob);
    if (globs.length === MAX_AREA_GLOBS) break;
  }
  return globs.length > 0 ? globs : [WHOLE_TREE];
}

/**
 * The area_bucket for an area, by the curator's convention (skill.md,
 * "area_bucket conventions"): a top-level directory, the one of the
 * first glob that names a directory. A skill cites its subject first,
 * usually in its description, the way the curator's bucket comes from
 * the path a comment was anchored on. `fallback` when no glob names a
 * directory (WHOLE_TREE, or only file names).
 */
export function adoptionBucket(area, fallback) {
  for (const glob of area) {
    const slash = glob.indexOf('/');
    if (slash <= 0) continue;
    const top = glob.slice(0, slash);
    if (!/[*?]/.test(top) && !top.startsWith(RESERVED_BUCKET_PREFIX)) return top;
  }
  return fallback;
}

/** Why `bucket` cannot hold concern records, or null. */
export function bucketProblem(bucket) {
  if (!bucket || bucket.length > MAX_BUCKET_CHARS) return `a bucket is 1 to ${MAX_BUCKET_CHARS} characters`;
  if (bucket.startsWith(RESERVED_BUCKET_PREFIX)) return `buckets starting with "${RESERVED_BUCKET_PREFIX}" are reserved and hold no concern records`;
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]/u.test(bucket)) return 'a bucket holds no spaces, control or format characters';
  return null;
}

/**
 * The record_id of the record adopted for `name`: a UUID (version 8, made
 * from a SHA-256 of the name), so two adopt runs for one name write the
 * same key and the second one's put, conditioned on attribute_not_exists,
 * fails instead of adding a second record for the skill.
 */
export function adoptedRecordId(name) {
  const h = createHash('sha256').update(`adopted-skill#${name}`).digest();
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Index of the closing '---' of a leading frontmatter block, or -1. */
function frontmatterEnd(lines) {
  if (lines[0]?.trimEnd() !== '---') return -1;
  return lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
}

/** The first `# Title` of the markdown body outside fenced blocks, or ''. */
function title(skillMd) {
  const lines = skillMd.split('\n').map((l) => l.replace(/\r$/, ''));
  let fence = null;
  for (const line of lines.slice(frontmatterEnd(lines) + 1)) {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (fence === null) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      continue;
    }
    const m = fence === null ? /^#\s+(.*?)\s*#*\s*$/.exec(line) : null;
    if (m && m[1]) return m[1];
  }
  return '';
}

/** The frontmatter `description` on one line, unquoted, or ''. */
function frontmatterDescription(skillMd) {
  const lines = skillMd.split('\n').map((l) => l.replace(/\r$/, ''));
  const end = frontmatterEnd(lines);
  const line = end > 0 ? lines.slice(1, end).find((l) => /^description\s*:/.test(l)) : undefined;
  if (!line) return '';
  const value = line.replace(/^description\s*:\s*/, '').trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.replace(/^"|"$/g, '');
    }
  }
  return value.startsWith("'") ? value.replace(/^'|'$/g, '').replace(/''/g, "'") : value;
}

const oneLine = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * The concern record adopted for a registry skill (`skill`: name,
 * recordId, description and skillMd as getSkillByName returns them).
 * Exactly the attributes the curator writes for a record that graduated
 * into the skill:
 * - create_concern: area_bucket, record_id, area, subject, concern,
 *   context, reinforcement_count, decay_score 1.0, created_at and
 *   updated_at (now);
 * - submit_skill: graduated_record_name (the registry name) and
 *   graduated_at (now).
 * reinforcement_count is the graduation threshold, so the record counts
 * as graduated as the curator sees it. Its reinforcer set is empty: no
 * person reinforced it. DynamoDB cannot store an empty set, so the item
 * has no reinforcers attribute, which the curator reads as an empty set
 * (and its first bump_concern creates). No verified_* or check state:
 * the next decay pass finds the record never checked and queues a first
 * release check.
 */
export function adoptionItem({ skill, threshold, nowIso, fallbackBucket }) {
  const area = adoptionArea(skill.skillMd);
  const subject = cut(oneLine(title(skill.skillMd)) || skill.name.replaceAll('-', ' '), MAX_SUBJECT_CHARS);
  const concern = cut(
    oneLine(String(skill.description ?? '').replace(PROVENANCE_RE, '')) || oneLine(frontmatterDescription(skill.skillMd)) || subject,
    MAX_CONCERN_CHARS,
  );
  return {
    area_bucket: adoptionBucket(area, fallbackBucket),
    record_id: adoptedRecordId(skill.name),
    area,
    subject,
    concern,
    context: `Adopted into the skill lifecycle from registry record ${skill.recordId} on ${nowIso.slice(0, 10)}. `
      + 'The skill was published outside the curator, so no maintainer reinforcement is recorded behind it.',
    reinforcement_count: threshold,
    decay_score: 1.0,
    created_at: nowIso,
    updated_at: nowIso,
    graduated_record_name: skill.name,
    graduated_at: nowIso,
  };
}

/**
 * `aws dynamodb put-item` arguments that write `item` only where no item
 * has its key, as create_concern conditions its put.
 */
export function adoptionPutArgs(table, item) {
  return [
    'dynamodb', 'put-item', '--table-name', table, '--item', JSON.stringify(toItem(item)),
    '--condition-expression', 'attribute_not_exists(#rid)',
    '--expression-attribute-names', JSON.stringify({ '#rid': 'record_id' }),
  ];
}

/**
 * Every SKILL record of a registry with what adopt does with it: `skip`
 * is the reason it is left as it is, or null when it gets a concern
 * record. `referenced` holds the graduated_record_name of every concern
 * record (graduatedNames). Sorted by name, then record id.
 */
export function planAdoption(summaries, referenced, isRetired) {
  const liveByName = new Map();
  for (const r of summaries) {
    if (!isRetired(r.status)) liveByName.set(r.name, (liveByName.get(r.name) ?? 0) + 1);
  }
  const reason = (r) => {
    if (isRetired(r.status)) return `${r.status}: a retired skill stays out of the lifecycle`;
    if (!r.recordId) return 'the registry gave no record id';
    if (referenced.has(r.name)) return 'a concern record already names it, so it is in the lifecycle';
    if (typeof r.name !== 'string' || !RECORD_NAME_RE.test(r.name)) {
      return 'the name is not one the lifecycle accepts (lowercase letters, digits and hyphens, at most 100)';
    }
    const live = liveByName.get(r.name);
    if (live > 1) return `${live} live records share the name, and a concern record names one skill by name`;
    if (!CHECKABLE_STATUSES.has(r.status)) {
      return `status ${r.status || 'none'}: the release check acts only on DRAFT, PENDING_APPROVAL or APPROVED records; run adopt again once it is one`;
    }
    return null;
  };
  return [...summaries]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.recordId ?? '').localeCompare(b.recordId ?? ''))
    .map((record) => ({ record, skip: reason(record) }));
}

/** Why `raw` is not a graduation threshold the curator accepts, or null. */
export function thresholdProblem(raw) {
  if (!/^\d+$/.test(raw)) return `must be a whole number, got ${JSON.stringify(raw)}`;
  const n = Number(raw);
  return n < THRESHOLD_MIN || n > THRESHOLD_MAX ? `must be between ${THRESHOLD_MIN} and ${THRESHOLD_MAX}, got ${n}` : null;
}
