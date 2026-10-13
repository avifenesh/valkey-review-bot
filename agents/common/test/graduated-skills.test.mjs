import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistryControlClient } from '@aws-sdk/client-agent-registry-control';
import './support/ts-resolve.mjs';

const { loadGraduatedSkills, renderGraduatedSkills } = await import('../src/graduated-skills.ts');
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

const skill = (overrides = {}) => ({
  recordArn: 'arn:lock-order',
  name: 'lock-order',
  description: 'Use when reviewing a PR that touches `src/networking.c`.\n\nGraduated from concern record_id=3f2a9c1e-0b7d-4e55-9a51-2c6f0d8e7b10.',
  status: 'DRAFT',
  skillMd: [
    '---',
    'name: lock-order',
    'description: "Use when reviewing a PR that touches `src/networking.c`."',
    '---',
    '',
    '## Use when',
    'A diff takes `c->lock` in `src/networking.c`.',
    '',
    '## Patterns',
    '',
    '### Lock order',
    'Skip unless: `lockClient` appears in the diff.',
  ].join('\n'),
  ...overrides,
});

test('rendering drops the frontmatter and nests the skill headings under the skill name', () => {
  const out = renderGraduatedSkills([skill()]);
  assert.doesNotMatch(out, /name: lock-order|description: "/);
  assert.ok(out.includes('## lock-order\n'));
  assert.ok(out.includes('\n### Use when\nA diff takes `c->lock` in `src/networking.c`.\n\n### Patterns\n\n#### Lock order\nSkip unless:'));
  assert.doesNotMatch(out, /^## (Use when|Patterns)$/m);
});

test('the description is one plain Scope line without the record id sentence', () => {
  const out = renderGraduatedSkills([skill()]);
  assert.ok(out.includes('## lock-order\nScope: Use when reviewing a PR that touches `src/networking.c`.\n\n'));
  assert.doesNotMatch(out, /record_id|Graduated from concern/);
  assert.doesNotMatch(out, /^_.*_$/m);
  const wrapped = renderGraduatedSkills([skill({ description: 'Use when reviewing\n  `src/db.c`.\nDoes NOT apply to `src/rdb.c`.' })]);
  assert.ok(wrapped.includes('\nScope: Use when reviewing `src/db.c`. Does NOT apply to `src/rdb.c`.\n'));
  const idOnly = renderGraduatedSkills([skill({ description: 'Graduated from concern record_id=abc.' })]);
  assert.ok(idOnly.includes('## lock-order\n\n'));
  assert.doesNotMatch(idOnly, /Scope:/);
});

test('the introduction says the code at the PR head wins', () => {
  const out = renderGraduatedSkills([skill()]);
  assert.doesNotMatch(out, /Treat as established conventions/);
  assert.ok(out.includes('Several maintainers confirmed each of these rules, and each is re-checked against the upstream default branch after releases. '
    + 'A rule is a reason to look; the code at the PR head wins. '
    + 'Confirm that the files and names a rule cites exist in this checkout before relying on it.'));
  assert.equal(renderGraduatedSkills([]), '');
});

test('headings in fenced blocks are left alone', () => {
  const md = [
    '## Always-on checks',
    '```sh',
    '# a shell comment',
    '```',
    '~~~~markdown',
    '## Example heading',
    '~~~',
    '# still inside the four-tilde fence',
    '~~~~',
    '``` not a fence ` because the info string has a backtick',
    '# a heading again',
    '    ## indented four spaces: code, not a heading',
    '###### deepest level stays',
    '#hashtag is not a heading',
  ].join('\n');
  const out = renderGraduatedSkills([skill({ skillMd: md })]);
  assert.ok(out.includes([
    '### Always-on checks',
    '```sh',
    '# a shell comment',
    '```',
    '~~~~markdown',
    '## Example heading',
    '~~~',
    '# still inside the four-tilde fence',
    '~~~~',
    '``` not a fence ` because the info string has a backtick',
    '## a heading again',
    '    ## indented four spaces: code, not a heading',
    '###### deepest level stays',
    '#hashtag is not a heading',
  ].join('\n')));
});

test('markdown without a complete frontmatter block is kept whole', () => {
  const out = renderGraduatedSkills([skill({ skillMd: '---\nname: broken\n## Use when\nbody' })]);
  assert.ok(out.includes('---\nname: broken\n### Use when\nbody'));
});
