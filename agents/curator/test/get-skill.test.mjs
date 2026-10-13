import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildGetSkillTool } from '../dist/curator/src/tools/get-skill.js';
import { assembleCuratorTools } from '../dist/curator/src/tools/index.js';
import { fakeDdb, newRun, parse } from './helpers.mjs';

const SKILL_MD = [
  '---',
  'name: replication-handshake',
  'description: Use when reviewing a PR that touches src/replication.c.',
  '---',
  '',
  '## Patterns',
  '<!-- suppressed: superseded in 9.1.2, 2026-10-13; `emptyDB` is now `emptyData`; evidence: valkey-io/valkey@' + 'a'.repeat(40) + ':src/server.h:10 -->',
  'Flag callers of `emptyDB` that skip the flags.',
  '<!-- /suppressed -->',
  'Flag callers of `emptyData` that skip the flags.',
].join('\n');

const graduated = { area_bucket: 'src', record_id: 'r1', reinforcement_count: 5, graduated_record_name: 'replication-handshake' };

function setup({ item = graduated, get } = {}) {
  const run = newRun();
  const ddb = fakeDdb({ GetCommand: () => ({ Item: item }) });
  const reads = [];
  const registry = {
    upsert: async () => { throw new Error('get_skill must not write'); },
    exists: async () => { throw new Error('get_skill must not look up names'); },
    get: get ?? (async (name) => {
      reads.push(name);
      return {
        name,
        status: 'DRAFT',
        description: 'Use when reviewing a PR that touches src/replication.c.\n\nGraduated from concern record_id=r1.',
        skillMd: SKILL_MD,
      };
    }),
  };
  return { run, ddb, reads, tool: buildGetSkillTool({ ddb, table: 'concerns', run, registry }) };
}

test('get_skill returns the published text of a graduated record, markers included', async () => {
  const { tool, ddb, reads, run } = setup();
  const out = parse(await tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(out.ok, true);
  assert.equal(out.record_name, 'replication-handshake');
  assert.equal(out.status, 'DRAFT');
  assert.equal(out.skill_md, SKILL_MD, 'the markdown is returned as the registry holds it');
  assert.equal(out.description, 'Use when reviewing a PR that touches src/replication.c.', 'the provenance sentence submit_skill adds is not shown');
  assert.deepEqual(reads, ['replication-handshake']);
  assert.deepEqual(ddb.ops(), ['GetCommand']);
  assert.equal(ddb.calls[0].input.ConsistentRead, true);
  assert.equal(run.take('concern_write', 'next'), null, 'no store change is used');
  assert.equal(run.take('skill_submit', 'next'), null, 'no submit is used');
  assert.deepEqual(run.actions, []);
});

test('get_skill reads a retired skill too', async () => {
  const { tool } = setup({
    item: { ...graduated, retired_at: '2026-10-01T00:00:00.000Z', retired_reason: 'decayed' },
    get: async (name) => ({ name, status: 'DEPRECATED', description: 'd', skillMd: SKILL_MD }),
  });
  const out = parse(await tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(out.ok, true);
  assert.equal(out.status, 'DEPRECATED');
  assert.equal(out.skill_md, SKILL_MD);
});

test('get_skill refuses records that never graduated, without a registry call', async () => {
  const { tool, reads } = setup({ item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 9 } });
  const out = parse(await tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /has not graduated/);
  assert.deepEqual(reads, []);

  const missing = setup({ item: null });
  const gone = parse(await missing.tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(gone.ok, false);
  assert.match(gone.error, /does not exist in src/);
  assert.deepEqual(missing.reads, []);
});

test('get_skill refuses a reserved bucket before any read', async () => {
  const { tool, ddb, reads } = setup();
  const out = parse(await tool.invoke({ area_bucket: '#maintenance', record_id: 'repo-skill' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /reserved/);
  assert.equal(ddb.calls.length, 0);
  assert.deepEqual(reads, []);
});

test('get_skill reports a missing registry record, a registry error and an unwired reader', async () => {
  const none = parse(await setup({ get: async () => null }).tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(none.ok, false);
  assert.match(none.error, /no skill named "replication-handshake"/);

  const denied = setup({ get: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); } });
  const failed = parse(await denied.tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /AccessDeniedException: denied/);

  const run = newRun();
  const unwired = buildGetSkillTool({
    ddb: fakeDdb({ GetCommand: () => ({ Item: graduated }) }),
    table: 'concerns',
    run,
    registry: { upsert: async () => ({}), exists: async () => false },
  });
  const out = parse(await unwired.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /no registry reader is configured/);
});

test('the curator gets get_skill, and the prompt\'s tool tables name exactly the assembled tools', () => {
  const tools = assembleCuratorTools({
    ddb: fakeDdb({}),
    table: 'concerns',
    run: newRun(),
    registry: { upsert: async () => ({}), exists: async () => false, get: async () => null },
    authoring: {},
  });
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('get_skill'));
  const prompt = readFileSync(new URL('../config/prompt.md', import.meta.url), 'utf8');
  const tables = prompt.slice(prompt.indexOf('## Tools'), prompt.indexOf('## Workflow'));
  const listed = [...tables.matchAll(/^\| `([a-z_]+)\(/gm)].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...names].sort());
});

test('get_skill shows the replaced skill when a claimed generation never reached the registry', async () => {
  const reads = [];
  const { tool } = setup({
    item: { ...graduated, graduated_record_name: 'replication-handshake-1a2b3c4d', previous_record_name: 'replication-handshake', retired_at: 'x' },
    get: async (name) => {
      reads.push(name);
      return name === 'replication-handshake' ? { name, status: 'DEPRECATED', description: 'd', skillMd: SKILL_MD } : null;
    },
  });
  const out = parse(await tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(out.ok, true);
  assert.equal(out.record_name, 'replication-handshake');
  assert.equal(out.skill_md, SKILL_MD);
  assert.deepEqual(reads, ['replication-handshake-1a2b3c4d', 'replication-handshake']);

  // A live record whose skill is missing has nothing to fall back on: submit_skill compares against no text.
  const live = setup({
    item: { ...graduated, graduated_record_name: 'replication-handshake-1a2b3c4d', previous_record_name: 'replication-handshake' },
    get: async (name) => (name === 'replication-handshake' ? { name, status: 'DEPRECATED', description: 'd', skillMd: SKILL_MD } : null),
  });
  const missing = parse(await live.tool.invoke({ area_bucket: 'src', record_id: 'r1' }));
  assert.equal(missing.ok, false);
  assert.match(missing.error, /the registry has no skill named "replication-handshake-1a2b3c4d"/);
});
