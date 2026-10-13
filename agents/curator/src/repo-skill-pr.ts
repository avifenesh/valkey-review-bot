import { createHash } from 'node:crypto';

/**
 * Repo skills (agents/<reviewer>/config/skill.md) as files of the bot's
 * own repository on GitHub.
 */

const GITHUB_API = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const USER_AGENT = 'valkey-reviewer-curator';
const TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = 1024 * 1024;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

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
