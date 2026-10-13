import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import './support/ts-resolve.mjs';

const { createStatusComment } = await import('../src/status-comment.ts');
const { createHeartbeat } = await import('../src/heartbeat.ts');

function statusComment({ summarize, editDelayMs = 0 }) {
  const bodies = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const octokit = {
    issues: {
      updateComment: async ({ body }) => {
        maxInFlight = Math.max(maxInFlight, ++inFlight);
        await sleep(editDelayMs);
        bodies.push(body);
        inFlight--;
        return { data: {} };
      },
    },
  };
  const comment = createStatusComment({
    octokit, owner: 'o', repo: 'r', commentId: 1, region: 'us-west-2',
    summarizerModelId: 'unused', summarizerFallbackModelId: 'unused', mantleRegion: 'us-east-1',
    reasoningEffort: 'high', isFallback: false, summarize, progressIntervalMs: 5,
  });
  return { comment, bodies, maxInFlight: () => maxInFlight };
}

test('a progress tick that finishes after the final edit does not overwrite it', async () => {
  let releaseSummary;
  const summaryGate = new Promise((resolve) => { releaseSummary = resolve; });
  let ticks = 0;
  const { comment, bodies } = statusComment({
    summarize: async () => {
      ticks++;
      await summaryGate;
      return 'The agent is reading the diff.';
    },
  });
  await comment.open();
  while (ticks === 0) await sleep(1);
  await comment.finish('Final review summary.');
  releaseSummary();
  await sleep(30);
  assert.equal(bodies.at(-1), 'Final review summary.');
  assert.equal(bodies.filter((b) => b.includes('reading the diff')).length, 0);
});

test('edits run one at a time and the final edit lands last', async () => {
  const { comment, bodies, maxInFlight } = statusComment({
    summarize: async () => 'The agent is building.',
    editDelayMs: 8,
  });
  await comment.open();
  await sleep(25);
  await comment.finish('Done.');
  await sleep(30);
  assert.equal(maxInFlight(), 1);
  assert.equal(bodies.at(-1), 'Done.');
  assert.ok(bodies.length >= 2);
});

test('stop() ends progress edits without a final edit', async () => {
  const { comment, bodies } = statusComment({ summarize: async () => 'working' });
  await comment.open();
  comment.stop();
  const count = bodies.length;
  await sleep(30);
  assert.equal(bodies.length, count);
});

test('heartbeat finish waits for a write in flight and wins', async (t) => {
  const written = [];
  let slowFirst = true;
  t.mock.method(DynamoDBDocumentClient.prototype, 'send', async (command) => {
    const status = command.input.ExpressionAttributeValues[':status'];
    if (slowFirst) {
      slowFirst = false;
      await sleep(20);
    }
    written.push(status);
    return {};
  });
  const heartbeat = createHeartbeat({ tableName: 'hb', region: 'us-west-2', runKey: 'k', modelId: 'm', intervalMs: 0 });
  heartbeat.beat();
  await heartbeat.finish('completed');
  heartbeat.beat();
  await sleep(30);
  assert.deepEqual(written, ['running', 'completed']);
});

test('a heartbeat without a table does nothing', async () => {
  const heartbeat = createHeartbeat({ tableName: '', region: 'us-west-2', runKey: 'k', modelId: 'm' });
  heartbeat.beat();
  await heartbeat.finish('failed');
});
