import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConcernsTools, LIST_LIMIT, recordView } from '../dist/curator/src/tools/concerns-ddb.js';
import { buildCuratorDoneTool } from '../dist/curator/src/tools/done.js';
import {
  assertPlaceholdersMatch, conditionFailed, conditionHolds, fakeDdb, newRun, parse, REINFORCER, transactionCanceled,
} from './helpers.mjs';

function tools(ddb, run = newRun()) {
  const byName = Object.fromEntries(buildConcernsTools({ ddb, table: 'concerns', run }).map((t) => [t.name, t]));
  byName.curator_done = buildCuratorDoneTool(run);
  return { run, ...byName };
}

const record = (id, count, extra = {}) => ({
  area_bucket: 'src',
  record_id: id,
  area: ['src/**'],
  subject: `subject ${id}`,
  concern: 'check it',
  context: '',
  reinforcement_count: count,
  decay_score: 1,
  updated_at: '2026-01-01T00:00:00.000Z',
  ...extra,
});

test('list_concerns reads every page and sorts before truncating', async () => {
  const page1 = Array.from({ length: 15 }, (_, i) => record(`a${i}`, 1, { reinforcers: new Set(['x#r#1']) }));
  const page2 = Array.from({ length: 15 }, (_, i) => record(`b${i}`, i === 14 ? 9 : 2));
  const ddb = fakeDdb({
    QueryCommand: (input) => (input.ExclusiveStartKey
      ? { Items: page2 }
      : { Items: page1, LastEvaluatedKey: { area_bucket: 'src', record_id: 'a14' } }),
  });
  const { list_concerns } = tools(ddb);
  const out = parse(await list_concerns.invoke({ area_bucket: 'src' }));

  assert.equal(ddb.calls.length, 2);
  assert.equal(out.total, 30);
  assert.equal(out.records.length, LIST_LIMIT);
  assert.equal(out.records[0].record_id, 'b14', 'the most reinforced record comes first even though it was on the last page');
  assert.ok(out.records.slice(1, 15).every((r) => r.reinforcement_count === 2));
  const fromPage1 = out.records.find((r) => r.record_id.startsWith('a'));
  assert.equal(fromPage1.distinct_reinforcers, 1);
  assert.equal(fromPage1.reinforcers, undefined, 'reinforcer logins are not shown to the model');
});

test('bump_concern adds the reinforcer and the count in one conditional update', async () => {
  const ddb = fakeDdb({
    UpdateCommand: (input) => ({ Attributes: record(input.Key.record_id, 4, { reinforcers: input.ExpressionAttributeValues[':rset'] }) }),
  });
  const { run, bump_concern, create_concern } = tools(ddb);
  const out = parse(await bump_concern.invoke({ area_bucket: 'src', record_id: 'r1' }));

  assert.equal(out.ok, true);
  assert.equal(out.reinforced, true);
  assert.equal(out.eligible_for_graduation, true);
  const { input } = ddb.calls[0];
  assert.match(input.UpdateExpression, /ADD #rc :one, #rs :rset/);
  assert.match(input.ConditionExpression, /attribute_exists\(#rid\) AND NOT contains\(#rs, :r\)/);
  assert.equal(input.ExpressionAttributeValues[':r'], REINFORCER);
  assert.deepEqual([...input.ExpressionAttributeValues[':rset']], [REINFORCER]);
  assertPlaceholdersMatch(input);
  assert.deepEqual(run.reinforced, { areaBucket: 'src', recordId: 'r1' });

  const second = parse(await create_concern.invoke({
    area_bucket: 'src',
    record: { area: ['src/x.c'], subject: 'another', concern: 'c', context: '' },
  }));
  assert.equal(second.ok, false);
  assert.match(second.error, /already changed the concerns store/);
});

test('a repeat reinforcer is a reported no-op and frees the write', async () => {
  const ddb = fakeDdb({
    UpdateCommand: () => { throw conditionFailed(); },
    GetCommand: () => ({ Item: record('r1', 2, { reinforcers: new Set([REINFORCER]) }) }),
    PutCommand: () => ({}),
  });
  const { run, bump_concern, create_concern } = tools(ddb);
  const out = parse(await bump_concern.invoke({ area_bucket: 'src', record_id: 'r1' }));

  assert.equal(out.ok, true);
  assert.equal(out.reinforced, false);
  assert.equal(out.record.reinforcement_count, 2);
  assert.equal(run.reinforced, null, 'a no-op does not make the record eligible to graduate');
  assert.deepEqual(run.actions, []);

  const created = parse(await create_concern.invoke({
    area_bucket: 'src',
    record: { area: ['src/x.c'], subject: 'another', concern: 'c', context: '' },
  }));
  assert.equal(created.ok, true);
});

test('bump_concern on a missing record says so', async () => {
  const ddb = fakeDdb({
    UpdateCommand: () => { throw conditionFailed(); },
    GetCommand: () => ({}),
  });
  const { bump_concern } = tools(ddb);
  const out = parse(await bump_concern.invoke({ area_bucket: 'src', record_id: 'nope' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /does not exist/);
});

test('bump_concern with context appends it, conditioned on the context it read', async () => {
  const ddb = fakeDdb({
    GetCommand: () => ({ Item: record('r1', 1, { context: 'old reason' }) }),
    UpdateCommand: (input) => ({ Attributes: record('r1', 2, { context: input.ExpressionAttributeValues[':ctx'] }) }),
  });
  const { bump_concern } = tools(ddb);
  const out = parse(await bump_concern.invoke({ area_bucket: 'src', record_id: 'r1', context_addition: 'new reason' }));

  assert.equal(out.ok, true);
  const update = ddb.calls.find((c) => c.op === 'UpdateCommand').input;
  assert.equal(update.ExpressionAttributeValues[':ctx'], 'old reason\n\nnew reason');
  assert.match(update.ConditionExpression, /#ctx = :oldCtx/);
  assertPlaceholdersMatch(update);
});

test('create_concern records the creator as the first reinforcer', async () => {
  const ddb = fakeDdb({ PutCommand: () => ({}) });
  const { create_concern } = tools(ddb);
  const out = parse(await create_concern.invoke({
    area_bucket: 'src',
    record: { area: ['src/a.c', 'src/a.c'], subject: 's', concern: 'c', context: '' },
  }));

  assert.equal(out.ok, true);
  const { Item, ConditionExpression, ExpressionAttributeNames } = ddb.calls[0].input;
  assert.equal(Item.reinforcement_count, 1);
  assert.deepEqual([...Item.reinforcers], [REINFORCER]);
  assert.deepEqual(Item.area, ['src/a.c']);
  assert.equal(Item.record_id, out.record_id);
  assert.equal(ConditionExpression, 'attribute_not_exists(#rid)');
  assert.deepEqual(ExpressionAttributeNames, { '#rid': 'record_id' });
});

test('update_concern needs a change and does not touch the reinforcement fields', async () => {
  const ddb = fakeDdb({
    GetCommand: () => ({ Item: record('r1', 3) }),
    UpdateCommand: (input) => ({ Attributes: record('r1', 3, { area: input.ExpressionAttributeValues[':area'] }) }),
  });
  const { update_concern } = tools(ddb);
  const empty = parse(await update_concern.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(empty.ok, false);

  const out = parse(await update_concern.invoke({ area_bucket: 'src', record_id: 'r1', area: ['src/a.c', 'src/b.c'] }));
  assert.equal(out.ok, true);
  const update = ddb.calls.find((c) => c.op === 'UpdateCommand').input;
  assert.doesNotMatch(update.UpdateExpression, /#rc|#ua|#ds/);
  assertPlaceholdersMatch(update);
});

/**
 * A concerns table holding `items`. GetCommand returns copies, so a later
 * change to the table does not reach what the tool read. `afterReads`
 * runs once both records of a merge have been read, to stand in for
 * another run writing in between. TransactWriteCommand evaluates every
 * item's condition against the table and cancels like DynamoDB does.
 */
function concernsTable(items, { afterReads } = {}) {
  const table = new Map(items.map((item) => [item.record_id, item]));
  let reads = 0;
  const ddb = fakeDdb({
    GetCommand: (input) => {
      const item = table.get(input.Key.record_id);
      reads += 1;
      if (reads === 2) afterReads?.(table);
      return { Item: item && structuredClone(item) };
    },
    TransactWriteCommand: (input) => {
      const codes = input.TransactItems.map((t) => {
        const op = t.Update ?? t.Delete;
        return conditionHolds(table.get(op.Key.record_id), op) ? 'None' : 'ConditionalCheckFailed';
      });
      if (codes.some((code) => code !== 'None')) throw transactionCanceled(codes);
      return {};
    },
  });
  return { ddb, table };
}

const MERGED = { area: ['src/**'], subject: 'merged', concern: 'c', context: '' };

async function mergeInto(ddb, run = newRun()) {
  const t = tools(ddb, run);
  const out = parse(await t.merge_concerns.invoke({ area_bucket: 'src', target_record_id: 'tgt1', source_record_id: 'src1', merged: MERGED }));
  const write = ddb.calls.find((c) => c.op === 'TransactWriteCommand');
  const [update, del] = write ? write.input.TransactItems : [];
  return { out, run: t.run, update: update?.Update, del: del?.Delete };
}

test('merge_concerns folds the source into the target in one transaction', async () => {
  const { ddb } = concernsTable([
    record('tgt1', 3, { reinforcers: new Set(['c#r#3']) }),
    record('src1', 2, { reinforcers: new Set(['a#r#1', 'b#r#2']), updated_at: '2026-02-01T00:00:00.000Z' }),
  ]);
  const { out, run, update, del } = await mergeInto(ddb);

  assert.equal(out.ok, true);
  assert.equal(out.reinforcement_count, 5);
  assert.equal(out.eligible_for_graduation, true);
  assert.deepEqual(ddb.ops(), ['GetCommand', 'GetCommand', 'TransactWriteCommand'], 'the count comes from the reads, not a re-read');
  assert.match(update.UpdateExpression, /#rc = :rc/);
  assert.match(update.UpdateExpression, / ADD #rs :rset$/);
  assert.equal(update.ExpressionAttributeValues[':rc'], 5);
  assert.deepEqual([...update.ExpressionAttributeValues[':rset']].sort(), ['a#r#1', 'b#r#2']);
  assertPlaceholdersMatch(update);
  assert.match(del.ConditionExpression, /attribute_not_exists\(#grn\)/);
  assert.equal(del.ExpressionAttributeValues[':readRc'], 2);
  assert.equal(del.ExpressionAttributeValues[':readUa'], '2026-02-01T00:00:00.000Z');
  assertPlaceholdersMatch(del);
  assert.deepEqual(run.reinforced, { areaBucket: 'src', recordId: 'tgt1' });
});

test('merge_concerns conditions the target on the state it read', async () => {
  const { ddb } = concernsTable([record('tgt1', 3, { edited_at: '2026-01-02T00:00:00.000Z' }), record('src1', 1)]);
  const { out, update } = await mergeInto(ddb);

  assert.equal(out.ok, true);
  for (const clause of ['attribute_exists(#rid)', '#rc = :readRc', '#ua = :readUa', '#ea = :readEa']) {
    assert.ok(update.ConditionExpression.split(' AND ').includes(clause), clause);
  }
  assert.equal(update.ExpressionAttributeValues[':readRc'], 3);
  assert.equal(update.ExpressionAttributeValues[':readUa'], '2026-01-01T00:00:00.000Z');
  assert.equal(update.ExpressionAttributeValues[':readEa'], '2026-01-02T00:00:00.000Z');
  assertPlaceholdersMatch(update);
});

test('a reinforcement or edit on the target after the read cancels the merge', async () => {
  const concurrent = {
    bump: (table) => table.set('tgt1', { ...table.get('tgt1'), reinforcement_count: 4, updated_at: '2026-03-01T00:00:00.000Z' }),
    edit: (table) => table.set('tgt1', { ...table.get('tgt1'), context: 'new reason', edited_at: '2026-03-01T00:00:00.000Z' }),
  };
  for (const [name, afterReads] of Object.entries(concurrent)) {
    const { ddb, table } = concernsTable([record('tgt1', 3), record('src1', 1)], { afterReads });
    const { out, run } = await mergeInto(ddb);

    assert.equal(out.ok, false, name);
    assert.match(out.error, /target tgt1 changed while the merge ran, so nothing was merged/, name);
    assert.match(out.error, /read both records again with get_concern and retry/, name);
    assert.ok(table.has('src1'), `${name}: the source is kept`);
    assert.equal(run.reinforced, null, `${name}: a cancelled merge makes nothing eligible to graduate`);
    assert.equal(run.take('concern_write', 'retry'), null, `${name}: the cancelled merge freed the write`);
  }
});

test('a change to the source after the read names the source', async () => {
  const { ddb } = concernsTable([record('tgt1', 3), record('src1', 1)], {
    afterReads: (table) => table.set('src1', { ...table.get('src1'), graduated_record_name: 'skill-a' }),
  });
  const { out } = await mergeInto(ddb);
  assert.equal(out.ok, false);
  assert.match(out.error, /source src1 changed while the merge ran/);
});

test('a person who reinforced both records counts once in the merged count', async () => {
  const { ddb } = concernsTable([
    record('tgt1', 3, { reinforcers: new Set(['a#r#1', 'b#r#2', 'c#r#3']) }),
    record('src1', 2, { reinforcers: new Set(['a#r#1', 'd#r#4']) }),
  ]);
  const { out, update } = await mergeInto(ddb);

  assert.equal(out.ok, true);
  assert.equal(out.reinforcement_count, 4, 'a#r#1 reinforced both and counts once');
  assert.equal(out.eligible_for_graduation, true);
  assert.equal(update.ExpressionAttributeValues[':rc'], 4);
});

test('reinforcements without a reinforcers key are counted in full', async () => {
  const cases = [
    // Neither record kept a set: the plain sum.
    { target: record('tgt1', 2), source: record('src1', 1), expected: 3 },
    // Three of the target's five reinforcements predate the set; only a#r#1 is known to be shared.
    {
      target: record('tgt1', 5, { reinforcers: new Set(['a#r#1', 'b#r#2']) }),
      source: record('src1', 2, { reinforcers: new Set(['a#r#1', 'e#r#5']) }),
      expected: 6,
    },
  ];
  for (const { target, source, expected } of cases) {
    const { ddb } = concernsTable([target, source]);
    const { out, update } = await mergeInto(ddb, newRun({ graduationThreshold: 10 }));
    assert.equal(out.ok, true);
    assert.equal(out.reinforcement_count, expected);
    assert.equal(out.eligible_for_graduation, false);
    assert.equal(update.ExpressionAttributeValues[':rc'], expected);
    if (!source.reinforcers) assert.doesNotMatch(update.UpdateExpression, /ADD/);
    assertPlaceholdersMatch(update);
  }
});

test('merge_concerns refuses a graduated source and reports a cancelled transaction', async () => {
  const graduated = fakeDdb({
    GetCommand: (input) => ({ Item: record(input.Key.record_id, 4, input.Key.record_id === 'src1' ? { graduated_record_name: 'skill-a' } : {}) }),
  });
  const merged = { area: ['src/**'], subject: 'm', concern: 'c', context: '' };
  const first = parse(await tools(graduated).merge_concerns.invoke({ area_bucket: 'src', target_record_id: 't', source_record_id: 'src1', merged }));
  assert.equal(first.ok, false);
  assert.match(first.error, /make it the target/);

  const racing = fakeDdb({
    GetCommand: (input) => ({ Item: record(input.Key.record_id, 1) }),
    TransactWriteCommand: () => { throw transactionCanceled(); },
  });
  const { run, merge_concerns } = tools(racing);
  const second = parse(await merge_concerns.invoke({ area_bucket: 'src', target_record_id: 't', source_record_id: 's', merged }));
  assert.equal(second.ok, false);
  assert.match(second.error, /a concurrent write cancelled the transaction, so nothing was merged; read both records again/);
  assert.equal(run.take('concern_write', 'next'), null, 'the failed merge freed the write');
});

test('merge_concerns rejects merging a record into itself', async () => {
  const { merge_concerns } = tools(fakeDdb({}));
  const out = parse(await merge_concerns.invoke({
    area_bucket: 'src', target_record_id: 'x', source_record_id: 'x',
    merged: { area: ['src/**'], subject: 's', concern: 'c', context: '' },
  }));
  assert.equal(out.ok, false);
});

test('delete_concern keeps graduated records', async () => {
  const ddb = fakeDdb({
    DeleteCommand: () => { throw conditionFailed(); },
    GetCommand: () => ({ Item: record('r1', 5, { graduated_record_name: 'skill-a' }) }),
  });
  const out = parse(await tools(ddb).delete_concern.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /graduated as skill "skill-a"/);
  assertPlaceholdersMatch(ddb.calls[0].input);
});

test('a submitted review (resolution) can only bump', async () => {
  const ddb = fakeDdb({ UpdateCommand: () => ({ Attributes: record('r1', 2) }) });
  const t = tools(ddb, newRun({ kind: 'resolution' }));
  const created = parse(await t.create_concern.invoke({
    area_bucket: 'src', record: { area: ['src/**'], subject: 's', concern: 'c', context: '' },
  }));
  assert.equal(created.ok, false);
  const edit = parse(await t.bump_concern.invoke({ area_bucket: 'src', record_id: 'r1', context_addition: 'why' }));
  assert.equal(edit.ok, false);
  const bumped = parse(await t.bump_concern.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(bumped.ok, true);
});

test('curator_done ends the run and later tools are refused', async () => {
  const t = tools(fakeDdb({}));
  const done = parse(await t.curator_done.invoke({ decision: 'dropped', summary: 'noise' }));
  assert.equal(done.ok, true);
  assert.deepEqual(t.run.done, { decision: 'dropped', summary: 'noise' });
  const after = parse(await t.bump_concern.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(after.ok, false);
  assert.match(after.error, /already ended/);
  const again = parse(await t.curator_done.invoke({ decision: 'noop', summary: 'x' }));
  assert.equal(again.ok, false);
});

test('every concerns tool refuses a reserved area_bucket without touching the table', async () => {
  const ddb = fakeDdb({});
  const t = tools(ddb);
  const bucket = '#maintenance';
  const concern = { area: ['src/**'], subject: 's', concern: 'c', context: '' };
  const calls = {
    list_concerns: { area_bucket: bucket },
    get_concern: { area_bucket: bucket, record_id: 'repo-skill' },
    create_concern: { area_bucket: bucket, record: concern },
    bump_concern: { area_bucket: bucket, record_id: 'repo-skill' },
    update_concern: { area_bucket: bucket, record_id: 'repo-skill', context_addition: 'why' },
    merge_concerns: { area_bucket: bucket, target_record_id: 'repo-skill', source_record_id: 'x', merged: concern },
    delete_concern: { area_bucket: bucket, record_id: 'repo-skill' },
  };
  for (const [name, input] of Object.entries(calls)) {
    const out = parse(await t[name].invoke(input));
    assert.equal(out.ok, false, name);
    assert.match(out.error, new RegExp(`^${name}: area_bucket values starting with "#" are reserved`), name);
  }
  assert.equal(ddb.calls.length, 0);
  assert.equal(t.run.take('concern_write', 'next'), null, 'a refused write does not use the slot');
});

test('list_concerns never returns an item from a reserved bucket', async () => {
  const ddb = fakeDdb({
    QueryCommand: () => ({ Items: [record('r1', 1), { area_bucket: '#maintenance', record_id: 'repo-skill', verified_release: '9.1.2' }] }),
  });
  const out = parse(await tools(ddb).list_concerns.invoke({ area_bucket: 'src' }));
  assert.equal(out.total, 1);
  assert.deepEqual(out.records.map((r) => r.record_id), ['r1']);
});

/** A graduated record carrying everything the release check and the decay job keep on it. */
const checked = (id, count, extra = {}) => record(id, count, {
  graduated_record_name: `skill-${id}`,
  graduated_at: '2026-02-01T00:00:00.000Z',
  verified_release: '9.1.2',
  verified_at: '2026-03-01T00:00:00.000Z',
  verified_sha: 'a'.repeat(40),
  verified_ref: `unstable@${'a'.repeat(12)}`,
  check_outcome: 'suspect',
  check_note: '1 of 9 names missing at unstable@aaaaaaaaaaaa: `emptyDB`',
  stale_names: new Set(['emptyDB', 'dictScan']),
  stale_since: '2026-03-01T00:00:00.000Z',
  audit_names: new Set(['src/server.c', 'emptyDB']),
  ignored_names: new Set(['VM_Foo']),
  pending_revision: { verdict: 'revise', summary: 'model prose', edits: [] },
  previous_skill_md: '---\nname: old\n---\nold body',
  revised_at: '2026-03-01T00:00:00.000Z',
  obsolete_release: '9.1.2',
  skill_generation: 2,
  previous_record_name: 'skill-old',
  maintenance_id: 'check#valkey-review#r1#2026-03-01T00:00:00.000Z',
  maintenance_requested_at: '2026-03-01T00:00:00.000Z',
  maintenance_reason: 'check',
  maintenance_deprecating: `skill-${id}`,
  ...extra,
});

test('recordView shows a graduated record\'s skill state and hides the check\'s own attributes', () => {
  const view = recordView(checked('r1', 5));
  assert.equal(view.skill_state, 'live');
  assert.equal(view.graduated_record_name, 'skill-r1');
  assert.equal(view.verified_release, '9.1.2');
  assert.equal(view.verified_at, '2026-03-01T00:00:00.000Z');
  assert.equal(view.check_outcome, 'suspect');
  assert.match(view.check_note, /`emptyDB`/);
  assert.deepEqual(view.stale_names, ['dictScan', 'emptyDB'], 'a string set is shown as a sorted list');
  assert.equal(view.retired_reason, undefined);
  for (const hidden of [
    'audit_names', 'ignored_names', 'verified_sha', 'verified_ref', 'pending_revision', 'previous_skill_md', 'revised_at',
    'stale_since', 'obsolete_release', 'skill_generation', 'previous_record_name',
    'maintenance_id', 'maintenance_requested_at', 'maintenance_reason', 'maintenance_deprecating',
  ]) {
    assert.ok(!(hidden in view), hidden);
  }
  const text = JSON.stringify(view);
  assert.doesNotMatch(text, /model prose|old body|VM_Foo|maintenance/);

  const retired = recordView(checked('r2', 5, { retired_at: '2026-04-01T00:00:00.000Z', retired_reason: 'decayed' }));
  assert.equal(retired.skill_state, 'retired');
  assert.equal(retired.retired_reason, 'decayed');

  const never = recordView(record('r3', 2, { retired_at: 'stray', check_note: 'stray' }));
  for (const field of ['graduated_record_name', 'skill_state', 'retired_reason', 'check_note', 'stale_names']) {
    assert.ok(!(field in never), `a record that never graduated has no ${field}`);
  }
});

test('list_concerns puts records with a retired skill after the live ones', async () => {
  const ddb = fakeDdb({
    QueryCommand: () => ({
      Items: [
        checked('tomb', 9, { retired_at: '2026-04-01T00:00:00.000Z', retired_reason: 'decayed' }),
        record('plain', 1),
        checked('live', 4),
        checked('tomb2', 2, { retired_at: '2026-04-01T00:00:00.000Z', retired_reason: 'operator' }),
      ],
    }),
  });
  const out = parse(await tools(ddb).list_concerns.invoke({ area_bucket: 'src' }));
  assert.deepEqual(out.records.map((r) => r.record_id), ['live', 'plain', 'tomb', 'tomb2']);
  assert.deepEqual(out.records.map((r) => r.skill_state), ['live', undefined, 'retired', 'retired']);
});

test('update_concern marks the run as having edited a graduated record, and only a graduated one', async () => {
  for (const [name, item, expected] of [
    ['graduated', checked('r1', 5), { areaBucket: 'src', recordId: 'r1' }],
    ['never graduated', record('r1', 5), null],
  ]) {
    const ddb = fakeDdb({
      GetCommand: () => ({ Item: item }),
      UpdateCommand: (input) => ({ Attributes: { ...item, context: input.ExpressionAttributeValues[':ctx'] } }),
    });
    const t = tools(ddb);
    const out = parse(await t.update_concern.invoke({ area_bucket: 'src', record_id: 'r1', context_addition: 'intentional because' }));
    assert.equal(out.ok, true, name);
    assert.deepEqual(t.run.edited, expected, name);
    assert.equal(t.run.reinforced, null, `${name}: an edit is not a reinforcement`);
  }

  const failed = fakeDdb({ GetCommand: () => ({ Item: checked('r1', 5) }), UpdateCommand: () => { throw conditionFailed(); } });
  const t = tools(failed);
  const out = parse(await t.update_concern.invoke({ area_bucket: 'src', record_id: 'r1', context_addition: 'why' }));
  assert.equal(out.ok, false);
  assert.equal(t.run.edited, null, 'an edit that did not land marks nothing');
});
