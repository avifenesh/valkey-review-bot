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

const sh = (script, opts = {}) =>
  runBounded('sh', ['-c', script], { env: process.env, timeoutMs: 5_000, maxBytes: 1_000, graceMs: 300, ...opts });

/** Wait until `pid` is gone, for at most `ms`. */
async function gone(pid, ms = 3_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
  }
  return false;
}

test('a timeout also stops the processes the command started', async () => {
  // sh forks sleep, which keeps stdout open after sh is killed.
  const started = Date.now();
  const r = await sh('sleep 30; echo done', { timeoutMs: 200 });
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  assert.equal(r.out, '');
  assert.notEqual(r.code, 0);
});

test('a background process left holding stdout is stopped after the grace period', async () => {
  const started = Date.now();
  const r = await sh('sleep 30 & echo $!');
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  assert.equal(r.code, 0);
  assert.ok(await gone(Number(r.out.trim())), 'the background sleep was stopped');
});

test('waiting for output ends even when a process outside the group holds stdout', async () => {
  const script = `
    const c = require('node:child_process').spawn('sleep', ['30'], { detached: true, stdio: 'inherit' });
    c.unref();
    console.log(c.pid);`;
  const started = Date.now();
  const r = await node(script, { graceMs: 300 });
  const pid = Number(r.out.trim());
  try {
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    assert.equal(r.code, 0);
    assert.ok(pid > 0);
  } finally {
    if (pid > 0) process.kill(pid, 'SIGKILL');
  }
});

test('a command that ignores SIGTERM is killed after the grace period', async () => {
  const started = Date.now();
  const r = await node("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)", { timeoutMs: 100, graceMs: 300 });
  assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
  assert.notEqual(r.code, 0);
});

test('mergeStderr collects stderr into out under the same cap', async () => {
  const r = await node('process.stdout.write("to-out "); process.stderr.write("to-err")', { mergeStderr: true });
  assert.match(r.out, /to-out/);
  assert.match(r.out, /to-err/);
  assert.equal(r.err, '');

  const capped = await node('process.stderr.write("e".repeat(5000)); setTimeout(() => {}, 10000)', { mergeStderr: true, maxBytes: 10 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.out, `${'e'.repeat(10)}\n[output truncated]`);
});

test('stderr keeps its first maxErrBytes', async () => {
  const r = await node('process.stderr.write("e".repeat(5000))', { maxErrBytes: 10 });
  assert.equal(r.err, 'e'.repeat(10));
  assert.equal(r.truncated, false);
});
