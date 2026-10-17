import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { buildReviewBotBuildTool } = await import('../src/tools/build.ts');

function workspace(scripts) {
  const root = mkdtempSync(path.join(tmpdir(), 'build-tool-'));
  mkdirSync(path.join(root, 'pkg'));
  writeFileSync(path.join(root, 'pkg', 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0', scripts }));
  return root;
}

test('build returns stdout, then stderr, then the exit code', async () => {
  const root = workspace({ test: 'echo to-out && echo to-err >&2 && exit 3' });
  const out = await buildReviewBotBuildTool({ workspaceRoot: root }).invoke({ subcommand: 'npm', args: ['test'], dir: 'pkg' });
  const [stdout, stderr] = out.split('\n--- stderr ---\n');
  assert.match(stdout, /to-out/);
  assert.match(stderr, /to-err/);
  assert.match(out, /\n\[exit 3\]$/);
});

// Code from the pull request runs here. It sees no credential, and the
// AWS SDK and npm see the settings that keep them off credentials and the network.
test('the command runs without credentials, with credential sources off and npm offline', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 't',
    AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.23/v1/credentials', GH_TOKEN: 'g', GITHUB_TOKEN: 'g',
  });
  try {
    const root = workspace({ test: 'env' });
    const out = await buildReviewBotBuildTool({ workspaceRoot: root }).invoke({ subcommand: 'npm', args: ['test'], dir: 'pkg' });
    for (const name of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      assert.doesNotMatch(out, new RegExp(`^${name}=`, 'm'), name);
    }
    assert.match(out, /^AWS_EC2_METADATA_DISABLED=true$/m);
    assert.match(out, /^AWS_CONFIG_FILE=\/dev\/null$/m);
    assert.match(out, /^AWS_SHARED_CREDENTIALS_FILE=\/dev\/null$/m);
    assert.match(out, /^npm_config_offline=true$/im);
    assert.match(out, /\n\[exit 0\]$/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('build refuses a dir outside the workspace and an argv the policy refuses', async () => {
  const root = workspace({ test: 'exit 0' });
  const tool = buildReviewBotBuildTool({ workspaceRoot: root });
  assert.match(await tool.invoke({ subcommand: 'npm', args: ['test'], dir: '../..' }), /^ERROR: dir "..\/.." is outside the workspace\.$/);
  assert.match(await tool.invoke({ subcommand: 'npm', args: ['ci'], dir: 'pkg' }), /^ERROR: npm action "ci" not allowed/);
});
