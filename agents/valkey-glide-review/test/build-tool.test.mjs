import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { buildGlideBuildTool } = await import('../src/tools/build.ts');

test('build returns stdout, then stderr, then the exit code', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'build-tool-'));
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'x', version: '1.0.0', scripts: { test: 'echo to-out && echo to-err >&2 && exit 3' },
  }));
  const out = await buildGlideBuildTool({ workspaceRoot: dir }).invoke({ subcommand: 'npm', args: ['test'], subdir: '.' });
  const [stdout, stderr] = out.split('\n--- stderr ---\n');
  assert.match(stdout, /to-out/);
  assert.match(stderr, /to-err/);
  assert.match(out, /\n\[exit 3\]$/);
});
