import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistryControlClient } from '@aws-sdk/client-agent-registry-control';
import './support/ts-resolve.mjs';

const { loadGraduatedSkills } = await import('../src/graduated-skills.ts');
const { GRADUATED_SKILL_MAX_CHARS } = await import('../src/skills-registry.ts');

/** Answers list and get calls from `records`, like the registry control plane. */
function fakeRegistry(t, records) {
  t.mock.method(AgentRegistryControlClient.prototype, 'send', async (command) => {
    const op = command.constructor.name;
    if (op === 'ListRegistryRecordsCommand') return { registryRecords: records };
    if (op === 'GetRegistryRecordCommand') {
      const r = records.find((x) => x.recordId === command.input.recordId);
      return { ...r, descriptors: { agentSkillsDefinition: { additionalData: { skillMd: { data: r.md } } } } };
    }
    throw new Error(`unexpected ${op}`);
  });
}

const rec = (id, updated, md) => ({ recordId: id, name: id, recordArn: `arn:${id}`, status: 'DRAFT', updatedAt: new Date(updated), md });

test('the default budget loads a skill of the largest size the curator may submit', async (t) => {
  const largest = `---\nname: big\n---\n${'x'.repeat(GRADUATED_SKILL_MAX_CHARS)}`;
  fakeRegistry(t, [rec('big', '2026-10-01', largest)]);
  const skills = await loadGraduatedSkills({ registryId: 'reg', region: 'us-west-2' });
  assert.deepEqual(skills.map((s) => s.name), ['big']);
});

test('the warning counts every skill the budget left out, not only older ones', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (msg) => warnings.push(msg));
  const md = (n) => `---\nname: s\n---\n${'x'.repeat(n)}`;
  fakeRegistry(t, [
    rec('old', '2026-10-01', md(10)),
    rec('new', '2026-10-03', md(600)),
    rec('mid', '2026-10-02', md(600)),
  ]);
  const skills = await loadGraduatedSkills({ registryId: 'reg', region: 'us-west-2', maxChars: 1000 });
  assert.deepEqual(skills.map((s) => s.name), ['new', 'old']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /loaded 2; 1 skill\(s\) left out by the limits \(30 skills, 1000 characters\)/);
});
