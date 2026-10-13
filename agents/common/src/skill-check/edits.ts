/**
 * Release-check edits to a skill, in suppress-and-add form.
 *
 * A stale piece of the skill body (one or more whole lines) is never
 * overwritten. It stays byte for byte between markers that name the
 * upstream release that superseded it and cite the upstream lines that
 * prove the change, and the replacement follows the closing marker:
 *
 *   <!-- suppressed: superseded in <release>, <YYYY-MM-DD>; <reason>; evidence: <repo>@<sha>:<path>:<line> -->
 *   <the original piece>
 *   <!-- /suppressed -->
 *   <the replacement piece>
 *
 * <release> is the GA tag that triggered the check (9.1.2 or v2.5.1), or
 * "<branch>@<first 12 hex of the checked commit>" when no tag is known
 * (releaseLabel builds it). parseSuppressed is the one reader of this
 * grammar; names.ts keeps a copy of it, kept in step by the tests.
 *
 * The reason is generated from the changed names ("`a` is now `b`",
 * several joined by "; ", then "; and N more" when they do not all
 * fit); an edit cannot supply one, so no caller or model text reaches
 * the skill, and parseSuppressed reads no other reason as well formed.
 * Several citations are separated by ", ".
 *
 * The replacement may differ from the original only where a cited line
 * supports it. Both are split on the token class [A-Za-z0-9_./:*>-]+;
 * the text between tokens must be identical and the token count equal.
 * Every changed token must be a code name inside an inline code span
 * (backticks) replacing a code name of the same sort, or a number
 * replacing a number, and appear on one of the edit's cited lines. A
 * changed name must be one the check flagged. A number may change only
 * on a line that holds a flagged name, and its cited line must also
 * hold a code name from that line, so a threshold elsewhere in the
 * piece, or one cited from an unrelated line, cannot change. Words
 * outside code spans never change, so an edit cannot turn "NEVER flag"
 * into "ALWAYS flag", add or remove a word, a sentence or punctuation,
 * and the replacement has as many lines as the original. An escaped
 * backtick (\`) is text, not a span delimiter; a line with a backtick
 * that pairs with none, or an escaped one inside a span, is never
 * edited. The
 * frontmatter, fenced blocks and already-suppressed pieces are never
 * edited, and suppressed blocks do not nest.
 *
 * No runtime imports, so scripts can load this file directly under
 * Node's type stripping. The token rules repeat names.ts's
 * classifyToken; the tests keep the two in step.
 */

export interface Citation {
  /** "owner/name". */
  readonly repo: string;
  /** Full commit SHA. */
  readonly sha: string;
  /** Repository-relative file path. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
}

export interface SuppressEdit {
  /** One or more whole lines of the skill body, exactly as written, joined with '\n'. */
  readonly original: string;
  /** The same lines with only code names or numbers changed. */
  readonly replacement: string;
  /** The upstream lines that support the changes: 1 to MAX_CITATIONS_PER_EDIT. */
  readonly evidence: readonly Citation[];
  // No reason: the marker's reason is generated from the changed names,
  // so no caller or model text reaches the skill. An edit that has one is refused.
}

export interface EditContext {
  /**
   * Names the check flagged (lost, new_absent or touched). Every piece
   * must contain one, every changed name must be one, and a number may
   * change only on a line that contains one.
   */
  readonly flagged: readonly string[];
  /** The release named in the marker: a GA tag, or "<branch>@<sha12>" when no tag is known (see releaseLabel). */
  readonly release: string;
  /** YYYY-MM-DD of the check. */
  readonly date: string;
  /** The checked commit. Every citation must name this repository and commit. */
  readonly upstream: { readonly repo: string; readonly sha: string };
  /** Cap on the edited markdown. Default 40,000 (GRADUATED_SKILL_MAX_CHARS). */
  readonly maxChars?: number;
}

/** Line `citation.line` of the file at the cited commit, without its line ending; null when there is none. */
export type LineResolver = (citation: Citation) => Promise<string | null>;

export interface SuppressedBlock {
  readonly release: string;
  readonly date: string;
  readonly reason: string;
  readonly evidence: readonly Citation[];
  /** The suppressed piece, exactly as written. */
  readonly original: string;
  /**
   * The live text that stands in its place: as many lines as the
   * original, read after the closing marker and skipping any later
   * suppressed block.
   */
  readonly replacement: string;
  /** 1-based line numbers of the opening and closing markers in the whole markdown. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface EditOutcome {
  /** Why the edits were refused; empty when they are valid. */
  readonly problems: readonly string[];
  /** The edited markdown when there are no problems, else null. */
  readonly skillMd: string | null;
}

export const MAX_EDITS = 6;
/**
 * Cap on how much one check's edits may grow the skill, measured on the
 * rendered markdown: markers, citations, kept originals and replacements.
 * Reviewers share one 80,000-character window across their skills.
 */
export const MAX_GROWTH_CHARS = 4_000;
/** Lines of a piece; the replacement has as many. */
export const MAX_PIECE_LINES = 5;
/** Characters of the original and of the replacement. */
export const MAX_PIECE_CHARS = 800;
export const MAX_CITATIONS_PER_EDIT = 5;
const MAX_REASON_CHARS = 300;
const DEFAULT_MAX_CHARS = 40_000;
const NAME_MAX_CHARS = 120;

export const SUPPRESSED_CLOSE = '<!-- /suppressed -->';
const HEADER_RE = /^<!-- suppressed: superseded in ([^\s,;]+), (\d{4}-\d{2}-\d{2}); (.+); evidence: (\S+(?:, \S+)*) -->$/;
const OPEN_LIKE_RE = /^<!--\s*suppressed\b/;
const CLOSE_LIKE_RE = /^<!--\s*\/\s*suppressed\b/;

/** A GA release tag, the shape release detection accepts (RELEASE_TAG_RE in ops). */
const RELEASE_TAG_RE = /^v?[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/;
/** A branch name in a release label: git ref rules, and no '@', ',', ';' or space, so the marker parses. */
const LABEL_BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!.*\/\.)(?!.*\/$)(?!.*\.$)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const LABEL_SHA_CHARS = 12;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CITATION_RE = /^([A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100})@([0-9a-f]{40}|[0-9a-f]{64}):(.+):([1-9][0-9]{0,6})$/;
const PATH_MAX_CHARS = 400;

const TOKEN_RE = /[A-Za-z0-9_.\/:*>-]+/g;
const WORD_CHAR_RE = /[A-Za-z0-9_]/;
/** A number, or a version such as 9.0.1 or v9.0. */
const NUMBER_RE = /^v?[0-9]+(?:\.[0-9]+)*$/;
/** Longer numbers are not changed, so one "`a` is now `b`" part always fits in a reason. */
const NUMBER_MAX_CHARS = 40;
/** One part of a generated reason; names and numbers are made of the token characters. */
const REASON_PART_RE = /^`([A-Za-z0-9_.\/:*>-]{1,120})` is now `([A-Za-z0-9_.\/:*>-]{1,120})`$/;
const REASON_MORE_RE = /^and [1-9][0-9]{0,3} more$/;

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})\s*$/;

// Token rules, copied from names.ts classifyToken.

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

type NameKind = 'path' | 'dir' | 'glob' | 'prefix' | 'qualified' | 'symbol' | 'config';

/** Which sort of name a kind is. An edit may only swap names of one sort. */
function nameSort(kind: NameKind): 'file' | 'code' | 'config' {
  if (kind === 'path' || kind === 'dir' || kind === 'glob') return 'file';
  return kind === 'config' ? 'config' : 'code';
}

function hasSourceExtension(token: string): boolean {
  const dot = token.lastIndexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  return SOURCE_EXTENSIONS.has(token.slice(dot + 1).toLowerCase());
}

function isRelativePath(token: string): boolean {
  const parts = token.replace(/\/$/, '').split('/');
  return !token.startsWith('/') && parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

function isStrongIdentifier(token: string): boolean {
  if (token.length < 4 || !IDENT_RE.test(token)) return false;
  if (token.includes('_') && /[A-Za-z0-9]/.test(token)) return true;
  if (/[a-z]/.test(token) && /[A-Z]/.test(token.slice(1))) return true;
  return /^[A-Z][A-Z0-9]*$/.test(token) && token.length >= 5;
}

function nameKind(token: string): NameKind | null {
  if (token.length < 2 || token.length > NAME_MAX_CHARS) return null;
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

/** A citation path: repository-relative, no '.' or '..' component, nothing that would break the marker line. */
function isCitablePath(p: string): boolean {
  if (p.length === 0 || p.length > PATH_MAX_CHARS || p.startsWith('/')) return false;
  if (/[\s,;<>"'`\\\x00-\x1f\x7f]/.test(p)) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

export function formatCitation(c: Citation): string {
  return `${c.repo}@${c.sha}:${c.path}:${c.line}`;
}

/** Parse "<repo>@<sha>:<path>:<line>"; null when it is not one. */
export function parseCitation(text: string): Citation | null {
  const m = CITATION_RE.exec(text);
  if (!m || !isCitablePath(m[3]!)) return null;
  return { repo: m[1]!, sha: m[2]!, path: m[3]!, line: Number(m[4]) };
}

function citationProblem(c: Citation, upstream: EditContext['upstream']): string | null {
  const shown = typeof c?.path === 'string' ? formatCitation(c) : JSON.stringify(c);
  if (!c || typeof c.repo !== 'string' || typeof c.sha !== 'string' || typeof c.path !== 'string' || !Number.isInteger(c.line)) {
    return `evidence ${shown} is not a citation of {repo, sha, path, line}`;
  }
  if (!isCitablePath(c.path)) return `evidence ${shown}: the path must be relative, without '..', '.', NUL, spaces, commas or quotes`;
  if (c.line < 1 || c.line > 9_999_999) return `evidence ${shown}: the line must be a positive number`;
  if (c.repo.toLowerCase() !== upstream.repo.toLowerCase() || c.sha !== upstream.sha) {
    return `evidence ${shown}: cite the checked commit, ${upstream.repo}@${upstream.sha}`;
  }
  if (parseCitation(formatCitation(c)) === null) return `evidence ${shown} is not a valid citation`;
  return null;
}

interface Header {
  readonly release: string;
  readonly date: string;
  readonly reason: string;
  readonly evidence: readonly Citation[];
}

interface Block {
  /** Line index of the opening marker. */
  readonly start: number;
  /** Line index of the closing marker. */
  readonly end: number;
  readonly header: Header;
}

interface Doc {
  /** The markdown split on '\n'; a '\r' stays on its line. */
  readonly lines: readonly string[];
  /** The lines without a trailing '\r'. */
  readonly plain: readonly string[];
  /** Index of the first body line (after the frontmatter). */
  readonly bodyStart: number;
  /** The first line opens a frontmatter block that never closes. */
  readonly unclosedFrontmatter: boolean;
  readonly fenced: readonly boolean[];
  /** Per line, whether it belongs to a suppressed block, markers included. */
  readonly inBlock: readonly boolean[];
  readonly blocks: readonly Block[];
  readonly problems: readonly string[];
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** Whether `release` can be named in a marker: a GA tag, or "<branch>@<12 hex>". */
export function isReleaseLabel(release: string): boolean {
  if (RELEASE_TAG_RE.test(release)) return true;
  const at = release.lastIndexOf('@');
  return at > 0 && LABEL_BRANCH_RE.test(release.slice(0, at)) && new RegExp(`^[0-9a-f]{${LABEL_SHA_CHARS}}$`).test(release.slice(at + 1));
}

/**
 * The release a marker names: the tag when there is one, else
 * "<branch>@<first 12 hex of sha>", as for a check started without a
 * known release (release_tag ""). Throws when neither form is valid.
 */
export function releaseLabel(tag: string, branch: string, sha: string): string {
  if (tag !== '') {
    if (!RELEASE_TAG_RE.test(tag)) throw new Error(`release tag ${JSON.stringify(tag)} is not a GA tag such as 9.1.2`);
    return tag;
  }
  if (!SHA_RE.test(sha)) throw new Error(`not a full commit SHA: ${JSON.stringify(sha)}`);
  const label = `${branch}@${sha.slice(0, LABEL_SHA_CHARS)}`;
  if (!isReleaseLabel(label)) throw new Error(`branch ${JSON.stringify(branch)} cannot be named in a marker`);
  return label;
}

function parseHeader(text: string): Header | null {
  const m = HEADER_RE.exec(text);
  if (!m || !isReleaseLabel(m[1]!) || !isValidDate(m[2]!) || reasonProblem(m[3]!) !== null) return null;
  const evidence = m[4]!.split(', ').map(parseCitation);
  if (evidence.some((c) => c === null)) return null;
  return { release: m[1]!, date: m[2]!, reason: m[3]!, evidence: evidence as Citation[] };
}

function parseDoc(skillMd: string): Doc {
  const lines = skillMd.split('\n');
  const plain = lines.map(stripCr);
  let bodyStart = 0;
  let unclosedFrontmatter = false;
  if (plain[0]?.trimEnd() === '---') {
    const end = plain.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
    if (end > 0) bodyStart = end + 1;
    else unclosedFrontmatter = true;
  }

  const fenced = plain.map(() => false);
  let fence: string | null = null;
  for (let i = bodyStart; i < plain.length; i++) {
    const line = plain[i]!;
    if (fence === null) {
      const m = FENCE_OPEN_RE.exec(line);
      if (m) fence = m[1]!;
      fenced[i] = fence !== null;
      continue;
    }
    fenced[i] = true;
    const m = FENCE_CLOSE_RE.exec(line);
    if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length) fence = null;
  }

  const blocks: Block[] = [];
  const problems: string[] = [];
  let open: { start: number; header: Header | null } | null = null;
  for (let i = bodyStart; i < plain.length; i++) {
    if (fenced[i]) continue;
    const text = plain[i]!.trim();
    if (OPEN_LIKE_RE.test(text)) {
      if (open) {
        problems.push(`line ${i + 1} opens a suppressed block inside the one opened at line ${open.start + 1}`);
        continue;
      }
      const header = parseHeader(text);
      if (!header) problems.push(`line ${i + 1} is not a well-formed suppression marker`);
      open = { start: i, header };
    } else if (CLOSE_LIKE_RE.test(text)) {
      if (!open) {
        problems.push(`line ${i + 1} closes a suppressed block that was never opened`);
      } else {
        if (text !== SUPPRESSED_CLOSE) problems.push(`line ${i + 1} is not a well-formed closing marker`);
        else if (i === open.start + 1) problems.push(`the suppressed block at line ${open.start + 1} is empty`);
        else if (open.header) blocks.push({ start: open.start, end: i, header: open.header });
        open = null;
      }
    }
  }
  if (open) problems.push(`the suppressed block opened at line ${open.start + 1} is never closed`);

  const inBlock = plain.map(() => false);
  for (const b of blocks) for (let i = b.start; i <= b.end; i++) inBlock[i] = true;
  return { lines, plain, bodyStart, unclosedFrontmatter, fenced, inBlock, blocks, problems };
}

/** The live lines after a block's closing marker, as many as it suppresses. */
function replacementOf(doc: Doc, block: Block): string {
  const want = block.end - block.start - 1;
  const out: string[] = [];
  for (let i = block.end + 1; i < doc.lines.length && out.length < want; i++) {
    if (!doc.inBlock[i]) out.push(doc.lines[i]!);
  }
  return out.join('\n');
}

/** Parse the suppressed blocks of a skill, with any problems in the markers. */
export function parseSuppressed(skillMd: string): { blocks: SuppressedBlock[]; problems: string[] } {
  const doc = parseDoc(skillMd);
  const blocks = doc.blocks.map((b) => ({
    ...b.header,
    original: doc.lines.slice(b.start + 1, b.end).join('\n'),
    replacement: replacementOf(doc, b),
    startLine: b.start + 1,
    endLine: b.end + 1,
  }));
  return { blocks, problems: [...doc.problems] };
}

/** The well-formed suppressed blocks of a skill, in document order. */
export function listSuppressedBlocks(skillMd: string): SuppressedBlock[] {
  return parseSuppressed(skillMd).blocks;
}

export interface SkillLayout {
  /** Index of the first body line, after a complete frontmatter block; 0 when there is none. */
  readonly bodyStart: number;
  /** Per line (split on '\n'), whether it is in a fenced code block, fence lines included. */
  readonly fenced: readonly boolean[];
}

/**
 * The frontmatter and fenced blocks of a skill as the check reads them.
 * The reviewers' rendering (graduated-skills.ts) uses this rather than
 * its own scan, so both treat the same lines as code.
 */
export function skillLayout(skillMd: string): SkillLayout {
  const doc = parseDoc(skillMd);
  return { bodyStart: doc.bodyStart, fenced: doc.fenced };
}

interface Change {
  readonly from: string;
  readonly to: string;
  /** A number replacing a number, rather than a name replacing a name. */
  readonly number: boolean;
  /** Index of the line of the piece the change is on. */
  readonly line: number;
  /** The code names in backticks on that line of the original and of the replacement. */
  readonly lineNames: readonly string[];
}

interface Tokens {
  readonly tokens: string[];
  /** Offset of each token in the text. */
  readonly starts: number[];
  readonly seps: string[];
  /** [start, end) of each inline code span's content. */
  readonly spans: [number, number][];
}

/**
 * The inline code spans of one line, as [start, end) of their content.
 * Backtick runs pair as in CommonMark (a run closes at the next run of
 * the same length), as names.ts reads them, but a run after an odd
 * number of backslashes is literal text, never a delimiter. `clear` is
 * false when an unescaped run pairs with none, or an escaped one falls
 * inside a span: a reader of the raw text could not tell which words
 * are code.
 */
function lineCodeSpans(line: string): { spans: [number, number][]; clear: boolean } {
  const runs: { start: number; end: number; escaped: boolean }[] = [];
  for (const m of line.matchAll(/`+/g)) {
    let slashes = 0;
    while (m.index - slashes > 0 && line[m.index - slashes - 1] === '\\') slashes++;
    runs.push({ start: m.index, end: m.index + m[0].length, escaped: slashes % 2 === 1 });
  }
  const delimiters = runs.filter((r) => !r.escaped);
  const spans: [number, number][] = [];
  let clear = true;
  for (let i = 0; i < delimiters.length; i++) {
    const open = delimiters[i]!;
    const close = delimiters.findIndex((r, k) => k > i && r.end - r.start === open.end - open.start);
    if (close < 0) {
      clear = false;
      continue;
    }
    spans.push([open.end, delimiters[close]!.start]);
    i = close;
  }
  if (runs.some((r) => r.escaped && spans.some(([s, e]) => r.start >= s && r.start < e))) clear = false;
  return { spans, clear };
}

function splitTokens(text: string): Tokens {
  const tokens: string[] = [];
  const starts: number[] = [];
  const seps: string[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    seps.push(text.slice(last, m.index));
    tokens.push(m[0]);
    starts.push(m.index);
    last = m.index + m[0].length;
  }
  seps.push(text.slice(last));
  // A span never crosses a line, as in names.ts.
  const spans: [number, number][] = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    for (const [s, e] of lineCodeSpans(line).spans) spans.push([lineStart + s, lineStart + e]);
    lineStart += line.length + 1;
  }
  return { tokens, starts, seps, spans };
}

/** Whether token `i` lies inside an inline code span. */
function inCodeSpan(t: Tokens, i: number): boolean {
  const start = t.starts[i]!;
  const end = start + t.tokens[i]!.length;
  return t.spans.some(([s, e]) => start >= s && end <= e);
}

interface Unwrapped {
  readonly pre: string;
  readonly core: string;
  readonly post: string;
}

/** A token in a code span without a `:<line>` suffix (`src/db.c:120`). */
function unwrapCode(token: string): Unwrapped {
  const tail = /:\d+(?:-\d+)?$/.exec(token)?.[0] ?? '';
  if (!tail || tail.length === token.length) return { pre: '', core: token, post: '' };
  return { pre: '', core: token.slice(0, -tail.length), post: tail };
}

/**
 * A token of prose without sentence punctuation and the markdown
 * emphasis around it: `**512**.` and `**512.**` give `512`.
 */
function unwrapProse(token: string): Unwrapped {
  let core = token;
  let pre = '';
  let post = '';
  const cut = (re: RegExp) => {
    const tail = re.exec(core)?.[0] ?? '';
    if (tail && tail.length < core.length) {
      post = tail + post;
      core = core.slice(0, -tail.length);
    }
  };
  cut(/[.:]+$/);
  const lead = /^(?:\*+|_+)/.exec(core)?.[0] ?? '';
  if (lead && core.length > 2 * lead.length && core.endsWith(lead)) {
    pre = lead;
    post = lead + post;
    core = core.slice(lead.length, -lead.length);
    cut(/[.:]+$/);
  }
  return { pre, core, post };
}

function isNumber(token: string): boolean {
  return token.length <= NUMBER_MAX_CHARS && NUMBER_RE.test(token);
}

function snippet(text: string): string {
  return JSON.stringify(text.length > 60 ? `${text.slice(0, 57)}...` : text);
}

/** The changed names of an edit, or why the replacement changes more than names. */
function diffTokens(original: string, replacement: string): { changes: Change[] } | { problem: string } {
  const a = splitTokens(original);
  const b = splitTokens(replacement);
  if (a.tokens.length !== b.tokens.length) {
    return { problem: `the replacement has ${b.tokens.length} words and the original ${a.tokens.length}; only code names and numbers may change, none added or removed` };
  }
  for (let i = 0; i < a.seps.length; i++) {
    if (a.seps[i] !== b.seps[i]) {
      return { problem: `the replacement changes the text between words (spacing, punctuation, markup or line breaks): ${snippet(a.seps[i]!)} became ${snippet(b.seps[i]!)}` };
    }
  }
  // The separators are the same in both, so a token is on the same line in both.
  const lineOf: number[] = [];
  for (let i = 0, line = 0; i < a.tokens.length; i++) {
    line += a.seps[i]!.split('\n').length - 1;
    lineOf.push(line);
  }
  const namesOn = new Map<number, Set<string>>();
  for (const t of [a, b]) {
    t.tokens.forEach((token, i) => {
      const core = unwrapCode(token).core;
      if (!inCodeSpan(t, i) || nameKind(core) === null) return;
      if (!namesOn.has(lineOf[i]!)) namesOn.set(lineOf[i]!, new Set());
      namesOn.get(lineOf[i]!)!.add(core);
    });
  }
  const changes: Change[] = [];
  for (let i = 0; i < a.tokens.length; i++) {
    if (a.tokens[i] === b.tokens[i]) continue;
    const code = inCodeSpan(a, i) && inCodeSpan(b, i);
    const x = code ? unwrapCode(a.tokens[i]!) : unwrapProse(a.tokens[i]!);
    const y = code ? unwrapCode(b.tokens[i]!) : unwrapProse(b.tokens[i]!);
    const numbers = isNumber(x.core) && isNumber(y.core);
    if (!code && !numbers) {
      const looseNumber = (t: string) => NUMBER_RE.test(t.replace(/^[*_]+|[*_.:]+$/g, ''));
      if (looseNumber(a.tokens[i]!) && looseNumber(b.tokens[i]!)) {
        return { problem: `"${b.tokens[i]}" changes the markup or punctuation around "${a.tokens[i]}"` };
      }
      return { problem: `"${b.tokens[i]}" replaces "${a.tokens[i]}" outside a code span; only names in backticks and numbers may change` };
    }
    if (x.pre !== y.pre || x.post !== y.post) {
      return { problem: `"${b.tokens[i]}" changes the markup or punctuation around "${a.tokens[i]}"` };
    }
    const kx = nameKind(x.core);
    const ky = nameKind(y.core);
    if (!numbers && !(kx && ky && nameSort(kx) === nameSort(ky))) {
      return { problem: `"${b.tokens[i]}" replaces "${a.tokens[i]}", but only a code name can replace a code name of the same sort (file, identifier or config), or a number a number` };
    }
    changes.push({ from: x.core, to: y.core, number: numbers, line: lineOf[i]!, lineNames: [...(namesOn.get(lineOf[i]!) ?? [])] });
  }
  if (changes.length === 0) return { problem: 'the replacement is the same as the original' };
  return { changes };
}

/** Whether `word` occurs in `text` with no identifier character joined to its identifier-character ends. */
function containsWord(text: string, word: string): boolean {
  if (!word) return false;
  const checkBefore = WORD_CHAR_RE.test(word[0]!);
  const checkAfter = WORD_CHAR_RE.test(word[word.length - 1]!);
  for (let i = text.indexOf(word); i >= 0; i = text.indexOf(word, i + 1)) {
    const before = i > 0 ? text[i - 1]! : '';
    const after = text[i + word.length] ?? '';
    if ((!checkBefore || !WORD_CHAR_RE.test(before)) && (!checkAfter || !WORD_CHAR_RE.test(after))) return true;
  }
  return false;
}

/** Whether `num` occurs in `text` as a whole number: not part of a word or of a longer number (`9.0` is not in `9.0.1`). */
function containsNumber(text: string, num: string): boolean {
  for (let i = text.indexOf(num); i >= 0; i = text.indexOf(num, i + 1)) {
    const before = text.slice(Math.max(0, i - 2), i);
    const after = text.slice(i + num.length, i + num.length + 2);
    if (WORD_CHAR_RE.test(before.slice(-1)) || /\d\.$/.test(before)) continue;
    if (WORD_CHAR_RE.test(after.slice(0, 1)) || /^\.\d/.test(after)) continue;
    return true;
  }
  return false;
}

/** Whether some word in `text` starts with `stem`. */
function containsWordStart(text: string, stem: string): boolean {
  for (let i = text.indexOf(stem); i >= 0; i = text.indexOf(stem, i + 1)) {
    if (i === 0 || !WORD_CHAR_RE.test(text[i - 1]!)) return true;
  }
  return false;
}

/** The components of a qualified name that differ from the one it replaces, or null when the shapes differ. */
function changedComponents(from: string, to: string): string[] | null {
  const a = from.split(/(::|\.|->)/);
  const b = to.split(/(::|\.|->)/);
  if (a.length !== b.length) return null;
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    if (i % 2 === 1 && a[i] !== b[i]) return null;
    if (i % 2 === 0 && a[i] !== b[i]) out.push(b[i]!);
  }
  return out;
}

/** Whether `line` names a code name: as a word, a prefix by a word starting with its stem, a qualified name by all its parts. */
function mentions(line: string, name: string): boolean {
  if (containsWord(line, name)) return true;
  switch (nameKind(name)) {
    case 'prefix': return containsWordStart(line, name.slice(0, -1));
    case 'qualified': return name.split(/::|\.|->/).every((p) => containsWord(line, p));
    default: return false;
  }
}

/**
 * Whether a cited line supports a change: the line contains the new
 * name (a path, directory or glob too, as text: the file a line comes
 * from is not evidence). A new prefix is supported by a word starting
 * with its stem, and a new qualified name by a line that has each
 * component that changed. A new number needs the number and a code
 * name of its line of the piece (or of the replacement line), so the
 * cited line is about the same thing.
 */
function supports(change: Change, line: string): boolean {
  const to = change.to;
  if (change.number) return containsNumber(line, to) && change.lineNames.some((name) => mentions(line, name));
  if (containsWord(line, to)) return true;
  switch (nameKind(to)) {
    case 'prefix': return containsWordStart(line, to.slice(0, -1));
    case 'qualified': {
      const parts = changedComponents(change.from, to);
      return parts !== null && parts.length > 0 && parts.every((p) => containsWord(line, p));
    }
    default: return false;
  }
}

function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

function assertContext(ctx: EditContext): void {
  if (!isReleaseLabel(ctx.release)) {
    throw new Error(`release ${JSON.stringify(ctx.release)} is neither a GA tag nor "<branch>@<12 hex>" (see releaseLabel)`);
  }
  if (!isValidDate(ctx.date)) throw new Error(`date ${JSON.stringify(ctx.date)} is not YYYY-MM-DD`);
  if (!REPO_RE.test(ctx.upstream.repo) || !SHA_RE.test(ctx.upstream.sha)) {
    throw new Error(`upstream ${ctx.upstream.repo}@${ctx.upstream.sha} is not "owner/name" and a full commit SHA`);
  }
}

/**
 * Why a marker reason is not one generatedReason can write: one or more
 * "`a` is now `b`" parts, a and b each a code name or a number, joined
 * with "; ", optionally ending in "; and N more", at most
 * MAX_REASON_CHARS. So text a person or a model wrote never reads as a
 * well-formed marker, and no reason can end the HTML comment early.
 */
function reasonProblem(reason: string): string | null {
  if (reason.length === 0 || reason.length > MAX_REASON_CHARS) return `the reason must be 1-${MAX_REASON_CHARS} characters`;
  if (/-->|--!>|<!--/.test(reason)) return 'the reason must not contain "<!--", "-->" or "--!>"';
  const parts = reason.split('; ');
  if (parts.length > 1 && REASON_MORE_RE.test(parts[parts.length - 1]!)) parts.pop();
  const token = (t: string) => nameKind(t) !== null || isNumber(t);
  for (const part of parts) {
    const m = REASON_PART_RE.exec(part);
    if (!m || m[1] === m[2] || !token(m[1]!) || !token(m[2]!)) {
      return `"${part.slice(0, 60)}" is not a generated reason part; a reason is "\`a\` is now \`b\`" parts joined with "; ", optionally ending in "; and N more"`;
    }
  }
  return null;
}

/**
 * The marker's reason, built only from the validated changes:
 * "`a` is now `b`; `c` is now `d`", with "; and N more" past
 * MAX_REASON_CHARS. Names have at most 120 characters and numbers at
 * most NUMBER_MAX_CHARS, so the first part always fits.
 */
function generatedReason(changes: readonly Change[]): string {
  const parts = [...new Set(changes.map((c) => `\`${c.from}\` is now \`${c.to}\``))];
  let out = parts[0] ?? '';
  let used = 1;
  for (const part of parts.slice(1)) {
    const next = `${out}; ${part}`;
    if (next.length > MAX_REASON_CHARS - 20) break;
    out = next;
    used++;
  }
  return used < parts.length ? `${out}; and ${parts.length - used} more` : out;
}

function suppressionHeader(release: string, date: string, reason: string, evidence: readonly Citation[]): string {
  return `<!-- suppressed: superseded in ${release}, ${date}; ${reason}; evidence: ${evidence.map(formatCitation).join(', ')} -->`;
}

interface Planned {
  readonly index: number;
  readonly start: number;
  readonly count: number;
  readonly replacementLines: readonly string[];
  readonly changes: readonly Change[];
  readonly reason: string;
  readonly evidence: readonly Citation[];
}

interface Plan {
  readonly doc: Doc;
  /** Problems, each with the edit it belongs to (-1 for the whole set). */
  readonly problems: { readonly edit: number; readonly message: string }[];
  readonly planned: Planned[];
  /** Edits whose changes and citations are well formed and in scope, so their evidence can be looked up. */
  readonly checkable: Map<number, { readonly changes: readonly Change[]; readonly evidence: readonly Citation[] }>;
}

function trimFinalNewline(text: string): string {
  return text.replace(/\r?\n$/, '');
}

/** Where the piece is: the index of its first line, or why it cannot be edited. */
function locate(doc: Doc, want: readonly string[]): number | string {
  const live: number[] = [];
  let inFrontmatter = 0;
  let suppressed = 0;
  let fencedHits = 0;
  for (let s = 0; s + want.length <= doc.plain.length; s++) {
    let match = true;
    for (let k = 0; k < want.length && match; k++) match = doc.plain[s + k] === want[k];
    if (!match) continue;
    const span = Array.from({ length: want.length }, (_, k) => s + k);
    if (s < doc.bodyStart) inFrontmatter++;
    else if (span.some((i) => doc.inBlock[i])) suppressed++;
    else if (span.some((i) => doc.fenced[i])) fencedHits++;
    else live.push(s);
  }
  if (live.length === 1) return live[0]!;
  if (live.length > 1) return `the original occurs ${live.length} times in the body; include neighbouring lines so it matches once`;
  if (inFrontmatter > 0) return 'the frontmatter is never edited';
  if (suppressed > 0) return 'that piece is already suppressed and is never edited again';
  if (fencedHits > 0) return 'pieces inside fenced code blocks are not edited';
  const joined = want.join('\n');
  if (joined && doc.plain.join('\n').includes(joined)) return 'the original must be whole lines; quote each line in full';
  return 'the original does not occur in the skill body';
}

function plan(skillMd: string, edits: readonly SuppressEdit[], ctx: EditContext): Plan {
  assertContext(ctx);
  const doc = parseDoc(skillMd);
  const problems: Plan['problems'] = [];
  const planned: Planned[] = [];
  const checkable: Plan['checkable'] = new Map();
  const whole = (message: string) => problems.push({ edit: -1, message });
  if (edits.length === 0) whole('no edits given');
  if (edits.length > MAX_EDITS) {
    whole(`at most ${MAX_EDITS} edits per check, got ${edits.length}`);
    return { doc, problems, planned, checkable };
  }
  // Where such a frontmatter ends is unknown, so no line is safely body.
  if (doc.unclosedFrontmatter) whole('the frontmatter has no closing "---", so the skill cannot be edited automatically');
  for (const p of doc.problems) whole(`the skill's suppression markers are malformed (${p}), so it cannot be edited automatically`);
  if (doc.unclosedFrontmatter || doc.problems.length > 0) return { doc, problems, planned, checkable };

  edits.forEach((edit, index) => {
    const before = problems.length;
    const fail = (message: string) => problems.push({ edit: index, message });
    const original = trimFinalNewline(String(edit.original ?? ''));
    const replacement = trimFinalNewline(String(edit.replacement ?? ''));
    const want = original.split('\n').map(stripCr);
    const replacementLines = replacement.split('\n').map(stripCr);

    const pieceFlagged = ctx.flagged.some((name) => containsWord(original, name));
    let start = -1;
    if (original.trim() === '') fail('the original is empty');
    else if (want.length > MAX_PIECE_LINES) fail(`the original has ${want.length} lines; at most ${MAX_PIECE_LINES}`);
    else if (original.length > MAX_PIECE_CHARS) fail(`the original has ${original.length} characters; at most ${MAX_PIECE_CHARS}`);
    else if (replacement.length > MAX_PIECE_CHARS) fail(`the replacement has ${replacement.length} characters; at most ${MAX_PIECE_CHARS}`);
    else {
      const at = locate(doc, want);
      if (typeof at === 'string') fail(at);
      else start = at;
    }
    if (start >= 0) {
      const end = start + want.length - 1;
      const overlap = planned.find((p) => start <= p.start + p.count - 1 && p.start <= end);
      if (overlap) fail(`it overlaps edit ${overlap.index + 1}`);
      if (!pieceFlagged) fail('the original contains none of the flagged names');
    }
    const unclear = want.findIndex((line) => !lineCodeSpans(line).clear);
    if (unclear >= 0) {
      fail(`line ${unclear + 1} of the original has a backtick that pairs with none, or an escaped one inside a code span, `
        + 'so which of its words are code is unclear; such a line is not edited');
    }
    if (replacementLines.some((l) => OPEN_LIKE_RE.test(l.trim()) || CLOSE_LIKE_RE.test(l.trim()))) {
      fail('the replacement must not contain suppression markers');
    }

    const diff = diffTokens(want.join('\n'), replacementLines.join('\n'));
    if ('problem' in diff) fail(diff.problem);
    const evidence = Array.isArray(edit.evidence) ? edit.evidence : [];
    if (evidence.length === 0) fail('give at least one cited upstream line as evidence');
    if (evidence.length > MAX_CITATIONS_PER_EDIT) fail(`at most ${MAX_CITATIONS_PER_EDIT} citations per edit`);
    const citationProblems = evidence.slice(0, MAX_CITATIONS_PER_EDIT).map((c) => citationProblem(c, ctx.upstream)).filter((p) => p !== null);
    citationProblems.forEach(fail);

    if (Object.hasOwn(Object(edit), 'reason')) {
      fail('an edit cannot give a reason; the marker\'s reason is generated from the changed names');
    }

    // Only once the piece holds a flagged name, so a wrong piece gets one message.
    let outOfScope = 0;
    if ('changes' in diff && pieceFlagged) {
      const flagged = new Set(ctx.flagged);
      const scope = (message: string) => {
        outOfScope++;
        fail(message);
      };
      for (const from of new Set(diff.changes.filter((c) => !c.number && !flagged.has(c.from)).map((c) => c.from))) {
        scope(`\`${from}\` is not a flagged name; only the names the check flagged (lost, new and absent, or touched) may change`);
      }
      for (const c of diff.changes.filter((ch) => ch.number)) {
        if (!ctx.flagged.some((name) => containsWord(want[c.line]!, name))) {
          scope(`the number ${c.from} is on line ${c.line + 1} of the original, which has no flagged name; a number may change only on a line that names one`);
        } else if (c.lineNames.length === 0) {
          scope(`the number ${c.from} is on line ${c.line + 1} of the original, which has no code name in backticks to cite with it`);
        }
      }
    }

    let reason = '';
    if ('changes' in diff) {
      if (outOfScope === 0 && citationProblems.length === 0 && evidence.length > 0 && evidence.length <= MAX_CITATIONS_PER_EDIT) {
        checkable.set(index, { changes: diff.changes, evidence });
      }
      reason = generatedReason(diff.changes);
      const bad = reasonProblem(reason);
      if (bad) fail(`the generated reason is malformed: ${bad}`);
    }
    if (problems.length > before || !('changes' in diff)) return;
    planned.push({ index, start, count: want.length, replacementLines, changes: diff.changes, reason, evidence });
  });
  // Rendered growth of the edits that passed so far, so the cap is reported with their other problems.
  const out = render(doc, planned, ctx);
  const growth = out.length - skillMd.length;
  if (growth > MAX_GROWTH_CHARS) {
    whole(`the edits grow the skill by ${growth} characters, markers, citations and kept originals included; at most ${MAX_GROWTH_CHARS}`);
  }
  if (problems.length === 0) {
    const maxChars = ctx.maxChars ?? DEFAULT_MAX_CHARS;
    if (out.length > maxChars) whole(`the edited skill would be ${out.length} characters; at most ${maxChars}`);
    const back = parseDoc(out);
    const sameFrontmatter = back.bodyStart === doc.bodyStart
      && back.lines.slice(0, back.bodyStart).join('\n') === doc.lines.slice(0, doc.bodyStart).join('\n');
    if (back.problems.length > 0 || back.blocks.length !== doc.blocks.length + planned.length || !sameFrontmatter) {
      whole('the edited skill does not parse back to the same frontmatter plus one suppressed block per edit');
    }
  }
  return { doc, problems, planned, checkable };
}

function render(doc: Doc, planned: readonly Planned[], ctx: EditContext): string {
  const lines = [...doc.lines];
  for (const p of [...planned].sort((a, b) => b.start - a.start)) {
    const piece = lines.slice(p.start, p.start + p.count);
    const eol = (line: string | undefined) => (line?.endsWith('\r') ? '\r' : '');
    const header = suppressionHeader(ctx.release, ctx.date, p.reason, p.evidence) + eol(piece[0]);
    const close = SUPPRESSED_CLOSE + eol(piece[piece.length - 1]);
    const replacement = p.replacementLines.map((line, k) => line + eol(piece[k]));
    lines.splice(p.start, p.count, header, ...piece, close, ...replacement);
  }
  return lines.join('\n');
}

function formatProblems(problems: Plan['problems']): string[] {
  return [...problems]
    .sort((a, b) => a.edit - b.edit)
    .map((p) => (p.edit < 0 ? p.message : `edit ${p.edit + 1}: ${p.message}`));
}

/**
 * The structural checks, without reading any upstream line: where each
 * piece is, what changed, and whether the citations are well formed.
 * Empty when the edits pass.
 */
export function checkEdits(skillMd: string, edits: readonly SuppressEdit[], ctx: EditContext): string[] {
  return formatProblems(plan(skillMd, edits, ctx).problems);
}

async function evidenceProblems(
  checkable: Plan['checkable'],
  resolveLine: LineResolver,
): Promise<{ edit: number; message: string }[]> {
  const problems: { edit: number; message: string }[] = [];
  const cache = new Map<string, Promise<string | null>>();
  const lineOf = (c: Citation) => {
    const key = formatCitation(c);
    if (!cache.has(key)) cache.set(key, resolveLine(c));
    return cache.get(key)!;
  };
  for (const [edit, { changes, evidence }] of checkable) {
    const lines = await Promise.all(evidence.map(lineOf));
    evidence.forEach((c, j) => {
      const line = lines[j];
      if (line === null || line === undefined) {
        problems.push({ edit, message: `evidence ${formatCitation(c)}: no such line at that commit` });
      } else if (!changes.some((ch) => supports(ch, line))) {
        problems.push({ edit, message: `evidence ${formatCitation(c)}: the line supports none of the changed names` });
      }
    });
    const unsupported = changes.filter((ch) => !lines.some((line) => typeof line === 'string' && supports(ch, line)));
    const messages = unsupported.map((ch) => (ch.number
      ? `no cited line contains \`${ch.to}\` together with a code name of line ${ch.line + 1} (${ch.lineNames.map((n) => `\`${n}\``).join(', ')})`
      : `no cited line contains \`${ch.to}\``));
    for (const message of new Set(messages)) problems.push({ edit, message });
  }
  return problems;
}

/**
 * Check every citation against upstream: each cited line must exist,
 * each changed name must appear on one of its edit's cited lines, and
 * each cited line must support one of them. Edits whose changes or
 * citations are malformed are left to checkEdits.
 */
export async function verifyEvidence(
  skillMd: string,
  edits: readonly SuppressEdit[],
  ctx: EditContext,
  resolveLine: LineResolver,
): Promise<string[]> {
  return formatProblems(await evidenceProblems(plan(skillMd, edits, ctx).checkable, resolveLine));
}

/**
 * Validate the edits, structure and evidence together, and render the
 * edited markdown when they all pass. All or nothing: one bad edit
 * refuses the set.
 */
export async function validateEdits(
  skillMd: string,
  edits: readonly SuppressEdit[],
  ctx: EditContext,
  resolveLine: LineResolver,
): Promise<EditOutcome> {
  const p = plan(skillMd, edits, ctx);
  const problems = formatProblems([...p.problems, ...(await evidenceProblems(p.checkable, resolveLine))]);
  if (problems.length > 0) return { problems, skillMd: null };
  return { problems, skillMd: render(p.doc, p.planned, ctx) };
}

/**
 * Render the edits in suppress-and-add form. Throws when checkEdits
 * finds a problem. It does not read upstream: call validateEdits (or
 * verifyEvidence) first.
 */
export function applyEdits(skillMd: string, edits: readonly SuppressEdit[], ctx: EditContext): string {
  const p = plan(skillMd, edits, ctx);
  if (p.problems.length > 0) throw new Error(`edits refused: ${formatProblems(p.problems).join('; ')}`);
  return render(p.doc, p.planned, ctx);
}
