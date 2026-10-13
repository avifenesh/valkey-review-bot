import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { conditionFailed } from './support/fakes.mjs';

// The invoker reads its settings and builds its clients when it loads, so
// the environment and the client stubs go in first.
Object.assign(process.env, {
  AWS_REGION: 'us-east-1',
  RUNTIME_ARN: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/reviewer',
  HEARTBEAT_TABLE: 'heartbeat',
  IDEMPOTENCY_TABLE: 'idempotency',
});

/** Every client call in order, as { op, input }. */
const calls = [];
let ddbAnswer = async () => ({});
DynamoDBDocumentClient.prototype.send = async function (command) {
  calls.push({ op: command.constructor.name, input: command.input });
  return ddbAnswer(command);
};
BedrockAgentCoreClient.prototype.send = async function (command) {
  calls.push({ op: command.constructor.name, input: command.input });
  const frames = 'event: done\ndata: {"terminal_tool":"post_review"}\n\n';
  return { response: (async function* () { yield new TextEncoder().encode(frames); })() };
};

const { handler } = await import('../src/invoker.ts');

const review = { repo: 'Example-Org/Valkey', pr_number: 7, installation_id: 42, head_sha: 'bbb' };

function sqsEvent(envelope, receiveCount = 1) {
  return {
    Records: [{
      messageId: 'm1',
      body: JSON.stringify(envelope),
      attributes: { ApproximateReceiveCount: String(receiveCount), SentTimestamp: String(Date.now()) },
    }],
  };
}

async function run(event) {
  calls.length = 0;
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await handler(event), lines };
  } finally {
    Object.assign(console, saved);
  }
}

const MARKER_KEY = { key: 'pending#example-org/valkey#7' };

/**
 * Answers the worker's table reads: the pending marker in the receiver's
 * table, the run's heartbeat record, and the scan of the pull request's
 * runs (`pages`, one array of records per page). Writes succeed unless
 * `deleteError`.
 */
function tables({ marker, heartbeat, pages = [[]], deleteError } = {}) {
  return async (command) => {
    const { TableName, ExclusiveStartKey } = command.input;
    switch (`${command.constructor.name} ${TableName}`) {
      case 'GetCommand idempotency': return marker ? { Item: { ...MARKER_KEY, marker } } : {};
      case 'GetCommand heartbeat': return heartbeat ? { Item: heartbeat } : {};
      case 'ScanCommand heartbeat': {
        const page = ExclusiveStartKey ? ExclusiveStartKey.page : 0;
        const more = page + 1 < pages.length ? { LastEvaluatedKey: { page: page + 1 } } : {};
        return { Items: pages[page], ...more };
      }
      case 'UpdateCommand idempotency': return {};
      case 'DeleteCommand idempotency':
        if (deleteError) throw deleteError;
        return {};
      default: throw new Error(`unexpected ${command.constructor.name} on ${TableName}`);
    }
  };
}

const ops = () => calls.map((c) => `${c.op}${c.input.TableName ? ` ${c.input.TableName}` : ''}`);
const invoked = () => JSON.parse(new TextDecoder().decode(calls.find((c) => c.op === 'InvokeAgentRuntimeCommand').input.payload));

test('an automatic review that holds its marker clears it, then runs', async () => {
  ddbAnswer = tables({ marker: 'marker-1' });
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.deepEqual(calls[0].input, { TableName: 'idempotency', Key: MARKER_KEY, ConsistentRead: true });
  assert.deepEqual(calls[2].input, {
    TableName: 'idempotency',
    Key: MARKER_KEY,
    ConditionExpression: '#m = :m',
    ExpressionAttributeNames: { '#m': 'marker' },
    ExpressionAttributeValues: { ':m': 'marker-1' },
  });
  assert.equal(invoked().pending_marker, 'marker-1', 'the envelope is forwarded unchanged');
  assert.ok(lines.some((l) => /^\[pending\] review repo=Example-Org\/Valkey pr=7 head=bbb marker=marker-1 cleared$/.test(l)), lines.join('\n'));
});

test('a marker that a later push replaced is left alone, and the run goes ahead', async () => {
  ddbAnswer = tables({ marker: 'marker-2' });
  const { result } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'InvokeAgentRuntimeCommand']);
});

test('a failed clear stops the run, and the retry runs it on the primary model', async () => {
  ddbAnswer = tables({ marker: 'marker-1', deleteError: Object.assign(new Error('throttled'), { name: 'ThrottlingException' }) });
  const failed = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(failed.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'DeleteCommand idempotency'], 'not invoked: the marker still says it never ran');
  assert.ok(failed.lines.some((l) => /^\[fail\] messageId=m1: throttled$/.test(l)), failed.lines.join('\n'));
  assert.equal(failed.lines.some((l) => l.startsWith('[invoke]')), false);

  ddbAnswer = tables({ marker: 'marker-1' });
  const retried = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(retried.result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand'], 'no heartbeat read');
  assert.equal(invoked().use_fallback_model, undefined);
});

test('a failed marker read leaves the message for a retry', async () => {
  ddbAnswer = async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); };
  const { result } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency']);
});

test('a worker not allowed to read the marker runs the review like any other', async () => {
  ddbAnswer = async (command) => {
    if (command.constructor.name === 'GetCommand') throw Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
    if (command.constructor.name === 'ScanCommand') return { Items: [] };
    throw new Error(`unexpected ${command.constructor.name}`);
  };
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'InvokeAgentRuntimeCommand']);
  assert.ok(lines.some((l) => /may not read idempotency; the pending marker stays until it expires/.test(l)), lines.join('\n'));
});

test('a redelivery whose marker is gone is watched like any review', async () => {
  ddbAnswer = tables({ heartbeat: { status: 'running', last_activity: Date.now() } });
  const alive = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(alive.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'GetCommand heartbeat']);

  ddbAnswer = tables({});
  await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(ops(), ['GetCommand idempotency', 'GetCommand heartbeat', 'ScanCommand heartbeat', 'InvokeAgentRuntimeCommand']);
  assert.equal(invoked().use_fallback_model, true, 'a run that died is retried on the fallback model');
});

test('without IDEMPOTENCY_TABLE the marker is left to expire', async () => {
  const saved = process.env.IDEMPOTENCY_TABLE;
  process.env.IDEMPOTENCY_TABLE = '';
  try {
    const { handler: bare } = await import(`../src/invoker.ts?bare`);
    ddbAnswer = tables({});
    calls.length = 0;
    const lines = [];
    const original = { log: console.log, warn: console.warn };
    console.log = console.warn = (...args) => lines.push(args.join(' '));
    try {
      assert.deepEqual(await bare(sqsEvent({ ...review, pending_marker: 'marker-1' })), { batchItemFailures: [] });
    } finally {
      Object.assign(console, original);
    }
    assert.deepEqual(ops(), ['ScanCommand heartbeat', 'InvokeAgentRuntimeCommand']);
    assert.ok(lines.some((l) => /IDEMPOTENCY_TABLE is not set; the pending marker stays until it expires/.test(l)));
  } finally {
    process.env.IDEMPOTENCY_TABLE = saved;
  }
});

const pushed = { ...review, run_nonce: 'push', pending_marker: 'marker-1', trigger: 'push', skip_drafts: false };
const running = (runKey, agoMs = 60_000) => ({ run_key: runKey, status: 'running', last_activity: Date.now() - agoMs });

test('a review of new commits looks for other runs of its pull request before it runs', async () => {
  ddbAnswer = tables({ marker: 'marker-1' });
  const { result } = await run(sqsEvent(pushed));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.deepEqual(calls[1].input, {
    TableName: 'heartbeat',
    FilterExpression: 'begins_with(#k, :prefix) AND #s = :running',
    ProjectionExpression: '#k, #a, #s',
    ExpressionAttributeNames: { '#k': 'run_key', '#a': 'last_activity', '#s': 'status' },
    ExpressionAttributeValues: { ':prefix': 'Example-Org/Valkey#7#', ':running': 'running' },
    ConsistentRead: true,
  });
});

test('while another review of the pull request runs, a review of new commits waits and keeps its marker', async () => {
  ddbAnswer = tables({ marker: 'marker-1', pages: [[running('Example-Org/Valkey#7#aaa')]] });
  const before = Math.floor(Date.now() / 1000);
  const { result, lines } = await run(sqsEvent(pushed));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand idempotency']);
  const update = calls[2].input;
  assert.deepEqual(update.Key, MARKER_KEY);
  assert.equal(update.ConditionExpression, '#m = :m');
  assert.equal(update.ExpressionAttributeValues[':m'], 'marker-1');
  assert.ok(update.ExpressionAttributeValues[':ttl'] >= before + 3600, 'kept an hour past this receive');
  assert.ok(lines.some((l) => /^\[watchdog\] review repo=Example-Org\/Valkey pr=7 head=bbb waits for Example-Org\/Valkey#7#aaa \(heartbeat 60s ago\); checking again after the visibility timeout$/.test(l)), lines.join('\n'));
  assert.equal(lines.some((l) => l.startsWith('[fail]')), false, 'waiting is not a failure');
});

test('after waiting, a review of new commits runs on the primary model', async () => {
  ddbAnswer = tables({ marker: 'marker-1' });
  const { result } = await run(sqsEvent(pushed, 4));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.equal(invoked().use_fallback_model, undefined);
});

test('an opened, reopened or ready review waits too, then runs on the primary model', async () => {
  const opened = { ...review, pending_marker: 'marker-1' };
  ddbAnswer = tables({ marker: 'marker-1', pages: [[running('Example-Org/Valkey#7#aaa#push')]] });
  const waited = await run(sqsEvent(opened));
  assert.deepEqual(waited.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand idempotency'], 'not invoked; marker kept');

  ddbAnswer = tables({ marker: 'marker-1' });
  const ran = await run(sqsEvent({ ...opened, run_nonce: 'ready' }, 3));
  assert.deepEqual(ran.result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.equal(invoked().use_fallback_model, undefined);
});

test('a running review on a later page of the scan is found', async () => {
  ddbAnswer = tables({ marker: 'marker-1', pages: [[], [], [running('Example-Org/Valkey#7#aaa#m9')]] });
  const { result } = await run(sqsEvent(pushed));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops().filter((o) => o.startsWith('Scan')).length, 3);
  assert.deepEqual(calls.filter((c) => c.op === 'ScanCommand').map((c) => c.input.ExclusiveStartKey), [undefined, { page: 1 }, { page: 2 }]);
});

test('a review of new commits still waiting past its run budget is dropped and lets go of its marker', async () => {
  ddbAnswer = tables({ marker: 'marker-1', pages: [[running('Example-Org/Valkey#7#aaa')]] });
  const event = sqsEvent(pushed, 7);
  event.Records[0].attributes.SentTimestamp = String(Date.now() - 91 * 60_000);
  const { result, lines } = await run(event);
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'DeleteCommand idempotency']);
  assert.ok(lines.some((l) => /^\[abandoned\] review repo=Example-Org\/Valkey pr=7 head=bbb attempt=7: still waiting for Example-Org\/Valkey#7#aaa/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => / marker=marker-1 cleared$/.test(l)));
});

test('a dead review of new commits waits too, without a marker to keep', async () => {
  ddbAnswer = tables({ pages: [[running('Example-Org/Valkey#7#ccc')]] });
  const { result } = await run(sqsEvent(pushed, 2));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'GetCommand heartbeat', 'ScanCommand heartbeat']);
});

test('reviews without a marker and curator messages make no store call', async () => {
  ddbAnswer = async () => ({});
  await run(sqsEvent(review));
  assert.deepEqual(calls.map((c) => c.op), ['InvokeAgentRuntimeCommand']);
  await run(sqsEvent({ ...review, run_nonce: 'm5', status_comment_id: 5, instruction: 'review' }));
  assert.deepEqual(calls.map((c) => c.op), ['InvokeAgentRuntimeCommand'], 'only automatic reviews look for other runs');
  await run(sqsEvent({ maintenance_id: 'check#valkey-review#r1#2026-10-13', reviewer_id: 'valkey-review' }));
  assert.deepEqual(calls.map((c) => c.op), ['InvokeAgentRuntimeCommand']);
});
