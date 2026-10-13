/**
 * Highest GA release of an upstream repository, read from the public
 * GitHub releases API without credentials.
 *
 * Nothing is stored per repository. The decay pass compares the tag with
 * each graduated record's verified_release, so a day on which the API is
 * unavailable only delays the trigger: the next pass that gets a tag
 * finds the records whose verified_release differs.
 */

/**
 * GA release tags: X.Y.Z with an optional "v". Release candidates
 * (9.2.0-rc1) and prefixed or suffixed tags (rust/v0.9.0, v2.2.9-java)
 * do not match. Tags go through this pattern before they reach a record
 * or a message.
 */
export const RELEASE_TAG_RE = /^v?([0-9]{1,4})[.]([0-9]{1,4})[.]([0-9]{1,4})$/;

/** owner/name, the shape infra/lib/deployment-config.ts accepts for upstreamRepos. */
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Releases read per call. The API lists the newest first. */
export const RELEASE_LIST_PAGE = 50;

const RELEASES_TIMEOUT_MS = 10_000;
const USER_AGENT = 'valkey-reviewer-decay';

/** Whether `repo` is an owner/name that is safe to put in an API path. */
export function isRepoName(repo: string): boolean {
  if (!REPO_RE.test(repo)) return false;
  const name = repo.slice(repo.indexOf('/') + 1);
  return name !== '.' && name !== '..';
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * The highest GA tag in a releases list: drafts, prereleases and tags
 * that do not match RELEASE_TAG_RE are dropped, then the semver maximum
 * wins. The publication date plays no part, so a patch release on an
 * older line (8.1.10 after 9.1.2) does not move it. Null when nothing
 * qualifies.
 */
export function pickReleaseTag(releases: readonly unknown[]): string | null {
  let best: { tag: string; version: readonly number[] } | null = null;
  for (const release of releases) {
    if (typeof release !== 'object' || release === null) continue;
    const { tag_name: tag, draft, prerelease } = release as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (draft !== false || prerelease !== false || typeof tag !== 'string') continue;
    const m = RELEASE_TAG_RE.exec(tag);
    if (!m) continue;
    const version = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag ?? null;
}

/**
 * The highest GA release tag of `repo`, or null when the API is
 * unavailable (rate limits on shared Lambda addresses, 5xx, timeout) or
 * lists no GA release. Every outcome logs one [release] line. Throws
 * only for a malformed repo, before any request is made.
 */
export async function latestReleaseTag(
  repo: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = RELEASES_TIMEOUT_MS,
): Promise<string | null> {
  if (!isRepoName(repo)) throw new Error(`upstream repository must look like "owner/name", got "${repo}"`);

  let releases: unknown;
  try {
    const resp = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=${RELEASE_LIST_PAGE}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (resp.status !== 200) {
      const remaining = resp.headers.get('x-ratelimit-remaining');
      console.warn(`[release] ${repo}: GET releases returned ${resp.status}${remaining === null ? '' : ` ratelimit_remaining=${remaining}`}; no release trigger this pass`);
      return null;
    }
    releases = await resp.json();
  } catch (err) {
    console.warn(`[release] ${repo}: GET releases failed: ${err instanceof Error ? err.message : String(err)}; no release trigger this pass`);
    return null;
  }

  if (!Array.isArray(releases)) {
    console.warn(`[release] ${repo}: GET releases did not return a list; no release trigger this pass`);
    return null;
  }
  const tag = pickReleaseTag(releases);
  if (tag === null) console.warn(`[release] ${repo}: no GA release among the latest ${RELEASE_LIST_PAGE}`);
  else console.log(`[release] ${repo} tag=${tag}`);
  return tag;
}
