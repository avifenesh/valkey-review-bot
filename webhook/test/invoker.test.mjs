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
 * table and the run's heartbeat record. Writes succeed unless `deleteError`.
 */
function tables({ marker, heartbeat, deleteError } = {}) {
  return async (command) => {
    const { TableName } = command.input;
    switch (`${command.constructor.name} ${TableName}`) {
      case 'GetCommand idempotency': return marker ? { Item: { ...MARKER_KEY, marker } } : {};
      case 'GetCommand heartbeat': return heartbeat ? { Item: heartbeat } : {};
      case 'DeleteCommand idempotency':
        if (deleteError) throw deleteError;
        return {};
      default: throw new Error(`unexpected ${command.constructor.name} on ${TableName}`);
    }
  };
}

const ops = () => calls.map((c) => `${c.op}${c.input.TableName ? ` ${c.input.TableName}` : ''}`);
const invoked = () => JSON.parse(new TextDecoder().decode(calls.find((c) => c.op === 'InvokeAgentRuntimeCommand').input.payload));

test('a review of new commits that holds its marker clears it, then runs', async () => {
  ddbAnswer = tables({ marker: 'marker-1' });
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.deepEqual(calls[0].input, { TableName: 'idempotency', Key: MARKER_KEY, ConsistentRead: true });
  assert.deepEqual(calls[1].input, {
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
  assert.deepEqual(ops(), ['GetCommand idempotency', 'InvokeAgentRuntimeCommand']);
});

test('a failed clear stops the run, and the retry runs it on the primary model', async () => {
  ddbAnswer = tables({ marker: 'marker-1', deleteError: Object.assign(new Error('throttled'), { name: 'ThrottlingException' }) });
  const failed = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(failed.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'DeleteCommand idempotency'], 'not invoked: the marker still says it never ran');
  assert.ok(failed.lines.some((l) => /^\[fail\] messageId=m1: throttled$/.test(l)), failed.lines.join('\n'));
  assert.equal(failed.lines.some((l) => l.startsWith('[invoke]')), false);

  ddbAnswer = tables({ marker: 'marker-1' });
  const retried = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(retried.result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand'], 'no heartbeat read');
  assert.equal(invoked().use_fallback_model, undefined);
});

test('a failed marker read leaves the message for a retry', async () => {
  ddbAnswer = async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); };
  const { result } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency']);
});

test('a redelivery whose marker is gone is watched like any review', async () => {
  ddbAnswer = tables({ heartbeat: { status: 'running', last_activity: Date.now() } });
  const alive = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(alive.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'GetCommand heartbeat']);

  ddbAnswer = tables({});
  await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(ops(), ['GetCommand idempotency', 'GetCommand heartbeat', 'InvokeAgentRuntimeCommand']);
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
    assert.deepEqual(ops(), ['InvokeAgentRuntimeCommand']);
    assert.ok(lines.some((l) => /IDEMPOTENCY_TABLE is not set; the pending marker stays until it expires/.test(l)));
  } finally {
    process.env.IDEMPOTENCY_TABLE = saved;
  }
});

test('reviews without a marker and curator messages make no store call', async () => {
  ddbAnswer = async () => ({});
  await run(sqsEvent(review));
  assert.deepEqual(calls.map((c) => c.op), ['InvokeAgentRuntimeCommand']);
  await run(sqsEvent({ maintenance_id: 'check#valkey-review#r1#2026-10-13', reviewer_id: 'valkey-review' }));
  assert.deepEqual(calls.map((c) => c.op), ['InvokeAgentRuntimeCommand']);
});
