import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { factsJson, factsReport, skillFacts } from '../lib/skill-facts.mjs';
import { fakeAwsCli, flag, runScript, tempDir, typed } from './support/aws.mjs';
import { fakeRegistry, registryEnv } from './support/registry.mjs';

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
};
const gitIn = (dir) => (...args) => execFileSync('git', args, { cwd: dir, env: gitEnv, encoding: 'utf8', stdio: 'pipe' }).trim();

/**
 * A bare upstream on `unstable`, served over file:// with filters and
 * fetch-by-SHA allowed. Between base and tip, emptyDB is renamed
 * emptyData (rdbLoad stays on a changed line) and src/old.c is removed.
 * `work` is a full clone at the tip.
 */
function makeUpstream() {
  const root = tempDir('facts-upstream-');
  const bare = path.join(root, 'upstream.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', bare], { env: gitEnv });
  const b = gitIn(bare);
  b('symbolic-ref', 'HEAD', 'refs/heads/unstable');
  b('config', 'uploadpack.allowFilter', 'true');
  b('config', 'uploadpack.allowAnySHA1InWant', 'true');
  mkdirSync(work);
  const w = gitIn(work);
  w('init', '-q', '-b', 'unstable');
  mkdirSync(path.join(work, 'src'));
  writeFileSync(path.join(work, 'src', 'db.c'), 'void emptyDB(int flags);\nint rdbLoad(void) { return 0; }\n');
  writeFileSync(path.join(work, 'src', 'old.c'), 'int old_counter = 1;\n');
  writeFileSync(path.join(work, 'src', 'config.c'), 'static int lazyfree_lazy_user_flush; /* lazyfree-lazy-user-flush */\n');
  w('add', '.');
  w('commit', '-q', '-m', 'base');
  const baseSha = w('rev-parse', 'HEAD');
  writeFileSync(path.join(work, 'src', 'db.c'), 'void emptyData(int flags);\nint rdbLoad(void) { return 1; }\n');
  rmSync(path.join(work, 'src', 'old.c'));
  w('add', '-A');
  w('commit', '-q', '-m', 'tip');
  const tipSha = w('rev-parse', 'HEAD');
  w('push', '-q', bare, 'unstable');
  return { root, url: `file://${bare}`, work, baseSha, tipSha };
}

const SKILL = [
  '---',
  'name: rdb-load',
  'description: "Use when a PR touches src/db.c."',
  '---',
  '',
  '## Use when',
  '',
  'The diff calls `emptyDB` or `rdbLoad`, or reads `old_counter` in `src/old.c`.',
  'The flush honours `lazyfree-lazy-user-flush`. `not_in_upstream` is prose.',
  '',
  '```',
  '`placeholder_name` in a fenced block is not a name',
  '```',
  '',
].join('\n');
const CLEAN = '---\nname: ok\ndescription: "Use when touching src/db.c."\n---\n\nCalls `rdbLoad` in `src/db.c`.\n';

const up = makeUpstream();
test.after(() => rmSync(up.root, { recursive: true, force: true }));

const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('skill-facts-'));

test('a fresh checkout of the default branch: absent names are new without a base, and it is removed afterwards', async () => {
  const before = leftovers();
  const facts = await skillFacts({ skillMd: SKILL, upstream: { url: up.url } });
  assert.deepEqual(leftovers(), before, 'the temporary checkout is deleted');
  assert.deepEqual(facts.upstream, { url: up.url, branch: 'unstable', commit: up.tipSha });
  assert.equal(facts.base, null);
  assert.equal(facts.baseline.from, 'none');
  assert.deepEqual(facts.names.map((n) => n.token), ['src/db.c', 'emptyDB', 'rdbLoad', 'old_counter', 'src/old.c', 'lazyfree-lazy-user-flush', 'not_in_upstream']);
  assert.deepEqual(facts.result.lost, []);
  assert.deepEqual(facts.result.newAbsent, ['emptyDB', 'old_counter', 'src/old.c', 'not_in_upstream']);
  assert.deepEqual(facts.result.touched, []);
  assert.equal(facts.result.clean, false);
});

test('with a base, the names present there are the baseline: lost and touched are reported', async () => {
  const facts = await skillFacts({ skillMd: SKILL, upstream: { url: up.url }, base: up.baseSha });
  assert.deepEqual(facts.base, { sha: up.baseSha, available: true });
  assert.equal(facts.baseline.from, 'base');
  assert.deepEqual(facts.baseline.names, ['src/db.c', 'emptyDB', 'rdbLoad', 'old_counter', 'src/old.c', 'lazyfree-lazy-user-flush']);
  assert.deepEqual(facts.result.lost, ['emptyDB', 'old_counter', 'src/old.c']);
  assert.deepEqual(facts.result.newAbsent, ['not_in_upstream']);
  assert.deepEqual(facts.result.touched, ['src/db.c', 'rdbLoad']);
  assert.equal(facts.result.keptFraction, 0.5);
});

test('a concern record supplies the baseline, ignored names, the base and the area, as in the curator', async () => {
  const record = {
    audit_names: ['emptyDB', 'rdbLoad', 'no_longer_cited'],
    ignored_names: ['not_in_upstream'],
    verified_sha: up.baseSha,
    area: ['src/*.c', 'gone/**'],
  };
  const facts = await skillFacts({ skillMd: SKILL, upstream: { url: up.url }, record });
  assert.equal(facts.baseline.from, 'record');
  assert.deepEqual(facts.baseline.names, ['emptyDB', 'rdbLoad'], 'names the skill no longer cites do not count');
  assert.deepEqual(facts.result.lost, ['emptyDB']);
  assert.deepEqual(facts.result.newAbsent, ['old_counter', 'src/old.c'], 'ignored names are not reported');
  assert.deepEqual(facts.result.touched, ['src/db.c', 'rdbLoad']);
  assert.deepEqual(facts.area, [{ glob: 'src/*.c', files: 2 }, { glob: 'gone/**', files: 0 }]);
  const lines = factsReport(facts, { label: 'rdb-load' });
  assert.ok(lines.includes("baseline: 2 name(s), the concern record's audit_names"));
  assert.ok(lines.includes('area: `src/*.c` 2 file(s), `gone/**` 0 file(s)'));

  const odd = await skillFacts({ skillMd: SKILL, upstream: { url: up.url }, record: { ...record, verified_sha: 'not-a-sha' } });
  assert.equal(odd.base, null, 'a malformed verified_sha is no base, not an error');
  assert.deepEqual(odd.result.lost, ['emptyDB']);
});

test('an existing clone is read at --rev; a base it lacks is reported as not available', async () => {
  const atBase = await skillFacts({ skillMd: SKILL, upstream: { checkout: path.join(up.work, 'src'), rev: up.baseSha } });
  assert.deepEqual(atBase.upstream, { checkout: up.work, rev: up.baseSha, commit: up.baseSha }, 'from the top of the work tree');
  assert.deepEqual(atBase.result.newAbsent, ['not_in_upstream']);

  const head = await skillFacts({ skillMd: SKILL, upstream: { checkout: up.work }, base: 'HEAD~1' });
  assert.deepEqual(head.base, { sha: up.baseSha, available: true }, 'a revision is resolved to its commit');
  assert.deepEqual(head.result.lost, ['emptyDB', 'old_counter', 'src/old.c']);

  const missing = await skillFacts({ skillMd: SKILL, upstream: { checkout: up.work }, base: 'f'.repeat(40) });
  assert.deepEqual(missing.base, { sha: 'f'.repeat(40), available: false });
  assert.equal(missing.result.compared, false);
  assert.ok(factsReport(missing, { label: 'x' }).includes(`base: "${'f'.repeat(40)}" is not available here, so no names are touched`));

  await assert.rejects(skillFacts({ skillMd: SKILL, upstream: { checkout: up.work, rev: '--output=x' } }), /names no commit/);
  await assert.rejects(skillFacts({ skillMd: SKILL, upstream: { url: up.url }, base: 'HEAD~1' }), /must be a full commit SHA for a fresh checkout/);
});

let partialClones = 0;
/** A blob:none clone of the upstream: it holds the tip's blobs, which its checkout fetched, and no others. */
function partialClone() {
  const dir = path.join(up.root, `partial-${partialClones++}`);
  execFileSync('git', ['clone', '-q', '--filter=blob:none', '--branch', 'unstable', up.url, dir], { env: gitEnv });
  assert.equal(gitIn(dir)('config', 'remote.origin.promisor'), 'true');
  return dir;
}
/** The objects of a clone: its packs and loose object directories. */
const objects = (dir) => {
  const root = path.join(dir, '.git', 'objects');
  return readdirSync(root).flatMap((d) => (d === 'info' ? [] : readdirSync(path.join(root, d)).map((f) => `${d}/${f}`))).sort();
};

const PARTIAL_RE = /is a partial clone \(it has a promisor remote\), so it can lack objects the check reads, and skill-facts does not read one\. Use a full clone/;

test('a partial clone is refused before any read, with any git version, and nothing is fetched into it', async () => {
  // Git 2.44 to 2.54 with lazy fetching off: git grep reports a blob it lacks and goes on, so a read would be silently wrong.
  const dir = partialClone();
  const before = objects(dir);
  for (const input of [
    { upstream: { checkout: dir } },
    { upstream: { checkout: path.join(dir, 'src') } },
    { upstream: { checkout: dir, rev: up.baseSha } },
    { upstream: { checkout: dir }, base: up.baseSha },
  ]) {
    await assert.rejects(skillFacts({ skillMd: SKILL, ...input }), PARTIAL_RE);
  }
  assert.deepEqual(objects(dir), before, 'no object was fetched into the clone');

  // A remote with only a filter set is a promisor remote too; so is extensions.partialClone alone.
  const g = gitIn(dir);
  g('config', '--unset', 'remote.origin.promisor');
  await assert.rejects(skillFacts({ skillMd: SKILL, upstream: { checkout: dir } }), PARTIAL_RE);
  g('config', '--unset', 'remote.origin.partialclonefilter');
  g('config', 'extensions.partialClone', 'origin');
  await assert.rejects(skillFacts({ skillMd: SKILL, upstream: { checkout: dir } }), PARTIAL_RE);
  assert.deepEqual(objects(dir), before);
});

test('skill-facts.mjs refuses a partial clone and prints no result', async () => {
  const dir = partialClone();
  const before = objects(dir);
  const file = path.join(up.root, 'partial-skill.md');
  writeFileSync(file, SKILL);
  const refused = await runScript('skill-facts.mjs', ['--file', file, '--checkout', dir]);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, PARTIAL_RE);
  assert.equal(refused.stdout, '');
  assert.deepEqual(objects(dir), before);
  const full = await runScript('skill-facts.mjs', ['--file', file, '--checkout', up.work]);
  assert.equal(full.code, 2, `a full clone is read: ${full.stderr}`);
});

test('the report lists every cited name with --names, and the JSON carries the excerpts', async () => {
  const facts = await skillFacts({ skillMd: SKILL, upstream: { url: up.url }, base: up.baseSha });
  const lines = factsReport(facts, { label: 'skill.md', allNames: true });
  assert.equal(lines[0], 'skill: skill.md');
  assert.equal(lines[1], `upstream: ${up.url} unstable@${up.tipSha.slice(0, 12)}`);
  assert.ok(lines.includes('lost (3): `emptyDB`, `old_counter`, `src/old.c`'));
  assert.ok(lines.includes('touched (2): `src/db.c`, `rdbLoad`'));
  assert.ok(lines.includes('clean: no'));
  const table = lines.slice(lines.indexOf('state      kind       count  name') + 1);
  assert.deepEqual(table.map((l) => l.split(/\s+/)), [
    ['touched', 'path', '1', 'src/db.c'],
    ['lost', 'symbol', '0', 'emptyDB'],
    ['touched', 'symbol', '1', 'rdbLoad'],
    ['lost', 'symbol', '0', 'old_counter'],
    ['lost', 'path', '0', 'src/old.c'],
    ['present', 'config', '1', 'lazyfree-lazy-user-flush'],
    ['absent', 'symbol', '0', 'not_in_upstream'],
  ]);
  const json = factsJson(facts, { label: 'skill.md' });
  assert.equal(json.clean, false);
  assert.ok(json.excerpts.some((e) => e.path === 'src/db.c' && e.hunk.includes('-void emptyDB(int flags);')));
  assert.deepEqual(json.names[1], { token: 'emptyDB', kind: 'symbol', count: 0 });
});

const UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

test('the report shows no control, escape or format character from the record, the upstream or git', () => {
  // A record's area globs are written by the curator model; the branch comes from the remote.
  const evil = 'x\u001b[2J\u202e\u200b\u009by';
  const facts = {
    names: [{ token: `name${evil}`, kind: `symbol${evil}` }],
    result: {
      present: [], lost: [`lost${evil}`], newAbsent: [`new${evil}`], touched: [], incomplete: [`git said ${evil}\nclean: yes`],
      keptFraction: 0, changedFiles: 0, counts: new Map(), clean: false,
    },
    upstream: { url: 'file:///up.git', branch: `main${evil}`, commit: 'a'.repeat(40) },
    base: null,
    baseline: { from: 'none', names: [], error: `bad object ${evil}` },
    ignored: [],
    area: [{ glob: `src/${evil}*.c`, files: 1 }],
  };
  const lines = factsReport(facts, { label: `skill${evil}.md`, allNames: true });
  for (const line of lines) assert.ok(!UNSAFE_RE.test(line), JSON.stringify(line));
  const shown = 'x?[2J???y';
  assert.ok(lines.includes(`area: \`src/${shown}*.c\` 1 file(s)`));
  assert.ok(lines.includes(`incomplete: git said ${shown} clean: yes`), 'one line, so it cannot pose as the verdict');
  assert.ok(!lines.includes('clean: yes'));
  for (const text of [`skill: skill${shown}.md`, `upstream: file:///up.git main${shown}@aaaaaaaaaaaa`, `lost (1): \`lost${shown}\``]) {
    assert.ok(lines.includes(text), text);
  }
  assert.ok(lines.some((l) => l.includes(`bad object ${shown}`)));
  assert.match(lines.at(-1), new RegExp(`^absent +symbol${shown.replace(/[?[]/g, '\\$&')} +0  name${shown.replace(/[?[]/g, '\\$&')}$`));
});

const write = (dir, name, text) => {
  const file = path.join(dir, name);
  writeFileSync(file, text);
  return file;
};

test('skill-facts.mjs exits 0 for a clean skill and 2 for a stale one', async () => {
  const dir = tempDir('facts-cli-');
  const clean = await runScript('skill-facts.mjs', ['--file', write(dir, 'clean.md', CLEAN), '--url', up.url]);
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /^clean: yes$/m);

  const stale = await runScript('skill-facts.mjs', ['--file', write(dir, 'skill.md', SKILL), '--checkout', up.work, '--base', up.baseSha]);
  assert.equal(stale.code, 2, stale.stderr);
  assert.match(stale.stdout, /^lost \(3\): `emptyDB`, `old_counter`, `src\/old\.c`$/m);
  assert.match(stale.stdout, /^new absent \(1\): `not_in_upstream`$/m);

  const json = await runScript('skill-facts.mjs', ['--file', path.join(dir, 'skill.md'), '--url', up.url, '--json']);
  assert.equal(json.code, 2, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).newAbsent, ['emptyDB', 'old_counter', 'src/old.c', 'not_in_upstream']);
  rmSync(dir, { recursive: true, force: true });
});

test('skill-facts.mjs prints the JSON as plain ASCII, the same data', async () => {
  const dir = tempDir('facts-cli-');
  const file = write(dir, 'skill\u202e\u0085.md', SKILL);
  const json = await runScript('skill-facts.mjs', ['--file', file, '--url', up.url, '--base', up.baseSha, '--json']);
  assert.equal(json.code, 2, json.stderr);
  assert.match(json.stdout, /^[\n\x20-\x7e]*$/);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.skill, file);
  assert.ok(parsed.excerpts.length > 0);
  const text = await runScript('skill-facts.mjs', ['--file', file, '--url', up.url]);
  assert.ok(text.stdout.startsWith(`skill: ${dir}/skill??.md\n`), text.stdout);
  rmSync(dir, { recursive: true, force: true });
});

test('skill-facts.mjs refuses bad option sets before any work', async () => {
  const cli = fakeAwsCli({});
  for (const [args, message] of [
    [['--url', up.url], /pass exactly one of --file or --name/],
    [['--file', 'a.md', '--name', 'x', '--url', up.url], /pass exactly one of --file or --name/],
    [['--file', 'a.md'], /pass exactly one of --repo, --url or --checkout/],
    [['--file', 'a.md', '--repo', 'a/b', '--checkout', '.'], /pass exactly one of --repo, --url or --checkout/],
    [['--file', 'a.md', '--repo', 'not a repo'], /--repo must look like owner\/name/],
    [['--file', 'a.md', '--checkout', '.', '--ref', 'main'], /--ref goes with --repo or --url/],
    [['--file', 'a.md', '--url', up.url, '--rev', 'HEAD'], /--rev goes with --checkout/],
    [['--file', 'a.md', '--url', up.url, '--stack', 'S'], /--stack, --registry-id and --table go with --name/],
    [['--name', 'x', '--table', 't', '--url', up.url], /--table goes with --registry-id/],
    [['--file', 'a.md', '--url', up.url, '--names', '--json'], /pass --names or --json, not both/],
    [['--file', path.join(up.root, 'missing.md'), '--url', up.url], /cannot read/],
    [['--file', 'a.md', '--checkout', path.join(up.root, 'nowhere')], /--checkout ".*nowhere" is not a directory/],
    [['--file', 'a.md', '--url', 'https://user:TOKEN-1@github.com/valkey-io/valkey.git'], /--url must not carry credentials/],
    [['--file', 'a.md', '--url', 'https://TOKEN-1@github.com/valkey-io/valkey.git'], /--url must not carry credentials/],
    [['--file', 'a.md', '--url', 'TOKEN-1 is not a url'], /--url is not a URL/],
  ]) {
    const r = await runScript('skill-facts.mjs', args, { env: cli.env });
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.ok(!`${r.stdout}${r.stderr}`.includes('TOKEN-1'), `no credential is echoed: ${args.join(' ')}`);
  }
  assert.deepEqual(cli.calls(), []);
});

test('skill-facts.mjs --name --stack checks the registry text against the concern record, as the curator does', async () => {
  const registry = await fakeRegistry([
    { recordId: 'rec-1', name: 'rdb-load', status: 'APPROVED', md: SKILL },
    { recordId: 'rec-0', name: 'rdb-load', status: 'DEPRECATED', md: 'old text' },
  ]);
  const cli = fakeAwsCli({
    'cloudformation describe-stacks': { stdout: [
      { OutputKey: 'SkillsRegistryId', OutputValue: 'reg-1' },
      { OutputKey: 'ConcernsTableName', OutputValue: 'valkey_review_concerns' },
    ] },
    'dynamodb scan': { stdout: { Items: [typed({
      area_bucket: 'src', record_id: 'r1', graduated_record_name: 'rdb-load',
      audit_names: ['emptyDB', 'rdbLoad'], ignored_names: ['not_in_upstream'], verified_sha: up.baseSha, area: ['src/*.c'],
    }, ['area'])] } },
  });
  try {
    const r = await runScript('skill-facts.mjs', ['--name', 'rdb-load', '--stack', 'ValkeyReviewAgent', '--url', up.url, '--region', 'eu-west-1'], { env: registryEnv(cli.env, registry) });
    assert.equal(r.code, 2, r.stderr);
    assert.match(r.stdout, /^skill: "rdb-load" \(record rec-1, APPROVED\)$/m, 'the live record, not the deprecated one');
    assert.match(r.stdout, /^base: [0-9a-f]{12}, 2 file\(s\) changed since$/m);
    assert.match(r.stdout, /^baseline: 2 name\(s\), the concern record's audit_names$/m);
    assert.match(r.stdout, /^lost \(1\): `emptyDB`$/m);
    assert.match(r.stdout, /^new absent \(2\): `old_counter`, `src\/old\.c`$/m);
    assert.match(r.stdout, /^area: `src\/\*\.c` 2 file\(s\)$/m);
    const calls = cli.calls();
    assert.deepEqual(calls.map((c) => c.op), ['cloudformation describe-stacks', 'dynamodb scan']);
    assert.ok(calls.every((c) => flag(c.args, '--region') === 'eu-west-1'));
    assert.equal(flag(calls[1].args, '--table-name'), 'valkey_review_concerns');
    assert.ok(registry.requests.every((q) => q.method !== 'PATCH'), 'nothing is written to the registry');
  } finally {
    await registry.close();
  }
});

test('skill-facts.mjs --name without a concern record is a first check', async () => {
  const registry = await fakeRegistry([{ recordId: 'rec-1', name: 'rdb-load', status: 'DRAFT', md: CLEAN }]);
  const cli = fakeAwsCli({});
  try {
    const r = await runScript('skill-facts.mjs', ['--name', 'rdb-load', '--registry-id', 'reg-1', '--checkout', up.work], { env: registryEnv(cli.env, registry) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^baseline: none \(a first check\)/m);
    assert.deepEqual(cli.calls(), [], 'no stack and no table without --stack or --table');

    const none = await runScript('skill-facts.mjs', ['--name', 'nope', '--registry-id', 'reg-1', '--checkout', up.work], { env: registryEnv(cli.env, registry) });
    assert.equal(none.code, 1);
    assert.match(none.stderr, /no SKILL record named "nope" in registry reg-1/);
  } finally {
    await registry.close();
  }
});
