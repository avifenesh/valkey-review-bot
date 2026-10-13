import type { CitedName } from './names.js';
import type { GitRunner } from './upstream.js';

/**
 * The deterministic part of a release check: which of a skill's cited
 * names exist at the checked commit, which were lost since the last
 * check, and which rare names the upstream diff since then touched.
 *
 * Runs only git plumbing (ls-tree, grep, diff) against the commit; no
 * repository code. Output options a clone's own config could change
 * (grep line numbers and columns, colour, relative diff paths) are fixed
 * on the command line, so this also works on a caller's clone. No
 * runtime relative imports, so scripts can load this file directly
 * under Node's type stripping.
 */

export interface CheckInput {
  /** extractNames() of the skill. */
  readonly names: readonly CitedName[];
  /** Names present at the last check (audit_names). Names the skill no longer cites are ignored. */
  readonly baseline?: readonly string[];
  /** Names an earlier audit judged accurate although absent (ignored_names). */
  readonly ignored?: readonly string[];
  /**
   * Commit of the last check (verified_sha), to diff against. One that
   * is not a full SHA or not in the repository makes the result
   * incomplete. Without it (no earlier check) the result is a presence
   * check only: `compared` is false and `touched` empty.
   */
  readonly baseSha?: string;
  /**
   * What prepareUpstreamCheckout said about baseSha, for a check of its
   * checkout: pass the checkout. With baseAvailable the diff is examined.
   * With baseGone (the remote no longer has the base, as after a
   * force-push) the result is a presence check only, which may confirm.
   * Otherwise (a timeout or a network error, which may pass) the result
   * is incomplete, and git is not asked for a diff whose blobs may be
   * missing. Leave it out for a clone of your own, where baseSha is
   * looked up as it is.
   */
  readonly checkout?: { readonly baseAvailable: boolean; readonly baseGone: boolean };
  /** The commit to check: HEAD by default, or any revision that names a commit (a full SHA, a tag). */
  readonly rev?: string;
}

export interface DiffExcerpt {
  /** The touched names this hunk shows. */
  readonly names: readonly string[];
  readonly path: string;
  /** The hunk, starting at its @@ line. */
  readonly hunk: string;
}

export interface CheckResult {
  /** The commit checked: `rev` resolved to its full SHA. */
  readonly commit: string;
  /** Cited names present at the commit, in skill order. */
  readonly present: readonly string[];
  /**
   * Occurrences at the commit: words for symbols and configs, the rarest
   * counted component for qualified names (all of them must be present),
   * words starting with the stem for prefixes, matching files for globs
   * and directories, 1 or 0 for paths. A path or directory whose first
   * component is not at the top of the tree is matched as a tail
   * (`client/mod.rs` for `glide-core/src/client/mod.rs`), so a bare file
   * name matches basenames, like a glob without '/'.
   */
  readonly counts: ReadonlyMap<string, number>;
  /** Baseline names now absent. */
  readonly lost: readonly string[];
  /** Cited names outside the baseline and ignored, and absent. */
  readonly newAbsent: readonly string[];
  /** Present rare names (1 to RARE_MAX occurrences) on a changed line or hunk header, and cited paths that changed. */
  readonly touched: readonly string[];
  readonly excerpts: readonly DiffExcerpt[];
  /** |baseline ∩ present| / |baseline|, 1 when the baseline is empty. */
  readonly keptFraction: number;
  /**
   * Nothing lost, new and absent, or touched, and the diff was read in
   * full (`incomplete` is empty). Only a clean result confirms the skill
   * without an audit, apart from the way past a partial diff that
   * confirmableCommit describes.
   */
  readonly clean: boolean;
  /** The base was available and diffed; without it `touched` is empty. */
  readonly compared: boolean;
  /** A base was given, and `checkout` said the remote no longer has it: a presence check only, which may confirm. */
  readonly baseGone: boolean;
  /** Files changed between the base and the commit. */
  readonly changedFiles: number;
  /** The diff of a candidate file passed DIFF_MAX_BYTES on its own and was read only that far, so `touched` may be incomplete. */
  readonly diffTruncated: boolean;
  /** DIFF_BUDGET_BYTES ran out before every candidate file was diffed; the rest were not. */
  readonly candidatesCapped: boolean;
  /**
   * Why `touched` may be incomplete, one line each: a diff budget that
   * ran out, a file whose diff was cut, a base that was given but is
   * missing or could not be fetched. Empty when the whole diff was
   * examined, or none was asked for. While `compared` is true, every
   * entry is about a diff that was read only in part (isPartial). See
   * confirmableCommit.
   */
  readonly incomplete: readonly string[];
}

/**
 * Partial checks of a skill (isPartial), counted once per maintenance
 * message since its verification last moved, after which the next
 * partial check confirms too: with 2, the third partial message. See
 * confirmableCommit and partialCountWrite.
 */
export const PARTIAL_CHECKS_BEFORE_CONFIRM = 2;

/** The diff since the base was examined, but only in part: the budget ran out, or a file's diff was cut. */
export function isPartial(result: CheckResult): boolean {
  return result.compared && result.incomplete.length > 0;
}

export interface ConfirmOptions {
  /**
   * The partial checks of the skill counted before this one:
   * partialChecksBefore(record, maintenance_id). Never the raw
   * partial_checks, which already holds this message's own count when
   * the message is run again. Default 0; NaN counts as 0.
   */
  readonly partialBefore?: number;
}

/**
 * The partial count on a skill's record, as the check run read it (step
 * 1, consistent read). Pass the record item itself.
 */
export interface PartialCountRecord {
  /** N: partial checks counted since the verification last moved. Missing, negative or not a finite number counts as 0; a fraction is rounded down. */
  readonly partial_checks?: unknown;
  /** S: the maintenance_id of the message counted last. */
  readonly partial_check_id?: unknown;
}

/**
 * What the write that records a check's outcome does to the partial
 * count: REMOVE both attributes, SET both to the values given, or write
 * neither. See partialCountWrite.
 */
export type PartialCountWrite =
  | { readonly kind: 'reset' }
  | { readonly kind: 'count'; readonly partial_checks: number; readonly partial_check_id: string }
  | { readonly kind: 'keep' };

function storedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function requireMessageId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('partial count: the maintenance_id of the message is required');
}

/**
 * opts.partialBefore for a check run of maintenance message
 * `maintenanceId`: the partial checks counted before this message. A
 * count this message made itself, in an earlier run of the same message
 * (a redelivery after a throw or a 15-minute cut, or a second run that
 * started alongside), is left out, so a message never confirms on its
 * own count.
 */
export function partialChecksBefore(record: PartialCountRecord, maintenanceId: string): number {
  requireMessageId(maintenanceId);
  const n = storedCount(record.partial_checks);
  return record.partial_check_id === maintenanceId ? Math.max(0, n - 1) : n;
}

/**
 * What the write that records a check's check_outcome does to the
 * record's partial count, for a run of maintenance message
 * `maintenanceId`. Pass the result of the check of the skill as it was
 * (never the 10(c) re-run on an edited body), the record as read, and
 * whether this write sets verified_sha.
 *
 * - reset, when the write sets verified_sha: REMOVE partial_checks and
 *   partial_check_id. That is every confirmation: clean (step 6),
 *   accurate, revised (10(c)), and one through the way past a partial
 *   diff, whatever the result.
 * - count, when the result isPartial, the write leaves verified_sha as
 *   it was, and the record does not already hold this message's count:
 *   SET partial_checks and partial_check_id to the values returned (the
 *   count + 1, and this maintenance_id). The check_outcome the write
 *   records does not matter. It counts for inconclusive (the usual case:
 *   incomplete and nothing flagged, so no model call and the claim is
 *   kept), and equally for suspect, obsolete, error, or an accurate or
 *   revise verdict that could not move the verification because
 *   confirmableCommit was null.
 * - keep, otherwise: write neither attribute. That is a result that is
 *   not partial while verified_sha stays: a first check (no base), a
 *   base that was malformed, missing, not fetched or gone, or a diff
 *   read in full whose audit did not confirm. It is also a partial
 *   result of a message already counted, by an earlier run of it.
 *
 * A run that ends before checkSkill (skipped, registry CREATING or
 * UPDATING, no upstream), or that throws before its outcome write,
 * changes neither attribute, whatever it records; a redelivered copy is
 * counted when it writes.
 *
 * Put the count in the same UpdateItem as check_outcome, under the
 * claim's condition (maintenance_id = :id AND #grn = :name), and for
 * count also under the count as read:
 * (attribute_not_exists(partial_check_id) OR partial_check_id <> :id)
 * AND partial_checks = :read, or attribute_not_exists(partial_checks)
 * when it was missing. When two runs of one message read the record
 * before either wrote, their count writes are the same and the second
 * loses the condition: finish it skipped, as for any
 * ConditionalCheckFailed.
 *
 * Each message needs its own maintenance_id for the count to be exact.
 * A reused one is counted once, which can only delay the way past a
 * partial diff, never hasten it.
 */
export function partialCountWrite(
  result: CheckResult,
  record: PartialCountRecord,
  maintenanceId: string,
  opts: { readonly movesVerification: boolean },
): PartialCountWrite {
  requireMessageId(maintenanceId);
  if (opts.movesVerification) return { kind: 'reset' };
  if (!isPartial(result) || record.partial_check_id === maintenanceId) return { kind: 'keep' };
  return { kind: 'count', partial_checks: storedCount(record.partial_checks) + 1, partial_check_id: maintenanceId };
}

/**
 * The commit a caller may record as verified (verified_sha) after acting
 * on a check: `result.commit`, or null while the result is incomplete.
 * Ask it of the check of the skill as it was, never of a re-run on an
 * edited body, which has no base.
 *
 * On null the verification never moves, whatever an audit concludes,
 * because the hunks nobody examined would otherwise never be checked:
 * the next check diffs from the same base again. A check of a fresh
 * checkout therefore passes baseSha and `checkout` whenever there is a
 * verified_sha: a base that could not be fetched is then incomplete,
 * and only one the remote no longer has (baseGone) gives a presence
 * check that confirms.
 *
 * The one way past an incomplete result, so that a skill whose diff
 * never fits the budget still moves on: the result isPartial, and
 * opts.partialBefore is at least PARTIAL_CHECKS_BEFORE_CONFIRM. A
 * result that is incomplete because its base was malformed, missing or
 * could not be fetched never confirms. A commit returned while
 * `incomplete` is not empty means this way was taken, and the caller
 * records that it was. The caller keeps the count with
 * partialChecksBefore and partialCountWrite, so that a message run more
 * than once is counted once.
 */
export function confirmableCommit(result: CheckResult, opts: ConfirmOptions = {}): string | null {
  if (result.incomplete.length === 0) return result.commit;
  if (isPartial(result) && (opts.partialBefore ?? 0) >= PARTIAL_CHECKS_BEFORE_CONFIRM) return result.commit;
  return null;
}

/**
 * git grep -e patterns per call. git grep -w -F slows down with the
 * product of patterns and raw substring hits: one 100-pattern call took
 * 53 s on valkey unstable, ten 10-pattern calls about 4 s.
 */
export const GREP_PATTERNS_PER_CALL = 10;
/** git grep calls run at once. */
const GREP_CONCURRENCY = 4;
/** Qualified-name components shorter than this (`c` in `c->flags`) are local names; they are not counted. */
const COMPONENT_MIN_CHARS = 3;
/** A name with at most this many occurrences at the commit is rare enough to report as touched. */
export const RARE_MAX = 40;
/** Candidate files (changed files that hold a rare cited name, and cited paths that changed) per git diff call. */
export const DIFF_FILES_PER_CALL = 200;
/** Output read per git diff call. The files of a call past it that were not read in full are diffed again; one file past it on its own is read that far. */
export const DIFF_MAX_BYTES = 4 * 1024 * 1024;
/** Diff output read per check, over all calls, split ones included. Once it is spent the files left are not diffed. */
export const DIFF_BUDGET_BYTES = 64 * 1024 * 1024;
export const EXCERPT_HUNKS_PER_NAME = 3;
export const EXCERPTS_MAX_CHARS = 24_000;
const HUNK_MAX_CHARS = 4_000;
const GREP_MAX_BYTES = 64 * 1024 * 1024;

/** `git grep` with the output settings a repository's config can change fixed. */
const GREP = ['-c', 'grep.lineNumber=false', '-c', 'grep.column=false', '-c', 'grep.fullName=false', '-c', 'color.grep=never', 'grep', '--no-color'];
/** `git diff` likewise: unquoted paths in headers, paths from the top, no merged hunks, no colour. */
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-relative', '--no-color', '--inter-hunk-context=0'];
const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const WORD_CHARS = 'A-Za-z0-9_';
const WORD_CHAR_RE = /[A-Za-z0-9_]/;

/** The git subcommand in an argv: the first argument that is not an option or the value of -c or -C. */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a === '-C') i++;
    else if (!a.startsWith('-')) return a;
  }
  return args[0] ?? '';
}

async function run(git: GitRunner, args: readonly string[], okCodes: readonly number[] = [0]): Promise<string> {
  const r = await git(args, { maxBytes: GREP_MAX_BYTES });
  if (r.truncated) throw new Error(`git ${subcommand(args)} output passed ${GREP_MAX_BYTES} bytes`);
  if (!okCodes.includes(r.code)) throw new Error(`git ${subcommand(args)} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  return r.stdout;
}

function nulList(out: string): string[] {
  return out.split('\0').filter((s) => s.length > 0);
}

/** Every file path at `rev`. */
async function treeFiles(git: GitRunner, rev: string): Promise<string[]> {
  return nulList(await run(git, ['ls-tree', '-r', '--full-tree', '--name-only', '-z', rev]));
}

/** The full SHA of the commit `rev` names; throws when it names none. */
async function resolveCommit(git: GitRunner, rev: string): Promise<string> {
  // No option-like or multi-word revisions: they would reach git as flags or extra arguments.
  if (rev.startsWith('-') || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(rev)) throw new Error(`invalid revision ${JSON.stringify(rev)}`);
  const r = await git(['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  const sha = r.stdout.trim();
  if (r.code !== 0 || !SHA_RE.test(sha)) throw new Error(`${JSON.stringify(rev)} names no commit in this repository`);
  return sha;
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1);
}

/** Each path and every tail of it that starts after a '/'. */
function withTails(paths: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) {
    out.add(p);
    for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) out.add(p.slice(i + 1));
  }
  return out;
}

/** Every directory of the given files, without a trailing '/'. */
function directoriesOf(files: readonly string[]): Set<string> {
  const dirs = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  }
  return dirs;
}

/** A glob as a regular expression: `*` and `?` stay within one path component, `**` crosses them. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Paths matching a glob; one without '/' matches basenames. */
function globMatches(glob: string, paths: readonly string[]): number {
  const re = globToRegExp(glob);
  const onBasename = !glob.includes('/');
  return paths.filter((p) => re.test(onBasename ? basename(p) : p)).length;
}

/**
 * Split words into git grep calls of at most `size` patterns, so no two
 * patterns in a call share a component (the parts between non-word
 * characters). Two whole-word matches can overlap only then, and
 * `grep -o` prints one of two overlapping matches, which would undercount
 * the other.
 */
function conflictFreeGroups(words: readonly string[], size: number): string[][] {
  const groups: { words: string[]; parts: Set<string> }[] = [];
  for (const w of [...words].sort((a, b) => b.length - a.length)) {
    const parts = w.split(new RegExp(`[^${WORD_CHARS}]+`)).filter(Boolean);
    let group = groups.find((g) => g.words.length < size && parts.every((p) => !g.parts.has(p)));
    if (!group) {
      group = { words: [], parts: new Set() };
      groups.push(group);
    }
    group.words.push(w);
    for (const p of parts) group.parts.add(p);
  }
  return groups.map((g) => g.words);
}

/** Run `task` on each item, at most `limit` at a time, results in item order. */
async function inBatches<T, R>(items: readonly T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) out.push(...(await Promise.all(items.slice(i, i + limit).map(task))));
  return out;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Whole-word occurrences of each word at `rev` (git grep -o -w -F, counted here). */
async function countWords(git: GitRunner, rev: string, words: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map(words.map((w) => [w, 0]));
  const outputs = await inBatches(conflictFreeGroups(words, GREP_PATTERNS_PER_CALL), GREP_CONCURRENCY, (group) =>
    run(git, [...GREP, '-o', '-h', '-I', '-w', '-F', ...group.flatMap((w) => ['-e', w]), rev, '--'], [0, 1]));
  for (const out of outputs) {
    for (const line of out.split('\n')) {
      const n = counts.get(line);
      if (n !== undefined) counts.set(line, n + 1);
    }
  }
  return counts;
}

/** How many words in `line` start with `stem`. */
function wordStarts(line: string, stem: string): number {
  let n = 0;
  for (let i = line.indexOf(stem); i >= 0; i = line.indexOf(stem, i + stem.length)) {
    if (i === 0 || !WORD_CHAR_RE.test(line[i - 1]!)) n++;
  }
  return n;
}

/**
 * Words at `rev` that start with each stem: lines holding the stem
 * (git grep -F; a regular expression for "word starting with" is very
 * slow in some regex libraries), counted here.
 */
async function countPrefixes(git: GitRunner, rev: string, stems: readonly string[]): Promise<Map<string, number>> {
  const counts = new Map(stems.map((s) => [s, 0]));
  const groups = chunks(stems, GREP_PATTERNS_PER_CALL);
  const outputs = await inBatches(groups, GREP_CONCURRENCY, (group) =>
    run(git, [...GREP, '-h', '-I', '-F', ...group.flatMap((s) => ['-e', s]), rev, '--'], [0, 1]));
  outputs.forEach((out, i) => {
    for (const line of out.split('\n')) {
      for (const s of groups[i]!) counts.set(s, counts.get(s)! + wordStarts(line, s));
    }
  });
  return counts;
}

/** Files at `rev` that contain one of the words as a word, or one of the stems anywhere. */
async function filesContaining(git: GitRunner, rev: string, words: readonly string[], stems: readonly string[]): Promise<Set<string>> {
  const calls = [
    ...chunks(words, GREP_PATTERNS_PER_CALL).map((group) => ['-w', '-F', ...group.flatMap((w) => ['-e', w])]),
    ...chunks(stems, GREP_PATTERNS_PER_CALL).map((group) => ['-F', ...group.flatMap((s) => ['-e', s])]),
  ];
  const outputs = await inBatches(calls, GREP_CONCURRENCY, (patterns) =>
    run(git, [...GREP, '-l', '-z', '-I', ...patterns, rev, '--'], [0, 1]));
  const files = new Set<string>();
  for (const out of outputs) {
    for (const entry of nulList(out)) files.add(entry.startsWith(`${rev}:`) ? entry.slice(rev.length + 1) : entry);
  }
  return files;
}

interface Hunk {
  readonly path: string;
  /** The @@ line and the changed lines. */
  readonly text: string;
  /** The hunk header's function context and the changed lines without their +/- marks. */
  readonly searchable: string;
}

/** The file path of a `diff --git a/P b/P` line (no renames, so both sides are equal). */
function diffPath(line: string): string {
  const rest = line.slice('diff --git '.length);
  const n = (rest.length - 5) / 2;
  if (Number.isInteger(n) && n > 0 && rest.startsWith('a/') && rest.slice(n + 2, n + 5) === ' b/') return rest.slice(2, n + 2);
  return rest;
}

/** The file path of each patch in `git diff` output, in order. */
function diffPaths(diff: string): string[] {
  return diff.split('\n').filter((line) => line.startsWith('diff --git ')).map(diffPath);
}

/** Hunks of `git diff -U0` output. */
function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let path = '';
  let current: { path: string; lines: string[]; searchable: string[] } | null = null;
  const flush = () => {
    if (current) hunks.push({ path: current.path, text: current.lines.join('\n'), searchable: current.searchable.join('\n') });
    current = null;
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      path = diffPath(line);
    } else if (line.startsWith('@@')) {
      flush();
      const context = /^@@ [^@]* @@ ?(.*)$/.exec(line)?.[1] ?? '';
      current = { path, lines: [line], searchable: [context] };
    } else if (current && (line.startsWith('+') || line.startsWith('-'))) {
      current.lines.push(line);
      current.searchable.push(line.slice(1));
    }
  }
  flush();
  return hunks;
}

/** The components of a qualified name that are counted: all but short local names, unless every one is short. */
function countedParts(token: string): string[] {
  const parts = token.split(/::|\.|->/);
  const long = parts.filter((p) => p.length >= COMPONENT_MIN_CHARS);
  return long.length > 0 ? long : parts;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
}

interface Probe {
  readonly name: string;
  /** A word to find as a whole word, or a stem a word must start with. */
  readonly word: string;
  readonly stem: boolean;
}

/** The probes a hunk hits, by name. */
function hitsIn(hunk: Hunk, wordRe: RegExp | null, stemRe: RegExp | null, byWord: Map<string, Probe[]>, byStem: Map<string, Probe[]>): Set<string> {
  const names = new Set<string>();
  if (wordRe) {
    for (const m of hunk.searchable.matchAll(wordRe)) for (const p of byWord.get(m[0]) ?? []) names.add(p.name);
  }
  if (stemRe) {
    for (const m of hunk.searchable.matchAll(stemRe)) {
      for (const [stem, probes] of byStem) if (m[0].startsWith(stem)) for (const p of probes) names.add(p.name);
    }
  }
  return names;
}

/** A hunk kept for the excerpts. */
interface Shown {
  readonly path: string;
  /** The hunk's text, capped at HUNK_MAX_CHARS. */
  readonly text: string;
}

function capHunk(text: string): string {
  return text.length > HUNK_MAX_CHARS ? `${text.slice(0, HUNK_MAX_CHARS)}\n[hunk truncated]` : text;
}

/**
 * Check a skill's names against a commit (`rev`, default HEAD) and,
 * when the base commit is present, against the diff since it.
 */
export async function checkSkill(git: GitRunner, input: CheckInput): Promise<CheckResult> {
  const commit = await resolveCommit(git, input.rev ?? 'HEAD');
  const names: CitedName[] = [];
  const seenNames = new Set<string>();
  for (const n of input.names) {
    if (!seenNames.has(n.token)) {
      seenNames.add(n.token);
      names.push(n);
    }
  }
  const files = await treeFiles(git, commit);
  const dirs = directoriesOf(files);
  const dirList = [...dirs];
  const fileTails = withTails(files);
  const dirTails = withTails(dirList);
  const fileSet = new Set(files);
  const topLevel = new Set(files.map((f) => f.split('/')[0]!));
  // `src/dict.c` in a tree with a top-level src/ means that file, not deps/x/src/dict.c.
  const rooted = (token: string) => topLevel.has(token.split('/')[0]!) && token.includes('/');

  const words = new Set<string>();
  const stems = new Set<string>();
  for (const n of names) {
    if (n.kind === 'symbol' || n.kind === 'config') words.add(n.token);
    else if (n.kind === 'qualified') for (const c of countedParts(n.token)) words.add(c);
    else if (n.kind === 'prefix') stems.add(n.token.slice(0, -1));
  }
  const wordCounts = await countWords(git, commit, [...words]);
  const stemCounts = await countPrefixes(git, commit, [...stems]);

  const counts = new Map<string, number>();
  /** For qualified names, the component the counts came from. */
  const rarest = new Map<string, string>();
  for (const n of names) {
    let count = 0;
    if (n.kind === 'path') {
      const found = rooted(n.token) ? fileSet.has(n.token) || dirs.has(n.token) : fileTails.has(n.token) || dirTails.has(n.token);
      count = found ? 1 : 0;
    } else if (n.kind === 'dir') {
      const dir = n.token.slice(0, -1);
      const under = (f: string) => f.startsWith(n.token) || (!rooted(n.token) && f.includes(`/${n.token}`));
      count = (rooted(n.token) ? dirs.has(dir) : dirTails.has(dir)) ? files.filter(under).length : 0;
    } else if (n.kind === 'glob') count = globMatches(n.token, files) + globMatches(n.token, dirList);
    else if (n.kind === 'symbol' || n.kind === 'config') count = wordCounts.get(n.token) ?? 0;
    else if (n.kind === 'prefix') count = stemCounts.get(n.token.slice(0, -1)) ?? 0;
    else {
      const parts = countedParts(n.token);
      const least = parts.reduce((a, b) => ((wordCounts.get(b) ?? 0) < (wordCounts.get(a) ?? 0) ? b : a));
      rarest.set(n.token, least);
      count = wordCounts.get(least) ?? 0;
    }
    counts.set(n.token, count);
  }

  const present = names.filter((n) => counts.get(n.token)! > 0).map((n) => n.token);
  const presentSet = new Set(present);
  const baseline = [...new Set(input.baseline ?? [])].filter((t) => seenNames.has(t));
  const baselineSet = new Set(baseline);
  const ignored = new Set(input.ignored ?? []);
  const lost = baseline.filter((t) => !presentSet.has(t));
  const newAbsent = names.map((n) => n.token).filter((t) => !baselineSet.has(t) && !ignored.has(t) && !presentSet.has(t));
  const keptFraction = baseline.length === 0 ? 1 : (baseline.length - lost.length) / baseline.length;

  let compared = false;
  let baseGone = false;
  let changedFiles = 0;
  let diffTruncated = false;
  let candidatesCapped = false;
  const incomplete: string[] = [];
  const touched: string[] = [];
  const excerpts: DiffExcerpt[] = [];
  const base = input.baseSha;
  const checkout = input.checkout;
  if (base !== undefined && !SHA_RE.test(base)) {
    incomplete.push(`the base ${JSON.stringify(base)} is not a full commit SHA, so no diff was examined`);
  } else if (base !== undefined && checkout && !checkout.baseAvailable && checkout.baseGone) {
    baseGone = true;
  } else if (base !== undefined && checkout && !checkout.baseAvailable) {
    incomplete.push(`the base commit ${base} could not be fetched, so the diff since it was not examined`);
  } else if (base !== undefined && (await git(['cat-file', '-e', `${base}^{commit}`])).code !== 0) {
    incomplete.push(`the base commit ${base} is not in the repository, so the diff since it was not examined`);
  } else if (base !== undefined) {
    compared = true;
    const changed = nulList(await run(git, [...DIFF, '--name-only', '--no-renames', '-z', base, commit]));
    const changedSet = new Set(changed);
    changedFiles = changed.length;

    const probes: Probe[] = [];
    const touchedPaths: string[] = [];
    for (const n of names) {
      if (!presentSet.has(n.token) || ignored.has(n.token)) continue;
      const count = counts.get(n.token)!;
      // Only a full path: a bare file name matches loosely, and files such as server.c change in every release.
      if (n.kind === 'path' && n.token.includes('/') && changedSet.has(n.token)) touchedPaths.push(n.token);
      if (count > RARE_MAX) continue;
      if (n.kind === 'symbol' || n.kind === 'config') probes.push({ name: n.token, word: n.token, stem: false });
      else if (n.kind === 'qualified') probes.push({ name: n.token, word: rarest.get(n.token)!, stem: false });
      else if (n.kind === 'prefix') probes.push({ name: n.token, word: n.token.slice(0, -1), stem: true });
    }

    const byWord = new Map<string, Probe[]>();
    const byStem = new Map<string, Probe[]>();
    for (const p of probes) {
      const map = p.stem ? byStem : byWord;
      map.set(p.word, [...(map.get(p.word) ?? []), p]);
    }
    const alternation = (keys: Iterable<string>) => [...keys].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|');
    const wordRe = byWord.size > 0 ? new RegExp(`(?<![${WORD_CHARS}])(?:${alternation(byWord.keys())})(?![${WORD_CHARS}])`, 'g') : null;
    const stemRe = byStem.size > 0 ? new RegExp(`(?<![${WORD_CHARS}])(?:${alternation(byStem.keys())})[${WORD_CHARS}]*`, 'g') : null;

    const touchedSet = new Set(touchedPaths);
    // Per name that a hunk hit, its first EXCERPT_HUNKS_PER_NAME hunks, capped. A hunk that hit several names is one object.
    const shownOf = new Map<string, Shown[]>();
    const scan = (hunks: readonly Hunk[]) => {
      for (const h of hunks) {
        const hit = hitsIn(h, wordRe, stemRe, byWord, byStem);
        if (touchedSet.has(h.path)) hit.add(h.path);
        let shown: Shown | undefined;
        for (const name of hit) {
          const list = shownOf.get(name) ?? [];
          shownOf.set(name, list);
          if (list.length >= EXCERPT_HUNKS_PER_NAME) continue;
          shown ??= { path: h.path, text: capHunk(h.text) };
          list.push(shown);
        }
      }
    };

    if (changed.length > 0 && (probes.length > 0 || touchedPaths.length > 0)) {
      const probeWords = [...new Set(probes.filter((p) => !p.stem).map((p) => p.word))];
      const probeStems = [...new Set(probes.filter((p) => p.stem).map((p) => p.word))];
      const withNames = probes.length > 0 ? await filesContaining(git, commit, probeWords, probeStems) : new Set<string>();
      // In the order git lists them, which is the order the hunks come in.
      const candidates = changed.filter((f) => touchedSet.has(f) || withNames.has(f));
      const pending = chunks(candidates, DIFF_FILES_PER_CALL);
      // Never an empty batch: `git diff -- ` with no path diffs the whole tree.
      const requeue = (...batches: string[][]) => pending.unshift(...batches.filter((b) => b.length > 0));
      let spent = 0;
      let cut = 0;
      let skipped = 0;
      while (pending.length > 0) {
        const batch = pending.shift()!;
        if (spent >= DIFF_BUDGET_BYTES) {
          skipped += batch.length;
          continue;
        }
        const r = await git([
          '--literal-pathspecs', ...DIFF, '-U0', '--no-renames', '--no-ext-diff', '--no-textconv',
          '--src-prefix=a/', '--dst-prefix=b/', base, commit, '--', ...batch,
        ], { maxBytes: DIFF_MAX_BYTES });
        if (r.code !== 0 && !r.truncated) throw new Error(`git diff exited ${r.code}: ${r.stderr.trim().slice(0, 2000)}`);
        spent += Buffer.byteLength(r.stdout);
        if (!r.truncated) {
          scan(parseHunks(r.stdout));
          continue;
        }
        // Cut short, maybe inside a line, which is left out. The files whose
        // patch ended before the last one began were read in full.
        const out = r.stdout.slice(0, r.stdout.lastIndexOf('\n') + 1);
        const hunks = parseHunks(out);
        const inBatch = new Set(batch);
        const paths = diffPaths(out);
        const last = paths[paths.length - 1];
        const full = new Set(paths.filter((f) => f !== last && inBatch.has(f)));
        if (full.size > 0) {
          scan(hunks.filter((h) => full.has(h.path)));
          requeue(batch.filter((f) => !full.has(f)));
        } else if (batch.length === 1) {
          // The file's diff alone passed the cap: it is read that far.
          cut++;
          scan(hunks);
        } else if (last !== undefined && inBatch.has(last)) {
          // Likewise the first file's, so the call needs no repeat for it.
          cut++;
          scan(hunks.filter((h) => h.path === last));
          requeue(batch.filter((f) => f !== last));
        } else {
          // Paths git quoted, so they cannot be matched: diff each half on its own.
          const half = Math.ceil(batch.length / 2);
          requeue(batch.slice(0, half), batch.slice(half));
        }
      }
      if (cut > 0) {
        diffTruncated = true;
        incomplete.push(`${cut} of the ${candidates.length} changed files that hold a cited name had a diff of more than ${DIFF_MAX_BYTES} bytes, which was read only that far`);
      }
      if (skipped > 0) {
        candidatesCapped = true;
        incomplete.push(`the diff budget of ${DIFF_BUDGET_BYTES} bytes ran out, so ${skipped} of the ${candidates.length} changed files that hold a cited name were not diffed`);
      }
    }
    for (const n of names) if (shownOf.has(n.token) || touchedSet.has(n.token)) touched.push(n.token);

    // Up to EXCERPT_HUNKS_PER_NAME hunks per touched name, each hunk once, within EXCERPTS_MAX_CHARS.
    const chosen = new Map<Shown, string[]>();
    let chars = 0;
    for (const name of touched) {
      for (const shown of shownOf.get(name) ?? []) {
        const listed = chosen.get(shown);
        if (listed) {
          listed.push(name);
          continue;
        }
        if (chars + shown.text.length > EXCERPTS_MAX_CHARS) continue;
        chars += shown.text.length;
        chosen.set(shown, [name]);
      }
    }
    for (const [shown, listed] of chosen) excerpts.push({ names: listed, path: shown.path, hunk: shown.text });
  }

  return {
    commit,
    present,
    counts,
    lost,
    newAbsent,
    touched,
    excerpts,
    keptFraction,
    clean: lost.length === 0 && newAbsent.length === 0 && touched.length === 0 && incomplete.length === 0,
    compared,
    baseGone,
    changedFiles,
    diffTruncated,
    candidatesCapped,
    incomplete,
  };
}

/**
 * How many files at `rev` (default HEAD) each glob matches (a glob
 * without '/' matches basenames). For the obsolete rule: a skill whose
 * area globs all match nothing has lost its subject.
 */
export async function areaFileCounts(git: GitRunner, globs: readonly string[], rev = 'HEAD'): Promise<number[]> {
  const files = await treeFiles(git, await resolveCommit(git, rev));
  return globs.map((g) => globMatches(g, files));
}
