/**
 * The code names a skill cites: file paths, symbols and config names a
 * release check looks up in the upstream tree.
 *
 * Skills put every code name in backticks (the curator's authoring
 * rule), so only inline code spans count, plus path-like and `A::b`
 * words in the frontmatter description. Fenced blocks hold placeholders
 * and are skipped. So are suppressed pieces (see edits.ts): they
 * describe code before a release on purpose, and checking their names
 * would flag the same superseded names at every check. Only blocks
 * that edits.ts parseSuppressed reads as well formed count; reviewers
 * get any other piece as live text, so its names are checked.
 *
 * No runtime imports, so scripts can load this file directly under
 * Node's type stripping.
 */

export type NameKind = 'path' | 'dir' | 'glob' | 'prefix' | 'qualified' | 'symbol' | 'config';

export interface CitedName {
  readonly token: string;
  readonly kind: NameKind;
}

/** Most names kept per skill, in document order. */
export const MAX_NAMES = 300;

const SPAN_MIN_CHARS = 2;
const SPAN_MAX_CHARS = 120;

/** An all-capitals name needs this many characters; shorter ones (`HSET`, `NULL`) are ordinary words. */
const ALL_CAPS_MIN_CHARS = 5;

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx', 'rs', 'go', 'py', 'pyi', 'java', 'kt', 'kts', 'scala',
  'cs', 'swift', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rb', 'lua', 'tcl', 'sh', 'bash', 'zsh', 'pl',
  'php', 'proto', 'def', 'json', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'xml', 'gradle', 'cmake',
  'mk', 'md', 'rst', 'txt', 'sql', 'html', 'css', 'lock',
]);

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';
const IDENT_RE = new RegExp(`^${IDENT}$`);
const QUALIFIED_RE = new RegExp(`^${IDENT}(?:(?:::|\\.|->)${IDENT})+$`);
const PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]{2,}\*$/;
const CONFIG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;
const PATH_CHARS_RE = /^[A-Za-z0-9_.\/@+-]+$/;
const GLOB_CHARS_RE = /^[A-Za-z0-9_.\/@+*?-]+$/;

function hasSourceExtension(token: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  return SOURCE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

/** A repository-relative path: no leading '/', no '.' or '..' component, no empty component. */
function isRelativePath(token: string): boolean {
  const parts = token.replace(/\/$/, '').split('/');
  return !token.startsWith('/') && parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

function isStrongIdentifier(token: string): boolean {
  if (token.length < 4 || !IDENT_RE.test(token)) return false;
  if (token.includes('_') && /[A-Za-z0-9]/.test(token)) return true;
  if (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1))) return true;
  return /^[A-Z][A-Z0-9]*$/.test(token) && token.length >= ALL_CAPS_MIN_CHARS;
}

/**
 * The kind of a code-span token, or null for a weak word (prose, short
 * all-capitals words, numbers, punctuation). The same rules decide which
 * tokens a release-check edit may change (edits.ts keeps a copy).
 */
export function classifyToken(token: string): NameKind | null {
  if (token.length < SPAN_MIN_CHARS || token.length > SPAN_MAX_CHARS) return null;
  if (PREFIX_RE.test(token)) return 'prefix';
  if (/[*?]/.test(token)) {
    const pathLike = GLOB_CHARS_RE.test(token) && /[\/.]/.test(token) && /[A-Za-z0-9]/.test(token);
    return pathLike && isRelativePath(token) ? 'glob' : null;
  }
  if (token.includes('/') || hasSourceExtension(token)) {
    if (!PATH_CHARS_RE.test(token) || !/[A-Za-z0-9]/.test(token) || !isRelativePath(token)) return null;
    return token.endsWith('/') ? 'dir' : 'path';
  }
  if (QUALIFIED_RE.test(token)) return 'qualified';
  if (isStrongIdentifier(token)) return 'symbol';
  if (CONFIG_RE.test(token)) return 'config';
  return null;
}

/**
 * The token a code span names: a call or index suffix (`foo(...)`,
 * `table[]`), a `:<line>` suffix and a leading `&` or `./` removed.
 * Null for spans that are not a single name: whitespace, URLs,
 * placeholders, shell or assignment syntax, quotes.
 */
function normalizeSpan(span: string): string | null {
  let t = span.trim();
  for (let prev = ''; prev !== t;) {
    prev = t;
    t = t.replace(/(?:\([^()]*\)|\[[^[\]]*\])$/, '').replace(/[,;]$/, '');
  }
  t = t.replace(/:\d+(?:-\d+)?$/, '').replace(/^&/, '').replace(/^\.\//, '');
  if (/\s|:\/\/|[<$='"`]/.test(t)) return null;
  // `->` is a member access (`ht->safe_iterators`); any other '>' is markup or a shell redirect.
  if (t.replace(/->/g, '').includes('>')) return null;
  return t;
}

/**
 * Inline code spans on one line, CommonMark style: a backtick run closes
 * at the next run of the same length, and one padding space is trimmed.
 * A run after an odd number of backslashes is text, not a delimiter, as
 * edits.ts reads spans.
 */
function codeSpans(line: string): string[] {
  const runs = [...line.matchAll(/`+/g)].filter((m) => {
    let slashes = 0;
    while (m.index - slashes > 0 && line[m.index - slashes - 1] === '\\') slashes++;
    return slashes % 2 === 0;
  });
  const out: string[] = [];
  for (let i = 0; i < runs.length; i++) {
    const open = runs[i]!;
    const close = runs.findIndex((r, k) => k > i && r[0].length === open[0].length);
    if (close < 0) continue;
    const inner = line.slice(open.index + open[0].length, runs[close]!.index);
    out.push(inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') ? inner.slice(1, -1) : inner);
    i = close;
  }
  return out;
}

/** Index of the closing '---' of a leading frontmatter block, or -1 when there is none. */
function frontmatterEnd(lines: readonly string[]): number {
  if (lines[0]?.trimEnd() !== '---') return -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trimEnd() === '---') return i;
  }
  return -1;
}

/** The frontmatter `description` value, unquoted, with folded continuation lines joined. */
function frontmatterDescription(lines: readonly string[]): string {
  const at = lines.findIndex((l) => /^description\s*:/.test(l));
  if (at < 0) return '';
  let value = lines[at]!.replace(/^description\s*:\s*/, '').trim();
  const continued: string[] = [];
  for (let i = at + 1; i < lines.length && /^\s+\S/.test(lines[i]!); i++) continued.push(lines[i]!.trim());
  if (/^[>|][+-]?$/.test(value)) return continued.join(' ');
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value) as string;
    } catch {
      value = value.replace(/^"|"$/g, '');
    }
  } else if (value.startsWith("'")) {
    value = value.replace(/^'|'$/g, '').replace(/''/g, "'");
  }
  return [value, ...continued].join(' ');
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/** For each line, whether it is part of a fenced code block, fence lines included. */
function fencedLines(lines: readonly string[]): boolean[] {
  const out: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    if (open === null) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m) open = m[1]!;
      out.push(open !== null);
      continue;
    }
    out.push(true);
    const m = FENCE_CLOSE_RE.exec(line);
    if (m && m[1]![0] === open[0] && m[1]!.length >= open.length) open = null;
  }
  return out;
}

// The suppression marker grammar, copied from edits.ts parseSuppressed
// (no runtime imports); the tests keep the two in step.
const SUPPRESSED_OPEN_RE = /^<!--\s*suppressed\b/;
const SUPPRESSED_CLOSE_RE = /^<!--\s*\/\s*suppressed\b/;
const SUPPRESSED_CLOSE = '<!-- /suppressed -->';
const MARKER_HEADER_RE = /^<!-- suppressed: superseded in ([^\s,;]+), (\d{4}-\d{2}-\d{2}); (.+); evidence: (\S+(?:, \S+)*) -->$/;
const MARKER_TAG_RE = /^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
const MARKER_BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\/$)(?!.*\.$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const MARKER_CITATION_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}@(?:[0-9a-f]{40}|[0-9a-f]{64}):(.+):[1-9][0-9]{0,6}$/;
const MARKER_REASON_PART_RE = /^`([A-Za-z0-9_.\/:*>-]{1,120})` is now `([A-Za-z0-9_.\/:*>-]{1,120})`$/;
const MARKER_NUMBER_RE = /^v?[0-9]+(?:\.[0-9]+)*$/;

function isMarkerRelease(release: string): boolean {
  if (MARKER_TAG_RE.test(release)) return true;
  const at = release.lastIndexOf('@');
  return at > 0 && MARKER_BRANCH_RE.test(release.slice(0, at)) && /^[0-9a-f]{12}$/.test(release.slice(at + 1));
}

function isMarkerDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function isMarkerCitation(text: string): boolean {
  const p = MARKER_CITATION_RE.exec(text)?.[1];
  if (p === undefined || p.length > 400 || p.startsWith('/') || /[\s,;<>"'`\\\x00-\x1f\x7f]/.test(p)) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** "`a` is now `b`" parts, a and b code names or numbers, joined with "; ", optionally ending in "; and N more". */
function isMarkerReason(reason: string): boolean {
  if (reason.length === 0 || reason.length > 300 || /-->|--!>|<!--/.test(reason)) return false;
  const parts = reason.split('; ');
  if (parts.length > 1 && /^and [1-9][0-9]{0,3} more$/.test(parts[parts.length - 1]!)) parts.pop();
  const token = (t: string) => classifyToken(t) !== null || (t.length <= 40 && MARKER_NUMBER_RE.test(t));
  return parts.every((part) => {
    const m = MARKER_REASON_PART_RE.exec(part);
    return m !== null && m[1] !== m[2] && token(m[1]!) && token(m[2]!);
  });
}

/** Whether a trimmed line is a well-formed opening marker. */
function isMarkerHeader(text: string): boolean {
  const m = MARKER_HEADER_RE.exec(text);
  if (!m || !isMarkerRelease(m[1]!) || !isMarkerDate(m[2]!) || !isMarkerReason(m[3]!)) return false;
  return m[4]!.split(', ').every(isMarkerCitation);
}

/**
 * For each line, whether the check skips it: every marker line, and the
 * pieces of well-formed suppressed blocks, as parseSuppressed reads them.
 * A malformed, nested-in, unclosed or empty block hides only its marker
 * lines, so the names it holds are still checked.
 */
function suppressedLines(lines: readonly string[], fenced: readonly boolean[]): boolean[] {
  const out = lines.map(() => false);
  let open: { start: number; ok: boolean } | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (fenced[i]) continue;
    const text = lines[i]!.trim();
    if (SUPPRESSED_OPEN_RE.test(text)) {
      out[i] = true;
      if (!open) open = { start: i, ok: isMarkerHeader(text) };
    } else if (SUPPRESSED_CLOSE_RE.test(text)) {
      out[i] = true;
      if (open && open.ok && text === SUPPRESSED_CLOSE && i > open.start + 1) {
        for (let j = open.start; j <= i; j++) out[j] = true;
      }
      open = null;
    }
  }
  return out;
}

/**
 * Words of the description that name code without backticks: paths
 * with a source extension or a trailing '/', globs with a '/', and
 * `A::b` names. Other bare words are prose ("Node.js", "owner/name").
 */
function bareDescriptionName(word: string): CitedName | null {
  const t = word.replace(/^[("'[]+/, '').replace(/[)"'\],;:.!?]+$/, '');
  const kind = classifyToken(t);
  if (kind === 'qualified') return t.includes('::') ? { token: t, kind } : null;
  if (kind === 'glob' && t.includes('/')) return { token: t, kind };
  if (kind === 'dir' || (kind === 'path' && t.includes('/') && hasSourceExtension(t))) return { token: t, kind };
  return null;
}

/**
 * The code names a skill cites, first-seen order, at most MAX_NAMES.
 * Body names come from inline code spans outside fenced blocks and
 * suppressed pieces; the frontmatter description adds its code spans
 * and its bare path-like and `A::b` words.
 */
export function extractNames(skillMd: string): CitedName[] {
  const lines = skillMd.split('\n').map((l) => l.replace(/\r$/, ''));
  const fmEnd = frontmatterEnd(lines);
  const out: CitedName[] = [];
  const seen = new Set<string>();
  const add = (name: CitedName | null) => {
    if (!name || seen.has(name.token) || out.length >= MAX_NAMES) return;
    seen.add(name.token);
    out.push(name);
  };
  const fromSpan = (span: string): CitedName | null => {
    if (span.length < SPAN_MIN_CHARS || span.length > SPAN_MAX_CHARS) return null;
    const token = normalizeSpan(span);
    const kind = token === null ? null : classifyToken(token);
    return kind ? { token: token!, kind } : null;
  };

  if (fmEnd > 0) {
    const description = frontmatterDescription(lines.slice(1, fmEnd));
    for (const m of description.matchAll(/`([^`]+)`|[^\s`]+/g)) {
      add(m[1] !== undefined ? fromSpan(m[1]) : bareDescriptionName(m[0]));
    }
  }

  const body = lines.slice(fmEnd + 1);
  const fenced = fencedLines(body);
  const suppressed = suppressedLines(body, fenced);
  body.forEach((line, i) => {
    if (fenced[i] || suppressed[i]) return;
    for (const span of codeSpans(line)) add(fromSpan(span));
  });
  return out;
}
