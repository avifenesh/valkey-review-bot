import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeAwsCli, flag, runScript, typed } from './support/aws.mjs';

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/ValkeyReviewWebhook-CuratorQueue';
const updatedAt = new Date(Date.now() - 86_400_000).toISOString();
const RECORDS = [
  { area_bucket: 'src', record_id: 'r1', graduated_record_name: 'rdb-load', updated_at: updatedAt },
  { area_bucket: 'src', record_id: 'r2', graduated_record_name: 'emptydb-flush', updated_at: updatedAt },
];

/** Runs skill-check.mjs with a fake CLI holding the stacks, RECORDS and the queue. */
async function skillCheck(args, responses = {}) {
  const cli = fakeAwsCli({
    'cloudformation describe-stacks': [
      { stdout: [{ OutputKey: 'ConcernsTableName', OutputValue: 'valkey_review_concerns' }] },
      { stdout: [{ OutputKey: 'CuratorQueueUrl', OutputValue: QUEUE }, { OutputKey: 'ApiUrl', OutputValue: 'https://x' }] },
    ],
    'dynamodb scan': { stdout: { Items: RECORDS.map((r) => typed(r)) } },
    'dynamodb update-item': { stdout: '' },
    'sqs send-message': { stdout: { MessageId: 'm-1' } },
    ...responses,
  });
  const r = await runScript('skill-check.mjs', args, { env: cli.env });
  const calls = cli.calls();
  const sent = calls.filter((c) => c.op === 'sqs send-message').map((c) => JSON.parse(flag(c.args, '--message-body')));
  return { ...r, calls, sent };
}

const STACKS = ['--stack', 'ValkeyReviewAgent', '--webhook-stack', 'ValkeyReviewWebhook'];

test('report mode by default: every graduated skill is claimed and queued with dry_run true', async () => {
  const r = await skillCheck([...STACKS, '--release', '9.1.2', '--region', 'us-west-2']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.op), [
    'cloudformation describe-stacks', 'cloudformation describe-stacks', 'dynamodb scan',
    'dynamodb update-item', 'sqs send-message', 'dynamodb update-item', 'sqs send-message',
  ]);
  assert.deepEqual(r.calls.slice(0, 2).map((c) => flag(c.args, '--stack-name')), ['ValkeyReviewAgent', 'ValkeyReviewWebhook']);
  assert.ok(r.calls.every((c) => flag(c.args, '--region') === 'us-west-2'), 'the region reaches every call');
  assert.equal(flag(r.calls[2].args, '--table-name'), 'valkey_review_concerns');
  assert.ok(r.calls.filter((c) => c.op === 'sqs send-message').every((c) => flag(c.args, '--queue-url') === QUEUE));
  assert.deepEqual(r.sent.map((m) => [m.reason, m.reviewer_id, m.record_name, m.release_tag, m.dry_run]), [
    ['check', 'valkey-review', 'rdb-load', '9.1.2', true],
    ['check', 'valkey-review', 'emptydb-flush', '9.1.2', true],
  ]);
  assert.match(r.stdout, /^report mode: dry_run=true/m);
  assert.match(r.stdout, /^queued 2 check\(s\) on the curator queue; skipped 0; errors 0$/m);
});

test('--apply sends dry_run false; --name queues one skill; no --release sends an empty tag', async () => {
  const r = await skillCheck([...STACKS, '--apply', '--name', 'emptydb-flush']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.sent.map((m) => [m.record_name, m.release_tag, m.dry_run]), [['emptydb-flush', '', false]]);
  assert.match(r.stdout, /^apply mode: dry_run=false/m);
});

test('--table and --queue-url need no stacks; the reviewer comes from the table name or --reviewer', async () => {
  const direct = ['--table', 'valkey_glide_review_concerns', '--queue-url', QUEUE];
  const r = await skillCheck(direct);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.op.startsWith('cloudformation')));
  assert.ok(r.sent.every((m) => m.reviewer_id === 'valkey-glide-review'));

  const odd = await skillCheck(['--table', 'my-table', '--queue-url', QUEUE]);
  assert.equal(odd.code, 1);
  assert.match(odd.stderr, /cannot tell the reviewer id from table "my-table"; pass --reviewer/);
  const named = await skillCheck(['--table', 'my-table', '--queue-url', QUEUE, '--reviewer', 'valkey-review']);
  assert.equal(named.code, 0, named.stderr);
  assert.ok(named.sent.every((m) => m.reviewer_id === 'valkey-review'));
});

test('--plan claims and sends nothing', async () => {
  const r = await skillCheck([...STACKS, '--plan']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.op), ['cloudformation describe-stacks', 'cloudformation describe-stacks', 'dynamodb scan']);
  assert.match(r.stdout, /^would queue bucket="src" id="r1" name="rdb-load" delay=0s$/m);
  assert.match(r.stdout, /^would queue 2 check\(s\)/m);
});

test('bad options fail before any AWS call', async () => {
  for (const [args, message] of [
    [[...STACKS, '--release', '9.2.0-rc1'], /--release must be a GA tag/],
    [[...STACKS, '--name', 'Bad Name'], /--name must be a registry record name/],
    [['--webhook-stack', 'W'], /pass exactly one of --stack or --table/],
    [['--stack', 'S', '--table', 't', '--queue-url', QUEUE], /pass exactly one of --stack or --table/],
    [['--stack', 'S'], /pass exactly one of --webhook-stack or --queue-url/],
    [['--table', 't_concerns', '--queue-url', 'http://insecure'], /must be an https:\/\/ SQS URL/],
    [['--table', 'my-table', '--queue-url', QUEUE, '--reviewer', 'Bad'], /--reviewer must be a reviewer id/],
    [['--table', 'valkey_glide_review_concerns', '--queue-url', QUEUE, '--reviewer', 'valkey-review'], /table valkey_glide_review_concerns belongs to reviewer valkey-glide-review, not "valkey-review"/],
    [[...STACKS, '--dry-run'], /Unknown option '--dry-run'/],
    [[...STACKS, '--limit', '0'], /--limit must be a whole number of at least 1, got "0"/],
    [[...STACKS, '--limit', '2.5'], /--limit must be a whole number of at least 1/],
    [[...STACKS, '--limit', 'all'], /--limit must be a whole number of at least 1/],
  ]) {
    const r = await skillCheck(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.equal(r.calls.length, 0, args.join(' '));
  }
});

test('a webhook stack without CuratorQueueUrl is an error', async () => {
  const r = await skillCheck(STACKS, {
    'cloudformation describe-stacks': [
      { stdout: [{ OutputKey: 'ConcernsTableName', OutputValue: 'valkey_review_concerns' }] },
      { stdout: [{ OutputKey: 'ApiUrl', OutputValue: 'https://x' }] },
    ],
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /stack ValkeyReviewWebhook has no output CuratorQueueUrl/);
  assert.equal(r.sent.length, 0);
});

test('a failed send exits 1 after releasing the claim', async () => {
  const r = await skillCheck(STACKS, { 'sqs send-message': { stderr: 'An error occurred (AccessDenied)\n', status: 254 } });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /errors 2$/m);
  assert.equal(r.calls.filter((c) => c.op === 'dynamodb update-item' && flag(c.args, '--update-expression').startsWith('REMOVE')).length, 2);
});

test('an AWS error reaches the terminal without control or format characters', async () => {
  const r = await skillCheck(STACKS, {
    'cloudformation describe-stacks': { stderr: 'An error occurred (ValidationException): Stack \u001b[2J\u202e does not exist\n', status: 254 },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^error: could not read the outputs of stack ValkeyReviewAgent: .*Stack \?\[2J\? does not exist/);
  assert.ok(!/[\u001b\u202e]/.test(r.stderr));
});

test('--limit caps the checks queued; the rest are listed and counted', async () => {
  const r = await skillCheck([...STACKS, '--limit', '1']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.sent.map((m) => m.record_name), ['rdb-load']);
  assert.match(r.stdout, /^limit: at most 1 check\(s\), 60 seconds apart$/m);
  assert.match(r.stdout, /^over the limit bucket="src" id="r2" name="emptydb-flush": a later run can queue it$/m);
  assert.match(r.stdout, /^queued 1 check\(s\) on the curator queue; skipped 0; errors 0$/m);
  assert.match(r.stdout, /^1 more over --limit 1\. A report-mode check advances no record/m);

  const apply = await skillCheck([...STACKS, '--limit', '1', '--apply']);
  assert.match(apply.stdout, /^1 more over --limit 1\. Run again for them once these checks have run/m);

  const many = await skillCheck([...STACKS, '--limit', '40', '--plan']);
  assert.match(many.stdout, /^limit: at most 40 check\(s\), 60 seconds apart; past the 16th they arrive together/m);
  const defaults = await skillCheck([...STACKS, '--plan']);
  assert.match(defaults.stdout, /^limit: at most 10 check\(s\), 60 seconds apart; 10 is the decay job's code default, not the deployed skillLifecycle\.checksPerDay$/m);
});
