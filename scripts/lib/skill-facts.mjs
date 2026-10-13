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

/**
 * What git prints on stderr about an object it could not read: one the
 * repository lacks, a corrupt one, or one it could not or may not fetch.
 */
const OBJECT_ERROR_RE = /unable to read|could not read|cannot read|failed to read|missing (?:blob |tree |commit |tag )?object|bad object|could not fetch|lazy fetching disabled|promisor remote|is corrupt|corrupt (?:loose )?object|unable to unpack|inflate:/i;

/** Git could not read an object the check reads; the result would be incomplete. */
export class ObjectReadError extends Error {}

/** The git subcommand in an argv: the first argument that is not an option or the value of -c or -C. */
function subcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') i++;
    else if (!args[i].startsWith('-')) return args[i];
  }
  return args[0] ?? '';
}

/**
 * A runner that throws ObjectReadError when git reports on stderr an
 * object it could not read, whatever its exit status. git grep reports a
 * blob it cannot read ("error: '<rev>:<path>': unable to read <sha>") and
 * goes on, exiting 0 or 1, which check.ts accepts: the names in that blob
 * would count as absent. `context` says where git ran.
 */
export function failOnObjectErrors(git, context) {
  return async (args, opts) => {
    const r = await git(args, opts);
    const line = r.stderr.split('\n').find((l) => OBJECT_ERROR_RE.test(l));
    if (line !== undefined) {
      throw new ObjectReadError(`git ${subcommand(args)} could not read an object the check needs (${line.trim().slice(0, 300)}),`
        + ` so no result is given. ${context}`);
    }
    return r;
  };
}

/**
 * Environment for git on a clone the operator already has. As for a fresh
 * checkout: no credentials, no inherited GIT_* settings and no system or
 * global config. Also GIT_NO_LAZY_FETCH, so that git 2.44 and later never
 * fetch an object the clone lacks and write a pack into it. Partial
 * clones are refused anyway (see cloneRunner); this is a second guard.
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

/**
 * A runner for the top of the clone at `dir`. Refuses a partial clone,
 * whatever the git version. Such a clone can lack objects the check reads,
 * and git either fetches them into the clone or, with lazy fetching off,
 * may skip them: git grep before 2.55 reports a blob it cannot read and
 * still exits 0 or 1, so the names in it would count as absent.
 */
async function cloneRunner(dir) {
  const env = cloneGitEnv();
  const top = await mustGit(createGitRunner(dir, env), ['rev-parse', '--show-toplevel']);
  // Check from the top of the work tree, as check.ts expects.
  const git = failOnObjectErrors(createGitRunner(top, env), `${top} lacks an object at the commits checked, or holds a corrupt`
    + ' one (git fsck there shows which). Use an intact full clone, or --repo or --url.');
  if (await isPartialClone(git)) {
    throw new Error(`${top} is a partial clone (it has a promisor remote), so it can lack objects the check reads,`
      + ' and skill-facts does not read one. Use a full clone (git clone without --filter), or --repo or --url,'
      + ' which make a checkout of their own.');
  }
  return { git, top };
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
 * only read. A partial clone is refused (see cloneRunner). In both, an
 * object git cannot read is an ObjectReadError, never a smaller count.
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
  try {
    let git;
    let commit;
    let baseAvailable = false;
    let where;
    if (upstream.url) {
      if (baseSha !== undefined && !SHA_RE.test(baseSha)) throw new Error(`the base must be a full commit SHA for a fresh checkout, got ${JSON.stringify(baseSha)}`);
      dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'skill-facts-')));
      const co = await prepareUpstreamCheckout({ dir, url: upstream.url, branch: upstream.branch, verifiedSha: baseSha });
      git = failOnObjectErrors(co.git, 'The fresh checkout lacks an object the check reads; run the script again.');
      commit = co.tipSha;
      baseAvailable = co.baseAvailable;
      where = { url: upstream.url, branch: co.defaultBranch, commit };
    } else {
      let top;
      ({ git, top } = await cloneRunner(upstream.checkout));
      const rev = upstream.rev ?? 'HEAD';
      commit = await commitOf(git, rev);
      if (!commit) throw new Error(`${JSON.stringify(rev)} names no commit in ${top}`);
      if (baseSha !== undefined) {
        const resolved = await commitOf(git, baseSha);
        if (resolved) baseSha = resolved;
        baseAvailable = resolved !== null;
      }
      where = { checkout: top, rev, commit };
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
        // An object git cannot read stops the check, as at the commit; any other failure here (a timeout, too much output) leaves no baseline.
        if (err instanceof ObjectReadError) throw err;
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
    : `upstream: checkout ${printable(upstream.checkout)} at ${printable(upstream.rev)} (${short(upstream.commit)})`);
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
