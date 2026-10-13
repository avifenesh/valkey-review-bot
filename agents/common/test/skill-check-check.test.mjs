import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// No resolve hook: these modules must load under plain type stripping.
const {
  areaFileCounts, checkSkill, confirmableCommit, DIFF_BUDGET_BYTES, DIFF_FILES_PER_CALL, DIFF_MAX_BYTES, globToRegExp, isPartial,
  PARTIAL_CHECKS_BEFORE_CONFIRM, partialChecksBefore, partialCountWrite, RARE_MAX,
} = await import('../src/skill-check/check.ts');
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

test('without a base nothing is touched; a base that is given but unusable makes the result incomplete', async () => {
  const r = repo({ 'a.c': 'int rare_x_name = 1;\n' }, { 'a.c': 'int rare_x_name = 2;\n' });
  const n = names('`rare_x_name`');
  const none = await checkSkill(r.git, { names: n, baseline: ['rare_x_name'] });
  assert.equal(none.compared, false);
  assert.deepEqual(none.touched, []);
  assert.deepEqual(none.incomplete, []);
  assert.equal(none.clean, true);
  const missing = 'f'.repeat(40);
  for (const [baseSha, why] of [
    [missing, `the base commit ${missing} is not in the repository, so the diff since it was not examined`],
    ['HEAD~1', 'the base "HEAD~1" is not a full commit SHA, so no diff was examined'],
    ['--output=/tmp/x', 'the base "--output=/tmp/x" is not a full commit SHA, so no diff was examined'],
  ]) {
    const result = await checkSkill(r.git, { names: n, baseline: ['rare_x_name'], baseSha });
    assert.equal(result.compared, false, baseSha);
    assert.deepEqual(result.touched, []);
    assert.deepEqual(result.incomplete, [why]);
    assert.equal(result.clean, false);
    assert.equal(confirmableCommit(result), null);
  }
  r.cleanup();
});

test('a checkout that could not fetch the base is incomplete; one whose base is gone gives a presence check', async () => {
  const r = repo({ 'a.c': 'int rare_co_name = 1;\n' }, { 'a.c': 'int rare_co_name = 2;\n' });
  const calls = [];
  const git = (args, opts) => {
    calls.push(args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-c'));
    return r.git(args, opts);
  };
  const check = (checkout) => checkSkill(git, { names: names('`rare_co_name`'), baseline: ['rare_co_name'], baseSha: r.baseSha, checkout });

  const failed = await check({ baseAvailable: false, baseGone: false });
  assert.deepEqual(failed.incomplete, [`the base commit ${r.baseSha} could not be fetched, so the diff since it was not examined`]);
  assert.deepEqual([failed.compared, failed.baseGone, failed.clean, failed.touched], [false, false, false, []]);
  assert.equal(confirmableCommit(failed), null);
  assert.deepEqual(calls.filter((c) => c === 'diff' || c === 'cat-file'), [], 'git was asked about the base');

  const gone = await check({ baseAvailable: false, baseGone: true });
  assert.deepEqual([gone.compared, gone.baseGone, gone.incomplete, gone.touched, gone.clean], [false, true, [], [], true]);
  assert.equal(confirmableCommit(gone), r.tipSha);
  assert.deepEqual(calls.filter((c) => c === 'diff' || c === 'cat-file'), [], 'git was asked about a base that is gone');

  const fetched = await check({ baseAvailable: true, baseGone: false });
  assert.deepEqual([fetched.compared, fetched.baseGone, fetched.touched, fetched.incomplete], [true, false, ['rare_co_name'], []]);
  r.cleanup();
});

test('only a complete result gives a commit to record as verified', async () => {
  const r = repo({ 'a.c': 'int rare_q_name = 1;\n' }, { 'a.c': 'int rare_q_name = 2;\n' });
  const n = names('`rare_q_name` `absent_q_name`');
  // Touched and absent names leave it to the audit, which may confirm.
  const flagged = await checkSkill(r.git, { names: n, baseline: ['rare_q_name'], baseSha: r.baseSha });
  assert.deepEqual([flagged.touched, flagged.newAbsent, flagged.clean], [['rare_q_name'], ['absent_q_name'], false]);
  assert.equal(confirmableCommit(flagged), r.tipSha);
  const clean = await checkSkill(r.git, { names: names('`rare_q_name`'), baseline: ['rare_q_name'], baseSha: r.tipSha });
  assert.equal(clean.clean, true);
  assert.equal(confirmableCommit(clean), r.tipSha);
  // Nothing flagged, but the diff was not read in full.
  assert.equal(confirmableCommit({ ...clean, incomplete: ['the diff of the candidate files passed 4194304 bytes and was read only that far'] }), null);
  r.cleanup();
});

/** A runner that counts the git diff -U0 calls and the files each names. */
function countingDiffs(git) {
  const calls = [];
  const run = (args, opts) => {
    if (args.includes('-U0')) calls.push(args.slice(args.indexOf('--') + 1));
    return git(args, opts);
  };
  return { run, calls };
}

test('more candidate files than one diff call takes are all diffed', async () => {
  // Each file holds a rare cited name, and each name's line changed.
  const count = DIFF_FILES_PER_CALL + 1;
  const file = (i, v) => `x = 1;\nint rare_cap_${i} = ${v};\n`;
  const base = Object.fromEntries(Array.from({ length: count }, (_, i) => [`f/${i}.txt`, file(i, 1)]));
  const tip = Object.fromEntries(Array.from({ length: count }, (_, i) => [`f/${i}.txt`, file(i, 2)]));
  const r = repo(base, tip);
  const cited = Array.from({ length: count }, (_, i) => `rare_cap_${i}`);
  const { run, calls } = countingDiffs(r.git);
  const result = await checkSkill(run, { names: names(cited.map((t) => `\`${t}\``).join(' ')), baseline: cited, baseSha: r.baseSha });
  assert.deepEqual(calls.map((c) => c.length), [DIFF_FILES_PER_CALL, 1]);
  assert.deepEqual(result.touched, cited);
  assert.deepEqual([result.candidatesCapped, result.diffTruncated, result.incomplete], [false, false, []]);
  assert.equal(confirmableCommit(result), r.tipSha);
  r.cleanup();
});

/** `lines` lines of 80 copies of `c`. */
const filler = (c, lines) => `${Array.from({ length: lines }, () => c.repeat(80)).join('\n')}\n`;

test('a diff call cut short keeps the files it read in full and diffs the rest again', async () => {
  // a.txt and b.txt each have a diff of about 2.4 MB, so the first call stops inside b.txt.
  const r = repo(
    { 'a.txt': `int rare_a_name = 1;\n${filler('a', 15_000)}`, 'b.txt': `int rare_b_name = 1;\n${filler('a', 15_000)}`, 'c.txt': 'int rare_c_name = 1;\n' },
    { 'a.txt': `int rare_a_name = 2;\n${filler('b', 15_000)}`, 'b.txt': `int rare_b_name = 2;\n${filler('b', 15_000)}`, 'c.txt': 'int rare_c_name = 2;\n' },
  );
  const cited = ['rare_a_name', 'rare_b_name', 'rare_c_name'];
  const { run, calls } = countingDiffs(r.git);
  const result = await checkSkill(run, { names: names(cited.map((t) => `\`${t}\``).join(' ')), baseline: cited, baseSha: r.baseSha });
  assert.deepEqual(calls, [['a.txt', 'b.txt', 'c.txt'], ['b.txt', 'c.txt']]);
  assert.deepEqual(result.touched, cited);
  assert.deepEqual([result.diffTruncated, result.candidatesCapped, result.incomplete], [false, false, []]);
  assert.deepEqual(result.excerpts.map((e) => e.path), ['a.txt', 'b.txt', 'c.txt']);
  r.cleanup();
});

test('a cut call never leaves an empty batch, which would diff the whole tree', async () => {
  // d/foo became a directory: its pathspec also matches d/foo/x, whose patch comes last and is cut.
  const r = repo({ 'd/foo': filler('a', 30_000), 'd/other.txt': 'x\n' }, { 'd/foo': null, 'd/foo/x': filler('b', 30_000), 'd/other.txt': 'y\n' });
  const { run, calls } = countingDiffs(r.git);
  const result = await checkSkill(run, { names: names('`d/foo`'), baseline: ['d/foo'], baseSha: r.baseSha });
  assert.deepEqual(calls, [['d/foo']]);
  assert.deepEqual(result.touched, ['d/foo']);
  assert.deepEqual(result.incomplete, []);
  r.cleanup();
});

test('a cut call whose paths git quoted is diffed again in halves', async () => {
  // A double quote in a file name makes git quote the path in the patch header.
  const r = repo(
    { 'q"1.txt': `int rare_q1_name = 1;\n${filler('a', 15_000)}`, 'q"2.txt': `int rare_q2_name = 1;\n${filler('a', 15_000)}` },
    { 'q"1.txt': `int rare_q1_name = 2;\n${filler('b', 15_000)}`, 'q"2.txt': `int rare_q2_name = 2;\n${filler('b', 15_000)}` },
  );
  const cited = ['rare_q1_name', 'rare_q2_name'];
  const { run, calls } = countingDiffs(r.git);
  const result = await checkSkill(run, { names: names(cited.map((t) => `\`${t}\``).join(' ')), baseline: cited, baseSha: r.baseSha });
  assert.deepEqual(calls, [['q"1.txt', 'q"2.txt'], ['q"1.txt'], ['q"2.txt']]);
  assert.deepEqual(result.touched, cited);
  assert.deepEqual(result.incomplete, []);
  r.cleanup();
});

test('a file whose diff alone passes the cap is read that far, and the result is incomplete', async () => {
  const r = repo(
    { 'big.txt': `int rare_head_name = 1;\n${filler('a', 30_000)}int rare_big_name;\n`, 'small.txt': 'int rare_small_name = 1;\n' },
    { 'big.txt': `int rare_head_name = 2;\n${filler('b', 30_000)}int rare_big_name;\n`, 'small.txt': 'int rare_small_name = 2;\n' },
  );
  const cited = ['rare_head_name', 'rare_big_name', 'rare_small_name'];
  const { run, calls } = countingDiffs(r.git);
  const result = await checkSkill(run, { names: names(cited.map((t) => `\`${t}\``).join(' ')), baseline: cited, baseSha: r.baseSha });
  // The first call stops inside big.txt, which comes first; it is not diffed again.
  assert.deepEqual(calls, [['big.txt', 'small.txt'], ['small.txt']]);
  assert.deepEqual(result.touched, ['rare_head_name', 'rare_small_name']);
  assert.equal(result.diffTruncated, true);
  assert.deepEqual(result.incomplete, [`1 of the 2 changed files that hold a cited name had a diff of more than ${DIFF_MAX_BYTES} bytes, which was read only that far`]);
  assert.equal(result.clean, false);
  assert.equal(confirmableCommit(result), null);
  r.cleanup();
});

test('once the diff budget is spent the files left are not diffed, and the result is incomplete', async () => {
  const count = 20;
  const file = (i, v) => `int rare_bud_${i} = ${v};\n`;
  const r = repo(
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, file(i, 1)])),
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${String(i).padStart(2, '0')}.txt`, file(i, 2)])),
  );
  const cited = Array.from({ length: count }, (_, i) => `rare_bud_${i}`);
  // Every diff call reads its first file's patch to the cap.
  let diffs = 0;
  const git = async (args, opts) => {
    if (!args.includes('-U0')) return r.git(args, opts);
    diffs++;
    const first = args[args.indexOf('--') + 1];
    const stdout = `diff --git a/${first} b/${first}\n@@ -1 +1 @@\n-${'x'.repeat(opts.maxBytes)}`.slice(0, opts.maxBytes);
    return { code: -1, stdout, stderr: '', truncated: true };
  };
  const result = await checkSkill(git, { names: names(cited.map((t) => `\`${t}\``).join(' ')), baseline: cited, baseSha: r.baseSha });
  const read = Math.ceil(DIFF_BUDGET_BYTES / DIFF_MAX_BYTES);
  assert.equal(diffs, read);
  assert.deepEqual([result.candidatesCapped, result.diffTruncated], [true, true]);
  assert.deepEqual(result.incomplete, [
    `${read} of the ${count} changed files that hold a cited name had a diff of more than ${DIFF_MAX_BYTES} bytes, which was read only that far`,
    `the diff budget of ${DIFF_BUDGET_BYTES} bytes ran out, so ${count - read} of the ${count} changed files that hold a cited name were not diffed`,
  ]);
  assert.equal(confirmableCommit(result), null);
  r.cleanup();
});

test(`a check whose diff stays partial confirms after ${PARTIAL_CHECKS_BEFORE_CONFIRM} such checks; one without its base never does`, async () => {
  const r = repo({ 'a.txt': 'int rare_p_name = 1;\n' }, { 'a.txt': 'int rare_p_name = 2;\n' });
  const n = names('`rare_p_name`');
  // A runner whose diff of the candidates is always cut short.
  const cutting = async (args, opts) => (args.includes('-U0')
    ? { code: -1, truncated: true, stderr: '', stdout: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-int rare_p_name = 1;\n+int rare_p_name = 2;\n+xxxx' }
    : r.git(args, opts));
  const partial = await checkSkill(cutting, { names: n, baseline: ['rare_p_name'], baseSha: r.baseSha });
  assert.deepEqual([partial.compared, partial.diffTruncated, partial.touched], [true, true, ['rare_p_name']]);
  assert.equal(isPartial(partial), true);
  for (let before = 0; before < PARTIAL_CHECKS_BEFORE_CONFIRM; before++) assert.equal(confirmableCommit(partial, { partialBefore: before }), null, `after ${before}`);
  assert.equal(confirmableCommit(partial), null);
  assert.equal(confirmableCommit(partial, { partialBefore: Number.NaN }), null);
  assert.equal(confirmableCommit(partial, { partialBefore: PARTIAL_CHECKS_BEFORE_CONFIRM }), r.tipSha);
  assert.equal(confirmableCommit(partial, { partialBefore: PARTIAL_CHECKS_BEFORE_CONFIRM + 3 }), r.tipSha);

  const complete = await checkSkill(r.git, { names: n, baseline: ['rare_p_name'], baseSha: r.baseSha });
  assert.equal(isPartial(complete), false);
  // However many checks came before, a base that was not diffed holds the verification.
  for (const input of [
    { baseSha: 'f'.repeat(40) },
    { baseSha: 'HEAD~1' },
    { baseSha: r.baseSha, checkout: { baseAvailable: false, baseGone: false } },
  ]) {
    const result = await checkSkill(cutting, { names: n, baseline: ['rare_p_name'], ...input });
    assert.equal(result.incomplete.length, 1, input.baseSha);
    assert.equal(isPartial(result), false);
    assert.equal(confirmableCommit(result, { partialBefore: 99 }), null, input.baseSha);
  }
  r.cleanup();
});

/** Real results of each kind, from one repository: a diff read in part, and the other cases. */
async function resultKinds() {
  const r = repo({ 'a.txt': 'int rare_pc_name = 1;\n' }, { 'a.txt': 'int rare_pc_name = 2;\n' });
  const n = names('`rare_pc_name`');
  const cutting = async (args, opts) => (args.includes('-U0')
    ? { code: -1, truncated: true, stderr: '', stdout: 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-int rare_pc_name = 1;\n+int rare_pc_name = 2;\n+xxxx' }
    : r.git(args, opts));
  const check = (git, input) => checkSkill(git, { names: n, baseline: ['rare_pc_name'], ...input });
  const kinds = {
    partial: await check(cutting, { baseSha: r.baseSha }),
    complete: await check(r.git, { baseSha: r.baseSha }),
    first: await check(r.git, {}),
    malformed: await check(cutting, { baseSha: 'HEAD~1' }),
    missing: await check(cutting, { baseSha: 'f'.repeat(40) }),
    notFetched: await check(cutting, { baseSha: r.baseSha, checkout: { baseAvailable: false, baseGone: false } }),
    gone: await check(cutting, { baseSha: r.baseSha, checkout: { baseAvailable: false, baseGone: true } }),
  };
  r.cleanup();
  assert.deepEqual(Object.keys(kinds).filter((k) => isPartial(kinds[k])), ['partial']);
  return { kinds, tip: r.tipSha };
}

test('the partial count counts each maintenance message once, however often it runs', async () => {
  const { kinds, tip } = await resultKinds();
  // One curator run of message `id`, as the contract has it: read the record, ask for the commit, then write the outcome
  // with the claim's condition and the count as read. Returns the commit it may record, or false when its write lost.
  const run = (rec, id, result) => {
    const read = { ...rec };
    const commit = confirmableCommit(result, { partialBefore: partialChecksBefore(read, id) });
    const write = partialCountWrite(result, read, id, { movesVerification: commit !== null });
    return () => {
      if (rec.maintenance_id !== id) return false;
      if (write.kind === 'count') {
        if (rec.partial_check_id === id || rec.partial_checks !== read.partial_checks) return false;
        rec.partial_checks = write.partial_checks;
        rec.partial_check_id = write.partial_check_id;
      } else if (write.kind === 'reset') {
        delete rec.partial_checks;
        delete rec.partial_check_id;
        delete rec.maintenance_id;
      }
      return commit;
    };
  };
  const count = (rec) => [rec.partial_checks, rec.partial_check_id];

  const rec = { maintenance_id: 'check#r#id#2026-10-01' };
  // A partial check, then two redelivered copies of the same message (after a throw, or a cut at 15 minutes).
  for (let i = 0; i < 3; i++) {
    assert.equal(run(rec, 'check#r#id#2026-10-01', kinds.partial)(), null, `receive ${i + 1}`);
    assert.deepEqual(count(rec), [1, 'check#r#id#2026-10-01'], `receive ${i + 1}`);
  }

  // The next message: two copies that read the record before either wrote make the same write, and the second loses.
  rec.maintenance_id = 'check#r#id#2026-10-08';
  const first = run(rec, 'check#r#id#2026-10-08', kinds.partial);
  const second = run(rec, 'check#r#id#2026-10-08', kinds.partial);
  assert.equal(first(), null);
  assert.equal(second(), false);
  assert.deepEqual(count(rec), [2, 'check#r#id#2026-10-08']);
  // A later copy of it does not confirm on its own count: one partial check came before it, not two.
  assert.equal(run(rec, 'check#r#id#2026-10-08', kinds.partial)(), null);
  assert.deepEqual(count(rec), [2, 'check#r#id#2026-10-08']);

  // A check whose base could not be fetched neither counts nor resets.
  rec.maintenance_id = 'check#r#id#2026-10-15';
  assert.equal(run(rec, 'check#r#id#2026-10-15', kinds.notFetched)(), null);
  assert.deepEqual(count(rec), [2, 'check#r#id#2026-10-08']);

  // The third partial message takes the way past the partial diff, and the confirmation resets the count.
  rec.maintenance_id = 'check#r#id#2026-10-22';
  assert.equal(run(rec, 'check#r#id#2026-10-22', kinds.partial)(), tip);
  assert.deepEqual(count(rec), [undefined, undefined]);
  rec.maintenance_id = 'check#r#id#2026-10-29';
  assert.equal(run(rec, 'check#r#id#2026-10-29', kinds.partial)(), null);
  assert.deepEqual(count(rec), [1, 'check#r#id#2026-10-29']);
});

test('only a partial result that leaves the verification counts; every write that moves it resets the count', async () => {
  const { kinds } = await resultKinds();
  const id = 'check#r#id#2026-10-13';
  const counted = { partial_checks: 1, partial_check_id: 'check#r#id#2026-10-06' };
  for (const [kind, result] of Object.entries(kinds)) {
    for (const rec of [{}, counted, { partial_checks: 2, partial_check_id: id }]) {
      assert.deepEqual(partialCountWrite(result, rec, id, { movesVerification: true }), { kind: 'reset' }, kind);
    }
    // Unchanged when it is not partial, whatever outcome the run records, and when this message was counted already.
    const expected = kind === 'partial' ? { kind: 'count', partial_checks: 2, partial_check_id: id } : { kind: 'keep' };
    assert.deepEqual(partialCountWrite(result, counted, id, { movesVerification: false }), expected, kind);
    assert.deepEqual(partialCountWrite(result, { partial_checks: 2, partial_check_id: id }, id, { movesVerification: false }), { kind: 'keep' }, kind);
  }
  assert.deepEqual(partialCountWrite(kinds.partial, {}, id, { movesVerification: false }), { kind: 'count', partial_checks: 1, partial_check_id: id });

  // A count that is missing or not a usable number is 0; one this message made itself is left out.
  for (const bad of [undefined, null, '2', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(partialChecksBefore({ partial_checks: bad, partial_check_id: 'other' }, id), 0, String(bad));
    assert.deepEqual(partialCountWrite(kinds.partial, { partial_checks: bad }, id, { movesVerification: false }), { kind: 'count', partial_checks: 1, partial_check_id: id }, String(bad));
  }
  assert.equal(partialChecksBefore({}, id), 0);
  assert.equal(partialChecksBefore({ partial_checks: 2.5, partial_check_id: 'other' }, id), 2);
  assert.equal(partialChecksBefore(counted, id), 1);
  assert.equal(partialChecksBefore({ partial_checks: 2, partial_check_id: id }, id), 1);
  assert.equal(partialChecksBefore({ partial_checks: 0, partial_check_id: id }, id), 0);
  for (const bad of ['', undefined, 7]) {
    assert.throws(() => partialChecksBefore(counted, bad), TypeError);
    assert.throws(() => partialCountWrite(kinds.partial, counted, bad, { movesVerification: false }), TypeError);
  }
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
