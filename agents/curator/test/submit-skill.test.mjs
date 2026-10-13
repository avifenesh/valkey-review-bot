import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubmitSkillTool, slugify, suffixedName, withRecordName } from '../dist/curator/src/tools/submit-skill.js';
import { buildListSkillAuthoringTool } from '../dist/curator/src/tools/skill-authoring.js';
import { GRADUATED_SKILL_MAX_CHARS, GRADUATED_SKILLS_MAX_CHARS } from '../dist/common/src/skills-registry.js';
import { assertPlaceholdersMatch, conditionFailed, conditionHolds, fakeDdb, memoryTable, newRun, parse } from './helpers.mjs';

const INPUT = {
  area_bucket: 'src',
  source_record_id: 'r1',
  subject: 'Replication handshake cancel paths',
  description: 'Use when reviewing a PR that touches src/replication.c.',
  skill_md: '---\nname: x\ndescription: y\n---\n\nbody of the skill',
};

/** `taken` lists the names other records' skills already hold in the registry. */
function setup({ item, upsert, taken = [], exists, reinforced = { areaBucket: 'src', recordId: 'r1' }, edited = null, updates = () => ({}) }) {
  const run = newRun();
  run.reinforced = reinforced;
  run.edited = edited;
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
  assert.match(claim.ConditionExpression, /attribute_not_exists\(#grn\)/);
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

test('submit_skill refuses a reserved area_bucket', async () => {
  const { submit, ddb, published, run } = setup({ item: { reinforcement_count: 9 }, reinforced: { areaBucket: '#maintenance', recordId: 'r1' } });
  const out = parse(await submit.invoke({ ...INPUT, area_bucket: '#maintenance' }));
  assert.equal(out.ok, false);
  assert.match(out.error, /reserved/);
  assert.equal(ddb.calls.length, 0);
  assert.equal(published.length, 0);
  assert.equal(run.take('skill_submit', 'next'), null);
});

test('submit_skill adds the provenance sentence once, even to a description copied from get_skill', async () => {
  const { submit, published } = setup({ item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4 } });
  const out = parse(await submit.invoke({ ...INPUT, description: `${INPUT.description}\n\nGraduated from concern record_id=r1.` }));
  assert.equal(out.ok, true);
  assert.equal(published[0].description, `${INPUT.description}\n\nGraduated from concern record_id=r1.`);
});

test('update_concern on a graduated record lets the run re-publish its skill', async () => {
  const { submit, published, run } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 5, graduated_record_name: 'original-name' },
    reinforced: null,
    edited: { areaBucket: 'src', recordId: 'r1' },
  });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, true);
  assert.equal(out.record_name, 'original-name');
  assert.equal(published[0].name, 'original-name');
  assert.deepEqual(run.actions, ['submit_skill r1']);
});

test('update_concern alone never graduates a record for the first time', async () => {
  const { submit, ddb, published, run } = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 5 },
    reinforced: null,
    edited: { areaBucket: 'src', recordId: 'r1' },
  });
  const out = parse(await submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /never graduated; a first graduation needs a bump or merge/);
  assert.deepEqual(ddb.ops(), ['GetCommand'], 'nothing is claimed');
  assert.equal(published.length, 0);
  assert.equal(run.take('skill_submit', 'next'), null);
});

test('re-publication after update_concern still needs the threshold and the same record', async () => {
  const low = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 3, graduated_record_name: 'original-name' },
    reinforced: null,
    edited: { areaBucket: 'src', recordId: 'r1' },
  });
  const below = parse(await low.submit.invoke(INPUT));
  assert.equal(below.ok, false);
  assert.match(below.error, /has 3 reinforcements; graduation needs 4/);
  assert.equal(low.published.length, 0);

  const other = setup({
    item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 9, graduated_record_name: 'original-name' },
    reinforced: null,
    edited: { areaBucket: 'src', recordId: 'r2' },
  });
  const out = parse(await other.submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /or a graduated record this run changed with update_concern/);
  assert.equal(other.ddb.calls.length, 0);
});

/**
 * Stand-in for the registry functions agent.ts wires: upsertSkill
 * refuses a DEPRECATED or REJECTED record with SkillRetiredError, and
 * getSkillByName returns a record in any status.
 */
function fakeRegistry(records = {}) {
  const skills = new Map(Object.entries(records).map(([name, r]) => [name, { name, description: 'd', ...r }]));
  const calls = [];
  return {
    skills,
    calls,
    async upsert(input) {
      calls.push(`upsert ${input.name}`);
      const existing = skills.get(input.name);
      if (existing && ['DEPRECATED', 'REJECTED'].includes(existing.status)) {
        throw Object.assign(new Error(`skill "${input.name}" is ${existing.status}`), { name: 'SkillRetiredError' });
      }
      const status = existing ? 'UPDATING' : 'CREATING';
      skills.set(input.name, { name: input.name, status, description: input.description, skillMd: input.skillMd });
      return { action: existing ? 'updated' : 'created', recordArn: `arn:${input.name}`, status };
    },
    async exists(name) {
      calls.push(`exists ${name}`);
      return skills.has(name);
    },
    async get(name) {
      calls.push(`get ${name}`);
      return skills.get(name) ?? null;
    },
  };
}

function world({ item, skills = {}, reinforced = true, edited = false, registry = fakeRegistry(skills) }) {
  const table = memoryTable([item]);
  const run = newRun();
  const touched = { areaBucket: item.area_bucket, recordId: item.record_id };
  if (reinforced) run.reinforced = touched;
  if (edited) run.edited = touched;
  const submit = buildSubmitSkillTool({ ddb: table.ddb, table: 'concerns', run, registry });
  return { ddb: table.ddb, registry, run, submit, record: () => table.item(item.area_bucket, item.record_id) };
}

const OLD = 'replication-handshake-cancel-paths';
const generationName = (n) => suffixedName(slugify(INPUT.subject), `r1#g${n}`);
const BASELINE = {
  audit_names: new Set(['src/replication.c', 'cancelReplicationHandshake']),
  ignored_names: new Set(['VM_Foo']),
  verified_release: '9.1.2',
  verified_sha: 'a'.repeat(40),
  verified_ref: `unstable@${'a'.repeat(12)}`,
  verified_at: '2026-08-01T00:00:00.000Z',
};
const live = (extra = {}) => ({
  area_bucket: 'src',
  record_id: 'r1',
  reinforcement_count: 6,
  decay_score: 1,
  updated_at: '2026-10-01T00:00:00.000Z',
  graduated_record_name: OLD,
  graduated_at: '2026-01-01T00:00:00.000Z',
  ...BASELINE,
  ...extra,
});
const tombstone = (extra = {}) => live({
  retired_at: '2026-09-01T00:00:00.000Z',
  retired_reason: 'decayed',
  retired_from_status: 'DRAFT',
  ...extra,
});
const DEPRECATED = { [OLD]: { status: 'DEPRECATED', skillMd: 'old body' } };

function assertUpdatesWellFormed(ddb) {
  for (const call of ddb.calls.filter((c) => c.op === 'UpdateCommand')) assertPlaceholdersMatch(call.input);
}

test('a reinforced decayed tombstone is published under the next generation name', async () => {
  const w = world({ item: tombstone(), skills: DEPRECATED });
  const out = parse(await w.submit.invoke(INPUT));

  assert.equal(out.ok, true, out.error);
  const name = generationName(2);
  assert.match(name, new RegExp(`^${OLD.slice(0, 51).replace(/-+$/, '')}-[0-9a-f]{8}$`));
  assert.notEqual(name, suffixedName(slugify(INPUT.subject), 'r1'), 'not the first graduation\'s suffix');
  assert.equal(out.record_name, name);
  assert.equal(out.replaces, OLD);
  assert.equal(out.action, 'created');
  assert.match(w.registry.skills.get(name).skillMd, new RegExp(`^---\nname: ${name}\n`));
  assert.deepEqual(w.registry.skills.get(OLD), { name: OLD, description: 'd', status: 'DEPRECATED', skillMd: 'old body' }, 'the tombstone\'s registry record is not touched');

  const rec = w.record();
  assert.equal(rec.graduated_record_name, name);
  assert.equal(rec.skill_generation, 2);
  assert.equal(rec.previous_record_name, OLD);
  for (const gone of ['retired_at', 'retired_reason', 'retired_from_status']) assert.ok(!(gone in rec), gone);
  assert.ok(rec.graduated_at > '2026-10-01', 'graduated_at moves, so the next decay pass queues a check');
  for (const [k, v] of Object.entries(BASELINE)) assert.deepEqual(rec[k], v, `${k} is kept`);
  assert.deepEqual(w.run.actions, ['submit_skill r1']);
  assertUpdatesWellFormed(w.ddb);
});

test('obsolete tombstones and operator-restored ones also take a generation, counting from skill_generation', async () => {
  for (const extra of [
    { retired_reason: 'obsolete', obsolete_release: '9.1.2', skill_generation: 2 },
    { retired_reason: undefined, skill_generation: 2 },
  ]) {
    const item = tombstone(extra);
    if (extra.retired_reason === undefined) delete item.retired_reason;
    const w = world({ item, skills: DEPRECATED });
    const out = parse(await w.submit.invoke(INPUT));
    assert.equal(out.ok, true, out.error);
    assert.equal(out.record_name, generationName(3));
    assert.equal(w.record().skill_generation, 3);
    assert.ok(!('obsolete_release' in w.record()), 'the subject is back, so obsolete_release goes');
  }
});

test('a skill an operator retired is never published again', async () => {
  for (const reason of ['operator', 'something-else']) {
    const w = world({ item: tombstone({ retired_reason: reason }), skills: DEPRECATED });
    const out = parse(await w.submit.invoke(INPUT));
    assert.equal(out.ok, false, reason);
    assert.match(out.error, /it is not published again/, reason);
    if (reason === 'operator') assert.match(out.error, /retired by an operator/);
    assert.deepEqual(w.registry.calls, [], `${reason}: no registry call`);
    assert.deepEqual(w.ddb.ops(), ['GetCommand'], `${reason}: no claim`);
    assert.deepEqual(w.record(), tombstone({ retired_reason: reason }));
    assert.equal(w.run.take('skill_submit', 'next'), null);
  }
});

test('update_concern alone cannot bring a retired skill back', async () => {
  const w = world({ item: tombstone(), skills: DEPRECATED, reinforced: false, edited: true });
  const out = parse(await w.submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /was retired; only a bump or merge in this run can publish it again/);
  assert.deepEqual(w.registry.calls, []);
  assert.deepEqual(w.ddb.ops(), ['GetCommand']);
});

test('a live skill deprecated outside the lifecycle is marked as an operator retirement', async () => {
  // No marker, or one an older generation left behind: the lifecycle did not retire this record.
  for (const marker of [undefined, 'an-older-generation']) {
    const item = live(marker ? { maintenance_deprecating: marker } : {});
    const w = world({ item, skills: DEPRECATED });
    const out = parse(await w.submit.invoke(INPUT));
    assert.equal(out.ok, false);
    assert.match(out.error, /skill "replication-handshake-cancel-paths" was retired by an operator; it is not published again/);
    const rec = w.record();
    assert.equal(rec.retired_reason, 'operator');
    assert.ok(rec.retired_at);
    assert.equal(rec.graduated_record_name, OLD);
    assert.equal(w.registry.skills.size, 1, 'nothing was published');
    assert.equal(w.run.take('skill_submit', 'next'), null, 'the slot is free');
    w.run.release('skill_submit');
    assertUpdatesWellFormed(w.ddb);

    const again = parse(await w.submit.invoke(INPUT));
    assert.equal(again.ok, false);
    assert.match(again.error, /retired by an operator/);
  }
});

test('a deprecation the lifecycle started is marked decayed or obsolete, and the run can publish again', async () => {
  for (const [extra, reason] of [[{}, 'decayed'], [{ obsolete_release: '9.1.2' }, 'obsolete']]) {
    const item = live({ maintenance_id: 'retire#valkey-review#r1#2026-10-01T00:00:00.000Z', maintenance_deprecating: OLD, ...extra });
    const w = world({ item, skills: DEPRECATED });
    const first = parse(await w.submit.invoke(INPUT));
    assert.equal(first.ok, false);
    assert.match(first.error, /retired by the skill lifecycle while this run worked; call submit_skill again to publish it under a new name/);
    assert.equal(w.record().retired_reason, reason);
    assert.equal(w.record().maintenance_deprecating, OLD, 'the retire run\'s marker stays');

    const second = parse(await w.submit.invoke(INPUT));
    assert.equal(second.ok, true, second.error);
    assert.equal(second.record_name, generationName(2));
    const rec = w.record();
    assert.equal(rec.graduated_record_name, generationName(2));
    for (const gone of ['retired_at', 'retired_reason', 'maintenance_id', 'maintenance_deprecating', 'obsolete_release']) {
      assert.ok(!(gone in rec), `${gone} is removed once a new generation is live`);
    }
  }

  const edited = world({ item: live({ maintenance_deprecating: OLD }), skills: DEPRECATED, reinforced: false, edited: true });
  const out = parse(await edited.submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /only a reinforcement can publish it again/);
});

test('an unfinished re-publication finishes under the name it claimed', async () => {
  const claimed = generationName(2);
  const item = tombstone({ graduated_record_name: claimed, skill_generation: 2, previous_record_name: OLD });
  for (const [skills, action] of [
    [{ ...DEPRECATED, [claimed]: { status: 'DRAFT', skillMd: 'gen 2 body' } }, 'updated'],
    [DEPRECATED, 'created'],
  ]) {
    const w = world({ item, skills });
    const out = parse(await w.submit.invoke(INPUT));
    assert.equal(out.ok, true, out.error);
    assert.equal(out.record_name, claimed, 'no third generation');
    assert.equal(out.action, action);
    assert.equal(out.replaces, undefined);
    const rec = w.record();
    assert.equal(rec.skill_generation, 2);
    assert.ok(!('retired_at' in rec));
  }
});

test('publishing clears the old text\'s check and maintenance state and keeps the name baseline', async () => {
  const item = live({
    stale_names: new Set(['emptyDB']),
    stale_since: '2026-08-01T00:00:00.000Z',
    pending_revision: { verdict: 'revise', summary: 's', edits: [] },
    check_outcome: 'suspect',
    check_note: 'note',
    maintenance_id: 'check#valkey-review#r1#2026-10-01T00:00:00.000Z',
    maintenance_requested_at: '2026-10-01T00:00:00.000Z',
    maintenance_reason: 'check',
    // Names this very record: a retire run may still be deprecating it.
    maintenance_deprecating: OLD,
  });
  const w = world({ item, skills: { [OLD]: { status: 'DRAFT', skillMd: 'live body' } } });
  const out = parse(await w.submit.invoke(INPUT));
  assert.equal(out.ok, true, out.error);
  assert.equal(out.record_name, OLD);
  assert.equal(out.action, 'updated');

  const rec = w.record();
  for (const gone of ['stale_names', 'stale_since', 'pending_revision', 'maintenance_id', 'maintenance_requested_at', 'maintenance_reason']) {
    assert.ok(!(gone in rec), `${gone} is removed`);
  }
  assert.equal(rec.maintenance_deprecating, OLD, 'a marker naming the published record stays');
  for (const [k, v] of Object.entries(BASELINE)) assert.deepEqual(rec[k], v, `${k} is kept`);
  assert.equal(rec.check_outcome, 'suspect', 'the last check\'s outcome stays until the next check');

  const [claim] = w.ddb.calls.filter((c) => c.op === 'UpdateCommand').map((c) => c.input);
  assert.match(claim.UpdateExpression, /REMOVE #mid, #mra, #mr$/, 'the claim voids a check queued for the old text');
  assert.ok(claim.ConditionExpression.split(' AND ').includes('attribute_not_exists(#ret)'));
  assertUpdatesWellFormed(w.ddb);
});

test('two runs restoring one tombstone agree on one generation', async () => {
  // The other run claimed generation 2 after this one read the record.
  const now = tombstone({ graduated_record_name: generationName(2), skill_generation: 2, previous_record_name: OLD });
  const ddb = fakeDdb({
    GetCommand: () => ({ Item: tombstone() }),
    UpdateCommand: (input) => { if (!conditionHolds(now, input)) throw conditionFailed(); return {}; },
  });
  const registry = fakeRegistry(DEPRECATED);
  const run = newRun();
  run.reinforced = { areaBucket: 'src', recordId: 'r1' };
  const out = parse(await buildSubmitSkillTool({ ddb, table: 'concerns', run, registry }).invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /changed or graduated under another name/);
  assert.ok(!registry.calls.some((c) => c.startsWith('upsert')));
});

test('a generation name another skill holds, or an unwired registry reader, publishes nothing', async () => {
  const taken = world({ item: tombstone(), skills: { ...DEPRECATED, [generationName(2)]: { status: 'DRAFT' } } });
  const out = parse(await taken.submit.invoke(INPUT));
  assert.equal(out.ok, false);
  assert.match(out.error, /another skill already uses the registry name/);
  assert.deepEqual(taken.ddb.ops(), ['GetCommand']);

  const reader = fakeRegistry(DEPRECATED);
  delete reader.get;
  const unwired = world({ item: tombstone(), registry: reader });
  const none = parse(await unwired.submit.invoke(INPUT));
  assert.equal(none.ok, false);
  assert.match(none.error, /no registry reader is configured/);
});

test('a first graduation loses to another run that claimed a name for the record first', async () => {
  for (const claimedName of ['replication-handshake-cancel-paths', 'some-other-name']) {
    const now = { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4, graduated_record_name: claimedName };
    const ddb = fakeDdb({
      GetCommand: () => ({ Item: { area_bucket: 'src', record_id: 'r1', reinforcement_count: 4 } }),
      UpdateCommand: (input) => { if (!conditionHolds(now, input)) throw conditionFailed(); return {}; },
    });
    const registry = fakeRegistry();
    const run = newRun();
    run.reinforced = { areaBucket: 'src', recordId: 'r1' };
    const out = parse(await buildSubmitSkillTool({ ddb, table: 'concerns', run, registry }).invoke(INPUT));
    assert.equal(out.ok, false, claimedName);
    assert.match(out.error, /read it again with get_concern/);
    assert.ok(!registry.calls.some((c) => c.startsWith('upsert')), 'the second run publishes nothing; a retry updates the claimed name');
  }
});
