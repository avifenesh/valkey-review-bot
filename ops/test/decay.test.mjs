import assert from 'node:assert/strict';
import test from 'node:test';
import { decayedScore, decayTable, loadDecayConfig } from '../src/decay.ts';

const DAY = 24 * 3600;
const HALF_LIFE = 30 * DAY;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * DAY * 1000).toISOString();
const CONFIG = { tables: { 'valkey-review': 'concerns' }, halfLifeSeconds: HALF_LIFE, floor: 0.05 };

test('the score halves every half-life', () => {
  assert.equal(decayedScore(1, 0, HALF_LIFE), 1);
  assert.equal(decayedScore(1, HALF_LIFE, HALF_LIFE), 0.5);
  assert.equal(decayedScore(1, 2 * HALF_LIFE, HALF_LIFE), 0.25);
  assert.equal(decayedScore(0.8, HALF_LIFE, HALF_LIFE), 0.4);
  assert.equal(decayedScore(1, -100, HALF_LIFE), 1, 'clock skew never raises the score');
});

test('decaying in daily steps matches one decay over the whole span', () => {
  let stepped = 1;
  for (let i = 0; i < 45; i++) stepped = decayedScore(stepped, DAY, HALF_LIFE);
  assert.ok(Math.abs(stepped - decayedScore(1, 45 * DAY, HALF_LIFE)) < 1e-12);
});

test('an unreinforced record crosses the 0.05 floor after about 130 days', () => {
  assert.ok(decayedScore(1, 129 * DAY, HALF_LIFE) >= 0.05);
  assert.ok(decayedScore(1, 130 * DAY, HALF_LIFE) < 0.05);
});

test('configuration is validated', () => {
  const tables = '{"valkey-review":"t1"}';
  assert.deepEqual(loadDecayConfig({ CONCERNS_TABLES_JSON: tables }), {
    tables: { 'valkey-review': 't1' },
    halfLifeSeconds: HALF_LIFE,
    floor: 0.05,
  });
  assert.equal(loadDecayConfig({ CONCERNS_TABLES_JSON: tables, DECAY_HALF_LIFE_SECONDS: '86400' }).halfLifeSeconds, 86400);
  assert.throws(() => loadDecayConfig({}), /CONCERNS_TABLES_JSON is required/);
  assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: '[]' }), /JSON object/);
  assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: '{"a":""}' }), /table name/);
  for (const bad of ['0', '-5', 'abc', 'Infinity']) {
    assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: tables, DECAY_HALF_LIFE_SECONDS: bad }), /DECAY_HALF_LIFE_SECONDS/, bad);
  }
  assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: tables, DECAY_FLOOR: '1' }), /below 1/);
  assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: tables, DECAY_FLOOR: 'x' }), /DECAY_FLOOR/);
});

function fakeDdb(pages, onWrite = () => ({})) {
  const writes = [];
  return {
    writes,
    async send(command) {
      const op = command.constructor.name;
      if (op === 'ScanCommand') {
        const index = command.input.ExclusiveStartKey?.page ?? 0;
        return { Items: pages[index], LastEvaluatedKey: index + 1 < pages.length ? { page: index + 1 } : undefined };
      }
      writes.push({ op, input: command.input });
      return onWrite(op, command.input);
    },
  };
}

test('decayTable decays from the later of updated_at and decayed_at and keeps updated_at', async () => {
  const ddb = fakeDdb([
    [{ area_bucket: 'src', record_id: 'fresh', decay_score: 1, updated_at: daysAgo(30) }],
    [{ area_bucket: 'src', record_id: 'stepped', decay_score: 0.5, updated_at: daysAgo(90), decayed_at: daysAgo(30) }],
  ]);
  const stats = await decayTable(ddb, 'concerns', CONFIG, NOW);

  assert.deepEqual(stats, { table: 'concerns', scanned: 2, decayed: 2, deleted: 0, skipped: 0, errors: 0 });
  const [fresh, stepped] = ddb.writes.map((w) => w.input);
  assert.equal(fresh.ExpressionAttributeValues[':s'], 0.5);
  assert.equal(fresh.ConditionExpression, '#ua = :ua AND attribute_not_exists(#da) AND #ds = :ds');
  assert.equal(fresh.ExpressionAttributeValues[':ua'], daysAgo(30));
  assert.equal(fresh.ExpressionAttributeValues[':ds'], 1);
  assert.equal(fresh.UpdateExpression, 'SET #ds = :s, #da = :now');
  assert.equal(stepped.ExpressionAttributeValues[':s'], 0.25);
  assert.equal(stepped.ConditionExpression, '#ua = :ua AND #da = :da AND #ds = :ds');
  assert.equal(stepped.ExpressionAttributeValues[':da'], daysAgo(30));
  assert.equal(stepped.ExpressionAttributeValues[':ds'], 0.5);
});

test('a reinforcement after a decay pass starts from the reinforcement', async () => {
  const ddb = fakeDdb([[{ area_bucket: 'src', record_id: 'r', decay_score: 1, updated_at: daysAgo(30), decayed_at: daysAgo(60) }]]);
  await decayTable(ddb, 'concerns', CONFIG, NOW);
  assert.equal(ddb.writes[0].input.ExpressionAttributeValues[':s'], 0.5);
});

test('records below the floor are deleted only in the state the scan saw', async () => {
  const ddb = fakeDdb([[{ area_bucket: 'src', record_id: 'old', decay_score: 1, updated_at: daysAgo(200) }]]);
  const stats = await decayTable(ddb, 'concerns', CONFIG, NOW);
  assert.equal(stats.deleted, 1);
  const { op, input } = ddb.writes[0];
  assert.equal(op, 'DeleteCommand');
  assert.equal(input.ConditionExpression, '#ua = :ua AND attribute_not_exists(#da) AND #ds = :ds');
  assert.deepEqual(input.ExpressionAttributeNames, { '#ua': 'updated_at', '#da': 'decayed_at', '#ds': 'decay_score' });
});

test('records reinforced during the pass are skipped, malformed ones counted as errors', async () => {
  const ddb = fakeDdb(
    [[
      { area_bucket: 'src', record_id: 'raced', decay_score: 1, updated_at: daysAgo(10) },
      { area_bucket: 'src', record_id: 'no-date', decay_score: 1 },
    ]],
    () => { throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' }); },
  );
  const stats = await decayTable(ddb, 'concerns', CONFIG, NOW);
  assert.deepEqual(stats, { table: 'concerns', scanned: 2, decayed: 0, deleted: 0, skipped: 1, errors: 1 });
});

test('every write is also conditioned on the decay_score as read, or its absence', async () => {
  const ddb = fakeDdb([[
    { area_bucket: 'src', record_id: 'scored', decay_score: 0.8, updated_at: daysAgo(30), decayed_at: daysAgo(1) },
    { area_bucket: 'src', record_id: 'unscored', updated_at: daysAgo(30) },
    { area_bucket: 'src', record_id: 'gone', updated_at: daysAgo(400) },
  ]]);
  await decayTable(ddb, 'concerns', CONFIG, NOW);
  const [scored, unscored, gone] = ddb.writes.map((w) => w.input);
  assert.match(scored.ConditionExpression, /(^| AND )#ds = :ds( AND |$)/);
  assert.equal(scored.ExpressionAttributeValues[':ds'], 0.8);
  assert.match(unscored.ConditionExpression, /(^| AND )attribute_not_exists\(#ds\)( AND |$)/);
  assert.ok(!(':ds' in unscored.ExpressionAttributeValues));
  assert.equal(unscored.ExpressionAttributeValues[':s'], 0.5, 'a record without a score starts from 1.0');
  assert.equal(ddb.writes[2].op, 'DeleteCommand');
  assert.match(gone.ConditionExpression, /(^| AND )attribute_not_exists\(#ds\)( AND |$)/);
  for (const w of ddb.writes) assert.equal(w.input.ExpressionAttributeNames['#ds'], 'decay_score');
});

test('a record the curator re-scored after the scan is skipped', async () => {
  const ddb = fakeDdb(
    [[{ area_bucket: 'src', record_id: 'penalised', decay_score: 1, updated_at: daysAgo(30), decayed_at: daysAgo(1) }]],
    (_op, input) => {
      // The curator lowered the score to 0.4 between the scan and the write.
      if (input.ExpressionAttributeValues[':ds'] !== 0.4) {
        throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
      }
      return {};
    },
  );
  const stats = await decayTable(ddb, 'concerns', CONFIG, NOW);
  assert.equal(stats.skipped, 1);
  assert.equal(stats.decayed, 0);
});
