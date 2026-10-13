import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSkills, upsertSkill, withFrontmatter } from '../src/skills-registry.ts';

/** Minimal stand-in for AgentRegistryControlClient: routes by command class name. */
function fakeClient(records, { pageSize = 2 } = {}) {
  const calls = [];
  return {
    calls,
    async send(command) {
      const op = command.constructor.name;
      const input = command.input;
      calls.push({ op, input });
      if (op === 'ListRegistryRecordsCommand') {
        const byName = input.filters?.find((f) => f.name === 'name')?.values[0];
        const matching = records.filter((r) => r.recordType === 'SKILL' && (!byName || r.name === byName));
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
      throw new Error(`unexpected ${op}`);
    },
  };
}

const rec = (recordId, status, updated, md = `---\nname: ${recordId}\n---\nbody`) => ({
  recordId, name: recordId, recordArn: `arn:${recordId}`, recordType: 'SKILL', status, md, updatedAt: new Date(updated),
});

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
