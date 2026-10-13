import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { heartbeatRunKey, isPushReview, pendingMarkerOf, pullRequestRunPrefix } = await import('../src/review-envelope.ts');
const { CURATOR_MAX_RECEIVES, decide, isCuratorMessage, liveRun, messageTag } = await import('../src/watchdog.ts');

const MIN = 60_000;
const NOW = Date.parse('2026-10-13T12:00:00Z');
const review = { repo: 'example-org/valkey', pr_number: 7, installation_id: 42, head_sha: 'abc123' };
const curator = { reviewer_id: 'valkey-review', feedback_id: 'rc-1', kind: 'review_comment_reply', repo: 'example-org/valkey', pr_number: 7 };
const maintenance = {
  maintenance_id: 'check#valkey-review#r1#2026-10-13', reason: 'check', reviewer_id: 'valkey-review',
  area_bucket: 'src', record_id: 'r1', record_name: 'rdb-load', release_tag: '9.1.2', seen_updated_at: '2026-10-01T00:00:00Z', dry_run: false,
};

function input(overrides = {}) {
  const reads = [];
  return {
    reads,
    value: {
      envelope: review,
      receiveCount: 2,
      sentAt: NOW - 20 * MIN,
      now: NOW,
      runBudgetMs: 90 * MIN,
      staleMs: 12 * MIN,
      readHeartbeat: async (key) => { reads.push(key); return undefined; },
      ...overrides,
    },
  };
}

const withHeartbeat = (record) => ({ readHeartbeat: async () => record });

test('the first receive of a review invokes the primary model without reading the heartbeat', async () => {
  const { value, reads } = input({ receiveCount: 1 });
  assert.deepEqual(await decide(value), { action: 'invoke', useFallbackModel: false, reason: 'first attempt' });
  assert.equal(reads.length, 0);
});

test('a review that still holds its pending marker has never run: any receive is a first attempt', async () => {
  for (const receiveCount of [1, 2, 5]) {
    const { value, reads } = input({ receiveCount, holdsMarker: true, envelope: { ...review, pending_marker: 'm-1' } });
    const decision = await decide(value);
    assert.equal(decision.action, 'invoke');
    assert.equal(decision.useFallbackModel, false);
    assert.equal(reads.length, 0, 'its heartbeat is not read');
  }
});

test('a completed run is not repeated', async () => {
  const { value } = input(withHeartbeat({ status: 'completed', last_activity: NOW - 30 * MIN }));
  assert.equal((await decide(value)).action, 'delete');
});

test('a live run is left alone until the next visibility timeout', async () => {
  const { value } = input(withHeartbeat({ status: 'running', last_activity: NOW - 3 * MIN }));
  assert.deepEqual(await decide(value), { action: 'wait', reason: 'heartbeat 180s ago' });
});

test('a dead run is retried on the fallback model', async () => {
  for (const record of [
    undefined,
    { status: 'running' },
    { status: 'failed', last_activity: NOW - MIN },
    { status: 'running', last_activity: NOW - 13 * MIN },
  ]) {
    const { value } = input(withHeartbeat(record));
    const decision = await decide(value);
    assert.equal(decision.action, 'invoke', JSON.stringify(record));
    assert.equal(decision.useFallbackModel, true);
  }
});

test('the staleness threshold comes from the input', async () => {
  const { value } = input({ staleMs: 2 * MIN, ...withHeartbeat({ status: 'running', last_activity: NOW - 3 * MIN }) });
  assert.equal((await decide(value)).action, 'invoke');
});

test('a review past its run budget is abandoned', async () => {
  for (const record of [undefined, { status: 'running', last_activity: NOW - MIN }, { status: 'failed', last_activity: NOW - MIN }]) {
    const { value } = input({ sentAt: NOW - 91 * MIN, receiveCount: 7, ...withHeartbeat(record) });
    const decision = await decide(value);
    assert.equal(decision.action, 'delete', JSON.stringify(record));
    assert.equal(decision.error, true);
    assert.match(decision.reason, /91 min > 90 min/);
  }

  const longer = input({ sentAt: NOW - 91 * MIN, runBudgetMs: 120 * MIN });
  assert.equal((await decide(longer.value)).action, 'invoke');
});

test('a review that completed is not reported as abandoned once past its budget', async () => {
  // Received at minutes 80 (running) and 96 (completed in between).
  const { value } = input({ sentAt: NOW - 96 * MIN, receiveCount: 7, ...withHeartbeat({ status: 'completed', last_activity: NOW - 5 * MIN }) });
  assert.deepEqual(await decide(value), { action: 'delete', reason: 'prior attempt completed' });
});

test('a healthy long review ends on its budget before the queue dead-letters it', async () => {
  // infra: 16-minute visibility timeout, dead letter after 8 receives.
  let receive = 1;
  let decision;
  for (; receive <= 8; receive++) {
    const sentAt = NOW - (receive - 1) * 16 * MIN;
    const { value } = input({ receiveCount: receive, sentAt, ...withHeartbeat({ status: 'running', last_activity: NOW - MIN }) });
    decision = await decide(value);
    if (decision.action === 'delete') break;
  }
  assert.equal(decision.action, 'delete');
  assert.ok(receive < 8, `ended on receive ${receive}`);
});

test('the heartbeat is read under the run key of the envelope', async () => {
  const { value, reads } = input({ envelope: { ...review, run_nonce: 'ready' } });
  await decide(value);
  assert.deepEqual(reads, ['example-org/valkey#7#abc123#ready']);
});

const pushed = { ...review, pending_marker: 'm-1', trigger: 'push', skip_drafts: false };

/** A review of new commits whose pull request has these runs. */
function pushInput(runs, overrides = {}) {
  const prefixes = [];
  const { value, reads } = input({
    envelope: pushed,
    receiveCount: 1,
    sentAt: NOW - 5 * MIN,
    holdsMarker: true,
    readPullRequestRuns: async (prefix) => { prefixes.push(prefix); return runs; },
    ...overrides,
  });
  return { value, reads, prefixes };
}

const otherRun = (record) => ({ run_key: 'example-org/valkey#7#aaa', ...record });

test('a review of new commits runs when no other review of its pull request is running', async () => {
  const { value, prefixes } = pushInput([]);
  assert.deepEqual(await decide(value), { action: 'invoke', useFallbackModel: false, reason: 'first attempt' });
  assert.deepEqual(prefixes, ['example-org/valkey#7#']);
});

test('a review of new commits waits while another review of its pull request runs', async () => {
  for (const receiveCount of [1, 4]) {
    const { value, reads } = pushInput([otherRun({ status: 'running', last_activity: NOW - 2 * MIN })], { receiveCount });
    assert.deepEqual(await decide(value), { action: 'wait', reason: 'heartbeat 120s ago', otherRun: 'example-org/valkey#7#aaa' });
    assert.equal(reads.length, 0);
  }
});

test('finished, failed, stale and silent runs do not hold a review back', async () => {
  for (const record of [
    { status: 'completed', last_activity: NOW - MIN },
    { status: 'failed', last_activity: NOW - MIN },
    { status: 'running', last_activity: NOW - 13 * MIN },
    { status: 'running' },
  ]) {
    const { value } = pushInput([otherRun(record)]);
    assert.equal((await decide(value)).action, 'invoke', JSON.stringify(record));
  }
  const { value } = pushInput([otherRun({ status: 'completed', last_activity: NOW }), otherRun({ run_key: 'example-org/valkey#7#bbb#m5', status: 'running', last_activity: NOW })]);
  assert.equal((await decide(value)).otherRun, 'example-org/valkey#7#bbb#m5', 'an @mention run counts too');
});

test('a dead run of new commits is not retried while another review runs', async () => {
  const { value, reads } = pushInput([otherRun({ status: 'running', last_activity: NOW - MIN })], {
    receiveCount: 2,
    sentAt: NOW - 30 * MIN,
    holdsMarker: false,
    readHeartbeat: async (key) => { reads.push(key); return { status: 'running', last_activity: NOW - 20 * MIN }; },
  });
  assert.equal((await decide(value)).action, 'wait');
  assert.deepEqual(reads, ['example-org/valkey#7#abc123']);
});

test('the other runs are read only when the review would run', async () => {
  const { value, prefixes } = pushInput([], {
    receiveCount: 2,
    holdsMarker: false,
    readHeartbeat: async () => ({ status: 'running', last_activity: NOW - MIN }),
  });
  assert.equal((await decide(value)).action, 'wait');
  assert.deepEqual(prefixes, [], 'its own run is alive');
  const done = pushInput([], { receiveCount: 2, holdsMarker: false, readHeartbeat: async () => ({ status: 'completed' }) });
  assert.equal((await decide(done.value)).action, 'delete');
  assert.deepEqual(done.prefixes, []);
});

test('a review of new commits still waiting past its run budget is dropped', async () => {
  const { value } = pushInput([otherRun({ status: 'running', last_activity: NOW - MIN })], { receiveCount: 7, sentAt: NOW - 91 * MIN });
  const decision = await decide(value);
  assert.equal(decision.action, 'delete');
  assert.equal(decision.error, true);
  assert.equal(decision.reason, 'still waiting for example-org/valkey#7#aaa (heartbeat 60s ago) past the run budget: 91 min > 90 min');

  const free = pushInput([], { receiveCount: 7, sentAt: NOW - 91 * MIN });
  assert.equal((await decide(free.value)).action, 'invoke', 'one that never ran still gets its run');
});

test('a review of new commits that waits ends before the queue dead-letters it', async () => {
  // infra: 16-minute visibility timeout, dead letter after 8 receives. The
  // review waits 5 minutes in the queue, then for another review until
  // minute 60, then runs past the budget.
  const delay = 5 * MIN;
  let held = true;
  const decisions = [];
  for (let receive = 1; receive <= 8; receive++) {
    const at = delay + (receive - 1) * 16 * MIN;
    const runs = at < 60 * MIN ? [otherRun({ status: 'running', last_activity: NOW - MIN })] : [];
    const { value } = pushInput(runs, {
      receiveCount: receive,
      sentAt: NOW - at,
      holdsMarker: held,
      readHeartbeat: async () => ({ status: 'running', last_activity: NOW - MIN }),
    });
    const decision = await decide(value);
    decisions.push(decision.action);
    if (decision.action === 'invoke') held = false;
    if (decision.action === 'delete') break;
  }
  assert.deepEqual(decisions, ['wait', 'wait', 'wait', 'wait', 'invoke', 'wait', 'delete']);
});

test('liveRun picks a running, fresh record', () => {
  assert.equal(liveRun([], NOW, 12 * MIN), undefined);
  const fresh = otherRun({ status: 'running', last_activity: NOW - 12 * MIN });
  assert.equal(liveRun([otherRun({ status: 'running', last_activity: NOW - 12 * MIN - 1 }), fresh], NOW, 12 * MIN), fresh);
});

test('curator messages run on every receive up to the queue limit, then are deleted', async () => {
  for (let receive = 1; receive <= CURATOR_MAX_RECEIVES; receive++) {
    const { value, reads } = input({ envelope: curator, receiveCount: receive });
    const decision = await decide(value);
    assert.equal(decision.action, 'invoke');
    assert.equal(decision.useFallbackModel, false);
    assert.equal(reads.length, 0, 'curator runs have no heartbeat');
  }
  const { value } = input({ envelope: curator, receiveCount: CURATOR_MAX_RECEIVES + 1 });
  const decision = await decide(value);
  assert.equal(decision.action, 'delete');
  assert.equal(decision.error, true);
});

test('maintenance messages run like curator messages, without a heartbeat read', async () => {
  for (let receive = 1; receive <= CURATOR_MAX_RECEIVES; receive++) {
    const { value, reads } = input({ envelope: maintenance, receiveCount: receive });
    assert.deepEqual(await decide(value), { action: 'invoke', useFallbackModel: false, reason: `attempt ${receive}` });
    assert.equal(reads.length, 0);
  }
  const { value, reads } = input({ envelope: maintenance, receiveCount: CURATOR_MAX_RECEIVES + 1 });
  const decision = await decide(value);
  assert.equal(decision.action, 'delete');
  assert.equal(decision.error, true);
  assert.equal(reads.length, 0);
});

test('only a string feedback_id or maintenance_id marks a curator message', () => {
  assert.equal(isCuratorMessage(curator), true);
  assert.equal(isCuratorMessage(maintenance), true);
  assert.equal(isCuratorMessage(review), false);
  assert.equal(isCuratorMessage({ ...review, feedback_id: 7 }), false);
  assert.equal(isCuratorMessage({ ...review, maintenance_id: null }), false);
});

test('the log tag names the message', () => {
  assert.equal(messageTag(review), 'review repo=example-org/valkey pr=7 head=abc123');
  assert.equal(messageTag(curator), 'curator repo=example-org/valkey feedback=rc-1');
  assert.equal(
    messageTag(maintenance),
    'curator maintenance=check#valkey-review#r1#2026-10-13 reviewer=valkey-review reason=check dry_run=false',
  );
  assert.equal(
    messageTag({ ...maintenance, reason: 'repo_check', dry_run: true }),
    'curator maintenance=check#valkey-review#r1#2026-10-13 reviewer=valkey-review reason=repo_check dry_run=true',
  );
  assert.match(messageTag({ ...maintenance, dry_run: 'true' }), / dry_run=false$/, 'only the boolean true is a dry run');
});

test('a review of new commits names the pending marker the worker clears', () => {
  assert.deepEqual(pendingMarkerOf({ ...review, pending_marker: 'm-1' }), { repo: 'example-org/valkey', prNumber: 7, markerId: 'm-1' });
  assert.equal(pendingMarkerOf(review), undefined);
  assert.equal(pendingMarkerOf(curator), undefined);
  assert.equal(pendingMarkerOf({ ...review, pending_marker: '' }), undefined);
  assert.equal(pendingMarkerOf({ ...review, pending_marker: 5 }), undefined);
  assert.equal(pendingMarkerOf({ ...review, pr_number: '7', pending_marker: 'm-1' }), undefined);
  assert.equal(pendingMarkerOf({ pr_number: 7, pending_marker: 'm-1' }), undefined);
});

test('only trigger "push" marks a review of new commits', () => {
  assert.equal(isPushReview({ ...review, trigger: 'push', skip_drafts: false }), true);
  assert.equal(isPushReview(review), false);
  assert.equal(isPushReview({ ...review, pending_marker: 'm-1' }), false);
  assert.equal(isPushReview({ ...review, trigger: 'opened' }), false);
});

test('the pull request prefix starts every run key of that pull request and no other', () => {
  assert.equal(pullRequestRunPrefix(review), 'example-org/valkey#7#');
  for (const envelope of [review, { ...review, run_nonce: 'm101' }, { ...review, head_sha: undefined }]) {
    assert.ok(heartbeatRunKey(envelope).startsWith(pullRequestRunPrefix(review)));
  }
  assert.equal(heartbeatRunKey({ ...review, pr_number: 70 }).startsWith(pullRequestRunPrefix(review)), false);
});

test('heartbeatRunKey matches the runtime formula', () => {
  assert.equal(heartbeatRunKey(review), 'example-org/valkey#7#abc123');
  assert.equal(heartbeatRunKey({ ...review, run_nonce: 'm101' }), 'example-org/valkey#7#abc123#m101');
  assert.equal(heartbeatRunKey({ ...review, run_nonce: '' }), 'example-org/valkey#7#abc123');
  assert.equal(heartbeatRunKey({ repo: 'o/r', pr_number: 1 }), 'o/r#1#unknown');
  assert.equal(heartbeatRunKey({ repo: 'o/r', pr_number: 1, head_sha: '' }), 'o/r#1#');
});

test('heartbeatRunKey stays byte-identical to agents/common/src/run-agent.ts', () => {
  // The runtime writes the heartbeat under this key; the invoker must
  // read the same one. Evaluate the runtime's own expression on the same
  // payloads and compare.
  const source = fs.readFileSync(new URL('../../agents/common/src/run-agent.ts', import.meta.url), 'utf8');
  const match = source.match(/const runKey = (`[^\n]*`);\n/);
  assert.ok(match, 'run-agent.ts no longer builds runKey inline; update this test and heartbeatRunKey together');
  const runtimeKey = new Function('payload', `return ${match[1]};`);
  for (const payload of [
    review,
    { ...review, run_nonce: 'm101' },
    { ...review, run_nonce: 'ready' },
    { repo: 'o/r', pr_number: 1, installation_id: 2 },
    { repo: 'o/r', pr_number: 1, installation_id: 2, head_sha: '' },
  ]) {
    assert.equal(heartbeatRunKey(payload), runtimeKey(payload), JSON.stringify(payload));
  }
});
