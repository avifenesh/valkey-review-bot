import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Citation, LineResolver } from './edits.js';

/**
 * A checkout of a public upstream repository for the release check.
 *
 * A fresh `git init` that fetches one branch tip with depth 1 and no
 * blobs and checks it out, which fetches the tip's blobs in one batch.
 * Then, best effort, the commit of the last check (depth 1, no blobs)
 * and, in one more batch, its blobs of the files that changed since, so
 * `git diff <base> <tip>` works. After that the repository stops being a
 * partial clone: a missing object is an error, never a fetch. This does
 * not rely on GIT_NO_LAZY_FETCH, which git before 2.44 ignores.
 *
 * The repository is new, so it has no hooks, and git reads no system or
 * global config and gets no credentials. Nothing here talks to the
 * network except git itself, on the URL the caller gives.
 *
 * No runtime relative imports, so scripts can load this file directly
 * under Node's type stripping.
 */

export interface GitResult {
  /** Exit status; -1 when the output went past `maxBytes` and git was stopped. */
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout went past `maxBytes`; `stdout` holds what came before. */
  readonly truncated: boolean;
}

export interface GitCallOptions {
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

/**
 * Run git with an argv (no shell) in one directory. A non-zero exit is
 * returned, not thrown; a timeout, a git killed by a signal or a git
 * that cannot start throws.
 */
export type GitRunner = (args: readonly string[], opts?: GitCallOptions) => Promise<GitResult>;

const GIT_TIMEOUT_MS = 10 * 60_000;
/** Each best-effort step for the base: its fetch and its blob batch. */
const BASE_TIMEOUT_MS = 3 * 60_000;
const GIT_MAX_BYTES = 64 * 1024 * 1024;
const STDERR_MAX_BYTES = 1024 * 1024;
/** How long to wait for git's output to close after it exits or is killed. */
const CLOSE_GRACE_MS = 2_000;
const FILE_MAX_BYTES = 16 * 1024 * 1024;

/** Same filter as tools/child-env.ts buildChildEnv. */
const CREDENTIAL_NAME = /^(AWS_|AMAZON_|GH_|GITHUB_)|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/i;

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH_RE = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\/$)(?!.*\.lock$)[A-Za-z0-9._\/-]{1,200}$/;

/**
 * Environment for upstream git: the process environment without
 * credentials or inherited GIT_* settings (GIT_CONFIG_COUNT and the like
 * can inject config), plus no system or global config, no prompts, and
 * the low-speed abort workspace.ts uses.
 */
export function upstreamGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (!CREDENTIAL_NAME.test(name) && !name.startsWith('GIT_')) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // Abort a transfer that stays under 1 KB/s for 60 seconds.
    GIT_HTTP_LOW_SPEED_LIMIT: '1000',
    GIT_HTTP_LOW_SPEED_TIME: '60',
  };
}

/** The git subcommand in an argv: the first argument that is not an option or the value of -c or -C. */
function subcommand(args: readonly string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' || a === '-C') i++;
    else if (!a.startsWith('-')) return a;
  }
  return args[0] ?? '';
}

/**
 * The runner of a checkout. git runs in its own process group, and a
 * timeout, or stdout past `maxBytes`, kills the whole group: a lazy
 * fetch or remote helper git started cannot keep writing into the
 * repository after the call returns. So does a git that exits while
 * something it started still holds its output, once a grace period
 * has passed.
 */
export function createGitRunner(cwd: string, env: NodeJS.ProcessEnv = upstreamGitEnv()): GitRunner {
  return (args, opts = {}) => new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? GIT_MAX_BYTES;
    const child = spawn('git', [...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let status: { code: number | null; signal: NodeJS.Signals | null } = { code: null, signal: null };
    let grace: NodeJS.Timeout | undefined;

    const killGroup = () => {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // The group has already exited.
      }
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (timedOut) return reject(new Error(`git ${subcommand(args)} timed out after ${Math.round(timeoutMs / 1000)}s`));
      if (truncated) return resolve({ code: -1, stdout, stderr, truncated: true });
      if (status.code !== null) return resolve({ code: status.code, stdout, stderr, truncated: false });
      reject(new Error(`git ${subcommand(args)} was killed by ${status.signal ?? 'a signal'}`));
    };
    // Kill the group, and stop waiting for its output after the grace period.
    const stop = () => {
      killGroup();
      grace ??= setTimeout(finish, CLOSE_GRACE_MS);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      if (truncated) return;
      if (outBytes + b.length > maxBytes) {
        out.push(b.subarray(0, maxBytes - outBytes));
        truncated = true;
        stop();
        return;
      }
      out.push(b);
      outBytes += b.length;
    });
    child.stderr.on('data', (b: Buffer) => {
      const kept = b.subarray(0, Math.max(0, STDERR_MAX_BYTES - errBytes));
      err.push(kept);
      errBytes += kept.length;
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      reject(new Error(`could not run git: ${e.message}`));
    });
    child.on('exit', (code, signal) => {
      status = { code, signal };
      // 'close' waits for everything that holds git's output. Whatever
      // git left running is stopped after the grace period.
      grace ??= setTimeout(() => {
        killGroup();
        finish();
      }, CLOSE_GRACE_MS);
    });
    child.on('close', (code, signal) => {
      if (status.code === null && status.signal === null) status = { code, signal };
      finish();
    });
  });
}

async function mustRun(git: GitRunner, args: readonly string[], opts?: GitCallOptions): Promise<string> {
  const r = await git(args, opts);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  return r.stdout;
}

export interface PrepareOptions {
  /** Directory for the new repository; created when missing, must be empty otherwise. */
  readonly dir: string;
  /** https:// URL of the public repository, without credentials (file:// for tests). */
  readonly url: string;
  /** Commit of the last check. Fetched too when the remote still has it, so the check can diff against it. */
  readonly verifiedSha?: string;
  /** Branch to check instead of the remote's default branch. */
  readonly branch?: string;
  /** Environment for git. Default upstreamGitEnv(). */
  readonly env?: NodeJS.ProcessEnv;
  /** Timeout of each best-effort base step. Default 3 minutes. A step that times out is killed with everything it started. */
  readonly baseTimeoutMs?: number;
}

export interface UpstreamCheckout {
  /** The remote's default branch (its HEAD), or the `branch` option when given. */
  readonly defaultBranch: string;
  /** The commit checked out, detached. */
  readonly tipSha: string;
  /**
   * verifiedSha was fetched, with its blobs of the files changed since,
   * so it can be diffed against the tip. False when it was not asked for,
   * is not a full SHA, or its fetch failed, timed out or could not start.
   */
  readonly baseAvailable: boolean;
  /** A runner in the checkout, with the same environment. The checkout is no longer a partial clone. */
  readonly git: GitRunner;
}

function checkUrl(url: string): void {
  // Only anonymous https, or a local file:// repository. No user info, so no credentials in the URL.
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^\s@]+$/.test(url) && !/^file:\/\/\/[^\s]+$/.test(url)) {
    throw new Error(`upstream URL must be https:// without credentials, or file:// (got ${JSON.stringify(url)})`);
  }
}

/** Parse `git ls-remote --symref` output into the HEAD symref target and ref tips. */
function parseLsRemote(out: string): { head: string | null; refs: Map<string, string> } {
  let head: string | null = null;
  const refs = new Map<string, string>();
  for (const line of out.split('\n')) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) {
      head = sym[1]!;
      continue;
    }
    const m = /^([0-9a-f]{40}|[0-9a-f]{64})\t(\S+)$/.exec(line);
    if (m) refs.set(m[2]!, m[1]!);
  }
  return { head, refs };
}

/** Run a best-effort git step: true when it exits 0, false on any failure, timeout or spawn error. */
async function tryRun(git: GitRunner, args: readonly string[], timeoutMs: number): Promise<boolean> {
  try {
    return (await git(args, { timeoutMs })).code === 0;
  } catch {
    return false;
  }
}

/**
 * Create the checkout: init, register origin as a promisor remote with
 * blob:none, find the branch and its tip with ls-remote, fetch the tip
 * at depth 1 without blobs and check it out detached. Then, best effort,
 * fetch verifiedSha the same way and its blobs of the changed files.
 * Last, drop the promisor settings, so later commands never fetch.
 */
export async function prepareUpstreamCheckout(opts: PrepareOptions): Promise<UpstreamCheckout> {
  checkUrl(opts.url);
  if (opts.branch !== undefined && !BRANCH_RE.test(opts.branch)) throw new Error(`invalid branch name ${JSON.stringify(opts.branch)}`);
  await mkdir(opts.dir, { recursive: true });
  if ((await readdir(opts.dir)).length > 0) throw new Error(`checkout directory ${opts.dir} is not empty`);

  const git = createGitRunner(opts.dir, opts.env ?? upstreamGitEnv());
  // --template= copies no templates, so not even sample hooks exist.
  await mustRun(git, ['init', '-q', '--template=']);
  await mustRun(git, ['remote', 'add', 'origin', opts.url]);
  await mustRun(git, ['config', 'remote.origin.promisor', 'true']);
  await mustRun(git, ['config', 'remote.origin.partialclonefilter', 'blob:none']);

  const wanted = opts.branch === undefined ? ['HEAD'] : ['HEAD', `refs/heads/${opts.branch}`];
  const listing = parseLsRemote(await mustRun(git, ['ls-remote', '--symref', 'origin', ...wanted], { timeoutMs: 2 * 60_000 }));
  const branch = opts.branch ?? listing.head;
  if (!branch || !BRANCH_RE.test(branch)) throw new Error(`could not tell the default branch of ${opts.url}`);
  if (!listing.refs.has(`refs/heads/${branch}`) && !(opts.branch === undefined && listing.refs.has('HEAD'))) {
    throw new Error(`${opts.url} has no branch ${branch}`);
  }

  const fetchArgs = ['fetch', '-q', '--depth=1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', 'origin'];
  await mustRun(git, [...fetchArgs, `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  // The fetched tip, not the one ls-remote printed: the branch can move in between.
  const tipSha = (await mustRun(git, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}^{commit}`])).trim();

  // Checking out fetches the tip's blobs in one batch.
  await mustRun(git, ['-c', 'advice.detachedHead=false', 'checkout', '-q', '--detach', '--force', tipSha]);

  let baseFetched = false;
  const base = opts.verifiedSha;
  if (base !== undefined && SHA_RE.test(base)) {
    const timeoutMs = opts.baseTimeoutMs ?? BASE_TIMEOUT_MS;
    baseFetched = base === tipSha || (
      await tryRun(git, [...fetchArgs, base], timeoutMs)
      // A diff that reads blobs fetches the missing ones (the base side of each changed file) in one batch.
      && await tryRun(git, ['diff', '--shortstat', '--no-renames', '--no-ext-diff', '--no-textconv', base, tipSha], timeoutMs));
  }

  // No longer a partial clone. Git before 2.44 ignores GIT_NO_LAZY_FETCH, and a
  // remote with promisor or partialclonefilter set (or extensions.partialClone)
  // makes any missing object a network fetch.
  await mustRun(git, ['config', '--unset-all', 'remote.origin.promisor']);
  await mustRun(git, ['config', '--unset-all', 'remote.origin.partialclonefilter']);
  const unset = await git(['config', '--unset-all', 'extensions.partialClone']);
  if (unset.code !== 0 && unset.code !== 5) throw new Error(`git config --unset-all extensions.partialClone exited ${unset.code}: ${unset.stderr.trim()}`);

  // The fetch's result decides; the probe only confirms, and can no longer fetch.
  const baseAvailable = baseFetched && (await git(['cat-file', '-e', `${base}^{commit}`])).code === 0;
  return { defaultBranch: branch, tipSha, baseAvailable, git };
}

/** Delete a checkout directory. Refuses a relative path or a filesystem root. */
export async function removeCheckout(dir: string): Promise<void> {
  const full = path.resolve(dir);
  if (!path.isAbsolute(dir) || full === path.parse(full).root) throw new Error(`refusing to remove ${JSON.stringify(dir)}`);
  await rm(full, { recursive: true, force: true });
}

function isRepoPath(p: string): boolean {
  if (p.length === 0 || p.includes('\0') || p.startsWith('/')) return false;
  return p.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * A LineResolver for edits.ts that reads cited lines from the checkout
 * with `git cat-file blob <sha>:<path>`. It answers only for `at`, the
 * checked-out commit, so no citation makes git fetch other objects.
 * Each file is read once.
 */
export function createLineResolver(git: GitRunner, at: { readonly repo: string; readonly sha: string }): LineResolver {
  if (!SHA_RE.test(at.sha)) throw new Error(`not a full commit SHA: ${JSON.stringify(at.sha)}`);
  const files = new Map<string, Promise<string[] | null>>();
  const read = async (file: string): Promise<string[] | null> => {
    const r = await git(['cat-file', 'blob', `${at.sha}:${file}`], { maxBytes: FILE_MAX_BYTES });
    if (r.code !== 0 || r.truncated || r.stdout.includes('\0')) return null;
    const lines = r.stdout.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  };
  return async (c: Citation) => {
    if (c.repo.toLowerCase() !== at.repo.toLowerCase() || c.sha !== at.sha) return null;
    if (!isRepoPath(c.path) || !Number.isInteger(c.line) || c.line < 1) return null;
    let lines = files.get(c.path);
    if (!lines) {
      lines = read(c.path);
      files.set(c.path, lines);
    }
    return (await lines)?.[c.line - 1] ?? null;
  };
}
