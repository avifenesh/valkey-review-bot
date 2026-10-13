import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { runBounded } = await import('../src/tools/spawn.ts');

const node = (script, opts = {}) =>
  runBounded(process.execPath, ['-e', script], { env: process.env, timeoutMs: 5_000, maxBytes: 1_000, ...opts });

test('output and exit code come back', async () => {
  const r = await node('process.stdout.write("out"); process.stderr.write("err"); process.exit(3)');
  assert.deepEqual(r, { code: 3, out: 'out', err: 'err', truncated: false });
});

test('stdout past the cap is cut and the process stopped', async () => {
  const r = await node('process.stdout.write("x".repeat(5000)); setTimeout(() => {}, 10000)', { maxBytes: 10 });
  assert.equal(r.truncated, true);
  assert.equal(r.out, `${'x'.repeat(10)}\n[output truncated]`);
});

test('a command that runs too long is stopped', async () => {
  const started = Date.now();
  const r = await node('setTimeout(() => {}, 10000)', { timeoutMs: 100 });
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - started < 5_000);
});

test('a command that cannot start resolves with code 127', async () => {
  const r = await runBounded('definitely-not-a-command-here', [], { env: process.env, timeoutMs: 1_000, maxBytes: 100 });
  assert.equal(r.code, 127);
  assert.match(r.err, /could not run definitely-not-a-command-here/);
});
