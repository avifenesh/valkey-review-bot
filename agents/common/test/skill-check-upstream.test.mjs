import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// No resolve hook: the module must load under plain type stripping, as scripts load it.
const { createGitRunner, createLineResolver, prepareUpstreamCheckout, removeCheckout, upstreamGitEnv } = await import('../src/skill-check/upstream.ts');

const tempDir = (prefix) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
const cleanEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
};
const gitIn = (dir) => (...args) => execFileSync('git', args, { cwd: dir, env: cleanEnv, encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * A bare upstream whose default branch is `unstable`, served over file://
 * with filters and fetch-by-SHA allowed, holding a base and a tip commit,
 * plus a `release-1.0` branch.
 */
function makeUpstream() {
  const root = tempDir('skc-upstream-');
  const bare = path.join(root, 'upstream.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: cleanEnv });
  const b = gitIn(bare);
  b('symbolic-ref', 'HEAD', 'refs/heads/unstable');
  b('config', 'uploadpack.allowFilter', 'true');
  b('config', 'uploadpack.allowAnySHA1InWant', 'true');
  mkdirSync(work);
  const w = gitIn(work);
  w('init', '-q', '-b', 'unstable');
  mkdirSync(path.join(work, 'src'));
  writeFileSync(path.join(work, 'src', 'db.c'), 'void emptyDB(int flags) {\n    (void)flags;\n}\n');
  writeFileSync(path.join(work, 'src', 'old.c'), 'int removed_later = 1;\n');
  w('add', '.');
  w('commit', '-q', '-m', 'base');
  const baseSha = w('rev-parse', 'HEAD');
  w('branch', 'release-1.0');
  writeFileSync(path.join(work, 'src', 'db.c'), 'void emptyData(int flags) {\n    (void)flags;\n}\n');
  rmSync(path.join(work, 'src', 'old.c'));
  w('add', '-A');
  w('commit', '-q', '-m', 'tip');
  const tipSha = w('rev-parse', 'HEAD');
  // A commit the checkout never fetches.
  w('checkout', '-q', '-b', 'side', baseSha);
  writeFileSync(path.join(work, 'src', 'side.c'), 'int side;\n');
  w('add', '-A');
  w('commit', '-q', '-m', 'side');
  const sideSha = w('rev-parse', 'HEAD');
  w('remote', 'add', 'origin', bare);
  w('push', '-q', 'origin', 'unstable', 'release-1.0', 'side');
  return { root, url: `file://${bare}`, baseSha, tipSha, sideSha };
}

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/**
 * An environment whose `git` drops GIT_NO_LAZY_FETCH, as git before 2.44
 * ignores it, and fails (mode 'fail') or stalls (mode 'stall') any fetch
 * that names `base`. In mode 'stall-writer' the stalled fetch also starts
 * a child that appends a line to `root`/writer.log every 100 ms for 10 s.
 */
function oldGitEnv(root, base, mode) {
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'unset GIT_NO_LAZY_FETCH',
    'if [ "$1" = fetch ]; then',
    '  for a in "$@"; do',
    '    if [ "$a" = "$SKC_BASE" ]; then',
    '      [ "$SKC_MODE" = stall ] && exec sleep 30',
    '      if [ "$SKC_MODE" = stall-writer ]; then',
    '        ( i=0; while [ $i -lt 100 ]; do echo x >> "$SKC_WRITER_LOG"; i=$((i + 1)); sleep 0.1; done ) &',
    '        exec sleep 30',
    '      fi',
    '      echo "fatal: simulated network failure" >&2',
    '      exit 128',
    '    fi',
    '  done',
    'fi',
    'exec "$SKC_REAL_GIT" "$@"',
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    ...upstreamGitEnv(), PATH: `${bin}:${process.env.PATH}`,
    SKC_BASE: base, SKC_MODE: mode, SKC_REAL_GIT: REAL_GIT, SKC_WRITER_LOG: path.join(root, 'writer.log'),
  };
}

test('the checkout finds the default branch, fetches tip and base at depth 1 and detaches at the tip', async () => {
  const up = makeUpstream();
  const dir = path.join(up.root, 'checkout');
  const co = await prepareUpstreamCheckout({ dir, url: up.url, verifiedSha: up.baseSha });
  assert.equal(co.defaultBranch, 'unstable');
  assert.equal(co.tipSha, up.tipSha);
  assert.equal(co.baseAvailable, true);

  const g = gitIn(dir);
  assert.equal(g('rev-parse', 'HEAD'), up.tipSha);
  assert.throws(() => g('symbolic-ref', '-q', 'HEAD'), 'HEAD is detached');
  assert.equal(readFileSync(path.join(dir, 'src', 'db.c'), 'utf8').includes('emptyData'), true);
  assert.equal(existsSync(path.join(dir, 'src', 'old.c')), false);
  assert.equal(g('rev-list', '--count', 'HEAD'), '1', 'depth 1');
  assert.deepEqual(readFileSync(path.join(dir, '.git', 'shallow'), 'utf8').trim().split('\n').sort(), [up.baseSha, up.tipSha].sort());
  assert.equal(existsSync(path.join(dir, '.git', 'hooks')), false, 'no template hooks');

  // The base's blobs of the changed files came in their batch, so the diff works.
  const diff = await co.git(['diff', '--no-color', up.baseSha, up.tipSha, '--']);
  assert.equal(diff.code, 0, diff.stderr);
  assert.match(diff.stdout, /^-void emptyDB\(int flags\) \{$/m);
  assert.match(diff.stdout, /^-int removed_later = 1;$/m);

  // No longer a partial clone: a missing object is an error, not a fetch.
  for (const key of ['remote.origin.promisor', 'remote.origin.partialclonefilter', 'extensions.partialClone']) {
    assert.equal((await co.git(['config', '--get', key])).code, 1, key);
  }
  assert.notEqual((await co.git(['cat-file', '-e', `${up.sideSha}^{commit}`])).code, 0, 'the side commit was fetched');
  assert.notEqual((await co.git(['rev-list', '-n', '1', 'HEAD~1'])).code, 0, 'history past depth 1 was fetched');

  // The runner it returns works in the checkout.
  assert.equal((await co.git(['rev-parse', 'HEAD'])).stdout.trim(), up.tipSha);
  await removeCheckout(up.root);
});

test('a failed base fetch gives baseAvailable false even where git ignores GIT_NO_LAZY_FETCH', async () => {
  const up = makeUpstream();
  const env = oldGitEnv(up.root, up.baseSha, 'fail');
  const co = await prepareUpstreamCheckout({ dir: path.join(up.root, 'checkout'), url: up.url, verifiedSha: up.baseSha, env });
  assert.equal(co.baseAvailable, false);
  assert.equal(co.tipSha, up.tipSha);
  // The same old git does not fetch the base when asked for it later.
  assert.notEqual((await co.git(['cat-file', '-e', `${up.baseSha}^{commit}`])).code, 0);
  await removeCheckout(up.root);
});

test('a base fetch that stalls times out to baseAvailable false and the checkout still succeeds', { timeout: 20_000 }, async () => {
  const up = makeUpstream();
  const env = oldGitEnv(up.root, up.baseSha, 'stall');
  const started = Date.now();
  const co = await prepareUpstreamCheckout({ dir: path.join(up.root, 'checkout'), url: up.url, verifiedSha: up.baseSha, env, baseTimeoutMs: 500 });
  assert.ok(Date.now() - started < 10_000);
  assert.equal(co.baseAvailable, false);
  assert.equal(gitIn(path.join(up.root, 'checkout'))('rev-parse', 'HEAD'), up.tipSha);
  await removeCheckout(up.root);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sizeOf = (file) => (existsSync(file) ? readFileSync(file).length : 0);

test('a base fetch that times out is killed with everything it started', { timeout: 20_000 }, async () => {
  const up = makeUpstream();
  const env = oldGitEnv(up.root, up.baseSha, 'stall-writer');
  const co = await prepareUpstreamCheckout({ dir: path.join(up.root, 'checkout'), url: up.url, verifiedSha: up.baseSha, env, baseTimeoutMs: 500 });
  assert.equal(co.baseAvailable, false);
  const log = env.SKC_WRITER_LOG;
  assert.ok(sizeOf(log) > 0, 'the writer ran');
  const before = sizeOf(log);
  await sleep(600);
  assert.equal(sizeOf(log), before, 'a child of the stalled fetch kept writing');
  await removeCheckout(up.root);
});

test('an unknown verified SHA leaves baseAvailable false and still checks out the tip', async () => {
  const up = makeUpstream();
  const dir = path.join(up.root, 'checkout');
  const co = await prepareUpstreamCheckout({ dir, url: up.url, verifiedSha: 'f'.repeat(40) });
  assert.equal(co.baseAvailable, false);
  assert.equal(co.tipSha, up.tipSha);
  assert.equal(gitIn(dir)('rev-parse', 'HEAD'), up.tipSha);
  await removeCheckout(up.root);
});

test('without a verified SHA there is no base; a malformed one is not fetched', async () => {
  const up = makeUpstream();
  const a = await prepareUpstreamCheckout({ dir: path.join(up.root, 'a'), url: up.url });
  assert.equal(a.baseAvailable, false);
  const b = await prepareUpstreamCheckout({ dir: path.join(up.root, 'b'), url: up.url, verifiedSha: '--upload-pack=touch /tmp/x' });
  assert.equal(b.baseAvailable, false);
  await removeCheckout(up.root);
});

test('the tip itself as the verified SHA counts as available', async () => {
  const up = makeUpstream();
  const co = await prepareUpstreamCheckout({ dir: path.join(up.root, 'c'), url: up.url, verifiedSha: up.tipSha });
  assert.equal(co.baseAvailable, true);
  await removeCheckout(up.root);
});

test('a named branch is checked instead of the default one', async () => {
  const up = makeUpstream();
  const dir = path.join(up.root, 'checkout');
  const co = await prepareUpstreamCheckout({ dir, url: up.url, branch: 'release-1.0' });
  assert.equal(co.defaultBranch, 'release-1.0');
  assert.equal(co.tipSha, up.baseSha);
  assert.equal(existsSync(path.join(dir, 'src', 'old.c')), true);
  await assert.rejects(prepareUpstreamCheckout({ dir: path.join(up.root, 'x'), url: up.url, branch: 'no-such-branch' }), /has no branch no-such-branch/);
  await assert.rejects(prepareUpstreamCheckout({ dir: path.join(up.root, 'y'), url: up.url, branch: '--upload-pack=x' }), /invalid branch name/);
  await removeCheckout(up.root);
});

test('bad URLs and non-empty directories are refused before git runs', async () => {
  const root = tempDir('skc-refuse-');
  for (const url of ['https://user:pw@github.com/valkey-io/valkey.git', 'ext::sh -c touch% /tmp/pwned', 'git@github.com:valkey-io/valkey.git', 'http://github.com/a/b.git']) {
    await assert.rejects(prepareUpstreamCheckout({ dir: path.join(root, 'd'), url }), /upstream URL must be/, url);
  }
  writeFileSync(path.join(root, 'file'), 'x');
  await assert.rejects(prepareUpstreamCheckout({ dir: root, url: 'https://github.com/valkey-io/valkey.git' }), /not empty/);
  rmSync(root, { recursive: true, force: true });
});

test('removeCheckout deletes the directory and refuses a root or a relative path', async () => {
  const dir = tempDir('skc-remove-');
  mkdirSync(path.join(dir, 'a', 'b'), { recursive: true });
  writeFileSync(path.join(dir, 'a', 'b', 'f'), 'x');
  await removeCheckout(dir);
  assert.equal(existsSync(dir), false);
  await removeCheckout(dir); // already gone
  await assert.rejects(removeCheckout('/'), /refusing/);
  await assert.rejects(removeCheckout('relative/dir'), /refusing/);
});

test('the git environment drops credentials and inherited git settings', () => {
  const env = upstreamGitEnv({
    PATH: '/usr/bin', HOME: '/home/x',
    AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't', GITHUB_TOKEN: 'g', GH_TOKEN: 'h', MY_API_TOKEN: 'm', DB_PASSWORD: 'p',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor', GIT_CONFIG_VALUE_0: 'touch /tmp/x', GIT_DIR: '/elsewhere', GIT_ASKPASS: '/bin/echo',
  });
  assert.deepEqual(env, {
    PATH: '/usr/bin', HOME: '/home/x',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '60',
  });
});

test('the runner passes that environment to git and ignores a gitconfig in HOME', async () => {
  const dir = tempDir('skc-runner-');
  const home = tempDir('skc-home-');
  writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = planted\n');
  gitIn(dir)('init', '-q');
  const saved = { HOME: process.env.HOME, GITHUB_TOKEN: process.env.GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY };
  process.env.HOME = home;
  process.env.GITHUB_TOKEN = 'ghs_secret';
  process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret';
  try {
    const git = createGitRunner(dir);
    const name = await git(['config', '--get', 'user.name']);
    assert.equal(name.code, 1, 'user.name from HOME was read');
    // A shell alias defined on the command line prints what git's children see.
    const env = await git(['-c', 'alias.printenv=!env', 'printenv']);
    assert.equal(env.code, 0);
    assert.doesNotMatch(env.stdout, /ghs_secret|aws_secret/);
    assert.match(env.stdout, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the runner returns exit codes, marks output past the cap and throws on a timeout', async () => {
  const dir = tempDir('skc-runner2-');
  const g = gitIn(dir);
  g('init', '-q');
  writeFileSync(path.join(dir, 'big.txt'), 'x'.repeat(200_000));
  g('add', 'big.txt');
  g('commit', '-q', '-m', 'big');
  const git = createGitRunner(dir);
  assert.equal((await git(['cat-file', '-e', 'HEAD:missing'])).code, 128);
  const cut = await git(['cat-file', 'blob', 'HEAD:big.txt'], { maxBytes: 1000 });
  assert.equal(cut.truncated, true);
  assert.ok(cut.stdout.length <= 1000);
  await assert.rejects(git(['-c', 'alias.wait=!sleep 5', 'wait'], { timeoutMs: 200 }), { message: 'git wait timed out after 0s' });
  rmSync(dir, { recursive: true, force: true });
});

test('the runner kills what git started when the output passes the cap, or when git leaves it running', { timeout: 20_000 }, async () => {
  const dir = tempDir('skc-runner3-');
  gitIn(dir)('init', '-q');
  const git = createGitRunner(dir);
  const marker = path.join(dir, 'late');
  // A child that would write a file later, and output past the cap.
  const cut = await git(['-c', `alias.flood=!(sleep 0.5; touch ${marker}) & yes`, 'flood'], { maxBytes: 1000 });
  assert.equal(cut.truncated, true);
  assert.equal(cut.stdout.length, 1000);
  // A child that holds git's output after git exits.
  const started = Date.now();
  const left = await git(['-c', `alias.leave=!(sleep 5; echo late; touch ${marker}) & echo early`, 'leave']);
  assert.deepEqual({ code: left.code, stdout: left.stdout }, { code: 0, stdout: 'early\n' });
  assert.ok(Date.now() - started < 4_000, 'waited for the child that held the output');
  await sleep(800);
  assert.equal(existsSync(marker), false, 'a child git started outlived the call');
  rmSync(dir, { recursive: true, force: true });
});

test('output that arrives after git exits is kept when the grace period kills what git left', { timeout: 20_000 }, async (t) => {
  const dir = tempDir('skc-runner4-');
  gitIn(dir)('init', '-q');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const call = createGitRunner(dir)(['-c', 'alias.late=!echo early; (sleep 0.6; echo late; sleep 5) &', 'late']);
  // Let git print and exit while the event loop runs.
  for (const until = Date.now() + 300; Date.now() < until;) await new Promise((r) => setImmediate(r));
  // Block the loop while the child writes, so its line waits in the pipe, then end the grace period.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
  t.mock.timers.tick(2_000);
  const r = await call;
  assert.deepEqual({ code: r.code, stdout: r.stdout }, { code: 0, stdout: 'early\nlate\n' });
  rmSync(dir, { recursive: true, force: true });
});

test('the line resolver reads cited lines at the checked commit only', async () => {
  const up = makeUpstream();
  const dir = path.join(up.root, 'checkout');
  const co = await prepareUpstreamCheckout({ dir, url: up.url });
  const resolve = createLineResolver(co.git, { repo: 'valkey-io/valkey', sha: co.tipSha });
  const at = (p, line, extra = {}) => resolve({ repo: 'valkey-io/valkey', sha: co.tipSha, path: p, line, ...extra });
  assert.equal(await at('src/db.c', 1), 'void emptyData(int flags) {');
  assert.equal(await at('src/db.c', 3), '}');
  assert.equal(await at('src/db.c', 4), null, 'past the end');
  assert.equal(await at('src/db.c', 0), null);
  assert.equal(await at('src/old.c', 1), null, 'not at this commit');
  assert.equal(await at('../outside', 1), null);
  assert.equal(await at('/etc/passwd', 1), null);
  assert.equal(await at('src/db.c', 1, { sha: up.baseSha }), null, 'another commit');
  assert.equal(await at('src/db.c', 1, { repo: 'someone/else' }), null, 'another repository');
  assert.equal(await at('src/db.c', 1, { repo: 'Valkey-IO/Valkey' }), 'void emptyData(int flags) {', 'owner and name are case-insensitive');
  assert.throws(() => createLineResolver(co.git, { repo: 'a/b', sha: 'HEAD' }), /full commit SHA/);
  await removeCheckout(up.root);
});

test('edit evidence is verified against the checkout', async () => {
  const { validateEdits } = await import('../src/skill-check/edits.ts');
  const up = makeUpstream();
  const co = await prepareUpstreamCheckout({ dir: path.join(up.root, 'checkout'), url: up.url });
  const repo = 'valkey-io/valkey';
  const resolve = createLineResolver(co.git, { repo, sha: co.tipSha });
  const skillMd = '---\nname: s\ndescription: "x"\n---\n\nCall `emptyDB` on flush.\n';
  const ctx = { flagged: ['emptyDB'], release: '9.1.2', date: '2026-10-13', upstream: { repo, sha: co.tipSha } };
  const edit = (line) => ({
    original: 'Call `emptyDB` on flush.',
    replacement: 'Call `emptyData` on flush.',
    evidence: [{ repo, sha: co.tipSha, path: 'src/db.c', line }],
  });
  const ok = await validateEdits(skillMd, [edit(1)], ctx, resolve);
  assert.deepEqual(ok.problems, []);
  assert.match(ok.skillMd, new RegExp(`evidence: ${repo}@${co.tipSha}:src/db.c:1 -->\nCall \`emptyDB\` on flush.\n<!-- /suppressed -->\nCall \`emptyData\` on flush.\n$`));
  assert.deepEqual((await validateEdits(skillMd, [edit(2)], ctx, resolve)).problems, [
    `edit 1: evidence ${repo}@${co.tipSha}:src/db.c:2: the line supports none of the changed names`,
    'edit 1: no cited line contains `emptyData`',
  ]);
  await removeCheckout(up.root);
});
