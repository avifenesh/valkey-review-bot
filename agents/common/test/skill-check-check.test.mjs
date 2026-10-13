import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// No resolve hook: these modules must load under plain type stripping.
const { areaFileCounts, checkSkill, DIFF_MAX_BYTES, DIFF_MAX_CANDIDATES, globToRegExp, RARE_MAX } = await import('../src/skill-check/check.ts');
const { extractNames } = await import('../src/skill-check/names.ts');
const { createGitRunner } = await import('../src/skill-check/upstream.ts');

const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
};

/**
 * A repository with a base commit holding `base` and a tip commit
 * holding `tip`, both maps of path to content (null deletes the file).
 */
function repo(base, tip = {}) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'skc-check-')));
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (files) => {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      if (content === null) {
        rmSync(full);
      } else {
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', 'c');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const baseSha = write(base);
  const tipSha = write(tip);
  return { dir, baseSha, tipSha, git: createGitRunner(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const skill = (body) => `---\nname: s\ndescription: "Use when reviewing a PR."\n---\n\n${body}\n`;
const names = (body) => extractNames(skill(body));

test('a first check with every name present is clean', async () => {
  const r = repo({
    'src/server.c': 'int replicationCachePrimaryUsingMyself(void);\nstruct s { int primary; } server;\nint x = REPL_STATE_CONNECT;\n',
    'src/modules/hello.c': 'int hello;\n',
    'valkey.conf': 'hash-max-listpack-entries 512\n',
  });
  const result = await checkSkill(r.git, {
    names: names('`src/server.c` `src/modules/` `src/modules/*.c` `*.conf` `replicationCachePrimaryUsingMyself` `server.primary` `REPL_STATE_*` `hash-max-listpack-entries` `src/modules`'),
  });
  assert.equal(result.clean, true);
  assert.deepEqual(result.lost, []);
  assert.deepEqual(result.newAbsent, []);
  assert.equal(result.present.length, 9);
  assert.equal(result.keptFraction, 1);
  assert.equal(result.compared, false);
  assert.equal(result.counts.get('src/modules/'), 1);
  assert.equal(result.counts.get('REPL_STATE_*'), 1);
  r.cleanup();
});

test('a first check with absent names reports them as new and absent, never as lost', async () => {
  const r = repo({ 'src/server.c': 'int presentName_x;\n' });
  const result = await checkSkill(r.git, { names: names('`presentName_x` `absentName_y` `src/gone.c` `src/nodir/` `absent-config-name` `REPL_GONE_*` `a_b.c_d` `src/*.rs`') });
  assert.deepEqual(result.present, ['presentName_x']);
  assert.deepEqual(result.newAbsent, ['absentName_y', 'src/gone.c', 'src/nodir/', 'absent-config-name', 'REPL_GONE_*', 'a_b.c_d', 'src/*.rs']);
  assert.deepEqual(result.lost, []);
  assert.equal(result.clean, false);
  r.cleanup();
});

test('regression: emptyDB renamed to emptyData and src/dict.c removed are lost', async () => {
  const r = repo(
    { 'src/db.c': 'long long emptyDB(int dbnum, int flags) {\n    return 0;\n}\n', 'src/dict.c': 'void dictCreate(void) {}\n', 'src/dict.h': 'typedef hashtable dict;\n' },
    { 'src/db.c': 'long long emptyData(int dbnum, int flags) {\n    return 0;\n}\n', 'src/dict.c': null },
  );
  const md = readFileSync(new URL('./fixtures/skills/valkey-rdb-load.md', import.meta.url), 'utf8');
  const cited = extractNames(md);
  const result = await checkSkill(r.git, { names: cited, baseline: ['emptyDB', 'src/dict.c', 'src/db.c', 'dictEntry'], baseSha: r.baseSha });
  assert.deepEqual(result.lost, ['emptyDB', 'src/dict.c', 'dictEntry']);
  assert.ok(result.present.includes('src/db.c'));
  assert.equal(result.keptFraction, 1 / 4);
  assert.equal(result.compared, true);
  assert.equal(result.changedFiles, 2);
  assert.equal(result.clean, false);
  r.cleanup();
});

test('baseline names the skill no longer cites are not reported', async () => {
  const r = repo({ 'a.c': 'int kept_name;\n' });
  const result = await checkSkill(r.git, { names: names('`kept_name`'), baseline: ['kept_name', 'dropped_from_skill'] });
  assert.deepEqual(result.lost, []);
  assert.equal(result.keptFraction, 1);
  r.cleanup();
});

test('keptFraction is the share of the baseline still present', async () => {
  const r = repo({ 'a.c': 'int one_name; int two_name; int three_name;\n' });
  const result = await checkSkill(r.git, {
    names: names('`one_name` `two_name` `three_name` `four_name` `five_name`'),
    baseline: ['one_name', 'two_name', 'three_name', 'four_name', 'five_name'],
  });
  assert.deepEqual(result.lost, ['four_name', 'five_name']);
  assert.equal(result.keptFraction, 3 / 5);
  r.cleanup();
});

test('names in ignored are not reported', async () => {
  const r = repo({ 'a.c': 'int here_name;\n' });
  const result = await checkSkill(r.git, { names: names('`here_name` `prose_in_ticks` `owner/name`'), ignored: ['prose_in_ticks', 'owner/name'] });
  assert.deepEqual(result.newAbsent, []);
  assert.equal(result.clean, true);
  r.cleanup();
});

test('a rare name on a changed line or in a hunk header is touched, with excerpts', async () => {
  const lines = (n) => Array.from({ length: n }, (_, i) => `    int filler_${i} = ${i};`).join('\n');
  const r = repo(
    {
      'src/a.c': `void rareChangedName(void) {\n    call(rare_line_name, 1);\n}\n`,
      'src/b.c': `void rareHeaderName(void) {\n${lines(5)}\n    int value = 1;\n}\n`,
      'src/c.c': `void untouchedName_x(void) {}\n`,
    },
    {
      'src/a.c': `void rareChangedName(void) {\n    call(rare_line_name, 2);\n}\n`,
      'src/b.c': `void rareHeaderName(void) {\n${lines(5)}\n    int value = 2;\n}\n`,
    },
  );
  const result = await checkSkill(r.git, {
    names: names('`rare_line_name` `rareHeaderName` `untouchedName_x` `rareChangedName`'),
    baseline: ['rare_line_name', 'rareHeaderName', 'untouchedName_x', 'rareChangedName'],
    baseSha: r.baseSha,
  });
  assert.deepEqual(result.touched, ['rare_line_name', 'rareHeaderName', 'rareChangedName']);
  assert.equal(result.clean, false);
  assert.deepEqual(result.lost, []);
  const byPath = Object.fromEntries(result.excerpts.map((e) => [e.path, e]));
  assert.deepEqual(byPath['src/a.c'].names, ['rare_line_name', 'rareChangedName']);
  assert.match(byPath['src/a.c'].hunk, /^@@ -2 \+2 @@ void rareChangedName\(void\) \{\n-    call\(rare_line_name, 1\);\n\+    call\(rare_line_name, 2\);$/);
  assert.deepEqual(byPath['src/b.c'].names, ['rareHeaderName']);
  r.cleanup();
});

test(`a name with more than ${RARE_MAX} occurrences is not touched, even on changed lines`, async () => {
  const many = (v) => Array.from({ length: RARE_MAX + 5 }, (_, i) => `int x${i} = common_name + ${v};`).join('\n');
  const r = repo({ 'a.c': `${many(1)}\nint rare_one_name = 1;\n` }, { 'a.c': `${many(2)}\nint rare_one_name = 2;\n` });
  const result = await checkSkill(r.git, { names: names('`common_name` `rare_one_name`'), baseline: ['common_name', 'rare_one_name'], baseSha: r.baseSha });
  assert.equal(result.counts.get('common_name'), RARE_MAX + 5);
  assert.deepEqual(result.touched, ['rare_one_name']);
  r.cleanup();
});

test('a cited path that changed is touched; changes elsewhere are not', async () => {
  const r = repo(
    { 'src/rdb.c': 'int a;\n', 'src/other.c': 'int b;\n', 'src/quiet.c': 'int quietName_x;\n' },
    { 'src/rdb.c': 'int a2;\n', 'src/other.c': 'int b2;\n' },
  );
  const result = await checkSkill(r.git, { names: names('`src/rdb.c` `src/quiet.c` `quietName_x`'), baseline: ['src/rdb.c', 'src/quiet.c', 'quietName_x'], baseSha: r.baseSha });
  assert.deepEqual(result.touched, ['src/rdb.c']);
  assert.equal(result.excerpts.length, 1);
  assert.equal(result.excerpts[0].path, 'src/rdb.c');
  assert.deepEqual(result.excerpts[0].names, ['src/rdb.c']);
  r.cleanup();
});

test('prefixes, qualified names and configs are touched through their words', async () => {
  const r = repo(
    { 'r.c': 'state = REPL_STATE_CONNECT;\nint x = server.primary_link;\nconfig("lazyfree-lazy-user-flush", 0);\n' },
    { 'r.c': 'state = REPL_STATE_CONNECTING;\nint x = server.primary_link + 1;\nconfig("lazyfree-lazy-user-flush", 1);\n' },
  );
  const result = await checkSkill(r.git, {
    names: names('`REPL_STATE_*` `server.primary_link` `lazyfree-lazy-user-flush`'),
    baseline: ['REPL_STATE_*', 'server.primary_link', 'lazyfree-lazy-user-flush'],
    baseSha: r.baseSha,
  });
  assert.deepEqual(result.touched, ['REPL_STATE_*', 'server.primary_link', 'lazyfree-lazy-user-flush']);
  assert.equal(result.excerpts.length, 1, 'the one hunk is shown once');
  r.cleanup();
});

test('without a usable base nothing is touched', async () => {
  const r = repo({ 'a.c': 'int rare_x_name = 1;\n' }, { 'a.c': 'int rare_x_name = 2;\n' });
  const n = names('`rare_x_name`');
  for (const baseSha of [undefined, 'f'.repeat(40), 'HEAD~1', '--output=/tmp/x']) {
    const result = await checkSkill(r.git, { names: n, baseline: ['rare_x_name'], baseSha });
    assert.equal(result.compared, false, String(baseSha));
    assert.deepEqual(result.touched, []);
    assert.equal(result.clean, true);
  }
  r.cleanup();
});

test('a capped candidate list is not clean, and says why', async () => {
  // Each file holds a rare cited name, and each changed, but not on the name's line.
  const count = DIFF_MAX_CANDIDATES + 1;
  const file = (i, v) => `x = ${v};\nint rare_cap_${i};\n`;
  const base = Object.fromEntries(Array.from({ length: count }, (_, i) => [`f/${i}.txt`, file(i, 1)]));
  const tip = Object.fromEntries(Array.from({ length: count }, (_, i) => [`f/${i}.txt`, file(i, 2)]));
  const r = repo(base, tip);
  const cited = Array.from({ length: count }, (_, i) => `rare_cap_${i}`);
  const result = await checkSkill(r.git, { names: names(cited.map((t) => `\`${t}\``).join(' ')), baseline: cited, baseSha: r.baseSha });
  assert.deepEqual(result.touched, []);
  assert.deepEqual(result.lost, []);
  assert.equal(result.candidatesCapped, true);
  assert.deepEqual(result.incomplete, [`only ${DIFF_MAX_CANDIDATES} of the ${count} changed files that hold a cited name were diffed`]);
  assert.equal(result.clean, false);
  r.cleanup();
});

test('a truncated diff is not clean, and says why', async () => {
  const filler = (c) => `${Array.from({ length: 30_000 }, () => c.repeat(80)).join('\n')}\n`;
  const r = repo({ 'big.txt': `${filler('a')}int rare_big_name;\n` }, { 'big.txt': `${filler('b')}int rare_big_name;\n` });
  const result = await checkSkill(r.git, { names: names('`rare_big_name`'), baseline: ['rare_big_name'], baseSha: r.baseSha });
  assert.deepEqual(result.touched, []);
  assert.equal(result.diffTruncated, true);
  assert.deepEqual(result.incomplete, [`the diff of the candidate files passed ${DIFF_MAX_BYTES} bytes and was read only that far`]);
  assert.equal(result.clean, false);
  r.cleanup();
});

test('word counts are exact when patterns overlap and pass one grep call', async () => {
  const symbols = Array.from({ length: 150 }, (_, i) => `sym_${i}_name`);
  const r = repo({
    'a.c': `${symbols.join(' ')}\nhash-max-listpack-entries hash-max x\nhash-max\nxsym_1_name sym_1_name\n`,
  });
  const result = await checkSkill(r.git, { names: names([...symbols, 'hash-max', 'hash-max-listpack-entries'].map((s) => `\`${s}\``).join(' ')) });
  assert.equal(result.present.length, 152);
  assert.equal(result.counts.get('sym_1_name'), 2, 'a non-word occurrence earlier on the line is skipped');
  assert.equal(result.counts.get('sym_149_name'), 1);
  assert.equal(result.counts.get('hash-max'), 3);
  assert.equal(result.counts.get('hash-max-listpack-entries'), 1);
  r.cleanup();
});

test('qualified names count their rarest component and need every component', async () => {
  const r = repo({ 'a.rs': 'impl ConnectionManager {\n    fn reconnect(&self) {}\n}\nlet c = ConnectionManager::new();\n' });
  const result = await checkSkill(r.git, { names: names('`ConnectionManager::reconnect` `ConnectionManager::vanished_fn`') });
  assert.deepEqual(result.present, ['ConnectionManager::reconnect']);
  assert.equal(result.counts.get('ConnectionManager::reconnect'), 1);
  assert.deepEqual(result.newAbsent, ['ConnectionManager::vanished_fn']);
  r.cleanup();
});

test('a path rooted at a top-level directory must match exactly; other paths match as tails', async () => {
  const r = repo({
    'src/server.c': '',
    'deps/libvalkey/src/dict.c': '',
    'glide-core/src/client/mod.rs': '',
    'glide-core/src/pubsub/mock.rs': '',
  });
  const result = await checkSkill(r.git, {
    names: names('`src/dict.c` `server.c` `dict.c` `client/mod.rs` `pubsub/` `src/server.c` `src/` `client/gone.rs` `nothere.c`'),
  });
  assert.deepEqual(result.present, ['server.c', 'dict.c', 'client/mod.rs', 'pubsub/', 'src/server.c', 'src/']);
  assert.deepEqual(result.newAbsent, ['src/dict.c', 'client/gone.rs', 'nothere.c']);
  assert.equal(result.counts.get('pubsub/'), 1);
  r.cleanup();
});

test('a clone whose own config changes grep and diff output is still read correctly', async () => {
  const r = repo(
    { 'src/a.c': 'int rare_cfg_name = 1;\nint other_name_x;\n', 'src/b.c': 'x = REPL_STATE_CONNECT;\n' },
    { 'src/a.c': 'int rare_cfg_name = 2;\nint other_name_x;\n' },
  );
  const local = Object.entries({
    'grep.lineNumber': 'true', 'grep.column': 'true', 'grep.fullName': 'true', 'color.ui': 'always', 'color.grep': 'always',
    'color.diff': 'always', 'diff.relative': 'true', 'diff.interHunkContext': '10', 'core.quotePath': 'true',
  });
  for (const [key, value] of local) execFileSync('git', ['config', key, value], { cwd: r.dir, env });
  const result = await checkSkill(r.git, {
    names: names('`rare_cfg_name` `other_name_x` `REPL_STATE_*`'),
    baseline: ['rare_cfg_name', 'other_name_x', 'REPL_STATE_*'],
    baseSha: r.baseSha,
  });
  assert.deepEqual(result.present, ['rare_cfg_name', 'other_name_x', 'REPL_STATE_*']);
  assert.equal(result.counts.get('rare_cfg_name'), 1);
  assert.equal(result.counts.get('REPL_STATE_*'), 1);
  assert.deepEqual(result.touched, ['rare_cfg_name']);
  assert.equal(result.excerpts[0].path, 'src/a.c');
  assert.equal(result.excerpts[0].hunk, '@@ -1 +1 @@\n-int rare_cfg_name = 1;\n+int rare_cfg_name = 2;');
  r.cleanup();
});

test('a given revision is checked instead of HEAD', async () => {
  const r = repo({ 'src/old.c': 'int base_only_name;\n' }, { 'src/old.c': null, 'src/new.c': 'int tip_only_name;\n' });
  const n = names('`base_only_name` `tip_only_name` `src/old.c` `src/new.c`');
  const atBase = await checkSkill(r.git, { names: n, rev: r.baseSha });
  assert.equal(atBase.commit, r.baseSha);
  assert.deepEqual(atBase.present, ['base_only_name', 'src/old.c']);
  const atHead = await checkSkill(r.git, { names: n });
  assert.equal(atHead.commit, r.tipSha);
  assert.deepEqual(atHead.present, ['tip_only_name', 'src/new.c']);
  assert.deepEqual(await areaFileCounts(r.git, ['src/old*'], r.baseSha), [1]);
  assert.deepEqual(await areaFileCounts(r.git, ['src/old*']), [0]);
  await assert.rejects(checkSkill(r.git, { names: n, rev: '--output=/tmp/x' }), /invalid revision/);
  await assert.rejects(checkSkill(r.git, { names: n, rev: 'f'.repeat(40) }), /names no commit/);
  await assert.rejects(areaFileCounts(r.git, ['src/old*'], 'no-such-ref'), /names no commit/);
  r.cleanup();
});

test('a failing git call names its subcommand, not its first option', async () => {
  const r = repo({ 'a.c': 'int some_name_x;\n' }, { 'a.c': 'int some_name_x = 1;\n' });
  const n = names('`some_name_x`');
  // A runner that gives `result` for calls holding `marker`, and runs the rest.
  const failing = (marker, result) => async (args, opts) => (args.includes(marker) ? { stdout: '', stderr: '', truncated: false, ...result } : r.git(args, opts));
  await assert.rejects(checkSkill(failing('grep', { code: 128, stderr: 'fatal: boom' }), { names: n }), { message: 'git grep exited 128: fatal: boom' });
  await assert.rejects(checkSkill(failing('grep', { code: -1, truncated: true }), { names: n }), { message: /^git grep output passed \d+ bytes$/ });
  await assert.rejects(checkSkill(failing('diff', { code: 128, stderr: 'fatal: bad object' }), { names: n, baseSha: r.baseSha }),
    { message: 'git diff exited 128: fatal: bad object' });
  r.cleanup();
});

test('globs match paths, or basenames when they have no slash', () => {
  assert.equal(globToRegExp('glide-core/src/client/**').test('glide-core/src/client/mod.rs'), true);
  assert.equal(globToRegExp('glide-core/src/client/**').test('glide-core/src/clientx/mod.rs'), false);
  assert.equal(globToRegExp('src/**/*.c').test('src/a.c'), true);
  assert.equal(globToRegExp('src/**/*.c').test('src/x/y/a.c'), true);
  assert.equal(globToRegExp('src/*.c').test('src/x/a.c'), false);
  assert.equal(globToRegExp('t_?ash.c').test('t_hash.c'), true);
  assert.equal(globToRegExp('a+b.c').test('a+b.c'), true);
});

test('area globs count the files they match', async () => {
  const r = repo({ 'src/cluster.c': '', 'src/cluster_legacy.c': '', 'tests/unit/cluster.tcl': '' });
  assert.deepEqual(await areaFileCounts(r.git, ['src/cluster*', '*.tcl', 'src/gone/**', 'src/cluster.c']), [2, 1, 0, 1]);
  r.cleanup();
});
