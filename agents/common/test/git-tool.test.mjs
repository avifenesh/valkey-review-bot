import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { buildGitTool } = await import('../src/tools/git.ts');

const tempDir = (prefix) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));

/** A one-commit repository, built without any user or system gitconfig. */
function repo() {
  const dir = tempDir('git-tool-');
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@example.com', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@example.com',
  };
  const git = (...args) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  return dir;
}

test('the git tool ignores a gitconfig in HOME', async () => {
  const dir = repo();
  const home = tempDir('git-tool-home-');
  writeFileSync(path.join(home, '.gitconfig'), '[log]\n\tdate = unix\n');
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  try {
    const out = await buildGitTool({ workspaceRoot: dir }).invoke({ args: ['log', '-1', '--format=%ad'] });
    assert.doesNotMatch(out.trim(), /^\d+$/, 'log.date from HOME was applied');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('--text never turns on a configured textconv driver', async () => {
  const dir = repo();
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  execFileSync('git', ['config', 'diff.up.textconv', 'sed s/hello/CONVERTED/'], { cwd: dir, env });
  writeFileSync(path.join(dir, '.gitattributes'), 'README.md diff=up\n');
  // The driver is live: git run directly with --textconv applies it.
  assert.match(execFileSync('git', ['cat-file', '--textconv', 'HEAD:README.md'], { cwd: dir, env }).toString(), /CONVERTED/);
  const tool = buildGitTool({ workspaceRoot: dir });
  for (const args of [
    ['cat-file', '--text', 'HEAD:README.md'],
    ['show', '--text', 'HEAD'],
    ['log', '--text', '-p', '-1'],
    ['diff', '--text', '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'HEAD'],
    ['blame', '--text', 'README.md'],
    ['grep', '--text', 'hello'],
  ]) {
    assert.doesNotMatch(await tool.invoke({ args }), /CONVERTED/, args.join(' '));
  }
});

test('git diff does not read a file outside the repository', async () => {
  const dir = repo();
  const secret = path.join(tempDir('git-tool-outside-'), 'secret.txt');
  writeFileSync(secret, 'outside-content\n');
  const tool = buildGitTool({ workspaceRoot: dir });
  for (const args of [['diff', secret, '/dev/null'], ['diff', '--stat', path.relative(dir, secret), 'README.md']]) {
    const out = await tool.invoke({ args });
    assert.match(out, /^ERROR:/, args.join(' '));
    assert.doesNotMatch(out, /outside-content|secret\.txt \|/);
  }
});

test('git diff does not read outside the repository through a directory named like an option', async () => {
  const dir = repo();
  mkdirSync(path.join(dir, '-x'));
  const secret = path.join(tempDir('git-tool-outside-'), 'secret.txt');
  writeFileSync(secret, 'outside-content\n');
  const tool = buildGitTool({ workspaceRoot: dir });
  const sneaky = `-x/${path.relative(path.join(dir, '-x'), secret)}`;
  const out = await tool.invoke({ args: ['diff', '--', sneaky, 'README.md'] });
  assert.match(out, /^ERROR:/);
  assert.doesNotMatch(out, /outside-content/);
});
