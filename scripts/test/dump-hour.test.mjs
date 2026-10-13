import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeAwsCli, runShell } from './support/aws.mjs';

const RECEIVER = [
  '2026-10-13T10:00:00 [delivery] event=pull_request repo=valkey-io/valkey actor=alice status=202 decision=enqueued',
  '2026-10-13T10:01:00 [delivery] event=issue_comment repo=valkey-io/valkey actor=bo\u001b[2Jb\u202e status=200 decision=skipped:noise:bot',
  '',
].join('\n');
// The curator's [done] line carries part of its output, which a model can shape.
const CURATOR = [
  '2026-10-13T10:02:00 [invoke] feedback#1 attempt=1',
  '2026-10-13T10:03:00 [done] feedback#1 terminal=done\u001b]0;title\u0007\u200b\u0085',
  '',
].join('\n');

async function dumpHour(args) {
  const cli = fakeAwsCli({
    'cloudformation list-stack-resources': [
      { stdout: 'ValkeyReviewWebhook-ReceiverFn-AAA\n' },
      { stdout: 'ValkeyReviewWebhook-CuratorWorkerFn-BBB\n' },
    ],
    'lambda get-function-configuration': { stdout: 'None\n' },
    'logs tail': [{ stdout: RECEIVER }, { stdout: CURATOR }],
  });
  const r = await runShell('dump-hour.sh', args, { env: cli.env });
  return { ...r, calls: cli.calls() };
}

test('dump-hour.sh prints no control, escape or format character from the logs', async () => {
  const r = await dumpHour(['--stack', 'ValkeyReviewWebhook', '--raw']);
  assert.equal(r.code, 0, r.stderr);
  // The script's own tab separates the repo x decision columns.
  assert.ok(!/[^\t\n\P{Cc}]|[\p{Cf}\p{Zl}\p{Zp}]/u.test(r.stdout), JSON.stringify(r.stdout));
  assert.match(r.stdout, /^deliveries observed: 2$/m);
  assert.match(r.stdout, /^ +1 bo\?\[2Jb\?$/m, 'the actor tally');
  assert.match(r.stdout, /^ +1 terminal=done\?\]0;title\?\?\?$/m, 'the curator decision tally');
  assert.match(r.stdout, /actor=bo\?\[2Jb\? status=200/, 'the raw delivery line');
  assert.deepEqual(r.calls.filter((c) => c.op === 'logs tail').map((c) => c.args[2]), [
    '/aws/lambda/ValkeyReviewWebhook-ReceiverFn-AAA', '/aws/lambda/ValkeyReviewWebhook-CuratorWorkerFn-BBB',
  ]);
});
