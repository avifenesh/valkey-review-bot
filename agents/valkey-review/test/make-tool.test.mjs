import '../../common/test/support/ts-resolve.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { buildMakeTool } = await import('../src/tools/make.ts');

function workspace(makefile) {
  const dir = mkdtempSync(path.join(tmpdir(), 'make-tool-'));
  writeFileSync(path.join(dir, 'Makefile'), makefile);
  return dir;
}

test('make returns stdout and stderr together, then the exit code', async () => {
  const dir = workspace('all:\n\t@echo built\n\t@echo a-warning >&2\n');
  const out = await buildMakeTool({ workspaceRoot: dir }).invoke({ targets: ['all'] });
  assert.match(out, /built/);
  assert.match(out, /a-warning/);
  assert.match(out, /\n\[exit 0\]$/);
});

test('a failing target reports make\'s exit code', async () => {
  const dir = workspace('all:\n\t@false\n');
  const out = await buildMakeTool({ workspaceRoot: dir }).invoke({ targets: ['all'] });
  assert.match(out, /\n\[exit 2\]$/);
});
