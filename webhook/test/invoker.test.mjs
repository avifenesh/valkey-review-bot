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

test('a review of new commits clears its pending marker, then runs', async () => {
  ddbAnswer = async () => ({});
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(calls.map((c) => c.op), ['DeleteCommand', 'InvokeAgentRuntimeCommand']);
  assert.deepEqual(calls[0].input, {
    TableName: 'idempotency',
    Key: { key: 'pending#example-org/valkey#7' },
    ConditionExpression: '#m = :m',
    ExpressionAttributeNames: { '#m': 'marker' },
    ExpressionAttributeValues: { ':m': 'marker-1' },
  });
  const payload = JSON.parse(new TextDecoder().decode(calls[1].input.payload));
  assert.equal(payload.pending_marker, 'marker-1', 'the envelope is forwarded unchanged');
  assert.ok(lines.some((l) => /^\[pending\] review repo=Example-Org\/Valkey pr=7 head=bbb marker=marker-1 cleared$/.test(l)), lines.join('\n'));
});

test('a marker that a later push replaced is left alone, and the run goes ahead', async () => {
  ddbAnswer = async () => { throw conditionFailed(); };
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(calls.map((c) => c.op), ['DeleteCommand', 'InvokeAgentRuntimeCommand']);
  assert.ok(lines.some((l) => / marker=marker-1 already gone$/.test(l)));
});

test('a failed clear is logged and does not stop the run', async () => {
  ddbAnswer = async () => { throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' }); };
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(calls.at(-1).op, 'InvokeAgentRuntimeCommand');
  assert.ok(lines.some((l) => /could not clear marker=marker-1/.test(l)));
});

test('a redelivery that only waits on a live run does not touch the marker', async () => {
  ddbAnswer = async (command) => (command.constructor.name === 'GetCommand'
    ? { Item: { status: 'running', last_activity: Date.now() } }
    : {});
  const { result } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(calls.map((c) => c.op), ['GetCommand']);
});

test('reviews without a marker and curator messages make no store call', async () => {
  ddbAnswer = async () => ({});
  await run(sqsEvent(review));
  assert.deepEqual(calls.map((c) => c.op), ['InvokeAgentRuntimeCommand']);
  await run(sqsEvent({ maintenance_id: 'check#valkey-review#r1#2026-10-13', reviewer_id: 'valkey-review' }));
  assert.deepEqual(calls.map((c) => c.op), ['InvokeAgentRuntimeCommand']);
});
