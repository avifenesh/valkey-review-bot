import { createHash } from 'node:crypto';
import {
  applyEdits,
  checkEdits,
  isReleaseLabel,
  parseCitation,
  parseSuppressed,
  type EditContext,
  type SuppressEdit,
  type SuppressedBlock,
} from '../../common/src/skill-check/edits.js';

/**
 * Repo-skill pull requests (amendment A2).
 *
 * The release check never edits a reviewer's repo skill
 * (agents/<reviewer>/config/skill.md) in place. When it has validated
 * suppress-and-add edits for one, this module proposes them as a pull
 * request against the bot's own repository, through the GitHub REST API
 * and a token from the skills-repo broker. Deterministic code only: the
 * model never sees the token, and the title, commit message and body are
 * built here from the proposal, whose summary and evidence the caller
 * generates from the validated edits.
 *
 * What it does, per (reviewer, release):
 * - refuses any path but agents/<reviewerId>/config/skill.md, and any
 *   new content that is not the base content plus suppress-and-add
 *   edits for that release that keep the registry skills' edit contract
 *   (skill-check/edits.ts), re-derived from the two texts;
 * - returns base-moved when the base branch moved past baseSha and the
 *   file changed since; when only other files changed, the commit is
 *   built on the new tip;
 * - points branch skill-check/<reviewerId>/<release> at one commit, on
 *   the base branch tip, holding newContent. A branch that already holds
 *   it is left alone. One that holds something else is rebuilt, unless
 *   it has commits the check did not make (a maintainer's fixups), which
 *   are never overwritten;
 * - opens a pull request when none is open from the branch, and updates
 *   the open one's title and body when it rebuilt the branch;
 * - never writes the base branch: the only ref it writes is the
 *   skill-check branch.
 * A retry after any partial run converges on the same branch and pull
 * request.
 */

export interface RepoSkillProposal {
  readonly reviewerId: string;
  /** The release named in the markers: a GA tag, or "<branch>@<sha12>" (releaseLabel in skill-check/edits.ts). */
  readonly releaseLabel: string;
  /** Must be agents/<reviewerId>/config/skill.md. */
  readonly path: string;
  /** The base branch commit baseContent was read at (fetchRepoFile's sha). */
  readonly baseSha: string;
  readonly baseContent: string;
  /** baseContent with the validated suppress-and-add edits applied. */
  readonly newContent: string;
  /** Code-generated from the validated edits, never model text. */
  readonly summary: string;
  /** Code-generated: the cited upstream lines, preferably as repo@sha:path:line. */
  readonly evidence: readonly string[];
}

export interface RepoSkillPrDeps {
  /** The bot's repository, "owner/name" (skillsRepo.repo). */
  readonly repo: string;
  readonly baseBranch: string;
  /** "Name <email>" for the DCO line. Default: the App bot identity GitHub gives the commit. */
  readonly signOff?: string;
  /** A token from the skills-repo broker (createSkillsRepoTokenSource). */
  readonly getToken: () => Promise<string>;
  readonly fetch?: typeof fetch;
  /** The date shown in the pull request body. */
  readonly now?: () => Date;
}

export type RepoSkillPrResult = {
  action: 'opened' | 'updated' | 'unchanged' | 'base-moved' | 'refused';
  branch: string;
  url?: string;
  reason?: string;
};

const GITHUB_API = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const USER_AGENT = 'valkey-reviewer-curator';
const TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 1024 * 1024;
const SUMMARY_MAX_CHARS = 8_000;
const EVIDENCE_MAX = 100;
const EVIDENCE_MAX_CHARS = 500;
const GITHUB_MESSAGE_MAX_CHARS = 200;
const BRANCH_PREFIX = 'skill-check/';

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const REVIEWER_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SIGN_OFF_RE = /^[^<>\x00-\x1f\x7f]+ <[^<>\s@]+@[^<>\s@]+>$/;
const MARKER_LIKE_RE = /^\s*<!--\s*\/?\s*suppressed\b/;
/** The token class the edit contract splits pieces on (skill-check/edits.ts). */
const TOKEN_RE = /[A-Za-z0-9_.\/:*>-]+/g;

/** A branch or tag name git and GitHub accept, kept to a safe character set. */
function isRefName(name: string): boolean {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.startsWith('-') || name.endsWith('.')) return false;
  if (name.includes('..')) return false;
  return name.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** A repository-relative file path. */
function isRepoPath(path: string): boolean {
  if (!path || path.length > 400 || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** The git blob id of a text file, as GitHub reports it for a path at a commit. */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function repoSkillPath(reviewerId: string): string {
  return `agents/${reviewerId}/config/skill.md`;
}

/** skill-check/<reviewerId>/<label>, with anything but [A-Za-z0-9._-] in the label turned into '-'. */
export function repoSkillBranch(reviewerId: string, releaseLabel: string): string {
  const label = releaseLabel.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.-]+|[.-]+$/g, '');
  return `${BRANCH_PREFIX}${reviewerId}/${label}`;
}

function titleFor(p: RepoSkillProposal): string {
  return `Supersede stale facts in the ${p.reviewerId} skill for ${p.releaseLabel}`;
}

/** Greedy wrap at `width` columns; a word longer than that gets its own line. */
function wrap(text: string, width = 72): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

function commitMessage(p: RepoSkillProposal, title: string, signOff: string): string {
  const intro = wrap(`The release check found facts in ${p.path} that ${p.releaseLabel} superseded. `
    + 'Each stale piece is kept between suppression markers that cite the upstream lines, '
    + 'and its replacement follows the closing marker.');
  return [title, '', intro, '', p.summary.trim(), '', 'Evidence:', ...p.evidence.map((e) => `- ${e}`), '', `Signed-off-by: ${signOff}`].join('\n');
}

/** Inline code that shows `text` as it is, whatever backticks it holds. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function evidenceItem(entry: string): string {
  const c = parseCitation(entry);
  if (!c) return `- ${codeSpan(entry)}`;
  const shown = `${c.repo}@${c.sha.slice(0, 12)}:${c.path}:${c.line}`;
  return `- [${codeSpan(shown)}](https://github.com/${c.repo}/blob/${c.sha}/${encodePath(c.path)}#L${c.line})`;
}

function prBody(p: RepoSkillProposal, date: string): string {
  return [
    `The release check found facts in \`${p.path}\` that ${p.releaseLabel} superseded. `
      + 'It does not rewrite them: each stale piece stays, byte for byte, between suppression markers '
      + 'that name the release and cite the upstream lines, and its replacement follows the closing marker. '
      + `Reviewers then read the old text as describing code before ${p.releaseLabel}, which still matters for backports.`,
    '',
    'Check the evidence before merging. Close this pull request to reject the change.',
    '',
    '### Changes',
    '',
    p.summary.trim(),
    '',
    '### Evidence',
    '',
    ...p.evidence.map(evidenceItem),
    '',
    '---',
    `Opened by the curator's release check of ${date}, from edits validated against the cited lines. No model wrote this text.`,
  ].join('\n');
}

function hasControl(text: string, allowNewline: boolean): boolean {
  return (allowNewline ? /[\x00-\x08\x0b-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(text);
}

/** The suppress-and-add edits a proposal adds to its base, and the date their markers carry. */
interface DerivedEdits {
  readonly edits: readonly SuppressEdit[];
  /** YYYY-MM-DD of the check that wrote them. */
  readonly date: string;
}

/**
 * Re-derive the edits `next` adds to `base` and check them with the
 * registry skills' edit contract, or say why they fail it.
 *
 * First the alignment: each insertion is an opening marker before lines
 * of the base kept as they are, the closing marker, and as many
 * replacement lines; nothing of the base may change or go. Then the
 * insertions, as edits of the base, go through skill-check's checkEdits
 * (piece size, edit count, growth, which tokens may change, frontmatter,
 * fenced and already-suppressed lines), and applyEdits must render
 * `next` from them byte for byte, so the marker text, its generated
 * reason and the line endings are the library's own. All edits of one
 * proposal come from one check: one release, one date, one upstream
 * commit.
 *
 * Two rules need the check's run rather than the content: which names
 * the check flagged, and whether the cited lines hold the new names.
 * The caller enforces them (validateEdits with the check's context), and
 * the pull request links every cited line for maintainers; here every
 * name of an edit's original counts as flagged.
 */
function deriveEdits(base: string, next: string, release: string): DerivedEdits | string {
  const parsed = parseSuppressed(next);
  if (parsed.problems.length > 0) return `the new content has malformed suppression markers: ${parsed.problems[0]}`;
  const opens = new Map(parsed.blocks.map((b) => [b.startLine - 1, b]));
  const b = base.split('\n');
  const n = next.split('\n');
  const added: { block: SuppressedBlock; edit: SuppressEdit }[] = [];
  let i = 0;
  let j = 0;
  while (i < n.length) {
    if (j < b.length && n[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    const block = opens.get(i);
    if (!block) return `line ${i + 1} of the new content is neither in the base content nor part of a suppress-and-add edit`;
    if (block.release !== release) return `the suppressed block at line ${i + 1} names ${block.release}, not ${release}`;
    const kept = block.endLine - block.startLine - 1;
    for (let k = 0; k < kept; k++) {
      if (n[i + 1 + k] !== b[j + k]) return `the suppressed block at line ${i + 1} does not keep the base content's lines as they are`;
    }
    const after = block.endLine;
    if (after + kept > n.length) return `the suppressed block at line ${i + 1} has no replacement after it`;
    for (let k = after; k < after + kept; k++) {
      if (MARKER_LIKE_RE.test(n[k]!)) return `the replacement after the suppressed block at line ${i + 1} holds a marker`;
    }
    // applyEdits drops one final newline of a piece, so one is added: a piece may end in an empty line.
    const original = `${n.slice(i + 1, i + 1 + kept).join('\n')}\n`;
    const replacement = `${n.slice(after, after + kept).join('\n')}\n`;
    added.push({ block, edit: { original, replacement, evidence: block.evidence } });
    i = after + kept;
    j += kept;
  }
  if (j !== b.length) return 'the new content drops lines of the base content';
  if (added.length === 0) return 'the new content adds no suppress-and-add edit';

  const dates = [...new Set(added.map((a) => a.block.date))];
  if (dates.length > 1) return `the new suppressed blocks carry ${dates.length} dates (${dates.join(', ')}); the edits of one check carry one`;
  const cited = added[0]!.block.evidence[0]!;
  const edits = added.map((a) => a.edit);
  const flagged = [...new Set(edits.flatMap((e) => (e.original.match(TOKEN_RE) ?? []).flatMap((t) => [t, t.replace(/:\d+(?:-\d+)?$/, '')])))];
  const ctx: EditContext = {
    flagged,
    release,
    date: dates[0]!,
    upstream: { repo: cited.repo, sha: cited.sha },
    // The file's own limit; the edit contract's growth cap still holds.
    maxChars: MAX_FILE_BYTES,
  };
  let problems: string[];
  let rendered: string;
  try {
    problems = checkEdits(base, edits, ctx);
    rendered = problems.length === 0 ? applyEdits(base, edits, ctx) : '';
  } catch (err) {
    return `the suppress-and-add edits cannot be checked: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (problems.length > 0) {
    const more = problems.length > 3 ? `; and ${problems.length - 3} more` : '';
    return `the suppress-and-add edits break the edit contract: ${problems.slice(0, 3).join('; ')}${more}`;
  }
  if (rendered !== next) {
    return 'the new content is not what its suppress-and-add edits render: the marker text, its reason or the line endings differ';
  }
  return { edits, date: ctx.date };
}

/**
 * Why `next` is not `base` plus suppress-and-add edits for `release`
 * that keep the edit contract, or null when it is (see deriveEdits).
 */
export function insertionProblem(base: string, next: string, release: string): string | null {
  const derived = deriveEdits(base, next, release);
  return typeof derived === 'string' ? derived : null;
}

function proposalProblem(p: RepoSkillProposal): string | null {
  const strings = [p.reviewerId, p.releaseLabel, p.path, p.baseSha, p.baseContent, p.newContent, p.summary];
  if (strings.some((s) => typeof s !== 'string') || !Array.isArray(p.evidence)) return 'the proposal is malformed';
  if (!REVIEWER_ID_RE.test(p.reviewerId)) return `reviewer id ${JSON.stringify(p.reviewerId)} is not valid`;
  if (p.path !== repoSkillPath(p.reviewerId)) return `only ${repoSkillPath(p.reviewerId)} can be proposed, not ${JSON.stringify(p.path)}`;
  if (!isReleaseLabel(p.releaseLabel)) return `release ${JSON.stringify(p.releaseLabel)} is not a GA tag or <branch>@<sha12>`;
  if (!SHA_RE.test(p.baseSha)) return 'baseSha is not a full commit SHA';
  if (Buffer.byteLength(p.newContent, 'utf8') > MAX_FILE_BYTES) return 'the new content is too large';
  if (p.newContent === p.baseContent) return 'the new content is the same as the base content';
  const summary = p.summary.trim();
  if (!summary || summary.length > SUMMARY_MAX_CHARS || hasControl(summary, true)) return 'the summary is empty, too long or holds control characters';
  if (p.evidence.length === 0 || p.evidence.length > EVIDENCE_MAX) return `evidence must hold 1 to ${EVIDENCE_MAX} entries`;
  if (p.evidence.some((e) => typeof e !== 'string' || !e.trim() || e.length > EVIDENCE_MAX_CHARS || hasControl(e, false))) {
    return 'an evidence entry is empty, too long or not one line';
  }
  return insertionProblem(p.baseContent, p.newContent, p.releaseLabel);
}

interface ApiResponse {
  readonly status: number;
  readonly json: unknown;
}

type Api = (method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown) => Promise<ApiResponse>;

function githubApi(token: string, fetchImpl: typeof fetch): Api {
  return async (method, path, body) => {
    const resp = await fetchImpl(`${GITHUB_API}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: unknown = {};
    try {
      json = await resp.json();
    } catch {
      // Empty or non-JSON body; callers go by the status.
    }
    return { status: resp.status, json };
  };
}

function apiError(what: string, r: ApiResponse): Error {
  const message = (r.json as { message?: unknown } | null)?.message;
  const detail = typeof message === 'string' && message ? `: ${message.slice(0, GITHUB_MESSAGE_MAX_CHARS)}` : '';
  return new Error(`${what} returned ${r.status}${detail}`);
}

function field<T>(value: unknown, what: string, test: (v: unknown) => v is T): T {
  if (!test(value)) throw new Error(`GitHub returned no ${what}`);
  return value;
}

const isSha = (v: unknown): v is string => typeof v === 'string' && SHA_RE.test(v);

/** The GitHub calls the proposal makes, with the base branch out of reach of every write. */
function skillsRepo(api: Api, repo: string, baseBranch: string) {
  const [owner] = repo.split('/') as [string];
  const writable = (branch: string) => {
    if (!branch.startsWith(BRANCH_PREFIX) || branch === baseBranch) throw new Error(`refusing to write branch ${branch}`);
  };
  return {
    /** The commit a branch points at, or null when there is no such branch. */
    async branchSha(branch: string): Promise<string | null> {
      const r = await api('GET', `repos/${repo}/git/ref/${encodePath(`heads/${branch}`)}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw apiError(`GET ref heads/${branch}`, r);
      return field((r.json as { object?: { sha?: unknown } }).object?.sha, `commit for heads/${branch}`, isSha);
    },
    /** The blob id of a file at a commit; null when it is missing or not a file. */
    async fileBlob(path: string, commit: string): Promise<string | null> {
      const r = await api('GET', `repos/${repo}/contents/${encodePath(path)}?ref=${commit}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw apiError(`GET contents ${path}@${commit}`, r);
      const file = r.json as { type?: unknown; sha?: unknown };
      return file.type === 'file' && isSha(file.sha) ? file.sha : null;
    },
    async treeOf(commit: string): Promise<string> {
      const r = await api('GET', `repos/${repo}/git/commits/${commit}`);
      if (r.status !== 200) throw apiError(`GET commit ${commit}`, r);
      return field((r.json as { tree?: { sha?: unknown } }).tree?.sha, `tree for ${commit}`, isSha);
    },
    async createTree(baseTree: string, path: string, content: string): Promise<string> {
      const r = await api('POST', `repos/${repo}/git/trees`, {
        base_tree: baseTree,
        tree: [{ path, mode: '100644', type: 'blob', content }],
      });
      if (r.status !== 201) throw apiError('POST git/trees', r);
      return field((r.json as { sha?: unknown }).sha, 'tree sha', isSha);
    },
    async createCommit(message: string, tree: string, parent: string): Promise<{ sha: string; author: string }> {
      const r = await api('POST', `repos/${repo}/git/commits`, { message, tree, parents: [parent] });
      if (r.status !== 201) throw apiError('POST git/commits', r);
      const c = r.json as { sha?: unknown; author?: { name?: unknown; email?: unknown } };
      const author = typeof c.author?.name === 'string' && typeof c.author.email === 'string' ? `${c.author.name} <${c.author.email}>` : '';
      return { sha: field(c.sha, 'commit sha', isSha), author };
    },
    async createBranch(branch: string, sha: string): Promise<void> {
      writable(branch);
      const r = await api('POST', `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
      if (r.status !== 201) throw apiError(`POST git/refs heads/${branch}`, r);
    },
    async moveBranch(branch: string, sha: string): Promise<void> {
      writable(branch);
      const r = await api('PATCH', `repos/${repo}/git/refs/${encodePath(`heads/${branch}`)}`, { sha, force: true });
      if (r.status !== 200) throw apiError(`PATCH git/refs heads/${branch}`, r);
    },
    /** What the branch adds to the base: its commits' titles and the files they touch. */
    async compare(base: string, head: string): Promise<{ aheadBy: number; titles: string[]; files: string[] } | null> {
      const r = await api('GET', `repos/${repo}/compare/${base}...${head}`);
      if (r.status === 404) return null;
      if (r.status !== 200) throw apiError(`GET compare ${base}...${head}`, r);
      const c = r.json as { ahead_by?: unknown; commits?: { commit?: { message?: unknown } }[]; files?: { filename?: unknown }[] };
      const aheadBy = field(c.ahead_by, 'ahead_by', (v): v is number => Number.isInteger(v));
      return {
        aheadBy,
        titles: (c.commits ?? []).map((x) => String(x.commit?.message ?? '').split('\n')[0]!),
        files: (c.files ?? []).map((f) => String(f.filename ?? '')),
      };
    },
    async openPull(branch: string): Promise<Pull | null> {
      const head = encodeURIComponent(`${owner}:${branch}`);
      const r = await api('GET', `repos/${repo}/pulls?head=${head}&state=open&per_page=10`);
      if (r.status !== 200) throw apiError(`GET pulls from ${branch}`, r);
      const pulls = Array.isArray(r.json) ? r.json as { number?: unknown; html_url?: unknown; head?: { ref?: unknown } }[] : [];
      const pr = pulls.find((x) => x.head?.ref === branch && Number.isInteger(x.number));
      return pr ? pull(pr) : null;
    },
    /** The new pull request, or GitHub's 422 refusal, which another open pull request from the branch explains. */
    async createPull(branch: string, title: string, body: string): Promise<Pull | ApiResponse> {
      writable(branch);
      const r = await api('POST', `repos/${repo}/pulls`, { title, head: branch, base: baseBranch, body });
      if (r.status === 422) return r;
      if (r.status !== 201) throw apiError(`POST pulls from ${branch}`, r);
      return pull(r.json as { number?: unknown; html_url?: unknown });
    },
    async updatePull(number: number, title: string, body: string): Promise<void> {
      const r = await api('PATCH', `repos/${repo}/pulls/${number}`, { title, body });
      if (r.status !== 200) throw apiError(`PATCH pulls/${number}`, r);
    },
  };
}

type SkillsRepo = ReturnType<typeof skillsRepo>;

interface Pull {
  readonly number: number;
  readonly url?: string;
}

function pull(pr: { number?: unknown; html_url?: unknown }): Pull {
  const number = field(pr.number, 'pull request number', (v): v is number => Number.isInteger(v));
  return typeof pr.html_url === 'string' && pr.html_url ? { number, url: pr.html_url } : { number };
}

function withUrl(result: RepoSkillPrResult, pr: Pull): RepoSkillPrResult {
  return pr.url ? { ...result, url: pr.url } : result;
}

function checkDeps(deps: RepoSkillPrDeps): void {
  if (!REPO_RE.test(deps.repo)) throw new Error(`skills repo must be "owner/name", got ${JSON.stringify(deps.repo)}`);
  if (!isRefName(deps.baseBranch)) throw new Error(`base branch ${JSON.stringify(deps.baseBranch)} is not a branch name`);
  if (deps.signOff !== undefined && !SIGN_OFF_RE.test(deps.signOff)) throw new Error('signOff must be "Name <email>"');
}

/** Why the branch may not be rebuilt: it holds commits the release check did not make. */
async function foreignWork(gh: SkillsRepo, tip: string, head: string, branch: string, title: string, path: string): Promise<string | null> {
  const diff = await gh.compare(tip, head);
  const ours = diff !== null && (diff.aheadBy === 0
    || (diff.aheadBy === 1 && diff.titles[0] === title && diff.files.length === 1 && diff.files[0] === path));
  return ours ? null : `branch ${branch} has commits the release check did not make; leaving it to the maintainers`;
}

async function buildCommit(gh: SkillsRepo, tip: string, p: RepoSkillProposal, title: string, signOff: string | undefined): Promise<string> {
  const tree = await gh.createTree(await gh.treeOf(tip), p.path, p.newContent);
  let line = signOff;
  if (!line) {
    // GitHub authors a commit made with an installation token as the
    // App's bot user. A first commit object, never referenced, gives
    // that identity for the DCO line of the one the branch points at.
    const probe = await gh.createCommit(title, tree, tip);
    if (!SIGN_OFF_RE.test(probe.author)) throw new Error('GitHub returned no commit author to sign off as');
    line = probe.author;
  }
  return (await gh.createCommit(commitMessage(p, title, line), tree, tip)).sha;
}

export async function proposeRepoSkillChange(p: RepoSkillProposal, deps: RepoSkillPrDeps): Promise<RepoSkillPrResult> {
  checkDeps(deps);
  const named = typeof p.reviewerId === 'string' && REVIEWER_ID_RE.test(p.reviewerId)
    && typeof p.releaseLabel === 'string' && isReleaseLabel(p.releaseLabel);
  const branch = named ? repoSkillBranch(p.reviewerId, p.releaseLabel) : '';
  const problem = proposalProblem(p) ?? (isRefName(branch) && branch !== deps.baseBranch ? null : `cannot use branch ${JSON.stringify(branch)}`);
  if (problem) return { action: 'refused', branch, reason: problem };

  const gh = skillsRepo(githubApi(await deps.getToken(), deps.fetch ?? fetch), deps.repo, deps.baseBranch);
  const tip = await gh.branchSha(deps.baseBranch);
  if (!tip) throw new Error(`${deps.repo} has no branch ${deps.baseBranch}`);
  if (await gh.fileBlob(p.path, tip) !== gitBlobSha(p.baseContent)) {
    if (tip === p.baseSha) return { action: 'refused', branch, reason: `the base content is not ${p.path} at ${p.baseSha}` };
    return {
      action: 'base-moved',
      branch,
      reason: `${deps.baseBranch} moved from ${p.baseSha.slice(0, 12)} to ${tip.slice(0, 12)} and ${p.path} changed since`,
    };
  }

  const title = titleFor(p);
  const head = await gh.branchSha(branch);
  let rebuilt = false;
  if (head === null || await gh.fileBlob(p.path, head) !== gitBlobSha(p.newContent)) {
    if (head !== null) {
      const foreign = await foreignWork(gh, tip, head, branch, title, p.path);
      if (foreign) return { action: 'refused', branch, reason: foreign };
    }
    const commit = await buildCommit(gh, tip, p, title, deps.signOff);
    if (head === null) await gh.createBranch(branch, commit);
    else await gh.moveBranch(branch, commit);
    rebuilt = true;
  }

  const body = prBody(p, (deps.now ?? (() => new Date()))().toISOString().slice(0, 10));
  let open = await gh.openPull(branch);
  if (!open) {
    const created = await gh.createPull(branch, title, body);
    if ('number' in created) return withUrl({ action: 'opened', branch }, created);
    // Another attempt may have opened it between the two calls.
    open = await gh.openPull(branch);
    if (!open) throw apiError(`POST pulls from ${branch}`, created);
  }
  if (!rebuilt) return withUrl({ action: 'unchanged', branch }, open);
  await gh.updatePull(open.number, title, body);
  return withUrl({ action: 'updated', branch }, open);
}

/**
 * A file of a public repository at a branch, tag or commit, read
 * anonymously. `sha` is the commit the content came from: the ref is
 * resolved first and the file read at that commit, so the two always
 * match. Null when the file is not there (or, for a ref given as a full
 * SHA, the commit is unknown). Throws when a named ref does not exist.
 * The content is decoded as strict UTF-8 with any BOM kept, so
 * gitBlobSha(content) is the file's blob id.
 */
export async function fetchRepoFile(
  repo: string,
  ref: string,
  path: string,
  opts: { fetch?: typeof fetch } = {},
): Promise<{ sha: string; content: string } | null> {
  if (!REPO_RE.test(repo)) throw new Error(`repo must be "owner/name", got ${JSON.stringify(repo)}`);
  if (!SHA_RE.test(ref) && !isRefName(ref)) throw new Error(`ref ${JSON.stringify(ref)} is not a branch, tag or commit`);
  if (!isRepoPath(path)) throw new Error(`path ${JSON.stringify(path)} is not a repository file path`);
  const fetchImpl = opts.fetch ?? fetch;

  let sha = ref;
  if (!SHA_RE.test(ref)) {
    const resp = await fetchImpl(`${GITHUB_API}/repos/${repo}/commits/${encodePath(ref)}`, {
      headers: { Accept: 'application/vnd.github.sha', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = (await resp.text()).trim();
    if (resp.status === 404 || resp.status === 422) throw new Error(`${repo} has no ref ${ref}`);
    if (resp.status !== 200 || !SHA_RE.test(text)) throw new Error(`GET ${repo} commits/${ref} returned ${resp.status}`);
    sha = text;
  }

  const resp = await fetchImpl(`${RAW_HOST}/${repo}/${sha}/${encodePath(path)}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (resp.status === 404) {
    await resp.body?.cancel();
    return null;
  }
  if (resp.status !== 200) throw new Error(`GET ${repo}@${sha}:${path} returned ${resp.status}`);
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`${path} at ${sha} is larger than ${MAX_FILE_BYTES} bytes`);
  try {
    return { sha, content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    throw new Error(`${path} at ${sha} is not UTF-8 text`);
  }
}
