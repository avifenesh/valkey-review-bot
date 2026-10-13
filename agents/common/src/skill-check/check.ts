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
   * Commit of the last check. Touched names need it in the repository;
   * pass it only when prepareUpstreamCheckout reported baseAvailable, as
   * a partial clone would otherwise try to fetch it.
   */
  readonly baseSha?: string;
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
   * full (`incomplete` is empty). A caller may advance the verified
   * commit only on a clean result.
   */
  readonly clean: boolean;
  /** The base was available and diffed; without it `touched` is empty. */
  readonly compared: boolean;
  /** Files changed between the base and the commit. */
  readonly changedFiles: number;
  /** The diff of the candidate files passed DIFF_MAX_BYTES, so `touched` may be incomplete. */
  readonly diffTruncated: boolean;
  /** More than DIFF_MAX_CANDIDATES changed files held a rare cited name; the rest were not diffed. */
  readonly candidatesCapped: boolean;
  /** Why `touched` may be incomplete, one line each; empty when the whole diff was examined. */
  readonly incomplete: readonly string[];
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
export const DIFF_MAX_CANDIDATES = 200;
export const DIFF_MAX_BYTES = 4 * 1024 * 1024;
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
  let changedFiles = 0;
  let diffTruncated = false;
  let candidatesCapped = false;
  const incomplete: string[] = [];
  const touched: string[] = [];
  const excerpts: DiffExcerpt[] = [];
  const base = input.baseSha;
  if (base !== undefined && SHA_RE.test(base) && (await git(['cat-file', '-e', `${base}^{commit}`])).code === 0) {
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

    let hunks: Hunk[] = [];
    if (changed.length > 0 && (probes.length > 0 || touchedPaths.length > 0)) {
      const probeWords = [...new Set(probes.filter((p) => !p.stem).map((p) => p.word))];
      const probeStems = [...new Set(probes.filter((p) => p.stem).map((p) => p.word))];
      const withNames = probes.length > 0 ? await filesContaining(git, commit, probeWords, probeStems) : new Set<string>();
      const all = [...new Set([...touchedPaths, ...changed.filter((f) => withNames.has(f))])];
      const candidates = all.slice(0, DIFF_MAX_CANDIDATES);
      if (all.length > candidates.length) {
        candidatesCapped = true;
        incomplete.push(`only ${candidates.length} of the ${all.length} changed files that hold a cited name were diffed`);
      }
      if (candidates.length > 0) {
        const r = await git([
          '--literal-pathspecs', ...DIFF, '-U0', '--no-renames', '--no-ext-diff', '--no-textconv',
          '--src-prefix=a/', '--dst-prefix=b/', base, commit, '--', ...candidates,
        ], { maxBytes: DIFF_MAX_BYTES });
        if (r.code !== 0 && !r.truncated) throw new Error(`git diff exited ${r.code}: ${r.stderr.trim().slice(0, 2000)}`);
        diffTruncated = r.truncated;
        if (r.truncated) incomplete.push(`the diff of the candidate files passed ${DIFF_MAX_BYTES} bytes and was read only that far`);
        hunks = parseHunks(r.stdout);
      }
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

    const hunksOf = new Map<string, Hunk[]>();
    for (const h of hunks) {
      const hit = hitsIn(h, wordRe, stemRe, byWord, byStem);
      for (const t of touchedPaths) if (h.path === t) hit.add(t);
      for (const name of hit) hunksOf.set(name, [...(hunksOf.get(name) ?? []), h]);
    }
    for (const n of names) if (hunksOf.has(n.token) || touchedPaths.includes(n.token)) touched.push(n.token);

    // Up to EXCERPT_HUNKS_PER_NAME hunks per touched name, each hunk once, within EXCERPTS_MAX_CHARS.
    const chosen = new Map<Hunk, { names: string[]; text: string }>();
    let chars = 0;
    for (const name of touched) {
      for (const h of (hunksOf.get(name) ?? []).slice(0, EXCERPT_HUNKS_PER_NAME)) {
        const existing = chosen.get(h);
        if (existing) {
          existing.names.push(name);
          continue;
        }
        const text = capHunk(h.text);
        if (chars + text.length > EXCERPTS_MAX_CHARS) continue;
        chars += text.length;
        chosen.set(h, { names: [name], text });
      }
    }
    for (const [h, { names: hunkNames, text }] of chosen) excerpts.push({ names: hunkNames, path: h.path, hunk: text });
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
