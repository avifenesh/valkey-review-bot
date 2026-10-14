import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { fakeDdb } from './support/fakes.mjs';

const {
  autoReviewKey, budgetKey, clearPendingReview, createDeliveryStore, extendPendingReview, holdsPendingReview, pendingReviewKey,
  releaseQuietly,
} = await import('../src/store.ts');

const TABLE = 'idempotency';
const at = (iso) => () => new Date(iso);

test('a key is claimed once', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE, at('2026-10-13T08:00:00Z'));
  assert.equal(await store.claim('o/r#1#abc', { action: 'opened' }), true);
  assert.equal(await store.claim('o/r#1#abc', { action: 'opened' }), false);
  const item = ddb.items.get('o/r#1#abc');
  assert.equal(item.action, 'opened');
  assert.equal(item.ttl, Date.parse('2026-10-14T08:00:00Z') / 1000);
  assert.equal(ddb.calls[0].input.TableName, TABLE);
  assert.equal(ddb.calls[0].input.ConditionExpression, 'attribute_not_exists(#k)');
});

test('attributes cannot replace the key or its expiry', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE, at('2026-10-13T08:00:00Z'));
  await store.claim('real', { key: 'other', ttl: '0' });
  assert.equal(ddb.items.has('real'), true);
  assert.equal(ddb.items.get('real').ttl, Date.parse('2026-10-14T08:00:00Z') / 1000);
});

test('a released key can be claimed again', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE);
  await store.claim('k');
  await store.release('k');
  assert.equal(await store.claim('k'), true);
});

test('other DynamoDB errors are not mistaken for duplicates', async () => {
  const throttled = { send: async () => { throw Object.assign(new Error('slow down'), { name: 'ProvisionedThroughputExceededException' }); } };
  const store = createDeliveryStore(throttled, TABLE);
  await assert.rejects(store.claim('k'), /slow down/);
  await assert.rejects(store.takeReviewSlot('route', 40), /slow down/);
  await assert.rejects(store.takeAutoReview('o/r', 1, 3), /slow down/);
  await assert.rejects(store.returnAutoReview('o/r', 1), /slow down/);
  await assert.rejects(store.markReviewPending('o/r', 1, 300), /slow down/);
  await assert.rejects(store.clearReviewPending('o/r', 1, 'm'), /slow down/);
});

test('the budget key names the route and the UTC day', () => {
  assert.equal(budgetKey('valkey-review', new Date('2026-10-13T23:59:59Z')), 'budget#valkey-review#2026-10-13');
  assert.equal(budgetKey('valkey-review', new Date('2026-10-14T01:30:00+03:00')), 'budget#valkey-review#2026-10-13');
});

test('the budget admits exactly the daily limit per route', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE, at('2026-10-13T08:00:00Z'));
  for (let i = 0; i < 40; i++) assert.equal(await store.takeReviewSlot('valkey-review', 40), true, `review ${i + 1}`);
  assert.equal(await store.takeReviewSlot('valkey-review', 40), false);
  assert.equal(await store.takeReviewSlot('valkey-glide-review', 40), true, 'routes count separately');

  const counter = ddb.items.get('budget#valkey-review#2026-10-13');
  assert.equal(counter.reviews, 40);
  assert.equal(counter.ttl, Date.parse('2026-10-16T08:00:00Z') / 1000, 'kept for three days');

  const update = ddb.calls.find((c) => c.op === 'UpdateCommand').input;
  assert.match(update.UpdateExpression, /ADD #reviews :one/);
  assert.equal(update.ConditionExpression, 'attribute_not_exists(#reviews) OR #reviews < :budget');
  assert.equal(update.ExpressionAttributeValues[':budget'], 40);
});

test('a new UTC day starts a new count', async () => {
  const ddb = fakeDdb();
  let now = new Date('2026-10-13T23:00:00Z');
  const store = createDeliveryStore(ddb, TABLE, () => now);
  assert.equal(await store.takeReviewSlot('r', 1), true);
  assert.equal(await store.takeReviewSlot('r', 1), false);
  now = new Date('2026-10-14T00:00:01Z');
  assert.equal(await store.takeReviewSlot('r', 1), true);
});

test('a zero budget admits nothing and does not touch the table', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE);
  assert.equal(await store.takeReviewSlot('r', 0), false);
  assert.equal(ddb.calls.length, 0);
});

test('the automatic review key names the lowercased repository and the PR', () => {
  assert.equal(autoReviewKey('Example-Org/Valkey', 7), 'autoreviews#example-org/valkey#7');
});

test('automatic reviews are numbered per pull request up to the cap', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE, at('2026-10-13T08:00:00Z'));
  assert.deepEqual([
    await store.takeAutoReview('o/r', 7, 3),
    await store.takeAutoReview('O/R', 7, 3),
    await store.takeAutoReview('o/r', 7, 3),
    await store.takeAutoReview('o/r', 7, 3),
  ], [1, 2, 3, 0]);
  assert.equal(await store.takeAutoReview('o/r', 8, 3), 1, 'pull requests count separately');
  assert.equal(await store.takeAutoReview('o/r', 7, 4), 4, 'a raised cap allows more');

  const counter = ddb.items.get('autoreviews#o/r#7');
  assert.equal(counter.reviews, 4);
  assert.equal(counter.ttl, Date.parse('2027-04-11T08:00:00Z') / 1000, 'kept for 180 days after the latest');
  const update = ddb.calls.find((c) => c.op === 'UpdateCommand').input;
  assert.equal(update.ConditionExpression, 'attribute_not_exists(#reviews) OR #reviews < :cap');
  assert.equal(update.ReturnValues, 'UPDATED_NEW');
});

test('a zero cap admits nothing and does not touch the table', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE);
  assert.equal(await store.takeAutoReview('o/r', 7, 0), 0);
  assert.equal(ddb.calls.length, 0);
});

test('a returned automatic review can be taken again, and the count never goes below zero', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE);
  assert.equal(await store.takeAutoReview('o/r', 7, 1), 1);
  assert.equal(await store.takeAutoReview('o/r', 7, 1), 0);
  await store.returnAutoReview('o/r', 7);
  assert.equal(ddb.items.get('autoreviews#o/r#7').reviews, 0);
  await store.returnAutoReview('o/r', 7);
  await store.returnAutoReview('o/r', 9);
  assert.equal(ddb.items.get('autoreviews#o/r#7').reviews, 0);
  assert.equal(ddb.items.has('autoreviews#o/r#9'), false);
  assert.equal(await store.takeAutoReview('o/r', 7, 1), 1);
});

test('the pending key names the lowercased repository and the PR', () => {
  assert.equal(pendingReviewKey('Example-Org/Valkey', 7), 'pending#example-org/valkey#7');
});

test('one pending marker per pull request, expiring an hour after the delay', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE, at('2026-10-13T08:00:00Z'));
  const marker = await store.markReviewPending('O/R', 7, 300);
  assert.match(marker, /^[0-9a-f-]{36}$/);
  assert.equal(await store.markReviewPending('o/r', 7, 300), null);
  assert.notEqual(await store.markReviewPending('o/r', 8, 300), null, 'pull requests are separate');

  const item = ddb.items.get('pending#o/r#7');
  assert.equal(item.marker, marker);
  assert.equal(item.ttl, Date.parse('2026-10-13T09:05:00Z') / 1000);
  const put = ddb.calls.find((c) => c.op === 'PutCommand').input;
  assert.equal(put.ConditionExpression, 'attribute_not_exists(#k) OR #ttl < :now');
  assert.equal(put.ExpressionAttributeValues[':now'], Date.parse('2026-10-13T08:00:00Z') / 1000);
});

test('an expired marker that TTL has not deleted yet counts as gone', async () => {
  const ddb = fakeDdb();
  let now = new Date('2026-10-13T08:00:00Z');
  const store = createDeliveryStore(ddb, TABLE, () => now);
  const first = await store.markReviewPending('o/r', 7, 0);
  now = new Date('2026-10-13T08:59:59Z');
  assert.equal(await store.markReviewPending('o/r', 7, 0), null);
  now = new Date('2026-10-13T09:00:01Z');
  const second = await store.markReviewPending('o/r', 7, 0);
  assert.ok(second && second !== first);
  assert.equal(ddb.items.get('pending#o/r#7').marker, second);
});

test('a pending marker is cleared only by its own id', async () => {
  const ddb = fakeDdb();
  const store = createDeliveryStore(ddb, TABLE);
  const marker = await store.markReviewPending('o/r', 7, 300);
  assert.equal(await clearPendingReview(ddb, TABLE, 'o/r', 7, 'some-other-marker'), false);
  assert.equal(ddb.items.has('pending#o/r#7'), true);
  assert.equal(await clearPendingReview(ddb, TABLE, 'O/R', 7, marker), true);
  assert.equal(ddb.items.has('pending#o/r#7'), false);
  assert.equal(await store.clearReviewPending('o/r', 7, marker), false, 'already gone');

  const del = ddb.calls.find((c) => c.op === 'DeleteCommand').input;
  assert.equal(del.TableName, TABLE);
  assert.deepEqual(del.Key, { key: 'pending#o/r#7' });
  assert.equal(del.ConditionExpression, '#m = :m');
  assert.notEqual(await store.markReviewPending('o/r', 7, 300), null, 'the next push can mark it again');
});

test('a worker holds the pending marker while it is still its own, expired or not', async () => {
  const ddb = fakeDdb();
  let now = new Date('2026-10-13T08:00:00Z');
  const store = createDeliveryStore(ddb, TABLE, () => now);
  const marker = await store.markReviewPending('o/r', 7, 300);
  assert.equal(await holdsPendingReview(ddb, TABLE, 'O/R', 7, marker), true);
  assert.equal(await holdsPendingReview(ddb, TABLE, 'o/r', 7, 'some-other-marker'), false);
  assert.equal(await holdsPendingReview(ddb, TABLE, 'o/r', 8, marker), false);
  const get = ddb.calls.findLast((c) => c.op === 'GetCommand').input;
  assert.deepEqual(get, { TableName: TABLE, Key: { key: 'pending#o/r#8' }, ConsistentRead: true });

  now = new Date('2026-10-13T10:00:00Z');
  assert.equal(await holdsPendingReview(ddb, TABLE, 'o/r', 7, marker), true, 'expired, but no later push replaced it');
  const later = await store.markReviewPending('o/r', 7, 300);
  assert.equal(await holdsPendingReview(ddb, TABLE, 'o/r', 7, marker), false, 'replaced');
  await store.clearReviewPending('o/r', 7, later);
  assert.equal(await holdsPendingReview(ddb, TABLE, 'o/r', 7, later), false, 'cleared');

  const throttled = { send: async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); } };
  await assert.rejects(holdsPendingReview(throttled, TABLE, 'o/r', 7, marker), /slow down/);
});

test('a waiting worker keeps its own marker an hour past now, and no other', async () => {
  const ddb = fakeDdb();
  let now = new Date('2026-10-13T08:00:00Z');
  const store = createDeliveryStore(ddb, TABLE, () => now);
  const marker = await store.markReviewPending('o/r', 7, 300);
  assert.equal(await extendPendingReview(ddb, TABLE, 'O/R', 7, marker, new Date('2026-10-13T08:50:00Z')), true);
  assert.equal(ddb.items.get('pending#o/r#7').ttl, Date.parse('2026-10-13T09:50:00Z') / 1000);
  const update = ddb.calls.find((c) => c.op === 'UpdateCommand').input;
  assert.deepEqual(update, {
    TableName: TABLE,
    Key: { key: 'pending#o/r#7' },
    UpdateExpression: 'SET #ttl = :ttl',
    ConditionExpression: '#m = :m',
    ExpressionAttributeNames: { '#ttl': 'ttl', '#m': 'marker' },
    ExpressionAttributeValues: { ':ttl': Date.parse('2026-10-13T09:50:00Z') / 1000, ':m': marker },
  });

  now = new Date('2026-10-13T09:30:00Z');
  assert.equal(await store.markReviewPending('o/r', 7, 300), null, 'past its first expiry, the marker still holds later pushes');
  assert.equal(await extendPendingReview(ddb, TABLE, 'o/r', 7, 'some-other-marker'), false);
  assert.equal(await extendPendingReview(ddb, TABLE, 'o/r', 8, marker), false);
  assert.equal(ddb.items.has('pending#o/r#8'), false, 'no marker is created');

  const throttled = { send: async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); } };
  await assert.rejects(extendPendingReview(throttled, TABLE, 'o/r', 7, marker), /slow down/);
});

test('a review waits while the pull request\'s marker is there and has not expired', async () => {
  const ddb = fakeDdb();
  let now = new Date('2026-10-13T08:00:00Z');
  const store = createDeliveryStore(ddb, TABLE, () => now);
  assert.equal(await store.hasPendingReview('o/r', 7), false);
  const marker = await store.markReviewPending('o/r', 7, 300);
  assert.equal(await store.hasPendingReview('O/R', 7), true);
  assert.equal(await store.hasPendingReview('o/r', 8), false, 'pull requests are separate');
  const get = ddb.calls.findLast((c) => c.op === 'GetCommand').input;
  assert.deepEqual(get, { TableName: TABLE, Key: { key: 'pending#o/r#8' }, ConsistentRead: true });

  now = new Date('2026-10-13T09:05:00Z');
  assert.equal(await store.hasPendingReview('o/r', 7), true, 'up to its expiry');
  now = new Date('2026-10-13T09:05:01Z');
  assert.equal(await store.hasPendingReview('o/r', 7), false, 'expired as markReviewPending counts it, deleted or not');

  now = new Date('2026-10-13T08:00:00Z');
  await store.clearReviewPending('o/r', 7, marker);
  assert.equal(await store.hasPendingReview('o/r', 7), false, 'the worker started it');

  const throttled = { send: async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); } };
  await assert.rejects(createDeliveryStore(throttled, TABLE).hasPendingReview('o/r', 7), /slow down/);
});

test('a waiting review\'s round is noted as given back once per marker, until an event joins it', async () => {
  const ddb = fakeDdb();
  let now = new Date('2026-10-13T08:00:00Z');
  const store = createDeliveryStore(ddb, TABLE, () => now);
  assert.equal(await store.markRoundGivenBack('o/r', 7), false, 'no review waits');
  assert.equal(ddb.items.has('pending#o/r#7'), false, 'no marker is created');
  assert.equal(await store.clearRoundGivenBack('o/r', 7), false);
  assert.equal(ddb.items.has('pending#o/r#7'), false);

  const marker = await store.markReviewPending('o/r', 7, 300);
  assert.equal(await store.markRoundGivenBack('O/R', 7), true);
  assert.equal(await store.markRoundGivenBack('o/r', 7), false, 'once per marker');
  const update = ddb.calls.findLast((c) => c.op === 'UpdateCommand' && c.input.UpdateExpression === 'SET #r = :true').input;
  assert.deepEqual(update, {
    TableName: TABLE,
    Key: { key: 'pending#o/r#7' },
    UpdateExpression: 'SET #r = :true',
    ConditionExpression: 'attribute_exists(#m) AND #ttl >= :now AND attribute_not_exists(#r)',
    ExpressionAttributeNames: { '#m': 'marker', '#ttl': 'ttl', '#r': 'roundGivenBack' },
    ExpressionAttributeValues: { ':true': true, ':now': Date.parse('2026-10-13T08:00:00Z') / 1000 },
  });
  // The worker keeps its marker while it waits; the note stays with it.
  assert.equal(await extendPendingReview(ddb, TABLE, 'o/r', 7, marker), true);
  assert.equal(ddb.items.get('pending#o/r#7').roundGivenBack, true);

  assert.equal(await store.clearRoundGivenBack('O/R', 7), true, 'the pull request is back');
  assert.equal(await store.clearRoundGivenBack('o/r', 7), false, 'only once');
  assert.equal(ddb.items.get('pending#o/r#7').marker, marker, 'the marker stays');
  assert.equal(await store.markRoundGivenBack('o/r', 7), true, 'it can leave again');

  // The note goes with its marker.
  await store.clearReviewPending('o/r', 7, marker);
  assert.equal(await store.clearRoundGivenBack('o/r', 7), false);
  await store.markReviewPending('o/r', 7, 0);
  assert.equal(await store.clearRoundGivenBack('o/r', 7), false, 'a new marker has no note');
  now = new Date('2026-10-13T09:00:01Z');
  assert.equal(await store.markRoundGivenBack('o/r', 7), false, 'an expired marker has no review waiting');

  const throttled = { send: async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); } };
  await assert.rejects(createDeliveryStore(throttled, TABLE).markRoundGivenBack('o/r', 7), /slow down/);
  await assert.rejects(createDeliveryStore(throttled, TABLE).clearRoundGivenBack('o/r', 7), /slow down/);
});

test('releaseQuietly logs a failed release instead of throwing', async () => {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await releaseQuietly(async () => { throw new Error('gone'); }, 'k');
  } finally {
    console.error = original;
  }
  assert.match(errors[0], /could not release k/);
});
