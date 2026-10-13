import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { checkGitArgs, gitArgv } = await import('../src/tools/git.ts');

const ok = (args) => assert.equal(checkGitArgs(args), null, args.join(' '));
const rejected = (args, pattern = /./) => {
  const problem = checkGitArgs(args);
  assert.ok(problem, `expected "${args.join(' ')}" to be rejected`);
  assert.match(problem, pattern);
};

test('common read commands pass', () => {
  ok(['log', '--oneline', '-20', 'abc..def']);
  ok(['log', '-S', 'listpack', '--', 'src/t_hash.c']);
  ok(['log', '--output-indicator-new=+', '-p']);
  ok(['show', 'abc123', '--', 'src/server.c']);
  ok(['diff', '--text', '--stat', 'abc..def']);
  ok(['blame', '-L', '10,20', 'src/server.c']);
  ok(['grep', '-n', '-e', 'dictFind', '--', 'src']);
  ok(['grep', '-nC3', 'zmalloc']);
  ok(['grep', '-nw', 'dictFind']);
  ok(['rev-list', '--filter=blob:none', '--count', 'HEAD']);
  ok(['status', '--short']);
  ok(['merge-base', 'HEAD', 'origin/unstable']);
});

test('the subcommand must be on the allowlist', () => {
  rejected([], /not on the allowlist/);
  rejected(['push', 'origin'], /not on the allowlist/);
  rejected(['-c', 'core.pager=sh', 'log'], /not on the allowlist/);
  rejected(['config', '--list'], /not on the allowlist/);
});

test('options that write files or run helpers are refused, including abbreviations', () => {
  rejected(['log', '-c']);
  rejected(['log', '-p', '--output=/tmp/x'], /--output/);
  rejected(['diff', '--out=/tmp/x'], /--output/);
  rejected(['diff', '--ext-diff'], /--ext-diff/);
  rejected(['diff', '--ext'], /--ext-diff/);
  rejected(['show', '--textconv', 'HEAD:README.md'], /--textconv/);
  rejected(['cat-file', '--filters', 'HEAD:README.md'], /--filters/);
  rejected(['grep', '--open-files-in-pager=sh', 'x'], /--open-files-in-pager/);
  rejected(['grep', '--open', 'x'], /--open-files-in-pager/);
  rejected(['grep', '-Ovim', 'x'], /-O/);
  rejected(['grep', '-nO', 'x'], /-O/);
  rejected(['diff', '-O/etc/passwd'], /-O/);
  rejected(['log', '--exec-path=/tmp'], /--exec-path/);
  rejected(['log', '--upload-pack=sh'], /--upload-pack/);
  rejected(['log', '--config-env=core.pager=X'], /--config-env/);
  rejected(['diff', '--no-index', '/dev/null', '/proc/self/environ'], /--no-index/);
  rejected(['blame', '--contents', '/etc/passwd', 'README.md'], /--contents/);
  rejected(['blame', '--ignore-revs-file=/proc/1/environ', 'README.md'], /--ignore-revs-file/);
  rejected(['blame', '-S', '/proc/1/environ', 'README.md'], /-S/);
  rejected(['blame', '-wS/proc/1/environ', 'README.md'], /-S/);
  rejected(['grep', '-f', '/proc/1/environ'], /-f/);
  rejected(['grep', '-nf/proc/1/environ'], /-f/);
  rejected(['ls-files', '--pathspec-from-file=/etc/passwd'], /--pathspec-from-file/);
  rejected(['grep', '-c', 'x'], /--count/);
});

test('git diff refuses paths outside the repository, which turn on --no-index by themselves', () => {
  rejected(['diff', '/etc/passwd', '/dev/null'], /outside the repository/);
  rejected(['diff', '--stat', '../../etc/passwd', 'README.md'], /"\.\.\/\.\.\/etc\/passwd"/);
  rejected(['diff', 'src/../../x', 'README.md'], /outside the repository/);
  rejected(['diff', '..', 'README.md'], /outside the repository/);
  rejected(['diff', '--', '/etc/passwd'], /outside the repository/);
  ok(['diff', 'abc..def', '--', 'src/server.c']);
  ok(['diff', '..HEAD']);
  ok(['diff', 'a...b', '--', 'src/../README.md']);
  ok(['diff', 'HEAD~1', 'HEAD', '--', 'src']);
  ok(['log', '-p', '--', 'src']);
});

test('-O inside a short-option bundle is refused for commands that take diff options', () => {
  rejected(['diff', '-RO/etc/passwd'], /git diff -O/);
  rejected(['diff', '-pO', '/etc/passwd'], /git diff -O/);
  rejected(['log', '-pO/proc/self/environ'], /git log -O/);
  rejected(['show', '-sRO/etc/passwd', 'HEAD'], /git show -O/);
  rejected(['rev-list', '-pO/etc/passwd', 'HEAD'], /git rev-list -O/);
  rejected(['shortlog', '-sO/etc/passwd'], /git shortlog -O/);
  rejected(['shortlog', '-nO/etc/passwd'], /git shortlog -O/);
  rejected(['shortlog', '-snO/etc/passwd'], /git shortlog -O/);
  rejected(['reflog', 'show', '-pO/etc/passwd'], /git reflog -O/);
  rejected(['blame', '-wO/etc/passwd', 'README.md'], /git blame -O/);
});

test('an O inside the value of a diff or log option is fine', () => {
  ok(['log', '-SOBJ_ENCODING', '--', 'src']);
  ok(['log', '-pSOBJ_ENCODING']);
  ok(['log', '-GObj', '-p']);
  ok(['log', '-L/Old/,+5:src/server.c']);
  ok(['diff', '-IOptional', 'a..b']);
  ok(['diff', '-U5', '-M50%', '-C', 'a..b']);
  ok(['show', '-s', '--format=%H', 'HEAD']);
  ok(['log', '-p', '-20', '-n5']);
  ok(['rev-list', '--count', 'HEAD']);
});

test('--text and --filter pass only where they are real options', () => {
  for (const sub of ['diff', 'show', 'log', 'reflog', 'blame', 'grep']) ok([sub, '--text']);
  ok(['rev-list', '--filter=blob:none', '--objects', 'HEAD']);
  // cat-file has no --text, and older git no --filter: they abbreviate --textconv and --filters.
  rejected(['cat-file', '--text', 'HEAD:README.md'], /--textconv/);
  rejected(['cat-file', '--filter', 'HEAD:README.md'], /--filters/);
  rejected(['cat-file', '--filter=blob:none', 'HEAD:README.md'], /--filters/);
  rejected(['log', '--ignore-rev', 'abc123'], /--ignore-revs-file/);
  // Names that exist on Object.prototype are just unknown options.
  ok(['log', '--constructor']);
  ok(['log', '--__proto__']);
});

test('blame and grep options that merely look similar are fine', () => {
  ok(['blame', '--ignore-rev', 'abc123', 'README.md']);
  ok(['blame', '-w', '-M', '-C', '-L', '1,5', 'README.md']);
  ok(['blame', '-L/Sentinel/,+5', 'README.md']);
  ok(['grep', '-e', 'fork', '-e', 'Format']);
  ok(['log', '-S', 'Format', '--', 'src']);
});

test('a grep pattern that merely contains O is fine', () => {
  ok(['grep', '-e', 'OBJ_ENCODING']);
  ok(['grep', '-eOBJ_ENCODING']);
  ok(['grep', 'OBJ_ENCODING']);
});

test('branch and tag only list refs', () => {
  ok(['branch']);
  ok(['branch', '-a']);
  ok(['branch', '-vv']);
  ok(['branch', '--list', 'release-*']);
  ok(['branch', '-r', '--contains', 'abc123']);
  ok(['branch', '--format', '%(refname)', '--sort=-committerdate']);
  ok(['tag', '-l', '9.*']);
  ok(['tag', '--contains', 'abc123']);
  ok(['tag', '-n5', '--list', '8.*']);

  rejected(['branch', 'new-branch'], /--list/);
  rejected(['branch', 'new-branch', 'HEAD'], /--list/);
  rejected(['branch', '--', 'new-branch'], /--list/);
  rejected(['branch', '-d', 'main']);
  rejected(['branch', '-D', 'main']);
  rejected(['branch', '-m', 'a', 'b']);
  rejected(['branch', '-M', 'a', 'b']);
  rejected(['branch', '-f', 'main', 'HEAD']);
  rejected(['branch', '-ad', 'main']);
  rejected(['branch', '--delete', 'main']);
  rejected(['branch', '--move', 'a', 'b']);
  rejected(['branch', '--force', 'main']);
  rejected(['branch', '--set-upstream-to=origin/main']);
  rejected(['branch', '--li', 'x']);
  rejected(['tag', 'v1']);
  rejected(['tag', '-a', 'v1', '-m', 'msg']);
  rejected(['tag', '-d', 'v1']);
  rejected(['tag', '-f', 'v1']);
  rejected(['tag', '-v', 'v1']);
});

test('reflog may only be read', () => {
  ok(['reflog']);
  ok(['reflog', 'show', '-n', '5', 'HEAD']);
  ok(['reflog', 'exists', 'HEAD']);
  rejected(['reflog', 'expire', '--all'], /expire/);
  rejected(['reflog', 'delete', 'HEAD@{0}'], /delete/);
  rejected(['reflog', '-n1', 'expire', '--all'], /expire/);
  rejected(['reflog', 'drop', 'HEAD'], /drop/);
});

test('diff-producing commands run with helpers disabled', () => {
  assert.deepEqual(gitArgv(['diff', 'a..b']), ['diff', '--no-ext-diff', '--no-textconv', 'a..b']);
  assert.deepEqual(gitArgv(['log', '-p']), ['log', '--no-ext-diff', '--no-textconv', '-p']);
  assert.deepEqual(gitArgv(['show', 'HEAD']), ['show', '--no-ext-diff', '--no-textconv', 'HEAD']);
  assert.deepEqual(gitArgv(['blame', 'f']), ['blame', '--no-textconv', 'f']);
  assert.deepEqual(gitArgv(['grep', 'x']), ['grep', 'x']);
});
