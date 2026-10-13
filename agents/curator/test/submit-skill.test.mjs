import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubmitSkillTool, slugify, suffixedName, withRecordName } from '../dist/curator/src/tools/submit-skill.js';
import { buildListSkillAuthoringTool } from '../dist/curator/src/tools/skill-authoring.js';
import { GRADUATED_SKILL_MAX_CHARS, GRADUATED_SKILLS_MAX_CHARS } from '../dist/common/src/skills-registry.js';
import { assertPlaceholdersMatch, conditionFailed, fakeDdb, newRun, parse } from './helpers.mjs';

const INPUT = {
  area_bucket: 'src',
  source_record_id: 'r1',
  subject: 'Replication handshake cancel paths',
  description: 'Use when reviewing a PR that touches src/replication.c.',
  skill_md: '---\nname: x\ndescription: y\n---\n\nbody of the skill',
};

/** `taken` lists the names other records' skills already hold in the registry. */
function setup({ item, upsert, taken = [], exists, reinforced = { areaBucket: 'src', recordId: 'r1' }, updates = () => ({}) }) {
  const run = newRun();
  run.reinforced = reinforced;
  const ddb = fakeDdb({ GetCommand: () => ({ Item: item }), UpdateCommand: updates });
  const published = [];
  const lookups = [];
  const registry = {
    upsert: upsert ?? (async (input) => { published.push(input); return { action: 'created', recordArn: 'arn:skill', status: 'CREATING' }; }),
    exists: exists ?? (async (name) => { lookups.push(name); return taken.includes(name); }),
  };
  const submit = buildSubmitSkillTool({ ddb, table: 'concerns', run, registry });
  return { run, ddb, published, lookups, submit };
}

test('slugify never returns an empty name or a trailing hyphen', () => {
  assert.equal(slugify('Replication: handshake / cancel!'), 'replication-handshake-cancel');
  assert.equal(slugify('Café naïve'), 'cafe-naive');
  const long = slugify(`${'a'.repeat(59)} b`);
  assert.equal(long, 'a'.repeat(59));
  assert.ok(!long.endsWith('-'));
  assert.match(slugify('!!!'), /^skill-[0-9a-f]{12}$/);
  assert.match(slugify('ручной'), /^skill-[0-9a-f]{12}$/);
  assert.equal(slugify('ручной'), slugify('ручной'), 'the fallback is stable');
});

test('submit_skill refuses a record this run did not reinforce', async () => {
  const { submit, ddb, published } = setup({ item: { reinforcement_count: 9 }, reinforced: null });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /only the record this run bumped or merged into/);
  assert.equal(ddb.calls.length, 0);
  assert.equal(published.length, 0);
});

test('submit_skill refuses below the threshold, checked against the stored count', async () => {
  const { submit, published, run } = setup({ item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 3 } });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /has 3 reinforcements; graduation needs 4/);
  assert.equal(published.length, 0);
  assert.equal(run.take('skill_submit', 'again'), null, 'a refused submit leaves the slot free');
});

test('submit_skill claims the name, publishes, then records graduated_at', async () => {
  const { submit, ddb, published, lookups, run } = setup({ item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4 } });
  const out = parse(await submit.invoke(INPUT));

  assert.equal(out.ok, true);
  assert.equal(out.record_name, 'replication-handshake-cancel-paths');
  assert.deepEqual(lookups, ['replication-handshake-cancel-paths'], 'a free slug is used as is');
  assert.equal(published.length, 1);
  assert.equal(published[0].name, 'replication-handshake-cancel-paths');
  assert.equal(published[0].skillMd, '---\nname: replication-handshake-cancel-paths\ndescription: y\n---\n\nbody of the skill');
  assert.match(published[0].description, /record_id=r1/);

  const [claim, stamp] = ddb.calls.filter((c) => c.op === 'UpdateCommand').map((c) => c.input);
  assert.match(claim.ConditionExpression, /#rc >= :t/);
  assert.match(claim.ConditionExpression, /attribute_not_exists\(#grn\) OR #grn = :name/);
  assert.equal(claim.ExpressionAttributeValues[':t'], 4);
  assertPlaceholdersMatch(claim);
  assert.match(stamp.UpdateExpression, /SET #ga = :now/);
  assertPlaceholdersMatch(stamp);

  const again = parse(await submit.invoke(INPUT));
  assert.equal(again.ok, false);
  assert.match(again.error, /already submitted a skill/);
  assert.deepEqual(run.actions, ['submit_skill r1']);
});

test('a second graduation of a record keeps its original skill name', async () => {
  const { submit, published, lookups } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 6, graduated_record_name: 'original-name' },
    taken: ['original-name'],
  });
  const out = parse(await submit.invoke({ ...INPUT, subject: 'A different title now' }));
  assert.equal(out.ok, true);
  assert.equal(out.record_name, 'original-name');
  assert.equal(published[0].name, 'original-name');
  assert.match(published[0].skillMd, /^---\nname: original-name\n/, 'the frontmatter names the record the skill updates');
  assert.deepEqual(lookups, [], 'the record already owns its name');
});

test('a subject whose slug another record\'s skill holds gets a suffixed name', async () => {
  const slug = 'replication-handshake-cancel-paths';
  const { submit, ddb, published, lookups } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4 },
    taken: [slug],
  });
  const out = parse(await submit.invoke(INPUT));

  assert.equal(out.ok, true);
  const expected = suffixedName(slug, 'r1');
  assert.match(expected, new RegExp(`^${slug}-[0-9a-f]{8}$`));
  assert.equal(out.record_name, expected);
  assert.deepEqual(lookups, [slug, expected]);
  const claim = ddb.calls.find((c) => c.op === 'UpdateCommand').input;
  assert.equal(claim.ExpressionAttributeValues[':name'], expected, 'the suffixed name is stored as graduated_record_name');
  assert.equal(published[0].name, expected);
  assert.match(published[0].skillMd, new RegExp(`^---\\nname: ${expected}\\ndescription: y\\n---\\n`));
});

test('suffixed names are stable per record, distinct across records, and no longer than a slug', () => {
  assert.equal(suffixedName('some-skill', 'r1'), suffixedName('some-skill', 'r1'));
  assert.notEqual(suffixedName('some-skill', 'r1'), suffixedName('some-skill', 'r2'));
  // The cut for the suffix lands right after the 50 a's, on a hyphen.
  const long = slugify(`${'a'.repeat(50)} b c d e`);
  assert.equal(long.length, 58);
  const suffixed = suffixedName(long, 'r1');
  assert.ok(suffixed.length <= 60, suffixed);
  assert.match(suffixed, /^a{50}-[0-9a-f]{8}$/, 'no doubled hyphen where the slug was cut');
});

test('submit_skill publishes nothing when the slug and the suffixed name are both taken', async () => {
  const slug = 'replication-handshake-cancel-paths';
  const { submit, ddb, published, run } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4 },
    taken: [slug, suffixedName(slug, 'r1')],
  });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /other skills already use the registry names/);
  assert.match(out.error, /different subject/);
  assert.equal(published.length, 0);
  assert.deepEqual(ddb.ops(), ['GetCommand'], 'no name is claimed');
  assert.equal(run.take('skill_submit', 'retry'), null);
});

test('a failed registry lookup frees the slot', async () => {
  const { submit, published, run } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4 },
    exists: async () => { throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' }); },
  });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /AccessDeniedException: denied/);
  assert.equal(published.length, 0);
  assert.equal(run.take('skill_submit', 'retry'), null);
});

test('submit_skill rejects markdown a reviewer could not load, before any store or registry call', async () => {
  assert.ok(GRADUATED_SKILL_MAX_CHARS * 2 <= GRADUATED_SKILLS_MAX_CHARS, 'a submitted skill fits in the reviewers\' budget');
  const { submit, ddb, published } = setup({ item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4 } });
  const head = INPUT.skill_md;
  await assert.rejects(submit.invoke({ ...INPUT, skill_md: head + 'x'.repeat(GRADUATED_SKILL_MAX_CHARS - head.length + 1) }), /too_big|Too big/);
  assert.equal(ddb.calls.length, 0);
  assert.equal(published.length, 0);

  const out = parse(await submit.invoke({ ...INPUT, skill_md: head + 'x'.repeat(GRADUATED_SKILL_MAX_CHARS - head.length) }));
  assert.equal(out.ok, true);
  assert.equal(published.length, 1);
});

test('withRecordName sets the frontmatter name and leaves the rest alone', () => {
  const body = '\n# Skill\n\nname: not frontmatter\n';
  assert.equal(withRecordName(`---\nname: old\ndescription: d\n---\n${body}`, 'new'), `---\nname: new\ndescription: d\n---\n${body}`);
  assert.equal(withRecordName(`---\ndescription: d\n---\n${body}`, 'new'), `---\nname: new\ndescription: d\n---\n${body}`);
  assert.equal(withRecordName(`# No frontmatter\n${body}`, 'new'), `# No frontmatter\n${body}`);
  assert.equal(withRecordName('---\nname: old\nnot closed', 'new'), '---\nname: old\nnot closed');
});

test('a lost race on the name claim publishes nothing', async () => {
  const { submit, published } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 5 },
    updates: () => { throw conditionFailed(); },
  });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /changed or graduated under another name/);
  assert.equal(published.length, 0);
});

test('a registry failure frees the slot so the model can retry', async () => {
  const { submit, run } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 5 },
    upsert: async () => { throw Object.assign(new Error('slow down'), { name: 'ThrottlingException' }); },
  });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /ThrottlingException: slow down/);
  assert.equal(run.take('skill_submit', 'retry'), null);
});

test('list_skill_authoring takes no input and falls back when unconfigured', async () => {
  const unconfigured = buildListSkillAuthoringTool({});
  assert.deepEqual(Object.keys(unconfigured.toolSpec.inputSchema.properties ?? {}), []);
  const none = parse(await unconfigured.invoke({}));
  assert.equal(none.ok, false);
  assert.ok(none.fallback);

  const configured = buildListSkillAuthoringTool({ load: async () => [{ name: 'how-to-write-a-skill', description: 'd', body: 'b' }] });
  const out = parse(await configured.invoke({}));
  assert.equal(out.ok, true);
  assert.equal(out.skills[0].name, 'how-to-write-a-skill');

  const failing = buildListSkillAuthoringTool({ load: async () => { throw new Error('denied'); } });
  const failed = parse(await failing.invoke({}));
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /denied/);
});
