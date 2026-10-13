import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const {
  decayedScore, decayTable, loadDecayConfig, MAINTENANCE_RETRY_DAYS, parseDecayEvent, releaseTags, summaryLine,
} = await import('../src/decay.ts');

const DAY = 24 * 3600;
const HALF_LIFE = 30 * DAY;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * DAY * 1000).toISOString();
const CONFIG = { tables: { 'valkey-review': 'concerns' }, halfLifeSeconds: HALF_LIFE, floor: 0.05 };
const GRADUATED_HALF_LIFE = 180 * DAY;
const LIFECYCLE = { ...CONFIG, graduatedHalfLifeSeconds: GRADUATED_HALF_LIFE };
// Stats fields for skill maintenance, all zero for a table with nothing to queue.
const NOTHING_QUEUED = { keptRetired: 0, checksRequested: 0, retireRequested: 0, wouldRetire: 0, deferred: 0 };

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
    graduatedHalfLifeSeconds: GRADUATED_HALF_LIFE,
    upstreamRepos: {},
    curatorQueueUrl: '',
    checksPerDay: 0,
    recheckSeconds: 90 * DAY,
    retireSkills: false,
    maxRetirementsPerDay: 3,
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
  assert.equal(loadDecayConfig({ CONCERNS_TABLES_JSON: tables, DECAY_GRADUATED_HALF_LIFE_SECONDS: '7776000' }).graduatedHalfLifeSeconds, 90 * DAY);
  for (const bad of ['0', '-1', 'soon']) {
    assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: tables, DECAY_GRADUATED_HALF_LIFE_SECONDS: bad }), /DECAY_GRADUATED_HALF_LIFE_SECONDS/, bad);
  }
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

  assert.deepEqual(stats, { table: 'concerns', scanned: 2, decayed: 2, deleted: 0, skipped: 0, errors: 0, ...NOTHING_QUEUED });
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
  assert.equal(input.ConditionExpression, '#ua = :ua AND attribute_not_exists(#da) AND #ds = :ds AND attribute_not_exists(#grn)');
  assert.deepEqual(input.ExpressionAttributeNames, { '#ua': 'updated_at', '#da': 'decayed_at', '#ds': 'decay_score', '#grn': 'graduated_record_name' });
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
  assert.deepEqual(stats, { table: 'concerns', scanned: 2, decayed: 0, deleted: 0, skipped: 1, errors: 1, ...NOTHING_QUEUED });
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

test('an unreinforced graduated record crosses the floor after about 778 days', () => {
  assert.ok(decayedScore(1, 777 * DAY, GRADUATED_HALF_LIFE) >= 0.05);
  assert.ok(decayedScore(1, 779 * DAY, GRADUATED_HALF_LIFE) < 0.05);
});

const graduated = (fields) => ({ area_bucket: 'src', graduated_record_name: 'rdb-load-rules', graduated_at: daysAgo(400), ...fields });

test('graduated records decay on their own half-life and are never deleted', async (t) => {
  t.mock.method(console, 'log', () => {});
  const ddb = fakeDdb([[
    graduated({ record_id: 'skill', decay_score: 1, updated_at: daysAgo(180) }),
    graduated({ record_id: 'faded', decay_score: 1, updated_at: daysAgo(2000) }),
    { area_bucket: 'src', record_id: 'plain', decay_score: 1, updated_at: daysAgo(180) },
  ]]);
  const stats = await decayTable(ddb, 'concerns', LIFECYCLE, NOW);
  // Without a curator queue the faded record is only reported.
  assert.deepEqual(stats, { table: 'concerns', scanned: 3, decayed: 2, deleted: 1, skipped: 0, errors: 0, ...NOTHING_QUEUED, wouldRetire: 1 });
  const byId = (id) => ddb.writes.find((w) => w.input.Key.record_id === id);
  const [skill, faded, plain] = ['skill', 'faded', 'plain'].map(byId);
  assert.equal(skill.op, 'UpdateCommand');
  assert.equal(skill.input.ExpressionAttributeValues[':s'], 0.5);
  assert.equal(faded.op, 'UpdateCommand', 'a graduated record below the floor keeps its provenance');
  assert.ok(faded.input.ExpressionAttributeValues[':s'] < 0.05);
  assert.equal(plain.op, 'DeleteCommand');
});

test('tombstones of retired skills get no write', async () => {
  const ddb = fakeDdb([[
    graduated({ record_id: 'gone', decay_score: 0.01, updated_at: daysAgo(900), retired_at: daysAgo(10), retired_reason: 'decayed' }),
  ]]);
  const stats = await decayTable(ddb, 'concerns', LIFECYCLE, NOW);
  assert.deepEqual(stats, { table: 'concerns', scanned: 1, decayed: 0, deleted: 0, skipped: 0, errors: 0, ...NOTHING_QUEUED, keptRetired: 1 });
  assert.equal(ddb.writes.length, 0);
});

test('the scan reads the lifecycle attributes it needs', async () => {
  const ddb = fakeDdb([[]]);
  const scans = [];
  const send = ddb.send.bind(ddb);
  ddb.send = async (command) => {
    if (command.constructor.name === 'ScanCommand') scans.push(command.input);
    return send(command);
  };
  await decayTable(ddb, 'concerns', LIFECYCLE, NOW);
  const names = scans[0].ExpressionAttributeNames;
  const projected = scans[0].ProjectionExpression.split(', ').map((n) => names[n]);
  for (const attr of ['area_bucket', 'record_id', 'decay_score', 'updated_at', 'decayed_at', 'graduated_record_name', 'retired_at']) {
    assert.ok(projected.includes(attr), attr);
  }
});

// Skill maintenance: retire and check requests on the curator queue.

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/curator';
const FULL = {
  ...LIFECYCLE,
  upstreamRepos: { 'valkey-review': 'valkey-io/valkey' },
  curatorQueueUrl: QUEUE,
  checksPerDay: 10,
  recheckSeconds: 90 * DAY,
  retireSkills: true,
  maxRetirementsPerDay: 3,
};
const NOW_ISO = new Date(NOW).toISOString();

function fakeSqs(events = [], onSend = () => ({})) {
  const sent = [];
  return {
    sent,
    async send(command) {
      assert.equal(command.constructor.name, 'SendMessageCommand');
      events.push(`send ${JSON.parse(command.input.MessageBody).record_id}`);
      const out = onSend(command.input);
      sent.push(command.input);
      return out;
    },
  };
}

function maintenance(fields = {}) {
  const events = [];
  return { events, ctx: { reviewerId: 'valkey-review', releaseTag: '9.1.2', recheckAll: false, dryRun: false, sqs: fakeSqs(events), ...fields } };
}

/** A live graduated record that was checked at the current release ten days ago: nothing is due. */
const live = (recordId, fields = {}) => graduated({
  record_id: recordId,
  graduated_record_name: `skill-${recordId}`,
  decay_score: 1,
  updated_at: daysAgo(5),
  verified_at: daysAgo(10),
  verified_release: '9.1.2',
  ...fields,
});

/** A live graduated record far below the floor. */
const faded = (recordId, fields = {}) => live(recordId, { updated_at: daysAgo(1000), decay_score: 1, ...fields });

const bodies = (sqs) => sqs.sent.map((m) => JSON.parse(m.MessageBody));
const claims = (ddb) => ddb.writes.filter((w) => w.input.UpdateExpression?.includes('#mid = :mid'));
const quietLogs = (t) => t.mock.method(console, 'log', () => {});

test('retirement off: candidates are logged as would-retire, given the score write and not queued', async (t) => {
  const log = quietLogs(t);
  for (const [config, fields] of [[{ ...FULL, retireSkills: false }, {}], [FULL, { dryRun: true }]]) {
    const { ctx } = maintenance(fields);
    const ddb = fakeDdb([[faded('r1'), faded('r2', { obsolete_release: 'unstable@0eb4ba3c1d2e', decay_score: 0 })]]);
    const stats = await decayTable(ddb, 'concerns', config, NOW, ctx);
    assert.equal(stats.wouldRetire, 2);
    assert.equal(stats.retireRequested, 0);
    assert.equal(ctx.sqs.sent.length, 0);
    assert.equal(claims(ddb).length, 0);
    assert.deepEqual(ddb.writes.map((w) => w.input.UpdateExpression), ['SET #ds = :s, #da = :now', 'SET #ds = :s, #da = :now']);
  }
  const lines = log.mock.calls.map((c) => c.arguments[0]).filter((l) => l.includes('would-retire'));
  assert.equal(lines.length, 4);
  // Lowest score first: the obsolete record has score 0.
  assert.equal(lines[0], '[decay] would-retire concerns src/r2 name=skill-r2 score=0.0000 reason=obsolete');
  assert.match(lines[1], /^\[decay\] would-retire concerns src\/r1 name=skill-r1 score=0\.\d{4} reason=decayed$/);
});

test('a retirement is claimed on the record, then sent', async (t) => {
  quietLogs(t);
  const { ctx, events } = maintenance();
  const record = faded('r1');
  const ddb = fakeDdb([[record]], (_op, input) => { events.push(`write ${input.Key.record_id}`); return {}; });
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);

  assert.deepEqual(events, ['write r1', 'send r1'], 'the claim comes before the message');
  assert.equal(stats.retireRequested, 1);
  assert.equal(stats.decayed, 1, 'the claim also stores the decayed score');

  const { input } = ddb.writes[0];
  const id = `retire#valkey-review#r1#${NOW_ISO}`;
  assert.equal(input.UpdateExpression, 'SET #ds = :s, #da = :now, #mid = :mid, #mra = :now, #mr = :mr');
  assert.equal(input.ConditionExpression, '#ua = :ua AND attribute_not_exists(#da) AND #ds = :ds AND #grn = :grn AND attribute_not_exists(#ret)');
  assert.deepEqual(input.ExpressionAttributeNames, {
    '#ds': 'decay_score', '#ua': 'updated_at', '#da': 'decayed_at', '#grn': 'graduated_record_name', '#ret': 'retired_at',
    '#mid': 'maintenance_id', '#mra': 'maintenance_requested_at', '#mr': 'maintenance_reason',
  });
  assert.equal(input.ExpressionAttributeValues[':mid'], id);
  assert.equal(input.ExpressionAttributeValues[':mr'], 'retire');
  assert.equal(input.ExpressionAttributeValues[':grn'], 'skill-r1');
  assert.equal(input.ExpressionAttributeValues[':now'], NOW_ISO);
  assert.ok(input.ExpressionAttributeValues[':s'] < 0.05);

  const [message] = ctx.sqs.sent;
  assert.equal(message.QueueUrl, QUEUE);
  assert.equal(message.DelaySeconds, 0);
  assert.deepEqual(JSON.parse(message.MessageBody), {
    maintenance_id: id,
    reason: 'retire',
    reviewer_id: 'valkey-review',
    area_bucket: 'src',
    record_id: 'r1',
    record_name: 'skill-r1',
    retire_reason: 'decayed',
    seen_updated_at: record.updated_at,
    dry_run: false,
  });
  assert.deepEqual(message.MessageAttributes, {
    reviewer_id: { DataType: 'String', StringValue: 'valkey-review' },
    maintenance_id: { DataType: 'String', StringValue: id },
    reason: { DataType: 'String', StringValue: 'retire' },
  });
});

test('retirements go lowest score first, within maxRetirementsPerDay, with reason obsolete when a check found the subject gone', async (t) => {
  const log = quietLogs(t);
  const { ctx } = maintenance();
  const ddb = fakeDdb([[
    faded('d900', { updated_at: daysAgo(900) }),
    faded('d2000', { updated_at: daysAgo(2000) }),
    faded('obs', { decay_score: 0, updated_at: daysAgo(20), obsolete_release: '9.1.2' }),
    faded('d1500', { updated_at: daysAgo(1500) }),
    faded('d800', { updated_at: daysAgo(800) }),
  ]]);
  const stats = await decayTable(ddb, 'concerns', { ...FULL, maxRetirementsPerDay: 3 }, NOW, ctx);

  assert.deepEqual(bodies(ctx.sqs).map((b) => [b.record_id, b.retire_reason]), [['obs', 'obsolete'], ['d2000', 'decayed'], ['d1500', 'decayed']]);
  assert.equal(stats.retireRequested, 3);
  assert.equal(stats.deferred, 2);
  assert.equal(stats.decayed, 5, 'deferred candidates still get their score');
  const deferredLines = log.mock.calls.map((c) => c.arguments[0]).filter((l) => l.startsWith('[decay] deferred'));
  assert.deepEqual(deferredLines.map((l) => l.split(' ')[3]), ['src/d900', 'src/d800']);
});

test('each check-due rule queues a check, and a record checked at the current release is left alone', async (t) => {
  quietLogs(t);
  const cases = [
    ['never checked', { verified_at: undefined, verified_release: undefined }, {}, true],
    ['new release', { verified_release: '9.1.1' }, {}, true],
    ['checked while the release was unknown', { verified_release: '' }, {}, true],
    ['re-published', { graduated_at: daysAgo(2) }, {}, true],
    ['old check', { verified_at: daysAgo(91) }, {}, true],
    ['recheck_all', {}, { recheckAll: true }, true],
    ['current', {}, {}, false],
    ['current, release unknown', { verified_release: '9.1.1' }, { releaseTag: null }, false],
    ['recent check', { verified_at: daysAgo(89) }, {}, false],
  ];
  for (const [label, fields, ctxFields, due] of cases) {
    const { ctx } = maintenance(ctxFields);
    const ddb = fakeDdb([[live('r', fields)]]);
    const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
    assert.equal(stats.checksRequested, due ? 1 : 0, label);
    assert.equal(ddb.writes.length, 1, label);
    assert.equal(ddb.writes[0].input.ExpressionAttributeValues[':mr'], due ? 'check' : undefined, label);
  }
});

test('a check request carries the release tag, the record and dry_run', async (t) => {
  quietLogs(t);
  for (const [releaseTag, dryRun] of [['9.1.2', false], [null, true]]) {
    const { ctx } = maintenance({ releaseTag, dryRun });
    const record = live('r1', { verified_at: undefined });
    const ddb = fakeDdb([[record]]);
    await decayTable(ddb, 'concerns', FULL, NOW, ctx);
    const id = `check#valkey-review#r1#${NOW_ISO}`;
    assert.deepEqual(bodies(ctx.sqs), [{
      maintenance_id: id,
      reason: 'check',
      reviewer_id: 'valkey-review',
      area_bucket: 'src',
      record_id: 'r1',
      record_name: 'skill-r1',
      release_tag: releaseTag ?? '',
      seen_updated_at: record.updated_at,
      dry_run: dryRun,
    }]);
    const claim = ddb.writes[0].input;
    assert.equal(claim.ExpressionAttributeValues[':mid'], id);
    assert.match(claim.ConditionExpression, / AND #grn = :grn AND attribute_not_exists\(#ret\)$/);
  }
});

test('the release tag is checked again before it reaches a message', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance({ releaseTag: '9.2.0-rc1' });
  const ddb = fakeDdb([[live('r1', { verified_at: undefined })]]);
  await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.equal(bodies(ctx.sqs)[0].release_tag, '');
});

test(`no new request within ${MAINTENANCE_RETRY_DAYS} days of the last one`, async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  const ddb = fakeDdb([[
    live('pending', { verified_at: undefined, maintenance_requested_at: daysAgo(6.9) }),
    faded('pending-retire', { maintenance_requested_at: daysAgo(1) }),
    live('stale', { verified_at: undefined, maintenance_requested_at: daysAgo(7.1) }),
  ]]);
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.deepEqual(bodies(ctx.sqs).map((b) => b.record_id), ['stale']);
  assert.equal(stats.decayed, 3, 'in-flight records still decay');
  assert.equal(stats.retireRequested + stats.wouldRetire + stats.deferred, 0);
});

test('checks go never checked first, then re-published, then the oldest check, within checksPerDay', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  const ddb = fakeDdb([[
    live('old-check', { verified_release: '9.1.1', verified_at: daysAgo(80) }),
    live('older-check', { verified_release: '9.1.1', verified_at: daysAgo(85) }),
    live('republished', { graduated_at: daysAgo(1), verified_at: daysAgo(20) }),
    live('new', { verified_at: undefined, graduated_at: daysAgo(3) }),
    live('newer', { verified_at: undefined, graduated_at: daysAgo(1) }),
    live('recent-check', { verified_release: '9.1.1', verified_at: daysAgo(2) }),
  ]]);
  const stats = await decayTable(ddb, 'concerns', { ...FULL, checksPerDay: 4 }, NOW, ctx);
  assert.deepEqual(bodies(ctx.sqs).map((b) => b.record_id), ['new', 'newer', 'republished', 'older-check']);
  assert.equal(stats.checksRequested, 4);
  assert.equal(stats.deferred, 2);
  assert.equal(stats.decayed, 6);
  const plain = ddb.writes.filter((w) => w.input.UpdateExpression === 'SET #ds = :s, #da = :now').map((w) => w.input.Key.record_id);
  assert.deepEqual(plain.sort(), ['old-check', 'recent-check']);
});

test('check requests are staggered by a minute each, up to the SQS maximum', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  const records = Array.from({ length: 20 }, (_, i) => live(`r${String(i).padStart(2, '0')}`, { verified_at: undefined, graduated_at: daysAgo(100 - i) }));
  await decayTable(fakeDdb([records]), 'concerns', { ...FULL, checksPerDay: 20 }, NOW, ctx);
  assert.deepEqual(ctx.sqs.sent.map((m) => m.DelaySeconds), [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 900, 900, 900, 900]);
});

test('retire requests are not delayed and do not shift the check stagger', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  await decayTable(fakeDdb([[faded('gone'), live('a', { verified_at: undefined }), live('b', { verified_at: undefined })]]), 'concerns', FULL, NOW, ctx);
  assert.deepEqual(ctx.sqs.sent.map((m) => [JSON.parse(m.MessageBody).reason, m.DelaySeconds]), [['retire', 0], ['check', 0], ['check', 60]]);
});

test('a failed send releases the claim and counts an error', async (t) => {
  quietLogs(t);
  t.mock.method(console, 'warn', () => {});
  const events = [];
  const ctx = {
    reviewerId: 'valkey-review', releaseTag: '9.1.2', recheckAll: false, dryRun: false,
    sqs: fakeSqs(events, () => { throw new Error('queue unavailable'); }),
  };
  const ddb = fakeDdb([[live('r1', { verified_at: undefined })]]);
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.equal(stats.errors, 1);
  assert.equal(stats.checksRequested, 0);
  assert.equal(ddb.writes.length, 2);
  const [claim, release] = ddb.writes.map((w) => w.input);
  assert.equal(release.UpdateExpression, 'REMOVE #mid, #mra, #mr');
  assert.equal(release.ConditionExpression, '#mid = :mid');
  assert.equal(release.ExpressionAttributeValues[':mid'], claim.ExpressionAttributeValues[':mid']);
  assert.deepEqual(release.ExpressionAttributeNames, { '#mid': 'maintenance_id', '#mra': 'maintenance_requested_at', '#mr': 'maintenance_reason' });
});

test('a record that changed after the scan loses its claim, and the next candidate takes the slot', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  const ddb = fakeDdb([[live('raced', { verified_at: undefined, graduated_at: daysAgo(9) }), live('next', { verified_at: undefined, graduated_at: daysAgo(1) })]], (_op, input) => {
    if (input.Key.record_id === 'raced') throw Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
    return {};
  });
  const stats = await decayTable(ddb, 'concerns', { ...FULL, checksPerDay: 1 }, NOW, ctx);
  assert.equal(stats.skipped, 1);
  assert.deepEqual(bodies(ctx.sqs).map((b) => b.record_id), ['next']);
  assert.equal(ctx.sqs.sent[0].DelaySeconds, 0);
});

test('no checks without an upstream, with checks off or without a queue; retirement still applies', async (t) => {
  quietLogs(t);
  const setups = [
    [{ ...FULL, upstreamRepos: {} }, {}],
    [{ ...FULL, upstreamRepos: { 'valkey-glide-review': 'valkey-io/valkey-glide' } }, {}],
    [{ ...FULL, checksPerDay: 0 }, {}],
    [FULL, { sqs: undefined }],
  ];
  for (const [config, fields] of setups) {
    const { ctx } = maintenance(fields);
    const ddb = fakeDdb([[live('unchecked', { verified_at: undefined }), faded('gone')]]);
    const stats = await decayTable(ddb, 'concerns', config, NOW, ctx);
    assert.equal(stats.checksRequested, 0);
    assert.equal(stats.retireRequested + stats.wouldRetire, 1);
    assert.equal(ddb.writes.length, 2);
  }
});

test('a record the curator could not accept is never queued', async (t) => {
  quietLogs(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const { ctx } = maintenance();
  const ddb = fakeDdb([[
    live('r1', { verified_at: undefined, graduated_record_name: 'Not A Slug' }),
    faded('r2', { graduated_record_name: '-leading-dash' }),
    live('x'.repeat(101), { verified_at: undefined }),
  ]]);
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.equal(ctx.sqs.sent.length, 0);
  assert.equal(stats.errors, 3);
  assert.equal(stats.decayed, 3, 'each still gets its score write');
  assert.equal(warn.mock.calls.length, 3);
  for (const call of warn.mock.calls) assert.match(call.arguments[0], /^\[decay\] cannot queue maintenance for concerns /);
});

test('the summary line names every counter', () => {
  const line = summaryLine({
    table: 'valkey_review_concerns', scanned: 9, decayed: 5, deleted: 1, skipped: 1, errors: 0,
    keptRetired: 2, checksRequested: 3, retireRequested: 1, wouldRetire: 0, deferred: 4,
  });
  assert.equal(line, '[decay] valkey_review_concerns scanned=9 decayed=5 deleted=1 skipped=1 errors=0 kept_retired=2 checks_requested=3 retire_requested=1 would_retire=0 deferred=4');
});

test('the manual event turns on recheck_all and dry_run only when set to true', () => {
  assert.deepEqual(parseDecayEvent({ recheck_all: true }), { recheckAll: true, dryRun: false });
  assert.deepEqual(parseDecayEvent({ recheck_all: true, dry_run: true }), { recheckAll: true, dryRun: true });
  for (const event of [undefined, null, 'x', {}, { recheck_all: 'true', dry_run: 1 }, { source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} }]) {
    assert.deepEqual(parseDecayEvent(event), { recheckAll: false, dryRun: false }, JSON.stringify(event));
  }
});

test('release tags are looked up once per upstream, and not at all when checks are off', async () => {
  const config = {
    ...FULL,
    tables: { 'valkey-review': 't1', 'valkey-glide-review': 't2', fork: 't3', local: 't4' },
    upstreamRepos: { 'valkey-review': 'valkey-io/valkey', fork: 'valkey-io/valkey', 'valkey-glide-review': 'valkey-io/valkey-glide', unused: 'a/b' },
  };
  const asked = [];
  const tags = await releaseTags(config, async (repo) => {
    asked.push(repo);
    return repo === 'valkey-io/valkey' ? '9.1.2' : null;
  });
  assert.deepEqual(asked.sort(), ['valkey-io/valkey', 'valkey-io/valkey-glide']);
  assert.deepEqual(tags, { 'valkey-review': '9.1.2', 'valkey-glide-review': null, fork: '9.1.2' });
  assert.deepEqual(await releaseTags({ ...config, checksPerDay: 0 }, async () => assert.fail('no lookup')), {});
});

test('skill maintenance settings are validated', () => {
  const base = { CONCERNS_TABLES_JSON: '{"valkey-review":"t1","valkey-glide-review":"t2"}' };
  const on = { ...base, CURATOR_QUEUE_URL: QUEUE, SKILL_CHECKS_PER_DAY: '10' };
  assert.deepEqual(loadDecayConfig({
    ...on,
    UPSTREAM_REPOS_JSON: '{"valkey-review":"valkey-io/valkey","valkey-glide-review":""}',
    SKILL_RECHECK_SECONDS: String(30 * DAY),
    RETIRE_SKILLS: 'true',
    MAX_RETIREMENTS_PER_DAY: '5',
  }), {
    tables: { 'valkey-review': 't1', 'valkey-glide-review': 't2' },
    halfLifeSeconds: HALF_LIFE,
    floor: 0.05,
    graduatedHalfLifeSeconds: GRADUATED_HALF_LIFE,
    upstreamRepos: { 'valkey-review': 'valkey-io/valkey' },
    curatorQueueUrl: QUEUE,
    checksPerDay: 10,
    recheckSeconds: 30 * DAY,
    retireSkills: true,
    maxRetirementsPerDay: 5,
  });
  assert.deepEqual(loadDecayConfig({ ...base, UPSTREAM_REPOS_JSON: '{}', RETIRE_SKILLS: 'false', SKILL_CHECKS_PER_DAY: '0' }).upstreamRepos, {});

  assert.throws(() => loadDecayConfig({ ...base, SKILL_CHECKS_PER_DAY: '1' }), /CURATOR_QUEUE_URL is required/);
  assert.throws(() => loadDecayConfig({ ...base, RETIRE_SKILLS: 'true' }), /CURATOR_QUEUE_URL is required/);
  for (const bad of ['-1', '1.5', 'ten']) {
    assert.throws(() => loadDecayConfig({ ...on, SKILL_CHECKS_PER_DAY: bad }), /SKILL_CHECKS_PER_DAY must be an integer of at least 0/, bad);
  }
  for (const bad of ['0', '2.5', 'x']) {
    assert.throws(() => loadDecayConfig({ ...on, MAX_RETIREMENTS_PER_DAY: bad }), /MAX_RETIREMENTS_PER_DAY must be an integer of at least 1/, bad);
  }
  for (const bad of ['0', '-86400', 'week']) {
    assert.throws(() => loadDecayConfig({ ...on, SKILL_RECHECK_SECONDS: bad }), /SKILL_RECHECK_SECONDS/, bad);
  }
  for (const bad of ['yes', 'TRUE', '1']) {
    assert.throws(() => loadDecayConfig({ ...on, RETIRE_SKILLS: bad }), /RETIRE_SKILLS must be "true" or "false"/, bad);
  }
  assert.throws(() => loadDecayConfig({ ...on, UPSTREAM_REPOS_JSON: '[' }), /UPSTREAM_REPOS_JSON is not valid JSON/);
  assert.throws(() => loadDecayConfig({ ...on, UPSTREAM_REPOS_JSON: '["valkey-io/valkey"]' }), /UPSTREAM_REPOS_JSON must be a JSON object/);
  assert.throws(() => loadDecayConfig({ ...on, UPSTREAM_REPOS_JSON: '{"valkey-review":7}' }), /UPSTREAM_REPOS_JSON.valkey-review must be a string/);
  for (const bad of ['valkey', 'valkey-io/valkey/tree', 'owner/..', 'https://github.com/valkey-io/valkey']) {
    assert.throws(() => loadDecayConfig({ ...on, UPSTREAM_REPOS_JSON: JSON.stringify({ 'valkey-review': bad }) }), /must look like "owner\/name"/, bad);
  }
});
