import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { fetchRepoFile, gitBlobSha } from '../dist/curator/src/repo-skill-pr.js';

const REPO = 'valkey-io/valkey-review-bot';
const PATH = 'agents/valkey-review/config/skill.md';
const BASE = [
  '# Valkey PR Reviewer Skill',
  '',
  '#### `emptyDB` flags',
  '',
  'Reviewer memory: `emptyDB` must respect `lazyfree_lazy_user_flush`.',
  'Skip unless: the PR touches an `rdbLoad*` caller.',
  '',
].join('\n');

const bytes = (content) => (Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
const blobId = (content) => {
  const b = bytes(content);
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
};
const json = (status, body) => new Response(JSON.stringify(body), { status });

/**
 * An in-memory GitHub repository behind fetch: the commits/{ref} SHA
 * lookup and raw.githubusercontent. Unknown calls fail the test.
 */
function fakeGitHub(files = { [PATH]: BASE, 'README.md': '# bot\n' }) {
  const trees = new Map();
  const commits = new Map();
  const refs = new Map();
  const calls = [];
  let seq = 0;
  const id = (kind) => createHash('sha1').update(`${kind}:${seq++}`).digest('hex');
  const filesAt = (sha) => Object.fromEntries(trees.get(commits.get(sha).tree));
  const addCommit = ({ files: f, parents, message }) => {
    const tree = id('tree');
    trees.set(tree, new Map(Object.entries(f)));
    const sha = id('commit');
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  const gh = {
    calls,
    tip: (branch = 'main') => refs.get(`heads/${branch}`),
    /** Commit `changes` on `branch` and move the branch. */
    commitOn(branch, changes, { message = 'Change something' } = {}) {
      const parent = refs.get(`heads/${branch}`);
      const files = { ...(parent ? filesAt(parent) : {}), ...changes };
      const sha = addCommit({ files, parents: parent ? [parent] : [], message });
      refs.set(`heads/${branch}`, sha);
      return sha;
    },
    async fetch(url, init = {}) {
      const method = init.method ?? 'GET';
      const u = new URL(url);
      calls.push({ method, host: u.host, path: u.pathname + u.search, headers: init.headers ?? {} });
      if (u.host === 'raw.githubusercontent.com') {
        const [, owner, name, sha, ...rest] = u.pathname.split('/');
        const file = `${owner}/${name}` === REPO && commits.has(sha) ? filesAt(sha)[rest.map(decodeURIComponent).join('/')] : undefined;
        return file === undefined ? new Response('404: Not Found', { status: 404 }) : new Response(bytes(file), { status: 200 });
      }
      assert.equal(u.host, 'api.github.com');
      const prefix = `/repos/${REPO}/`;
      if (!u.pathname.startsWith(prefix)) return json(404, { message: 'Not Found' });
      const rest = u.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
      let m;
      if (method === 'GET' && (m = /^commits\/(.+)$/.exec(rest))) {
        assert.equal(init.headers.Accept, 'application/vnd.github.sha');
        const sha = refs.get(`heads/${m[1]}`) ?? (commits.has(m[1]) ? m[1] : null);
        return sha ? new Response(sha, { status: 200 }) : json(404, { message: 'No commit found' });
      }
      throw new Error(`unexpected GitHub call ${method} ${rest}`);
    },
  };
  gh.commitOn('main', files, { message: 'Initial commit' });
  return gh;
}

const NO_GITHUB = { async fetch(url) { throw new Error(`unexpected fetch ${url}`); } };

test('gitBlobSha is git\'s blob id', () => {
  assert.equal(gitBlobSha(''), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  assert.equal(gitBlobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(gitBlobSha('é\n'), blobId('é\n'));
});

test('fetchRepoFile resolves a branch to its commit anonymously and reads the file there', async () => {
  const gh = fakeGitHub();
  const tip = gh.tip();
  assert.deepEqual(await fetchRepoFile(REPO, 'main', PATH, { fetch: gh.fetch }), { sha: tip, content: BASE });
  assert.deepEqual(gh.calls.map((c) => `${c.host}${c.path}`), [
    `api.github.com/repos/${REPO}/commits/main`,
    `raw.githubusercontent.com/${REPO}/${tip}/${PATH}`,
  ]);
  assert.ok(gh.calls.every((c) => c.headers.Authorization === undefined));
  // At a commit there is nothing to resolve.
  gh.commitOn('main', { [PATH]: `${BASE}more\n` });
  assert.deepEqual(await fetchRepoFile(REPO, tip, PATH, { fetch: gh.fetch }), { sha: tip, content: BASE });
  assert.equal(gh.calls.length, 3);
});

test('fetchRepoFile returns null for a missing file and throws for a missing ref or bad input', async () => {
  const gh = fakeGitHub();
  assert.equal(await fetchRepoFile(REPO, 'main', 'agents/new-review/config/skill.md', { fetch: gh.fetch }), null);
  await assert.rejects(fetchRepoFile(REPO, 'no-such-branch', PATH, { fetch: gh.fetch }), /has no ref no-such-branch/);
  await assert.rejects(fetchRepoFile('not-a-repo', 'main', PATH, NO_GITHUB), /repo must be "owner\/name"/);
  await assert.rejects(fetchRepoFile(REPO, 'a..b', PATH, NO_GITHUB), /is not a branch, tag or commit/);
  for (const path of ['../x', '/etc/passwd', 'a//b', '']) {
    await assert.rejects(fetchRepoFile(REPO, 'main', path, NO_GITHUB), /is not a repository file path/, path);
  }
});

test('fetchRepoFile keeps a BOM, so the blob id matches, and refuses text that is not UTF-8', async () => {
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BASE)]);
  const gh = fakeGitHub({ [PATH]: withBom, 'bad.md': Buffer.from([0x66, 0xff, 0x0a]) });
  const file = await fetchRepoFile(REPO, 'main', PATH, { fetch: gh.fetch });
  assert.equal(gitBlobSha(file.content), blobId(withBom));
  await assert.rejects(fetchRepoFile(REPO, 'main', 'bad.md', { fetch: gh.fetch }), /is not UTF-8 text/);
});
