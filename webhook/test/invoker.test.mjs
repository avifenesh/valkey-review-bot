import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { conditionFailed } from './support/fakes.mjs';

// The invoker reads its settings and builds its clients when it loads, so
// the environment and the client stubs go in first.
const ACCOUNT = '123456789012';
Object.assign(process.env, {
  AWS_REGION: 'us-east-1',
  RUNTIME_ARN: `arn:aws:bedrock-agentcore:us-east-1:${ACCOUNT}:runtime/reviewer`,
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

/** Runs `fn` with the call list cleared and console output collected. */
async function capture(fn) {
  calls.length = 0;
  const lines = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args) => lines.push(args.join(' '));
  try {
    return { result: await fn(), lines };
  } finally {
    Object.assign(console, saved);
  }
}

const run = (event) => capture(() => handler(event));

const MARKER_KEY = { key: 'pending#example-org/valkey#7' };

/**
 * Answers the worker's table calls: the pending marker in the receiver's
 * table, the run's heartbeat record, and the scan of the pull request's
 * runs (`pages`, one array of records per page). Writes succeed unless
 * `deleteError` or `claimError`.
 */
function tables({ marker, heartbeat, pages = [[]], deleteError, claimError } = {}) {
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
      case 'UpdateCommand heartbeat':
        if (claimError) throw claimError;
        return {};
      case 'UpdateCommand idempotency': return {};
      case 'DeleteCommand idempotency':
        if (deleteError) throw deleteError;
        return {};
      default: throw new Error(`unexpected ${command.constructor.name} on ${TableName}`);
    }
  };
}

const CLAIM_CONDITION = 'NOT ((#s = :running AND #a >= :fresh) OR (#s = :completed AND #m = :message))';

/**
 * Both tables in memory, for receives that see each other's writes: the
 * pull request's pending marker, and heartbeat records by run key. It
 * applies the worker's start claim with its condition. `beforeClaim`
 * runs before a claim is applied.
 */
function memoryTables({ marker } = {}) {
  const t = {
    marker,
    runs: new Map(),
    beforeClaim: async () => {},
    answer: async (command) => {
      const { TableName, Key } = command.input;
      const v = command.input.ExpressionAttributeValues ?? {};
      switch (`${command.constructor.name} ${TableName}`) {
        case 'GetCommand idempotency': return t.marker ? { Item: { ...MARKER_KEY, marker: t.marker } } : {};
        case 'UpdateCommand idempotency': return {};
        case 'DeleteCommand idempotency':
          if (t.marker !== v[':m']) throw conditionFailed();
          t.marker = undefined;
          return {};
        case 'GetCommand heartbeat': {
          const r = t.runs.get(Key.run_key);
          return r ? { Item: { run_key: Key.run_key, ...r } } : {};
        }
        case 'ScanCommand heartbeat': return {
          Items: [...t.runs].filter(([k, r]) => k.startsWith(v[':prefix']) && r.status === v[':running']).map(([k, r]) => ({ run_key: k, ...r })),
        };
        case 'UpdateCommand heartbeat': {
          assert.equal(command.input.ConditionExpression, CLAIM_CONDITION);
          await t.beforeClaim();
          const r = t.runs.get(Key.run_key);
          const live = r?.status === 'running' && r.last_activity >= v[':fresh'];
          const done = r?.status === 'completed' && r.message_id === v[':message'];
          if (live || done) throw conditionFailed();
          t.runs.set(Key.run_key, { ...r, last_activity: v[':now'], status: 'running', ttl: v[':ttl'], message_id: v[':message'] });
          return {};
        }
        default: throw new Error(`unexpected ${command.constructor.name} on ${TableName}`);
      }
    },
  };
  return t;
}

const ops = () => calls.map((c) => `${c.op}${c.input.TableName ? ` ${c.input.TableName}` : ''}`);
const invoked = () => JSON.parse(new TextDecoder().decode(calls.find((c) => c.op === 'InvokeAgentRuntimeCommand').input.payload));

test('an automatic review that holds its marker clears it, then runs', async () => {
  ddbAnswer = tables({ marker: 'marker-1' });
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.deepEqual(calls[0].input, { TableName: 'idempotency', Key: MARKER_KEY, ConsistentRead: true });
  assert.deepEqual(calls[3].input, {
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
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'InvokeAgentRuntimeCommand']);
});

test('a failed clear stops the run, and the retry runs it on the primary model', async () => {
  ddbAnswer = tables({ marker: 'marker-1', deleteError: Object.assign(new Error('throttled'), { name: 'ThrottlingException' }) });
  const failed = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(failed.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'DeleteCommand idempotency'], 'not invoked: the marker still says it never ran');
  assert.ok(failed.lines.some((l) => /^\[fail\] messageId=m1: throttled$/.test(l)), failed.lines.join('\n'));
  assert.equal(failed.lines.some((l) => l.startsWith('[invoke]')), false);

  ddbAnswer = tables({ marker: 'marker-1' });
  const retried = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(retried.result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand'], 'no heartbeat read');
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
    if (command.constructor.name === 'UpdateCommand' && command.input.TableName === 'heartbeat') return {};
    throw new Error(`unexpected ${command.constructor.name}`);
  };
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'InvokeAgentRuntimeCommand']);
  assert.ok(lines.some((l) => /may not read idempotency; the pending marker stays until it expires/.test(l)), lines.join('\n'));
});

test('a redelivery whose marker is gone is watched like any review', async () => {
  ddbAnswer = tables({ heartbeat: { status: 'running', last_activity: Date.now() } });
  const alive = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(alive.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'GetCommand heartbeat']);

  ddbAnswer = tables({});
  await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, 2));
  assert.deepEqual(ops(), ['GetCommand idempotency', 'GetCommand heartbeat', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'InvokeAgentRuntimeCommand']);
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
    assert.deepEqual(ops(), ['ScanCommand heartbeat', 'UpdateCommand heartbeat', 'InvokeAgentRuntimeCommand']);
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
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
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
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.equal(invoked().use_fallback_model, undefined);
});

test('an opened, reopened or ready review waits too, then runs on the primary model', async () => {
  for (const envelope of [{ ...review, pending_marker: 'marker-1' }, { ...review, run_nonce: 'ready', pending_marker: 'marker-1' }]) {
    ddbAnswer = tables({ marker: 'marker-1', pages: [[running('Example-Org/Valkey#7#aaa#push')]] });
    const waited = await run(sqsEvent(envelope));
    assert.deepEqual(waited.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
    assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand idempotency'], 'not invoked; marker kept');

    ddbAnswer = tables({ marker: 'marker-1' });
    const ran = await run(sqsEvent(envelope, 3));
    assert.deepEqual(ran.result, { batchItemFailures: [] });
    assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
    assert.equal(invoked().use_fallback_model, undefined);
  }
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

test('reviews without a marker only write their start record, and curator messages make no store call', async () => {
  ddbAnswer = tables({});
  await run(sqsEvent(review));
  assert.deepEqual(ops(), ['UpdateCommand heartbeat', 'InvokeAgentRuntimeCommand']);
  await run(sqsEvent({ ...review, run_nonce: 'm5', status_comment_id: 5, instruction: 'review' }));
  assert.deepEqual(ops(), ['UpdateCommand heartbeat', 'InvokeAgentRuntimeCommand'], 'only automatic reviews look for other runs');
  await run(sqsEvent({ maintenance_id: 'check#valkey-review#r1#2026-10-13', reviewer_id: 'valkey-review' }));
  assert.deepEqual(ops(), ['InvokeAgentRuntimeCommand']);
});

const invokes = () => calls.filter((c) => c.op === 'InvokeAgentRuntimeCommand').length;
const quiet = (lines) => !lines.some((l) => /^\[(fail|invoke|abandoned)\]/.test(l));
const mention = { ...review, run_nonce: 'm5', status_comment_id: 5, instruction: 'review' };

test('the worker writes the run\'s start record before it lets go of the marker and invokes', async () => {
  ddbAnswer = tables({ marker: 'marker-1' });
  const before = Date.now();
  await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  const after = Date.now();
  assert.deepEqual(ops().slice(2), ['UpdateCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  const { ExpressionAttributeValues: v, ...claim } = calls[2].input;
  assert.deepEqual(claim, {
    TableName: 'heartbeat',
    Key: { run_key: 'Example-Org/Valkey#7#bbb' },
    UpdateExpression: 'SET #a = :now, #s = :running, #t = :ttl, #m = :message',
    ConditionExpression: CLAIM_CONDITION,
    ExpressionAttributeNames: { '#a': 'last_activity', '#s': 'status', '#t': 'ttl', '#m': 'message_id' },
  });
  assert.ok(v[':now'] >= before && v[':now'] <= after);
  assert.deepEqual(v, {
    ':now': v[':now'],
    ':running': 'running',
    ':completed': 'completed',
    ':fresh': v[':now'] - 12 * 60_000,
    ':ttl': Math.floor(v[':now'] / 1000) + 24 * 3600,
    ':message': 'm1',
  });

  await run(sqsEvent(mention));
  assert.deepEqual(calls[0].input.Key, { run_key: 'Example-Org/Valkey#7#bbb#m5' }, 'an @mention run has one too');
});

test('an automatic review queued after another review started waits for it, before its runtime writes a heartbeat', async () => {
  const t = memoryTables({ marker: 'marker-1' });
  ddbAnswer = t.answer;
  await run(sqsEvent({ ...review, head_sha: 'aaa', pending_marker: 'marker-1' }));
  assert.equal(invokes(), 1);
  assert.equal(t.marker, undefined);

  // The receiver queues the next round now that the marker is gone.
  t.marker = 'marker-2';
  const next = await run(sqsEvent({ ...pushed, pending_marker: 'marker-2' }));
  assert.deepEqual(next.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.equal(invokes(), 0);
  assert.ok(next.lines.some((l) => / waits for Example-Org\/Valkey#7#aaa \(heartbeat \d+s ago\)/.test(l)), next.lines.join('\n'));
  assert.equal(t.marker, 'marker-2', 'it keeps its marker');
});

test('a duplicate receive that reads the marker after the other receive removed it does not run the review', async () => {
  for (const receiveCount of [1, 2]) {
    const t = memoryTables({ marker: 'marker-1' });
    ddbAnswer = t.answer;
    await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
    assert.equal(invokes(), 1);

    const dup = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }, receiveCount));
    assert.deepEqual(dup.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] }, 'left for the next receive');
    assert.equal(invokes(), 0, `receive ${receiveCount}`);
    assert.ok(quiet(dup.lines), dup.lines.join('\n'));
  }
});

test('of two receives that both read the marker, only the one whose start claim lands first runs the review', async () => {
  const t = memoryTables({ marker: 'marker-1' });
  let stalled;
  let resume;
  const reached = new Promise((resolve) => { stalled = resolve; });
  const gate = new Promise((resolve) => { resume = resolve; });
  let first = true;
  t.beforeClaim = async () => {
    if (!first) return;
    first = false;
    stalled();
    await gate;
  };
  ddbAnswer = t.answer;
  const envelope = { ...review, pending_marker: 'marker-1' };
  const { result: [late, winner], lines } = await capture(async () => {
    // The late receive reads the marker and finds no run, then its claim stalls.
    const lateRun = handler(sqsEvent(envelope));
    await Promise.race([reached, lateRun]);
    const winnerRun = await handler(sqsEvent(envelope));
    resume();
    return [await lateRun, winnerRun];
  });
  assert.deepEqual(winner, { batchItemFailures: [] });
  assert.deepEqual(late, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.equal(invokes(), 1);
  assert.equal(t.marker, undefined);
  assert.ok(lines.some((l) => l === '[start] review repo=Example-Org/Valkey pr=7 head=bbb run=Example-Org/Valkey#7#bbb is already running or done; not run twice'), lines.join('\n'));
  assert.equal(lines.some((l) => l.startsWith('[fail]')), false);
});

test('a second receive of an @mention message does not run it again', async () => {
  const t = memoryTables();
  ddbAnswer = t.answer;
  await run(sqsEvent(mention));
  const dup = await run(sqsEvent(mention));
  assert.deepEqual(dup.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['UpdateCommand heartbeat']);
  assert.ok(quiet(dup.lines), dup.lines.join('\n'));
});

test('a receive that finds its run already completed does not run it, and the next one ends the message', async () => {
  const t = memoryTables();
  t.runs.set('Example-Org/Valkey#7#bbb#m5', { status: 'completed', last_activity: Date.now() - 1000, message_id: 'm1' });
  ddbAnswer = t.answer;
  const dup = await run(sqsEvent(mention));
  assert.deepEqual(dup.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.equal(invokes(), 0);
  assert.equal(t.runs.get('Example-Org/Valkey#7#bbb#m5').status, 'completed', 'the completed record is kept');

  const next = await run(sqsEvent(mention, 2));
  assert.deepEqual(next.result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand heartbeat']);
});

test('a start claim goes ahead over a run that died, and over a finished run of another message', async () => {
  for (const [record, receiveCount, fallback] of [
    [{ status: 'running', last_activity: Date.now() - 13 * 60_000, message_id: 'm1' }, 2, true],
    [{ status: 'failed', last_activity: Date.now() - 60_000, message_id: 'm1' }, 2, true],
    [{ status: 'completed', last_activity: Date.now() - 60_000, message_id: 'm0' }, 1, undefined],
  ]) {
    const t = memoryTables();
    t.runs.set('Example-Org/Valkey#7#bbb#m5', { ...record, model: 'primary' });
    ddbAnswer = t.answer;
    const { result } = await run(sqsEvent(mention, receiveCount));
    assert.deepEqual(result, { batchItemFailures: [] }, JSON.stringify(record));
    assert.equal(invokes(), 1);
    assert.equal(invoked().use_fallback_model, fallback);
    const claimed = t.runs.get('Example-Org/Valkey#7#bbb#m5');
    assert.equal(claimed.status, 'running');
    assert.equal(claimed.message_id, 'm1');
  }
});

test('once the start is claimed, a marker that went some other way does not stop the run', async () => {
  const t = memoryTables({ marker: 'marker-1' });
  // The receiver gives the marker back between the read and the delete.
  t.beforeClaim = async () => { t.marker = undefined; };
  ddbAnswer = t.answer;
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(invokes(), 1);
  assert.ok(lines.some((l) => / marker=marker-1 already gone$/.test(l)), lines.join('\n'));
});

test('a worker not allowed to write the start record runs the review, and the marker is the start claim', async () => {
  const denied = Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
  ddbAnswer = tables({ marker: 'marker-1', claimError: denied });
  const ran = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(ran.result, { batchItemFailures: [] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat', 'DeleteCommand idempotency', 'InvokeAgentRuntimeCommand']);
  assert.ok(ran.lines.some((l) => /^\[start\] review repo=Example-Org\/Valkey pr=7 head=bbb may not write heartbeat; the run is not visible until its runtime writes a heartbeat/.test(l)), ran.lines.join('\n'));

  // Both receives read the marker, and the other one removed it first.
  ddbAnswer = tables({ marker: 'marker-1', claimError: denied, deleteError: conditionFailed() });
  const dup = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(dup.result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.equal(invokes(), 0);
  assert.ok(dup.lines.some((l) => /^\[pending\] review repo=Example-Org\/Valkey pr=7 head=bbb marker=marker-1 was gone when this receive went to start the run/.test(l)), dup.lines.join('\n'));
  assert.ok(quiet(dup.lines), dup.lines.join('\n'));
});

test('a failed start claim leaves the message and its marker for a retry', async () => {
  ddbAnswer = tables({ marker: 'marker-1', claimError: Object.assign(new Error('throttled'), { name: 'ThrottlingException' }) });
  const { result, lines } = await run(sqsEvent({ ...review, pending_marker: 'marker-1' }));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm1' }] });
  assert.deepEqual(ops(), ['GetCommand idempotency', 'ScanCommand heartbeat', 'UpdateCommand heartbeat'], 'no delete, no invoke');
  assert.ok(lines.some((l) => /^\[fail\] messageId=m1: throttled$/.test(l)), lines.join('\n'));
});
