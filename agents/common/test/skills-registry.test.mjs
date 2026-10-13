import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deprecateSkill, getSkillByName, isRetiredStatus, loadSkills, SkillRetiredError, STATUS_REASON_MAX_CHARS, upsertSkill, withFrontmatter,
} from '../src/skills-registry.ts';

/**
 * Minimal stand-in for AgentRegistryControlClient: routes by command
 * class name. `looseNameFilter` makes the name filter a substring match,
 * since the service does not document it as exact. `statusReplies`
 * answers successive status updates; an Error entry is thrown.
 */
function fakeClient(records, { pageSize = 2, looseNameFilter = false, statusReplies = [] } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      const op = command.constructor.name;
      const input = command.input;
      calls.push({ op, input });
      if (op === 'ListRegistryRecordsCommand') {
        const byName = input.filters?.find((f) => f.name === 'name')?.values[0];
        const nameMatches = (name) => !byName || (looseNameFilter ? name.includes(byName) : name === byName);
        const matching = records.filter((r) => r.recordType === 'SKILL' && nameMatches(r.name));
        const start = Number(input.nextToken ?? 0);
        const page = matching.slice(start, start + pageSize);
        const next = start + pageSize < matching.length ? String(start + pageSize) : undefined;
        return { registryRecords: page, nextToken: next };
      }
      if (op === 'GetRegistryRecordCommand') {
        const r = records.find((x) => x.recordId === input.recordId);
        return { ...r, descriptors: { agentSkillsDefinition: { additionalData: { skillMd: { data: r.md } } } } };
      }
      if (op === 'CreateRegistryRecordCommand') return { recordArn: 'arn:new', status: 'CREATING' };
      if (op === 'UpdateRegistryRecordCommand') return { recordArn: 'arn:existing', status: 'UPDATING' };
      if (op === 'UpdateRegistryRecordStatusCommand') {
        const reply = statusReplies.shift() ?? { status: input.status };
        if (reply instanceof Error) throw reply;
        return { recordId: input.recordId, ...reply };
      }
      throw new Error(`unexpected ${op}`);
    },
  };
}

const rec = (recordId, status, updated, md = `---\nname: ${recordId}\n---\nbody`, name = recordId) => ({
  recordId, name, recordArn: `arn:${recordId}`, recordType: 'SKILL', status, md, updatedAt: new Date(updated),
});

const serviceError = (name) => Object.assign(new Error(name), { name });

const writes = (client) => client.calls.filter((c) => c.op === 'CreateRegistryRecordCommand' || c.op === 'UpdateRegistryRecordCommand');

test('withFrontmatter keeps existing frontmatter and adds one otherwise', () => {
  const md = '---\nname: x\n---\nbody';
  assert.equal(withFrontmatter('x', 'd', md), md);
  assert.equal(
    withFrontmatter('lock-order', 'Two\nlines  here', '# Title'),
    '---\nname: "lock-order"\ndescription: "Two lines here"\n---\n\n# Title',
  );
});

test('loadSkills follows pagination and drops records that are not ready or retired', async () => {
  const client = fakeClient([
    rec('a', 'APPROVED', '2026-10-01'), rec('b', 'DRAFT', '2026-10-03'), rec('c', 'DEPRECATED', '2026-10-04'),
    rec('d', 'CREATING', '2026-10-05'), rec('e', 'UPDATING', '2026-10-02'), rec('f', 'REJECTED', '2026-10-06'),
  ]);
  const { skills, skipped } = await loadSkills(client, 'reg', 10);
  assert.deepEqual(skills.map((s) => s.name), ['b', 'e', 'a']);
  assert.equal(skipped, 0);
});

test('loadSkills keeps the most recently updated records when over the limit and reports the rest', async () => {
  const client = fakeClient([rec('old', 'DRAFT', '2026-01-01'), rec('new', 'DRAFT', '2026-10-01'), rec('mid', 'DRAFT', '2026-05-01')]);
  const { skills, skipped } = await loadSkills(client, 'reg', 2);
  assert.deepEqual(skills.map((s) => s.name), ['new', 'mid']);
  assert.equal(skipped, 1);
});

test('upsertSkill updates the record with the same name instead of creating a duplicate', async () => {
  const client = fakeClient([rec('lock-order', 'APPROVED', '2026-10-01')]);
  const out = await upsertSkill(client, 'reg', { name: 'lock-order', description: 'd', skillMd: '# body' });
  assert.equal(out.action, 'updated');
  assert.equal(client.calls.filter((c) => c.op === 'CreateRegistryRecordCommand').length, 0);
  const update = client.calls.find((c) => c.op === 'UpdateRegistryRecordCommand').input;
  assert.equal(update.recordId, 'lock-order');
  assert.match(update.descriptors.optionalValue.agentSkillsDefinition.optionalValue.additionalData.optionalValue.skillMd.optionalValue.data.optionalValue, /^---\n/);
});

test('upsertSkill creates a SKILL record with frontmatter when no record has the name', async () => {
  const client = fakeClient([]);
  const out = await upsertSkill(client, 'reg', { name: 'new-skill', description: 'd', skillMd: '# body' });
  assert.equal(out.action, 'created');
  const create = client.calls.find((c) => c.op === 'CreateRegistryRecordCommand').input;
  assert.equal(create.recordType, 'SKILL');
  assert.match(create.descriptors.agentSkillsDefinition.additionalData.skillMd.data, /^---\nname: "new-skill"/);
});

test('upsertSkill rejects markdown over the registry limit before calling the service', async () => {
  const client = fakeClient([]);
  await assert.rejects(upsertSkill(client, 'reg', { name: 'big', description: 'd', skillMd: 'x'.repeat(102_400) }), /registry limit/);
  assert.equal(client.calls.length, 0);
});

test('loadSkills stops at the character budget and reports what it left out', async () => {
  const big = (id, updated) => rec(id, 'DRAFT', updated, `---\nname: ${id}\n---\n` + 'x'.repeat(1000));
  const client = fakeClient([big('new', '2026-10-03'), big('mid', '2026-10-02'), big('old', '2026-10-01')]);
  const { skills, skipped } = await loadSkills(client, 'reg', 10, undefined, 2100);
  assert.deepEqual(skills.map((s) => s.name), ['new', 'mid']);
  assert.equal(skipped, 1);
});

test('only DEPRECATED and REJECTED count as retired', () => {
  assert.deepEqual(
    ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'UPDATING', 'CREATING', 'UPDATE_FAILED', 'DEPRECATED', 'REJECTED', undefined].filter(isRetiredStatus),
    ['DEPRECATED', 'REJECTED'],
  );
});

for (const status of ['DEPRECATED', 'REJECTED']) {
  test(`upsertSkill refuses a ${status} record and writes nothing`, async () => {
    const client = fakeClient([rec('lock-order', status, '2026-10-01')]);
    const err = await upsertSkill(client, 'reg', { name: 'lock-order', description: 'd', skillMd: '# body' }).then(
      () => assert.fail('expected SkillRetiredError'),
      (e) => e,
    );
    assert.ok(err instanceof SkillRetiredError);
    assert.equal(err.name, 'SkillRetiredError');
    assert.deepEqual([err.skillName, err.recordId, err.status], ['lock-order', 'lock-order', status]);
    assert.deepEqual(writes(client), []);
  });

  test(`upsertSkill with updateOnly also refuses a ${status} record`, async () => {
    const client = fakeClient([rec('lock-order', status, '2026-10-01')]);
    await assert.rejects(
      upsertSkill(client, 'reg', { name: 'lock-order', description: 'd', skillMd: '# body' }, { updateOnly: true }),
      { name: 'SkillRetiredError' },
    );
    assert.deepEqual(writes(client), []);
  });
}

test('upsertSkill updates the live record when a retired one shares its name', async () => {
  for (const order of [['old', 'live'], ['live', 'old']]) {
    const byId = { old: rec('old', 'DEPRECATED', '2026-10-05', undefined, 'lock-order'), live: rec('live', 'DRAFT', '2026-10-01', undefined, 'lock-order') };
    const client = fakeClient(order.map((id) => byId[id]));
    const out = await upsertSkill(client, 'reg', { name: 'lock-order', description: 'd', skillMd: '# body' });
    assert.equal(out.action, 'updated');
    assert.deepEqual(writes(client).map((c) => [c.op, c.input.recordId]), [['UpdateRegistryRecordCommand', 'live']]);
  }
});

test('upsertSkill with updateOnly updates an existing record', async () => {
  const client = fakeClient([rec('lock-order', 'DRAFT', '2026-10-01')]);
  const out = await upsertSkill(client, 'reg', { name: 'lock-order', description: 'd', skillMd: '# body' }, { updateOnly: true });
  assert.equal(out.action, 'updated');
  assert.deepEqual(writes(client).map((c) => c.op), ['UpdateRegistryRecordCommand']);
});

test('upsertSkill with updateOnly never creates a missing record', async () => {
  const client = fakeClient([rec('other', 'DRAFT', '2026-10-01')]);
  await assert.rejects(
    upsertSkill(client, 'reg', { name: 'lock-order', description: 'd', skillMd: '# body' }, { updateOnly: true }),
    /no skill record named "lock-order" to update/,
  );
  assert.deepEqual(writes(client), []);
});

test('getSkillByName returns only the record with exactly that name, with its markdown', async () => {
  const client = fakeClient([
    rec('a', 'DRAFT', '2026-10-01', '# lock-order-v2', 'lock-order-v2'),
    rec('b', 'APPROVED', '2026-10-02', '# lock-order', 'lock-order'),
    rec('c', 'DRAFT', '2026-10-03', '# x', 'old-lock-order'),
  ], { looseNameFilter: true });
  const skill = await getSkillByName(client, 'reg', 'lock-order');
  assert.deepEqual(skill, { recordId: 'b', recordArn: 'arn:b', name: 'lock-order', description: '', status: 'APPROVED', skillMd: '# lock-order' });
  assert.equal(await getSkillByName(client, 'reg', 'lock'), null);
  assert.deepEqual(client.calls.filter((c) => c.op === 'GetRegistryRecordCommand').map((c) => c.input.recordId), ['b']);
});

test('getSkillByName returns a retired record, and prefers a live one with the same name', async () => {
  const retired = rec('old', 'DEPRECATED', '2026-10-05', '# old body', 'lock-order');
  assert.equal((await getSkillByName(fakeClient([retired]), 'reg', 'lock-order')).status, 'DEPRECATED');
  assert.equal((await getSkillByName(fakeClient([retired]), 'reg', 'lock-order')).skillMd, '# old body');
  const both = fakeClient([retired, rec('live', 'UPDATING', '2026-10-01', '# live body', 'lock-order')]);
  assert.equal((await getSkillByName(both, 'reg', 'lock-order')).recordId, 'live');
});

test('getSkillByName passes the abort signal to every call', async () => {
  const signals = [];
  const client = fakeClient([rec('lock-order', 'DRAFT', '2026-10-01')]);
  const send = client.send.bind(client);
  client.send = (command, opts) => { signals.push(opts?.abortSignal); return send(command, opts); };
  const abortSignal = new AbortController().signal;
  await getSkillByName(client, 'reg', 'lock-order', abortSignal);
  assert.deepEqual(signals, [abortSignal, abortSignal]);
});

test('deprecateSkill sets DEPRECATED with the reason trimmed to the limit', async () => {
  const client = fakeClient([]);
  const reason = `  valkey-reviewer: retired (decayed) 2026-10-13; ${'x'.repeat(400)}  `;
  assert.equal(await deprecateSkill(client, 'reg', 'rec-1', reason), 'DEPRECATED');
  const [call] = client.calls;
  assert.equal(call.op, 'UpdateRegistryRecordStatusCommand');
  assert.equal(call.input.registryId, 'reg');
  assert.equal(call.input.recordId, 'rec-1');
  assert.equal(call.input.status, 'DEPRECATED');
  assert.equal(call.input.statusReason.length, STATUS_REASON_MAX_CHARS);
  assert.equal(STATUS_REASON_MAX_CHARS, 256);
  assert.ok(call.input.statusReason.startsWith('valkey-reviewer: retired (decayed) 2026-10-13; x'));
});

test('deprecateSkill does not cut a reason in the middle of a character', async () => {
  const client = fakeClient([]);
  // U+1F512 takes two code units, at 255 and 256: a plain cut at 256 would keep half of it.
  await deprecateSkill(client, 'reg', 'rec-1', `${'x'.repeat(STATUS_REASON_MAX_CHARS - 1)}\u{1F512} locked`);
  const sent = client.calls[0].input.statusReason;
  assert.ok(sent.isWellFormed(), 'no lone surrogate');
  assert.equal(sent, 'x'.repeat(STATUS_REASON_MAX_CHARS - 1));
  // A character that ends right at the limit is kept whole.
  await deprecateSkill(client, 'reg', 'rec-1', `${'x'.repeat(STATUS_REASON_MAX_CHARS - 2)}\u{1F512} locked`);
  assert.equal(client.calls[1].input.statusReason, `${'x'.repeat(STATUS_REASON_MAX_CHARS - 2)}\u{1F512}`);
});

test('deprecateSkill keeps a short reason as written, without surrounding space', async () => {
  const client = fakeClient([]);
  await deprecateSkill(client, 'reg', 'rec-1', '\n valkey-reviewer: retired (obsolete) 2026-10-13 \n');
  assert.equal(client.calls[0].input.statusReason, 'valkey-reviewer: retired (obsolete) 2026-10-13');
});

test('deprecateSkill refuses an empty reason without calling the service', async () => {
  const client = fakeClient([]);
  await assert.rejects(deprecateSkill(client, 'reg', 'rec-1', '   '), /needs a reason/);
  assert.equal(client.calls.length, 0);
});

test('deprecateSkill waits out a busy record and retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const client = fakeClient([], { statusReplies: [serviceError('ConflictException'), serviceError('ConflictException'), { status: 'DEPRECATED' }] });
  const done = deprecateSkill(client, 'reg', 'rec-1', 'retired');
  for (let i = 0; i < 2; i++) {
    await new Promise(setImmediate);
    t.mock.timers.tick(5_000);
  }
  assert.equal(await done, 'DEPRECATED');
  assert.equal(client.calls.filter((c) => c.op === 'UpdateRegistryRecordStatusCommand').length, 3);
});

test('deprecateSkill passes a refused transition to the caller without retrying', async () => {
  const client = fakeClient([], { statusReplies: [serviceError('ValidationException')] });
  await assert.rejects(deprecateSkill(client, 'reg', 'rec-1', 'retired'), { name: 'ValidationException' });
  assert.equal(client.calls.length, 1);
});
