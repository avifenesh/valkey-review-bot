import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const {
  decayedScore, decayTable, isReservedBucket, loadDecayConfig, MAINTENANCE_RETRY_DAYS, parseDecayEvent, releaseTags,
  REPO_SKILL_KEY, RESERVED_BUCKET_PREFIX, summaryLine,
} = await import('../src/decay.ts');

const DAY = 24 * 3600;
const HALF_LIFE = 30 * DAY;
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const daysAgo = (n) => new Date(NOW - n * DAY * 1000).toISOString();
const QUEUE = 'https://sqs.us-east-1.amazonaws.com/123456789012/curator';
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
  const base = { CONCERNS_TABLES_JSON: tables, CURATOR_QUEUE_URL: QUEUE };
  assert.deepEqual(loadDecayConfig(base), {
    tables: { 'valkey-review': 't1' },
    halfLifeSeconds: HALF_LIFE,
    floor: 0.05,
    graduatedHalfLifeSeconds: GRADUATED_HALF_LIFE,
    upstreamRepos: {},
    curatorQueueUrl: QUEUE,
    checksPerDay: 10,
    recheckSeconds: 90 * DAY,
    retireSkills: false,
    maxRetirementsPerDay: 3,
  });
  // Checks are on by default, so the queue is required unless they are turned off.
  assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: tables }), /CURATOR_QUEUE_URL is required when SKILL_CHECKS_PER_DAY is above 0 \(default 10\)/);
  const off = loadDecayConfig({ CONCERNS_TABLES_JSON: tables, SKILL_CHECKS_PER_DAY: '0' });
  assert.equal(off.checksPerDay, 0);
  assert.equal(off.curatorQueueUrl, '');
  assert.equal(loadDecayConfig({ ...base, DECAY_HALF_LIFE_SECONDS: '86400' }).halfLifeSeconds, 86400);
  assert.throws(() => loadDecayConfig({}), /CONCERNS_TABLES_JSON is required/);
  assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: '[]' }), /JSON object/);
  assert.throws(() => loadDecayConfig({ CONCERNS_TABLES_JSON: '{"a":""}' }), /table name/);
  for (const bad of ['0', '-5', 'abc', 'Infinity']) {
    assert.throws(() => loadDecayConfig({ ...base, DECAY_HALF_LIFE_SECONDS: bad }), /DECAY_HALF_LIFE_SECONDS/, bad);
  }
  assert.throws(() => loadDecayConfig({ ...base, DECAY_FLOOR: '1' }), /below 1/);
  assert.throws(() => loadDecayConfig({ ...base, DECAY_FLOOR: 'x' }), /DECAY_FLOOR/);
  assert.equal(loadDecayConfig({ ...base, DECAY_GRADUATED_HALF_LIFE_SECONDS: '7776000' }).graduatedHalfLifeSeconds, 90 * DAY);
  for (const bad of ['0', '-1', 'soon']) {
    assert.throws(() => loadDecayConfig({ ...base, DECAY_GRADUATED_HALF_LIFE_SECONDS: bad }), /DECAY_GRADUATED_HALF_LIFE_SECONDS/, bad);
  }
});

/** The attributes a scan's ProjectionExpression names, or null when it projects everything. */
function projectedAttributes(input) {
  if (!input.ProjectionExpression) return null;
  return input.ProjectionExpression.split(',').map((token) => {
    const name = token.trim();
    return name.startsWith('#') ? input.ExpressionAttributeNames[name] : name;
  });
}

/** Each item as DynamoDB returns it under the scan's projection. */
function project(items, input) {
  const attributes = projectedAttributes(input);
  if (!attributes || !items) return items;
  return items.map((item) => Object.fromEntries(Object.entries(item).filter(([attr]) => attributes.includes(attr))));
}

function fakeDdb(pages, onWrite = () => ({})) {
  const writes = [];
  return {
    writes,
    async send(command) {
      const op = command.constructor.name;
      if (op === 'ScanCommand') {
        const index = command.input.ExclusiveStartKey?.page ?? 0;
        return { Items: project(pages[index], command.input), LastEvaluatedKey: index + 1 < pages.length ? { page: index + 1 } : undefined };
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

/**
 * Whether a write's ConditionExpression holds for `item`. Supports what
 * the decay pass writes: clauses of `#a = :v`, attribute_exists(#a) and
 * attribute_not_exists(#a) joined by AND. Anything else throws, so a new
 * form of condition cannot pass unevaluated.
 */
function conditionHolds(input, item) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const attr = (ref) => {
    assert.ok(ref in names, `${ref} is not in ExpressionAttributeNames`);
    return names[ref];
  };
  return input.ConditionExpression.split(' AND ').every((clause) => {
    let m;
    if ((m = /^(#\w+) = (:\w+)$/.exec(clause))) {
      assert.ok(m[2] in values, `${m[2]} is not in ExpressionAttributeValues`);
      return item[attr(m[1])] === values[m[2]];
    }
    if ((m = /^attribute_not_exists\((#\w+)\)$/.exec(clause))) return !(attr(m[1]) in item);
    if ((m = /^attribute_exists\((#\w+)\)$/.exec(clause))) return attr(m[1]) in item;
    throw new Error(`unsupported condition clause: ${clause}`);
  });
}

const conditionalFailure = () => Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });

test('a record the curator re-scored after the scan is skipped', async () => {
  const scanned = { area_bucket: 'src', record_id: 'penalised', decay_score: 1, updated_at: daysAgo(30), decayed_at: daysAgo(1) };
  // The curator lowered the score to 0.4 between the scan and the write;
  // updated_at and decayed_at are unchanged.
  const stored = { ...scanned, decay_score: 0.4 };
  const ddb = fakeDdb([[scanned]], (_op, input) => {
    if (!conditionHolds(input, stored)) throw conditionalFailure();
    return {};
  });
  const stats = await decayTable(ddb, 'concerns', CONFIG, NOW);
  assert.equal(ddb.writes.length, 1);
  assert.equal(ddb.writes[0].input.ExpressionAttributeValues[':ds'], 1, 'the write expects the score the scan read');
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

test('the scan projects exactly the attributes the pass reads', async () => {
  const ddb = fakeDdb([[]]);
  const scans = [];
  const send = ddb.send.bind(ddb);
  ddb.send = async (command) => {
    if (command.constructor.name === 'ScanCommand') scans.push(command.input);
    return send(command);
  };
  await decayTable(ddb, 'concerns', LIFECYCLE, NOW);
  // The fake returns only projected attributes, as DynamoDB does, so an
  // attribute dropped here also changes what the other tests see.
  assert.deepEqual(projectedAttributes(scans[0]).sort(), [
    'area_bucket',
    'decay_score',
    'decayed_at',
    'graduated_at',
    'graduated_record_name',
    'maintenance_requested_at',
    'obsolete_release',
    'record_id',
    'retired_at',
    'updated_at',
    'verified_at',
    'verified_release',
  ]);
});

// Skill maintenance: retire and check requests on the curator queue.

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

/** The reviewer's repo skill.md item, checked at the current release, so record tests see no repo check. */
const REPO_SKILL_CHECKED = { area_bucket: '#maintenance', record_id: 'repo-skill', verified_release: '9.1.2', verified_at: daysAgo(10) };
const table = (items, onWrite) => fakeDdb([[REPO_SKILL_CHECKED, ...items]], onWrite);

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
    const ddb = table([faded('r1'), faded('r2', { obsolete_release: 'unstable@0eb4ba3c1d2e', decay_score: 0 })]);
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
  assert.equal(lines[0], '[decay] would-retire concerns bucket="src" id="r2" name="skill-r2" score=0.0000 reason=obsolete');
  assert.match(lines[1], /^\[decay\] would-retire concerns bucket="src" id="r1" name="skill-r1" score=0\.\d{4} reason=decayed$/);
});

test('a retirement is claimed on the record, then sent', async (t) => {
  quietLogs(t);
  const { ctx, events } = maintenance();
  const record = faded('r1');
  const ddb = table([record], (_op, input) => { events.push(`write ${input.Key.record_id}`); return {}; });
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
  const ddb = table([
    faded('d900', { updated_at: daysAgo(900) }),
    faded('d2000', { updated_at: daysAgo(2000) }),
    faded('obs', { decay_score: 0, updated_at: daysAgo(20), obsolete_release: '9.1.2' }),
    faded('d1500', { updated_at: daysAgo(1500) }),
    faded('d800', { updated_at: daysAgo(800) }),
  ]);
  const stats = await decayTable(ddb, 'concerns', { ...FULL, maxRetirementsPerDay: 3 }, NOW, ctx);

  assert.deepEqual(bodies(ctx.sqs).map((b) => [b.record_id, b.retire_reason]), [['obs', 'obsolete'], ['d2000', 'decayed'], ['d1500', 'decayed']]);
  assert.equal(stats.retireRequested, 3);
  assert.equal(stats.deferred, 2);
  assert.equal(stats.decayed, 5, 'deferred candidates still get their score');
  const deferredLines = log.mock.calls.map((c) => c.arguments[0]).filter((l) => l.startsWith('[decay] deferred'));
  assert.deepEqual(deferredLines.map((l) => /\bid="([^"]*)"/.exec(l)?.[1]), ['d900', 'd800']);
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
    const ddb = table([live('r', fields)]);
    await decayTable(ddb, 'concerns', FULL, NOW, ctx);
    assert.equal(bodies(ctx.sqs).filter((m) => m.reason === 'check').length, due ? 1 : 0, label);
    const writes = ddb.writes.filter((w) => w.input.Key.record_id === 'r');
    assert.equal(writes.length, 1, label);
    assert.equal(writes[0].input.ExpressionAttributeValues[':mr'], due ? 'check' : undefined, label);
  }
});

test('a check request carries the release tag, the record and dry_run', async (t) => {
  quietLogs(t);
  for (const [releaseTag, dryRun] of [['9.1.2', false], [null, true]]) {
    const { ctx } = maintenance({ releaseTag, dryRun });
    const record = live('r1', { verified_at: undefined });
    const ddb = table([record]);
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
  const ddb = table([live('r1', { verified_at: undefined })]);
  await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.equal(bodies(ctx.sqs)[0].release_tag, '');
});

test(`no new request within ${MAINTENANCE_RETRY_DAYS} days of the last one`, async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  const ddb = table([
    live('pending', { verified_at: undefined, maintenance_requested_at: daysAgo(6.9) }),
    faded('pending-retire', { maintenance_requested_at: daysAgo(1) }),
    live('stale', { verified_at: undefined, maintenance_requested_at: daysAgo(7.1) }),
  ]);
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.deepEqual(bodies(ctx.sqs).map((b) => b.record_id), ['stale']);
  assert.equal(stats.decayed, 3, 'in-flight records still decay');
  assert.equal(stats.retireRequested + stats.wouldRetire + stats.deferred, 0);
});

test('checks go never checked first, then re-published, then the oldest check, within checksPerDay', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  const ddb = table([
    live('old-check', { verified_release: '9.1.1', verified_at: daysAgo(80) }),
    live('older-check', { verified_release: '9.1.1', verified_at: daysAgo(85) }),
    live('republished', { graduated_at: daysAgo(1), verified_at: daysAgo(20) }),
    live('new', { verified_at: undefined, graduated_at: daysAgo(3) }),
    live('newer', { verified_at: undefined, graduated_at: daysAgo(1) }),
    live('recent-check', { verified_release: '9.1.1', verified_at: daysAgo(2) }),
  ]);
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
  await decayTable(table(records), 'concerns', { ...FULL, checksPerDay: 20 }, NOW, ctx);
  assert.deepEqual(ctx.sqs.sent.map((m) => m.DelaySeconds), [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 900, 900, 900, 900]);
});

test('retire requests are not delayed and do not shift the check stagger', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  await decayTable(table([faded('gone'), live('a', { verified_at: undefined }), live('b', { verified_at: undefined })]), 'concerns', FULL, NOW, ctx);
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
  const ddb = table([live('r1', { verified_at: undefined })]);
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
  const ddb = table([live('raced', { verified_at: undefined, graduated_at: daysAgo(9) }), live('next', { verified_at: undefined, graduated_at: daysAgo(1) })], (_op, input) => {
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
    const ddb = table([live('unchecked', { verified_at: undefined }), faded('gone')]);
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
  const ddb = table([
    live('r1', { verified_at: undefined, graduated_record_name: 'Not A Slug' }),
    faded('r2', { graduated_record_name: '-leading-dash' }),
    live('x'.repeat(101), { verified_at: undefined }),
  ]);
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.equal(ctx.sqs.sent.length, 0);
  assert.equal(stats.errors, 3);
  assert.equal(stats.decayed, 3, 'each still gets its score write');
  assert.equal(warn.mock.calls.length, 3);
  for (const call of warn.mock.calls) assert.match(call.arguments[0], /^\[decay\] cannot queue maintenance for concerns /);
});

/**
 * Runs passes that log every kind of report and warning line about
 * records in `bucket`, and returns the lines. `name` is a graduated
 * record name the curator could not accept.
 */
async function reportLines(t, bucket, name) {
  const log = quietLogs(t);
  const warn = t.mock.method(console, 'warn', () => {});
  const boom = () => Object.assign(new Error('internal error'), { name: 'InternalServerError' });

  // would-retire, and a record that is not a valid concern record
  await decayTable(table([faded('a', { area_bucket: bucket }), { area_bucket: bucket, record_id: 'h' }]), 'concerns', { ...FULL, retireSkills: false }, NOW, maintenance().ctx);
  // retire-requested, deferred, check-requested, and a record that cannot be queued
  await decayTable(table([
    faded('b', { area_bucket: bucket, updated_at: daysAgo(2000) }),
    faded('c', { area_bucket: bucket }),
    live('d', { area_bucket: bucket, verified_at: undefined }),
    live('e', { area_bucket: bucket, verified_at: undefined, graduated_record_name: name }),
  ]), 'concerns', { ...FULL, maxRetirementsPerDay: 1 }, NOW, maintenance().ctx);
  // a failed write, and a failed send whose claim cannot be released
  const ctx = { ...maintenance().ctx, sqs: fakeSqs([], () => { throw boom(); }) };
  await decayTable(table([live('f', { area_bucket: bucket, verified_at: undefined, graduated_at: daysAgo(300) }), live('g', { area_bucket: bucket })], (_op, input) => {
    if (input.Key.record_id === 'g' || input.UpdateExpression?.startsWith('REMOVE')) throw boom();
    return {};
  }), 'concerns', FULL, NOW, ctx);

  const lines = [...log.mock.calls, ...warn.mock.calls].map((c) => c.arguments[0]);
  for (const kind of ['would-retire', 'retire-requested', 'deferred', 'check-requested', 'cannot queue maintenance', 'write failed', 'send failed', 'could not release']) {
    assert.ok(lines.some((l) => l.startsWith(`[decay] ${kind} `)), `a ${kind} line was logged`);
  }
  assert.ok(lines.some(isDump), 'the invalid record was logged');
  return lines;
}

/** The warning that dumps an invalid record as JSON. */
const isDump = (line) => line.startsWith('[decay] concerns: record without ');

test('values read from the table are JSON-quoted in every report line', async (t) => {
  // area_bucket is chosen by the curator model; this one tries to end the
  // line and forge a second report line.
  const bucket = 'src"\n[decay] would-retire concerns bucket="x" id="y" name="z" score=0.0000 reason=obsolete';
  const name = 'Not A Slug\n[decay] forged';
  const lines = await reportLines(t, bucket, name);

  for (const line of lines) {
    assert.ok(!line.includes('\n'), `one line: ${JSON.stringify(line)}`);
    if (line.includes(' id=') && !isDump(line)) assert.ok(line.includes(` bucket=${JSON.stringify(bucket)} id="`), `bucket quoted: ${JSON.stringify(line)}`);
  }
  assert.ok(lines.some((l) => l.includes(`graduated_record_name ${JSON.stringify(name)} is not`)), 'the rejected name is quoted');
  const report = lines.filter((l) => /^\[decay\] (would-retire|retire-requested|deferred|check-requested) /.test(l));
  assert.equal(report.length, 4);
  const head = ` bucket=${JSON.stringify(bucket)} id="`;
  for (const l of report) {
    assert.ok(l.includes(head), l);
    assert.match(l.slice(l.indexOf(head) + head.length), /^[a-g]" name="skill-[a-g]" /, l);
  }
  for (const l of lines.filter((l) => l.includes('maintenance='))) assert.match(l, / maintenance="[^"\s]+"/);
});

test('report lines strip invisible format and line-separator characters from table values', async (t) => {
  const invisible = [
    0x200b, 0x200c, 0x200d, 0x200e, 0x200f, // zero-width characters and bidi marks
    0x2028, 0x2029, // line and paragraph separators
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embeddings and overrides
    0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner and invisible operators
    0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
    0xfeff, 0x0085, 0x009b, 0x007f, // BOM, NEL, CSI, DEL
  ].map((c) => String.fromCodePoint(c));
  // With the override it would read "src/ok"; the other characters hide
  // between the letters of the tail.
  const bucket = `src/\u202eko ${invisible.join('x')} id="forged"`;
  const name = 'Not\u202eA\u2028Slug';
  const lines = await reportLines(t, bucket, name);

  const shown = JSON.stringify(`src/ko ${'x'.repeat(invisible.length - 1)} id="forged"`);
  for (const line of lines) {
    for (const c of invisible) assert.ok(!line.includes(c), `U+${c.codePointAt(0).toString(16)} in ${JSON.stringify(line)}`);
    if (line.includes(' id=') && !isDump(line)) assert.ok(line.includes(` bucket=${shown} id="`), `bucket shown: ${JSON.stringify(line)}`);
  }
  assert.ok(lines.some((l) => l.includes('graduated_record_name "NotASlug" is not')), 'the rejected name is stripped');
  assert.ok(lines.some((l) => isDump(l) && l.includes(`"area_bucket":${shown}`)), 'the record dump is stripped');
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
  assert.throws(() => loadDecayConfig({ ...base, SKILL_CHECKS_PER_DAY: '0', RETIRE_SKILLS: 'true' }), /CURATOR_QUEUE_URL is required/);
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

// The reviewer's skill.md in this repository: one check per GA release.

const REPO_SKILL = { area_bucket: '#maintenance', record_id: 'repo-skill' };
const repoItem = (fields) => ({ ...REPO_SKILL, ...fields });

test('the first repo skill check creates its item with the claim and is queued ahead of the records', async (t) => {
  quietLogs(t);
  const { ctx, events } = maintenance();
  const ddb = fakeDdb([[live('r1', { verified_at: undefined })]], (_op, input) => { events.push(`write ${input.Key.record_id}`); return {}; });
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);

  assert.deepEqual(events, ['write repo-skill', 'send repo-skill', 'write r1', 'send r1']);
  assert.equal(stats.checksRequested, 2);
  const claim = ddb.writes[0].input;
  assert.deepEqual(claim.Key, REPO_SKILL);
  assert.equal(claim.UpdateExpression, 'SET #mid = :mid, #mra = :now, #mr = :mr');
  assert.equal(claim.ConditionExpression, 'attribute_not_exists(#rid)');
  assert.deepEqual(claim.ExpressionAttributeNames, { '#mid': 'maintenance_id', '#mra': 'maintenance_requested_at', '#mr': 'maintenance_reason', '#rid': 'record_id' });
  const id = `repo_check#valkey-review#repo-skill#${NOW_ISO}`;
  assert.deepEqual(claim.ExpressionAttributeValues, { ':mid': id, ':now': NOW_ISO, ':mr': 'repo_check' });

  const [repo, record] = ctx.sqs.sent;
  assert.deepEqual(JSON.parse(repo.MessageBody), {
    maintenance_id: id,
    reason: 'repo_check',
    reviewer_id: 'valkey-review',
    area_bucket: '#maintenance',
    record_id: 'repo-skill',
    release_tag: '9.1.2',
    dry_run: false,
  });
  assert.equal(repo.DelaySeconds, 0);
  assert.equal(repo.MessageAttributes.reason.StringValue, 'repo_check');
  assert.equal(record.DelaySeconds, 60, 'record checks are staggered after it');
});

test('a repo skill checked at an older release is checked again, in the state the scan read', async (t) => {
  quietLogs(t);
  for (const [fields, condition] of [
    [{ verified_release: '9.1.1', verified_at: daysAgo(40) }, '#vr = :vr AND attribute_not_exists(#mra)'],
    [{ verified_release: '9.1.1', maintenance_requested_at: daysAgo(8) }, '#vr = :vr AND #mra = :mra'],
    [{ maintenance_requested_at: daysAgo(30) }, 'attribute_not_exists(#vr) AND #mra = :mra'],
  ]) {
    const { ctx } = maintenance({ dryRun: true });
    const ddb = fakeDdb([[repoItem(fields)]]);
    await decayTable(ddb, 'concerns', FULL, NOW, ctx);
    const claim = ddb.writes[0].input;
    assert.equal(claim.ConditionExpression, condition);
    if (fields.verified_release) assert.equal(claim.ExpressionAttributeValues[':vr'], fields.verified_release);
    if (fields.maintenance_requested_at) assert.equal(claim.ExpressionAttributeValues[':mra'], fields.maintenance_requested_at);
    assert.deepEqual(Object.keys(claim.ExpressionAttributeNames).sort(), ['#mid', '#mr', '#mra', '#vr']);
    const [body] = bodies(ctx.sqs);
    assert.equal(body.reason, 'repo_check');
    assert.equal(body.dry_run, true);
  }
});

test('the repo skill is checked once per release, and not while a request is in flight', async (t) => {
  quietLogs(t);
  const cases = [
    ['current release', repoItem({ verified_release: '9.1.2' }), {}, false],
    ['current release, recheck_all', repoItem({ verified_release: '9.1.2' }), { recheckAll: true }, true],
    ['in flight', repoItem({ verified_release: '9.1.1', maintenance_requested_at: daysAgo(2) }), { recheckAll: true }, false],
    ['release unknown', repoItem({ verified_release: '9.1.1' }), { releaseTag: null, recheckAll: true }, false],
    ['release unknown, never checked', undefined, { releaseTag: null }, false],
  ];
  for (const [label, item, fields, due] of cases) {
    const { ctx } = maintenance(fields);
    const ddb = fakeDdb([item ? [item] : []]);
    const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
    assert.equal(ctx.sqs.sent.length, due ? 1 : 0, label);
    assert.equal(ddb.writes.length, due ? 1 : 0, label);
    assert.equal(stats.errors, 0, label);
    assert.equal(stats.decayed + stats.deleted, 0, `${label}: the item is never scored or deleted`);
  }
});

test('the repo skill check takes a slot of checksPerDay', async (t) => {
  quietLogs(t);
  const { ctx } = maintenance();
  const ddb = fakeDdb([[repoItem({ verified_release: '9.1.1' }), live('r1', { verified_at: undefined })]]);
  const stats = await decayTable(ddb, 'concerns', { ...FULL, checksPerDay: 1 }, NOW, ctx);
  assert.deepEqual(bodies(ctx.sqs).map((b) => b.reason), ['repo_check']);
  assert.equal(stats.deferred, 1);
});

test('items in reserved buckets are never scored, deleted or queued as records', async (t) => {
  quietLogs(t);
  assert.equal(RESERVED_BUCKET_PREFIX, '#');
  assert.ok(REPO_SKILL_KEY.area_bucket.startsWith(RESERVED_BUCKET_PREFIX), 'the repo skill item is in a reserved bucket');
  assert.ok(isReservedBucket('#maintenance') && isReservedBucket('#'));
  assert.ok(!isReservedBucket('src') && !isReservedBucket('src/#x') && !isReservedBucket(undefined));

  const { ctx } = maintenance();
  const ddb = table([
    // Below the floor, never graduated: a concern record like this is deleted.
    { area_bucket: '#maintenance', record_id: 'other', decay_score: 1, updated_at: daysAgo(400) },
    { area_bucket: '#future', record_id: 'state', decay_score: 1, updated_at: daysAgo(10) },
    // Shaped like graduated records that are due for retirement and a check.
    faded('gone', { area_bucket: '#maintenance' }),
    live('unchecked', { area_bucket: '#x', verified_at: undefined }),
  ]);
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.equal(ddb.writes.length, 0);
  assert.equal(ctx.sqs.sent.length, 0);
  assert.deepEqual(stats, { table: 'concerns', scanned: 5, decayed: 0, deleted: 0, skipped: 0, errors: 0, ...NOTHING_QUEUED });
});

test('no repo skill check without an upstream or with checks off, and the item is left alone', async (t) => {
  quietLogs(t);
  for (const config of [{ ...FULL, upstreamRepos: {} }, { ...FULL, checksPerDay: 0 }]) {
    const { ctx } = maintenance();
    const ddb = fakeDdb([[repoItem({ verified_release: '9.0.0' })]]);
    const stats = await decayTable(ddb, 'concerns', config, NOW, ctx);
    assert.equal(ctx.sqs.sent.length, 0);
    assert.equal(ddb.writes.length, 0);
    assert.equal(stats.scanned, 1);
    assert.equal(stats.errors, 0);
  }
});

test('a failed repo skill send releases its claim', async (t) => {
  quietLogs(t);
  t.mock.method(console, 'warn', () => {});
  const ctx = {
    reviewerId: 'valkey-review', releaseTag: '9.1.2', recheckAll: false, dryRun: false,
    sqs: fakeSqs([], () => { throw new Error('queue unavailable'); }),
  };
  const ddb = fakeDdb([[]]);
  const stats = await decayTable(ddb, 'concerns', FULL, NOW, ctx);
  assert.equal(stats.errors, 1);
  assert.equal(stats.checksRequested, 0);
  const [claim, release] = ddb.writes.map((w) => w.input);
  assert.deepEqual(release.Key, REPO_SKILL);
  assert.equal(release.UpdateExpression, 'REMOVE #mid, #mra, #mr');
  assert.equal(release.ExpressionAttributeValues[':mid'], claim.ExpressionAttributeValues[':mid']);
});

test('a claim left on a record expires by age alone, and a new claim leaves the curator\'s own markers', async (t) => {
  quietLogs(t);
  const old = {
    maintenance_id: `check#valkey-review#r#${daysAgo(8)}`,
    maintenance_reason: 'check',
    maintenance_requested_at: daysAgo(8),
    maintenance_deprecating: 'skill-r',
  };
  const cases = [
    ['every maintenance attribute left, 8 days old', old, true],
    ['id and reason left, request time removed', { maintenance_id: old.maintenance_id, maintenance_reason: 'check' }, true],
    ['request time left, id removed', { maintenance_requested_at: daysAgo(3) }, false],
    ['every maintenance attribute left, 3 days old', { ...old, maintenance_requested_at: daysAgo(3) }, false],
  ];
  for (const [label, fields, due] of cases) {
    for (const record of [live('r', { verified_at: undefined, ...fields }), faded('r', fields)]) {
      const { ctx } = maintenance();
      const ddb = table([record]);
      await decayTable(ddb, 'concerns', FULL, NOW, ctx);
      assert.equal(ctx.sqs.sent.length, due ? 1 : 0, label);
      if (!due) continue;
      const [claim] = claims(ddb).map((w) => w.input);
      assert.ok(claim.ExpressionAttributeValues[':mid'].endsWith(`#r#${NOW_ISO}`), `${label}: a new id`);
      // The claim only SETs; any other maintenance_* attribute stays for the curator.
      assert.ok(!/\bREMOVE\b/.test(claim.UpdateExpression), label);
      assert.deepEqual(
        Object.values(claim.ExpressionAttributeNames).filter((n) => n.startsWith('maintenance_')).sort(),
        ['maintenance_id', 'maintenance_reason', 'maintenance_requested_at'],
        label,
      );
    }
  }
  // The same holds for the repo skill item.
  for (const [fields, due] of [[{ maintenance_id: 'x', maintenance_reason: 'repo_check' }, true], [{ maintenance_requested_at: daysAgo(3) }, false]]) {
    const { ctx } = maintenance();
    await decayTable(fakeDdb([[repoItem({ verified_release: '9.1.1', ...fields })]]), 'concerns', FULL, NOW, ctx);
    assert.equal(ctx.sqs.sent.length, due ? 1 : 0, JSON.stringify(fields));
  }
});
