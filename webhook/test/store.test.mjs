import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';
import { fakeDdb } from './support/fakes.mjs';

const { budgetKey, createDeliveryStore, releaseQuietly } = await import('../src/store.ts');

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
