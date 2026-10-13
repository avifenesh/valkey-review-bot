// The deterministic part of the curator's skill check, run locally for
// one skill: which cited names exist at the upstream commit, which were
// lost since a base commit, and which rare names the diff since then
// touched. It loads the skill-check modules of agents/common directly
// (Node strips the TypeScript types); they need no npm packages.

import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { areaFileCounts, checkSkill } from '../../agents/common/src/skill-check/check.ts';
import { extractNames } from '../../agents/common/src/skill-check/names.ts';
import { createGitRunner, prepareUpstreamCheckout, removeCheckout, upstreamGitEnv } from '../../agents/common/src/skill-check/upstream.ts';
import { printable, quoted } from './text.mjs';

const SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The first git that honours GIT_NO_LAZY_FETCH; older git ignores it. */
const NO_LAZY_FETCH_GIT = [2, 44];

/**
 * Environment for git on a clone the operator already has. As for a fresh
 * checkout: no credentials, no inherited GIT_* settings and no system or
 * global config. Also GIT_NO_LAZY_FETCH, so in a partial clone an object
 * the clone lacks is an error, not a fetch from its promisor remote that
 * writes a pack into the clone.
 */
const cloneGitEnv = () => ({ ...upstreamGitEnv(), GIT_NO_LAZY_FETCH: '1' });

/**
 * Whether the clone fetches missing objects on demand: extensions.partialClone
 * is set, or a remote has promisor or partialclonefilter set.
 */
async function isPartialClone(git) {
  const ext = await git(['config', '--get', 'extensions.partialClone']);
  const remotes = await git(['config', '--get-regexp', '^remote[.].+[.](promisor|partialclonefilter)$']);
  for (const r of [ext, remotes]) {
    // 1: no such key.
    if (r.code !== 0 && r.code !== 1) throw new Error(`git config exited ${r.code}: ${r.stderr.trim().slice(0, 500)}`);
  }
  return (ext.code === 0 && ext.stdout.trim() !== '') || (remotes.code === 0 && remotes.stdout.trim() !== '');
}

/** [major, minor] of the git that runs, or null when its version cannot be read. */
async function gitVersion(git) {
  const m = /^git version (\d+)\.(\d+)/.exec((await git(['--version'])).stdout.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const atLeast = (version, [major, minor]) => version !== null && (version[0] > major || (version[0] === major && version[1] >= minor));

/**
 * A runner for the top of the clone at `dir`, and whether it is a partial
 * clone. Refuses a partial clone when git is too old to turn off lazy
 * fetching.
 */
async function cloneRunner(dir) {
  const env = cloneGitEnv();
  const top = await mustGit(createGitRunner(dir, env), ['rev-parse', '--show-toplevel']);
  // Check from the top of the work tree, as check.ts expects.
  const git = createGitRunner(top, env);
  const partial = await isPartialClone(git);
  if (partial) {
    const version = await gitVersion(git);
    if (!atLeast(version, NO_LAZY_FETCH_GIT)) {
      throw new Error(`${top} is a partial clone, and git ${version ? version.join('.') : 'of an unknown version'} cannot turn off`
        + ` its fetches of missing objects (git ${NO_LAZY_FETCH_GIT.join('.')} can). Use git ${NO_LAZY_FETCH_GIT.join('.')} or later,`
        + ' a full clone, or --repo or --url.');
    }
  }
  return { git, top, partial };
}

async function mustGit(git, args) {
  const r = await git(args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 500)}`);
  return r.stdout.trim();
}

/**
 * The full SHA a revision names in a checkout, or null. Only a plain
 * revision: no option-like or multi-word text reaches git.
 */
async function commitOf(git, rev) {
  if (rev.startsWith('-') || !/^[^\s\x00-\x1f\x7f]{1,200}$/.test(rev)) return null;
  const r = await git(['rev-parse', '--verify', '-q', `${rev}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA_RE.test(sha) ? sha : null;
}

/**
 * Check `skillMd` against an upstream commit.
 *
 * upstream is either { url, branch? }: a fresh anonymous checkout of the
 * branch tip (the default branch unless given) in a temporary directory,
 * deleted afterwards, as the curator makes it; or { checkout, rev? }: the
 * committed tree at `rev` (default HEAD) of an existing clone, which is
 * only read: git runs there with lazy fetching off (see cloneRunner), so
 * in a partial clone an object it lacks is an error, never a fetch.
 *
 * record, when given, is the graduated concern record's check state, as
 * the curator uses it: audit_names is the baseline, ignored_names are not
 * reported, verified_sha is the base, and area's globs are counted.
 * Without a record the baseline is the cited names present at `base`.
 * `base` overrides the record's verified_sha.
 */
export async function skillFacts({ skillMd, upstream, record = null, base }) {
  const names = extractNames(skillMd);
  // A malformed verified_sha in the table is no base; a malformed --base is an error below.
  const recordSha = typeof record?.verified_sha === 'string' && SHA_RE.test(record.verified_sha) ? record.verified_sha : undefined;
  let baseSha = base ?? recordSha;
  let dir;
  let partialClone = null;
  try {
    let git;
    let commit;
    let baseAvailable = false;
    let where;
    if (upstream.url) {
      if (baseSha !== undefined && !SHA_RE.test(baseSha)) throw new Error(`the base must be a full commit SHA for a fresh checkout, got ${JSON.stringify(baseSha)}`);
      dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'skill-facts-')));
      const co = await prepareUpstreamCheckout({ dir, url: upstream.url, branch: upstream.branch, verifiedSha: baseSha });
      git = co.git;
      commit = co.tipSha;
      baseAvailable = co.baseAvailable;
      where = { url: upstream.url, branch: co.defaultBranch, commit };
    } else {
      const clone = await cloneRunner(upstream.checkout);
      git = clone.git;
      const { top, partial } = clone;
      if (partial) partialClone = top;
      const rev = upstream.rev ?? 'HEAD';
      commit = await commitOf(git, rev);
      if (!commit) throw new Error(`${JSON.stringify(rev)} names no commit in ${top}`);
      if (baseSha !== undefined) {
        const resolved = await commitOf(git, baseSha);
        if (resolved) baseSha = resolved;
        baseAvailable = resolved !== null;
      }
      where = { checkout: top, rev, commit, ...(partial ? { partial: true } : {}) };
    }

    let baseline = [];
    let baselineFrom = 'none';
    let baselineError = null;
    if (record) {
      baseline = Array.isArray(record.audit_names) ? record.audit_names : [];
      baselineFrom = 'record';
    } else if (baseAvailable) {
      try {
        baseline = (await checkSkill(git, { names, rev: baseSha })).present;
        baselineFrom = 'base';
      } catch (err) {
        // A fresh checkout holds the base's trees and changed blobs; if git still misses an object, go on without a baseline.
        baselineError = err instanceof Error ? err.message : String(err);
      }
    }
    const cited = new Set(names.map((n) => n.token));
    const ignored = Array.isArray(record?.ignored_names) ? record.ignored_names : [];
    const result = await checkSkill(git, { names, baseline, ignored, baseSha: baseAvailable ? baseSha : undefined, rev: commit });

    const globs = Array.isArray(record?.area) ? record.area.filter((g) => typeof g === 'string' && g) : [];
    const counts = globs.length > 0 ? await areaFileCounts(git, globs, commit) : [];
    return {
      names,
      result,
      upstream: where,
      base: baseSha === undefined ? null : { sha: baseSha, available: baseAvailable },
      // As checkSkill reads it: names the skill no longer cites do not count.
      baseline: { from: baselineFrom, names: [...new Set(baseline)].filter((t) => cited.has(t)), error: baselineError },
      ignored,
      area: globs.map((glob, i) => ({ glob, files: counts[i] })),
    };
  } catch (err) {
    // Git's own words for an object a partial clone lacks while lazy fetching is off.
    if (partialClone && err instanceof Error && /lazy fetching disabled|from promisor remote/.test(err.message)) {
      err.message += `\n${partialClone} is a partial clone, and this reads only the objects it has. Fetch what the check needs there`
        + ' yourself (checking out --rev and --base does), or use --repo or --url.';
    }
    throw err;
  } finally {
    if (dir) await removeCheckout(dir);
  }
}

const list = (tokens) => (tokens.length === 0 ? '-' : tokens.map((t) => `\`${printable(t)}\``).join(', '));

/**
 * The report as text lines. `label` names the skill; with `allNames` every
 * cited name gets a line. Names, area globs, the branch and git's messages
 * come from the skill, the concern record or the upstream, so each goes
 * through printable().
 */
export function factsReport(facts, { label, allNames = false }) {
  const { names, result, upstream, base, baseline, area } = facts;
  const short = (sha) => sha.slice(0, 12);
  const lines = [`skill: ${printable(label)}`];
  lines.push(upstream.url
    ? `upstream: ${printable(upstream.url)} ${printable(upstream.branch)}@${short(upstream.commit)}`
    : `upstream: checkout ${printable(upstream.checkout)} at ${printable(upstream.rev)} (${short(upstream.commit)})`
      + (upstream.partial ? ', a partial clone, read without fetching' : ''));
  if (!base) lines.push('base: none, so no names are touched');
  else if (!base.available) lines.push(`base: ${quoted(base.sha)} is not available here, so no names are touched`);
  else lines.push(`base: ${short(base.sha)}, ${result.changedFiles} file(s) changed since`);
  if (baseline.from === 'record') lines.push(`baseline: ${baseline.names.length} name(s), the concern record's audit_names`);
  else if (baseline.from === 'base') lines.push(`baseline: ${baseline.names.length} name(s), the cited names present at the base`);
  else if (baseline.error) lines.push(`baseline: none, the names at the base could not be read (${printable(baseline.error.slice(0, 300))})`);
  else lines.push('baseline: none (a first check): every absent name is new');
  lines.push(`names: ${names.length} cited, ${result.present.length} present`);
  lines.push(`lost (${result.lost.length}): ${list(result.lost)}`);
  lines.push(`new absent (${result.newAbsent.length}): ${list(result.newAbsent)}`);
  lines.push(`touched (${result.touched.length}): ${list(result.touched)}`);
  for (const why of result.incomplete) lines.push(`incomplete: ${printable(why)}`);
  lines.push(`kept fraction: ${result.keptFraction.toFixed(3)}`);
  if (area.length > 0) lines.push(`area: ${area.map((a) => `\`${printable(a.glob)}\` ${a.files} file(s)`).join(', ')}`);
  lines.push(`clean: ${result.clean ? 'yes' : 'no'}`);
  if (allNames) {
    const lost = new Set(result.lost);
    const touched = new Set(result.touched);
    const ignored = new Set(facts.ignored);
    lines.push('', 'state      kind       count  name');
    for (const n of names) {
      const count = result.counts.get(n.token) ?? 0;
      let state = count > 0 ? 'present' : 'absent';
      if (lost.has(n.token)) state = 'lost';
      else if (count === 0 && ignored.has(n.token)) state = 'ignored';
      else if (touched.has(n.token)) state = 'touched';
      lines.push(`${state.padEnd(10)} ${printable(n.kind).padEnd(10)} ${String(count).padStart(5)}  ${printable(n.token)}`);
    }
  }
  return lines;
}

/** The report as one JSON-ready object, diff excerpts included. */
export function factsJson(facts, { label }) {
  const { names, result } = facts;
  return {
    skill: label,
    upstream: facts.upstream,
    base: facts.base,
    baseline: facts.baseline,
    names: names.map((n) => ({ token: n.token, kind: n.kind, count: result.counts.get(n.token) ?? 0 })),
    present: result.present,
    lost: result.lost,
    newAbsent: result.newAbsent,
    touched: result.touched,
    incomplete: result.incomplete,
    keptFraction: result.keptFraction,
    changedFiles: result.changedFiles,
    excerpts: result.excerpts,
    area: facts.area,
    clean: result.clean,
  };
}
