import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { buildHarnessTools } = await import('../src/tools/harness.ts');

// realpath: on macOS the temp directory is behind the /var symlink.
const tempDir = (prefix) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));

/** A workspace with symlinks a PR could commit, and a directory outside it. */
async function setup() {
  const ws = tempDir('harness-ws-');
  const outside = tempDir('harness-outside-');
  mkdirSync(path.join(ws, '.git', 'hooks'), { recursive: true });
  symlinkSync(outside, path.join(ws, 'link'));
  symlinkSync(path.join(ws, '.git'), path.join(ws, 'gitlink'));
  symlinkSync(path.join(outside, 'missing'), path.join(ws, 'dangling'));
  const { tools } = await buildHarnessTools({ workspaceRoot: ws, allowWrite: true });
  const write = tools.find((t) => t.name === 'write');
  return { ws, outside, write: (p, content = 'x') => write.invoke({ path: path.join(ws, p), content }) };
}

test('write creates new files and directories inside the workspace', async () => {
  const { ws, write } = await setup();
  assert.doesNotMatch(await write('src/new/file.c', 'int x;\n'), /^ERROR/);
  assert.equal(readFileSync(path.join(ws, 'src/new/file.c'), 'utf8'), 'int x;\n');
});

test('write refuses a new file under a directory symlink that points outside', async () => {
  const { outside, write } = await setup();
  assert.match(await write('link/.gitconfig'), /^ERROR.*outside the workspace/);
  assert.equal(existsSync(path.join(outside, '.gitconfig')), false);
});

test('write refuses to create directories through a symlink that points outside', async () => {
  const { outside, write } = await setup();
  assert.match(await write('link/sub/file'), /^ERROR/);
  assert.equal(existsSync(path.join(outside, 'sub')), false);
  assert.match(await write('dangling/file'), /^ERROR/);
  assert.equal(existsSync(path.join(outside, 'missing')), false);
});

test('write refuses a new file in .git reached through a symlink', async () => {
  const { ws, write } = await setup();
  assert.match(await write('gitlink/hooks/post-checkout', '#!/bin/sh\n'), /^ERROR/);
  assert.equal(existsSync(path.join(ws, '.git', 'hooks', 'post-checkout')), false);
});

test('grep leaves out matches in files on the sensitive-path list', async () => {
  const ws = tempDir('harness-grep-');
  mkdirSync(path.join(ws, 'src'));
  mkdirSync(path.join(ws, 'certs'));
  writeFileSync(path.join(ws, 'src', 'a.c'), 'needle\n');
  writeFileSync(path.join(ws, 'certs', 'server.pem'), 'needle\n');
  writeFileSync(path.join(ws, 'certs', 'server.key'), 'needle\n');
  const { tools } = await buildHarnessTools({ workspaceRoot: ws });
  const grep = tools.find((t) => t.name === 'grep');
  for (const output_mode of ['files_with_matches', 'content', 'count']) {
    const out = await grep.invoke({ pattern: 'needle', output_mode });
    assert.match(out, /a\.c/, output_mode);
    assert.doesNotMatch(out, /server\.(pem|key)/, output_mode);
  }
});
