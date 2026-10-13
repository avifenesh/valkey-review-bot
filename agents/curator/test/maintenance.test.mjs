import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import {
  CHECK_DEADLINE_MS,
  curatorRequestSchema,
  handleMaintenance,
  isMaintenanceRequest,
  maintenanceRegistry,
  REPO_SKILL_KEY,
  repoSkillPath,
  skillPublisher,
} from '../dist/curator/src/maintenance.js';
import { prepareUpstreamCheckout } from '../dist/common/src/skill-check/upstream.js';
import { captureLogs, drain, fakeRegistry, makeUpstream, memoryTable, ScriptedModel, tempDir } from './maintenance-fakes.mjs';

const TABLE = 'valkey_review_concerns';
const REVIEWER = 'valkey-review';
const NAME = 'db-flush';
const KEY = { area_bucket: 'src', record_id: 'rec-1' };
const MID = 'check#valkey-review#rec-1#2026-10-13T00:00:00.000Z';
const RID = 'retire#valkey-review#rec-1#2026-10-13T00:00:00.000Z';
const UPDATED = '2026-01-01T00:00:00.000Z';
const NOW = '2026-10-13T01:00:00.000Z';

const SKILL_MD = [
  '---',
  `name: ${NAME}`,
  'description: Use when a PR changes how `src/db.c` flushes keyspaces.',
  '---',
  '',
  '# Flushing',
  '',
  '- Flag callers of `emptyDB` that never call `signalFlushedDb`.',
  '- `serverCron` runs the expire cycle.',
  '',
].join('\n');

const DB_BASE = 'void emptyDB(int flags) {\n    (void)flags;\n}\n\nvoid signalFlushedDb(int dbid) {\n    (void)dbid;\n}\n';
const DB_TIP = 'void emptyData(int flags) {\n    (void)flags;\n}\n\nvoid signalFlushedDb(int dbid) {\n    (void)dbid;\n}\n';
const up = makeUpstream([
  { 'src/db.c': DB_BASE, 'src/server.c': 'int serverCron(void) {\n    return 0;\n}\n' },
  { 'src/db.c': DB_TIP },
]);
const [BASE_SHA, TIP_SHA] = up.shas;
const checkRoot = tempDir('maint-checkouts-');
after(() => up.cleanup());

const EDIT = {
  original: '- Flag callers of `emptyDB` that never call `signalFlushedDb`.',
  replacement: '- Flag callers of `emptyData` that never call `signalFlushedDb`.',
  evidence: [{ path: 'src/db.c', line: 1 }],
};
const report = (verdict, edits = [], summary = 'MODEL SUMMARY emptyDB became emptyData') => ({ tool: 'report_skill_check', input: { verdict, summary, edits } });

function record(overrides = {}) {
  return {
    ...KEY,
    subject: 'Flushing',
    area: ['src/db.c'],
    reinforcement_count: 5,
    decay_score: 0.8,
    updated_at: UPDATED,
    graduated_record_name: NAME,
    graduated_at: '2026-02-01T00:00:00.000Z',
    audit_names: new Set(['src/db.c', 'emptyDB', 'signalFlushedDb', 'serverCron']),
    verified_sha: BASE_SHA,
    verified_release: '9.1.1',
    verified_at: '2026-03-01T00:00:00.000Z',
    maintenance_id: MID,
    maintenance_requested_at: '2026-10-13T00:00:00.000Z',
    maintenance_reason: 'check',
    ...overrides,
  };
}

function checkMessage(overrides = {}) {
  return {
    maintenance_id: MID, reason: 'check', reviewer_id: REVIEWER, area_bucket: KEY.area_bucket, record_id: KEY.record_id,
    record_name: NAME, release_tag: '9.1.2', seen_updated_at: UPDATED, dry_run: false, ...overrides,
  };
}

function retireMessage(overrides = {}) {
  return {
    maintenance_id: RID, reason: 'retire', reviewer_id: REVIEWER, area_bucket: KEY.area_bucket, record_id: KEY.record_id,
    record_name: NAME, retire_reason: 'decayed', seen_updated_at: UPDATED, dry_run: false, ...overrides,
  };
}

const retireClaim = { maintenance_id: RID, maintenance_reason: 'retire' };

/** Dependencies with the fakes; `model` is a list of scripted turns, or a ScriptedModel. */
function setup({ item = record(), skill = { name: NAME, skillMd: SKILL_MD, description: 'Use when.\n\nGraduated from concern record_id=rec-1.' }, turns, settings = {}, prompt = 'audit', hooks, registryOpts, ...rest } = {}) {
  const table = memoryTable(item ? [item] : [], hooks);
  const registry = fakeRegistry(skill ? [skill] : [], registryOpts);
  const model = turns instanceof ScriptedModel ? turns : new ScriptedModel(turns ?? [{ text: 'no model expected' }]);
  let modelBuilds = 0;
  const deps = {
    ddb: table,
    table: TABLE,
    registry,
    settings: {
      upstreamRepos: { [REVIEWER]: 'valkey-io/valkey' },
      checkApplyEdits: false,
      retireSkills: false,
      checkOpenPullRequests: false,
      skillsRepo: null,
      checkDir: checkRoot,
      checkMaxRounds: 10,
      ...settings,
    },
    audit: { model: () => { modelBuilds += 1; return model; }, systemPrompt: prompt },
    upstreamUrl: () => up.url,
    now: () => new Date(NOW),
    printer: false,
    ...rest,
  };
  return { table, registry, model, deps, modelBuilds: () => modelBuilds };
}

async function run(message, deps) {
  const { value, lines } = await captureLogs(() => drain(handleMaintenance(message, deps)));
  return { ...value, lines };
}

const claimGone = (item) => ['maintenance_id', 'maintenance_requested_at', 'maintenance_reason'].every((a) => item[a] === undefined);
const set = (v) => [...(v ?? [])].sort();

// --- Schema ---------------------------------------------------------------

test('the curator schema still parses feedback events and parses maintenance messages', () => {
  const feedback = curatorRequestSchema.parse({
    reviewer_id: REVIEWER, feedback_id: 'rc-1', kind: 'review_comment_reply', human_body: 'yes', actor: 'm',
    actor_association: 'MEMBER', repo: 'valkey-io/valkey', pr_number: 42, bot_comment: { body: 'b', path: 'src/a.c', line: 1 },
  });
  assert.equal(isMaintenanceRequest(feedback), false);
  assert.equal(feedback.feedback_id, 'rc-1');
  const older = curatorRequestSchema.parse({
    reviewer_id: REVIEWER, feedback_id: 'ic-2', kind: 'issue_comment_reply', body: 'old', actor: 'm', actor_association: 'OWNER',
    bot_comment: { body: '', line: null, pr_number: 7, repo: 'valkey-io/valkey-glide' }, installation_id: 1,
  });
  assert.equal(isMaintenanceRequest(older), false);

  for (const message of [
    checkMessage(), checkMessage({ release_tag: '' }), checkMessage({ release_tag: 'v2.5.3' }), retireMessage(),
    retireMessage({ retire_reason: 'obsolete' }),
    { maintenance_id: 'repo_check#valkey-review#repo-skill#x', reason: 'repo_check', reviewer_id: REVIEWER, ...REPO_SKILL_KEY, release_tag: '9.1.2', dry_run: true },
  ]) {
    const parsed = curatorRequestSchema.parse(message);
    assert.equal(isMaintenanceRequest(parsed), true, JSON.stringify(message));
    assert.deepEqual(parsed, message);
  }
});

test('maintenance messages outside the decay contract are rejected', () => {
  const repo = { maintenance_id: 'r', reason: 'repo_check', reviewer_id: REVIEWER, ...REPO_SKILL_KEY, release_tag: '9.1.2', dry_run: false };
  const bad = [
    checkMessage({ record_name: 'Db-Flush' }),
    checkMessage({ record_name: '-db' }),
    checkMessage({ release_tag: '9.2.0-rc1' }),
    checkMessage({ release_tag: 'rust/v0.9.0' }),
    checkMessage({ area_bucket: '#maintenance' }),
    checkMessage({ reviewer_id: '../x' }),
    checkMessage({ maintenance_id: 'x'.repeat(201) }),
    checkMessage({ dry_run: undefined }),
    retireMessage({ retire_reason: 'operator' }),
    { ...repo, release_tag: '' },
    { ...repo, record_id: 'other' },
    { ...checkMessage(), reason: 'delete' },
  ];
  for (const message of bad) assert.equal(curatorRequestSchema.safeParse(message).success, false, JSON.stringify(message));
});

// --- Retire ---------------------------------------------------------------

test('a retirement of a record reinforced since the request makes no registry call', async () => {
  const s = setup({ item: record({ ...retireClaim, updated_at: '2026-10-12T00:00:00.000Z' }), settings: { retireSkills: true } });
  const { result } = await run(retireMessage(), s.deps);
  assert.equal(result.status, 'skipped');
  assert.deepEqual(s.registry.calls, []);
  const item = s.table.item(KEY);
  assert.ok(claimGone(item));
  assert.equal(item.retired_at, undefined);
});

test('a retirement sets the marker, deprecates, then writes the tombstone', async () => {
  let atDeprecate;
  const s = setup({
    item: record({ ...retireClaim, retire_refused_at: '2026-01-01T00:00:00.000Z' }),
    settings: { retireSkills: true },
    registryOpts: {
      deprecate: (recordId, reason, byName) => {
        atDeprecate = structuredClone(s.table.item(KEY));
        byName.get(NAME).status = 'DEPRECATED';
        return 'DEPRECATED';
      },
    },
  });
  const { result } = await run(retireMessage(), s.deps);
  assert.deepEqual(result, { status: 'completed', decision: 'retired' });
  assert.equal(atDeprecate.maintenance_deprecating, NAME);
  assert.equal(atDeprecate.retired_at, undefined);
  const [, recordId, reason] = s.registry.calls.find((c) => c[0] === 'deprecate');
  assert.equal(recordId, `rec-${NAME}`);
  assert.equal(reason, 'valkey-reviewer: retired (decayed) 2026-10-13; last reinforced 2026-01-01');
  const item = s.table.item(KEY);
  assert.equal(item.retired_at, NOW);
  assert.equal(item.retired_reason, 'decayed');
  assert.equal(item.retired_from_status, 'DRAFT');
  assert.ok(claimGone(item));
  assert.equal(item.maintenance_deprecating, undefined);
  assert.equal(item.retire_refused_at, undefined);
});

test('an obsolete retirement keeps its reason, and is skipped once the record is no longer obsolete', async () => {
  const s = setup({ item: record({ ...retireClaim, obsolete_release: '9.1.2', decay_score: 0 }), settings: { retireSkills: true } });
  await run(retireMessage({ retire_reason: 'obsolete' }), s.deps);
  assert.equal(s.table.item(KEY).retired_reason, 'obsolete');

  const again = setup({ item: record({ ...retireClaim }), settings: { retireSkills: true } });
  const { result } = await run(retireMessage({ retire_reason: 'obsolete' }), again.deps);
  assert.equal(result.status, 'skipped');
  assert.deepEqual(again.registry.calls, []);
});

test('a skill already DEPRECATED without the marker was retired by an operator', async () => {
  const s = setup({ item: record({ ...retireClaim }), skill: { name: NAME, skillMd: SKILL_MD, status: 'DEPRECATED' }, settings: { retireSkills: true } });
  const { result } = await run(retireMessage(), s.deps);
  assert.equal(result.decision, 'retired');
  assert.equal(s.registry.calls.some((c) => c[0] === 'deprecate'), false);
  const item = s.table.item(KEY);
  assert.equal(item.retired_reason, 'operator');
  assert.equal(item.retired_from_status, 'DEPRECATED');
  assert.ok(claimGone(item));
});

test('a skill DEPRECATED with the marker is the lifecycle\'s own retirement, finished now', async () => {
  const s = setup({
    item: record({ ...retireClaim, maintenance_deprecating: NAME }),
    skill: { name: NAME, skillMd: SKILL_MD, status: 'DEPRECATED' },
    settings: { retireSkills: true },
  });
  await run(retireMessage(), s.deps);
  const item = s.table.item(KEY);
  assert.equal(item.retired_reason, 'decayed');
  assert.equal(item.maintenance_deprecating, undefined);
  assert.equal(s.registry.calls.some((c) => c[0] === 'deprecate'), false);
});

test('a refused deprecation keeps the skill, backs off and releases the claim', async () => {
  const s = setup({
    item: record({ ...retireClaim }),
    settings: { retireSkills: true },
    registryOpts: { deprecate: () => { throw Object.assign(new Error('bad transition'), { name: 'ValidationException' }); } },
  });
  const { result, lines } = await run(retireMessage(), s.deps);
  assert.deepEqual(result, { status: 'completed', decision: 'refused' });
  const item = s.table.item(KEY);
  assert.equal(item.retire_refused_at, NOW);
  assert.equal(item.retired_at, undefined);
  assert.ok(claimGone(item));
  // Read as DRAFT after the refusal: the marker goes too.
  assert.equal(item.maintenance_deprecating, undefined);
  assert.ok(lines.some((l) => l.startsWith('[maintenance] retire-refused "db-flush" status="DRAFT"')), lines.join('\n'));
});

test('a refusal from a duplicate that already deprecated the skill still writes the tombstone', async () => {
  const s = setup({
    item: record({ ...retireClaim }),
    settings: { retireSkills: true },
    registryOpts: {
      deprecate: (recordId, reason, byName) => {
        byName.get(NAME).status = 'DEPRECATED';
        throw Object.assign(new Error('already deprecated'), { name: 'ValidationException' });
      },
    },
  });
  const { result } = await run(retireMessage(), s.deps);
  assert.equal(result.decision, 'retired');
  assert.equal(s.table.item(KEY).retired_reason, 'decayed');
});

test('an ambiguous deprecation failure keeps the claim and the marker for the redelivery', async () => {
  const s = setup({
    item: record({ ...retireClaim }),
    settings: { retireSkills: true },
    registryOpts: { deprecate: () => { throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }); } },
  });
  await assert.rejects(run(retireMessage(), s.deps), /socket hang up/);
  const item = s.table.item(KEY);
  assert.equal(item.maintenance_id, RID);
  assert.equal(item.maintenance_deprecating, NAME);
  assert.equal(item.retired_at, undefined);
});

test('with retirement off a retire message is only reported', async () => {
  const s = setup({ item: record({ ...retireClaim }) });
  const { result, lines } = await run(retireMessage(), s.deps);
  assert.equal(result.decision, 'would-retire');
  assert.equal(s.registry.calls.some((c) => c[0] === 'deprecate'), false);
  const item = s.table.item(KEY);
  assert.ok(claimGone(item));
  assert.equal(item.maintenance_deprecating, undefined);
  assert.ok(lines.some((l) => l.includes('[maintenance] retire') && l.includes('outcome="would-retire"')), lines.join('\n'));
});

test('a message whose claim is not on the record writes nothing', async () => {
  for (const item of [record({ maintenance_id: 'check#other' }), record({ maintenance_id: undefined }), null]) {
    const s = setup({ item, settings: { retireSkills: true } });
    const { result } = await run(checkMessage(), s.deps);
    assert.equal(result.status, 'skipped');
    assert.deepEqual(s.table.updates(), []);
    assert.deepEqual(s.registry.calls, []);
  }
  // A claim for another reason does not count either.
  const s = setup({ item: record({ maintenance_id: RID, maintenance_reason: 'check' }), settings: { retireSkills: true } });
  await run(retireMessage(), s.deps);
  assert.deepEqual(s.table.updates(), []);
});

// --- Check: skips and the registry state -----------------------------------

test('a check of a tombstone or a renamed record only releases the claim', async () => {
  for (const item of [record({ retired_at: '2026-09-01T00:00:00.000Z', retired_reason: 'decayed' }), record({ graduated_record_name: 'other-name' })]) {
    const s = setup({ item });
    const { result } = await run(checkMessage(), s.deps);
    assert.equal(result.status, 'skipped');
    assert.deepEqual(s.registry.calls, []);
    const after = s.table.item(KEY);
    assert.ok(claimGone(after));
    assert.equal(after.check_outcome, undefined);
  }
});

test('a check finds a skill an operator deprecated and records it', async () => {
  const s = setup({ skill: { name: NAME, skillMd: SKILL_MD, status: 'DEPRECATED' } });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'retired');
  const item = s.table.item(KEY);
  assert.equal(item.retired_reason, 'operator');
  assert.ok(claimGone(item));
  assert.equal(s.modelBuilds(), 0);
});

test('a check with the marker of an earlier retirement records that retirement', async () => {
  const s = setup({ item: record({ maintenance_deprecating: NAME, obsolete_release: '9.1.1' }), skill: { name: NAME, skillMd: SKILL_MD, status: 'DEPRECATED' } });
  await run(checkMessage(), s.deps);
  assert.equal(s.table.item(KEY).retired_reason, 'obsolete');
});

test('a check without an upstream is skipped and stays due', async () => {
  const s = setup({ settings: { upstreamRepos: {} } });
  const { result, lines } = await run(checkMessage(), s.deps);
  assert.equal(result.status, 'skipped');
  const item = s.table.item(KEY);
  assert.equal(item.check_outcome, undefined);
  assert.equal(item.verified_release, '9.1.1');
  assert.ok(claimGone(item));
  assert.ok(lines.some((l) => l.includes('no upstream repository is configured for valkey-review')), lines.join('\n'));
});

test('a record still being written in the registry keeps the claim', async () => {
  const s = setup({ skill: { name: NAME, skillMd: SKILL_MD, status: 'UPDATING' } });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'inconclusive');
  const item = s.table.item(KEY);
  assert.equal(item.maintenance_id, MID);
  assert.equal(item.check_outcome, 'inconclusive');
  assert.equal(item.verified_release, '9.1.1');
});

test('a published skill missing from the registry is retired, by the lifecycle only with its marker', async () => {
  const s = setup({ skill: null });
  await run(checkMessage(), s.deps);
  assert.equal(s.table.item(KEY).retired_reason, 'operator');
  const own = setup({ item: record({ maintenance_deprecating: NAME }), skill: null });
  await run(checkMessage(), own.deps);
  const item = own.table.item(KEY);
  assert.equal(item.retired_reason, 'decayed');
  assert.equal(item.retired_from_status, undefined);
  assert.equal(item.maintenance_deprecating, undefined);
});

test('a name whose publication never finished is not taken for an operator retirement', async () => {
  const s = setup({ item: record({ graduated_at: undefined }), skill: null });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'error');
  const item = s.table.item(KEY);
  assert.equal(item.retired_at, undefined);
  assert.ok(claimGone(item));
});

// --- Check: outcomes --------------------------------------------------------

const CLEAN_MD = '---\nname: db-flush\ndescription: Use when.\n---\n\n- `serverCron` lives in `src/server.c`.\n';

test('a clean check makes no model call and confirms the skill at the tip', async () => {
  const s = setup({
    item: record({ audit_names: new Set(['serverCron', 'src/server.c']), stale_names: new Set(['old']), stale_since: '2026-01-01', maintenance_deprecating: NAME }),
    skill: { name: NAME, skillMd: CLEAN_MD },
  });
  const { result, lines } = await run(checkMessage(), s.deps);
  assert.deepEqual(result, { status: 'completed', decision: 'clean' });
  assert.equal(s.modelBuilds(), 0);
  assert.equal(s.model.calls, 0);
  const item = s.table.item(KEY);
  assert.equal(item.check_outcome, 'clean');
  assert.equal(item.verified_sha, TIP_SHA);
  assert.equal(item.verified_ref, `unstable@${TIP_SHA.slice(0, 12)}`);
  assert.equal(item.verified_release, '9.1.2');
  assert.equal(item.verified_at, NOW);
  assert.deepEqual(set(item.audit_names), ['serverCron', 'src/server.c']);
  assert.equal(item.stale_names, undefined);
  assert.equal(item.stale_since, undefined);
  assert.ok(claimGone(item));
  // A live record was read, so a leftover marker goes.
  assert.equal(item.maintenance_deprecating, undefined);
  assert.equal(s.registry.calls.some((c) => c[0] === 'update'), false);
  assert.ok(lines.some((l) => l.startsWith('[maintenance] check ') && l.includes('outcome="clean"')), lines.join('\n'));
  assert.deepEqual(readdirSync(checkRoot), [], 'the checkout is removed');
});

test('a first check with every name present is clean', async () => {
  const s = setup({ item: record({ audit_names: undefined, verified_sha: undefined, verified_at: undefined }), skill: { name: NAME, skillMd: CLEAN_MD } });
  const { result } = await run(checkMessage({ release_tag: '' }), s.deps);
  assert.equal(result.decision, 'clean');
  const item = s.table.item(KEY);
  assert.equal(item.verified_sha, TIP_SHA);
  assert.equal(item.verified_release, '');
});

// A base the checkout says it has but the repository lacks: the diff since it is never examined.
const MISSING_BASE = 'f'.repeat(40);
const claimingBase = async (opts) => ({ ...(await prepareUpstreamCheckout(opts)), baseAvailable: true });

test('an incomplete result with nothing flagged is not confirmed and needs no model', async () => {
  const s = setup({
    item: record({ audit_names: new Set(['serverCron', 'src/server.c']), verified_sha: MISSING_BASE }),
    skill: { name: NAME, skillMd: CLEAN_MD },
    checkout: claimingBase,
  });
  const { result, lines } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'suspect');
  assert.equal(s.modelBuilds(), 0);
  const item = s.table.item(KEY);
  assert.equal(item.verified_sha, MISSING_BASE);
  assert.equal(item.verified_release, '9.1.2');
  assert.match(item.check_note, /not examined in full/);
  assert.ok(claimGone(item));
  assert.ok(lines.some((l) => l.includes('is not in the repository')), lines.join('\n'));
});

test('an accurate verdict on an incomplete result keeps the verification where it was', async () => {
  const md = '---\nname: db-flush\ndescription: Use when.\n---\n\n- `serverCron` is never `old_placeholder_name`.\n';
  const s = setup({
    item: record({ audit_names: new Set(['serverCron']), verified_sha: MISSING_BASE }),
    skill: { name: NAME, skillMd: md },
    turns: [report('accurate')],
    checkout: claimingBase,
  });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'accurate');
  const item = s.table.item(KEY);
  assert.equal(item.verified_sha, MISSING_BASE);
  assert.equal(item.verified_ref, undefined);
  assert.deepEqual(set(item.audit_names), ['serverCron']);
  assert.deepEqual(set(item.ignored_names), ['old_placeholder_name']);
});

test('valid edits with applyEdits on are claimed, written update-only, then verified', async () => {
  let atUpdate;
  const s = setup({
    turns: [{ tool: 'git', input: { args: ['grep', '-n', 'emptyData'] } }, report('revise', [EDIT])],
    settings: { checkApplyEdits: true },
    registryOpts: {
      update: (input, byName) => {
        atUpdate = structuredClone(s.table.item(KEY));
        byName.get(NAME).skillMd = input.skillMd;
        return { status: 'UPDATING' };
      },
    },
  });
  const { result, lines } = await run(checkMessage(), s.deps);
  assert.deepEqual(result, { status: 'completed', decision: 'revised' });
  // The claim's id is gone and the old text kept before the registry write.
  assert.equal(atUpdate.maintenance_id, undefined);
  assert.equal(atUpdate.previous_skill_md, SKILL_MD);
  assert.equal(atUpdate.revised_at, NOW);

  const edited = s.registry.record(NAME).skillMd;
  assert.match(edited, /<!-- suppressed: superseded in 9\.1\.2, 2026-10-13; `emptyDB` is now `emptyData`; evidence: valkey-io\/valkey@[0-9a-f]{40}:src\/db\.c:1 -->/);
  assert.ok(edited.includes(`${EDIT.original}\n<!-- /suppressed -->\n${EDIT.replacement}`));
  assert.equal(edited.includes('MODEL SUMMARY'), false);

  const item = s.table.item(KEY);
  assert.equal(item.check_outcome, 'revised');
  assert.equal(item.verified_sha, TIP_SHA);
  assert.equal(item.verified_release, '9.1.2');
  assert.deepEqual(set(item.audit_names), ['emptyData', 'serverCron', 'signalFlushedDb', 'src/db.c']);
  assert.equal(item.stale_names, undefined);
  assert.equal(item.decay_score, 0.8);
  assert.ok(claimGone(item));
  assert.equal(item.pending_revision, undefined);
  assert.ok(lines.some((l) => l.startsWith('[maintenance] edit ') && l.includes('applied=true')), lines.join('\n'));
});

test('a duplicate run loses the edit claim and never writes the registry', async () => {
  const s = setup({
    turns: [report('revise', [EDIT])],
    settings: { checkApplyEdits: true },
    hooks: {
      beforeUpdate: (input, table) => {
        // The other copy of the message claimed the edit first.
        if (input.UpdateExpression.includes('#previousskillmd')) {
          const row = table.item(KEY);
          table.put({ ...row, maintenance_id: undefined, revised_at: '2026-10-13T00:59:00.000Z' });
        }
      },
    },
  });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.status, 'skipped');
  assert.equal(s.registry.calls.some((c) => c[0] === 'update'), false);
  assert.equal(s.table.item(KEY).revised_at, '2026-10-13T00:59:00.000Z');
});

test('with applyEdits off the edits wait in pending_revision and the lost name costs standing once', async () => {
  const s = setup({ turns: [report('revise', [EDIT])] });
  const { result, lines } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'suspect');
  assert.equal(s.registry.calls.some((c) => c[0] === 'update'), false);
  const item = s.table.item(KEY);
  assert.equal(item.check_outcome, 'suspect');
  assert.equal(item.pending_revision.verdict, 'revise');
  assert.equal(item.pending_revision.reason, 'CHECK_APPLY_EDITS is off');
  assert.equal(item.pending_revision.summary, 'MODEL SUMMARY emptyDB became emptyData');
  assert.deepEqual(item.pending_revision.edits, [{ original: EDIT.original, replacement: EDIT.replacement, evidence: [`valkey-io/valkey@${TIP_SHA}:src/db.c:1`] }]);
  assert.deepEqual(set(item.stale_names), ['emptyDB']);
  assert.equal(item.stale_since, NOW);
  // 3 of the 4 baseline names are still there.
  assert.equal(item.decay_score, 0.8 * 0.75);
  assert.deepEqual(set(item.audit_names), ['serverCron', 'signalFlushedDb', 'src/db.c']);
  // The verification does not move; the release is recorded, so the next trigger checks again.
  assert.equal(item.verified_sha, BASE_SHA);
  assert.equal(item.verified_release, '9.1.2');
  assert.ok(claimGone(item));
  assert.match(item.check_note, /`emptyDB`/);
  assert.equal(item.check_note.includes('MODEL'), false);
  assert.ok(lines.some((l) => l.startsWith('[maintenance] edit ') && l.includes('applied=false')), lines.join('\n'));
});

test('accurate is refused while names are lost; a third report is accepted but changes nothing', async () => {
  const s = setup({ turns: [report('accurate'), report('accurate'), report('accurate')] });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'suspect');
  assert.equal(s.model.calls, 3);
  const item = s.table.item(KEY);
  assert.equal(item.pending_revision.reason, 'the report broke the rules and was accepted after refusals');
  assert.match(item.pending_revision.problems[0], /accurate is refused/);
  assert.equal(item.ignored_names, undefined);
});

test('accurate on new names records them as ignored and confirms the skill', async () => {
  const md = '---\nname: db-flush\ndescription: Use when.\n---\n\n- `serverCron` is never `old_placeholder_name`.\n';
  const s = setup({ item: record({ audit_names: new Set(['serverCron']) }), skill: { name: NAME, skillMd: md }, turns: [report('accurate')] });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'accurate');
  const item = s.table.item(KEY);
  assert.deepEqual(set(item.ignored_names), ['old_placeholder_name']);
  assert.equal(item.verified_sha, TIP_SHA);
  assert.equal(item.pending_revision, undefined);
});

test('obsolete without deterministic evidence is handled as suspect', async () => {
  const s = setup({ turns: [report('obsolete')] });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'suspect');
  const item = s.table.item(KEY);
  assert.equal(item.pending_revision.reason, 'obsolete without deterministic evidence');
  assert.equal(item.obsolete_release, undefined);
});

test('obsolete with every area glob empty sets the score to 0 and records the release', async () => {
  const s = setup({ item: record({ area: ['src/gone/**'] }), turns: [report('obsolete')] });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'obsolete');
  const item = s.table.item(KEY);
  assert.equal(item.check_outcome, 'obsolete');
  assert.equal(item.decay_score, 0);
  assert.equal(item.obsolete_release, '9.1.2');
  assert.ok(claimGone(item));
});

test('the penalty is conditioned on the score as read and dropped after a reinforcement', async () => {
  let bumped = false;
  const s = setup({
    turns: [report('unsure')],
    hooks: {
      beforeUpdate: (input, table) => {
        // A maintainer reinforces the record just before the check's write.
        if (!bumped && input.UpdateExpression.includes('#checkoutcome')) {
          bumped = true;
          table.put({ ...table.item(KEY), decay_score: 1, updated_at: '2026-10-13T00:30:00.000Z' });
        }
      },
    },
  });
  await run(checkMessage(), s.deps);
  const terminal = s.table.updates().filter((u) => u.input.UpdateExpression.includes('#checkoutcome'));
  assert.equal(terminal.length, 2);
  assert.match(terminal[0].input.ConditionExpression, /#decayscore = :v\d+/);
  assert.match(terminal[0].input.ConditionExpression, /#updatedat = :v\d+/);
  assert.equal(terminal[1].input.UpdateExpression.includes('#decayscore'), false);
  const item = s.table.item(KEY);
  assert.equal(item.decay_score, 1);
  assert.equal(item.check_outcome, 'suspect');
  assert.ok(claimGone(item));
});

test('the deadline, the round cap and a run without a report end inconclusive with the claim kept', async () => {
  const grep = { tool: 'git', input: { args: ['grep', 'emptyData'] } };
  for (const [turns, extra, note] of [
    [[grep], { auditDeadlineMs: 0 }, /deadline/],
    [[grep], { settings: { checkMaxRounds: 5 } }, /5 tool rounds/],
    [[{ text: 'I am done.' }], {}, /without a report/],
    [[{ error: 'model unavailable' }], {}, /audit model failed/],
  ]) {
    const s = setup({ turns, ...extra });
    const { result } = await run(checkMessage(), s.deps);
    assert.equal(result.decision, 'inconclusive');
    const item = s.table.item(KEY);
    assert.equal(item.maintenance_id, MID);
    assert.equal(item.check_outcome, 'inconclusive');
    assert.match(item.check_note, note);
    assert.equal(item.verified_release, '9.1.1');
    assert.equal(item.decay_score, 0.8);
  }
  assert.equal(CHECK_DEADLINE_MS, 12 * 60_000);
});

test('without an audit prompt a flagged skill ends inconclusive with no model', async () => {
  const s = setup({ prompt: '' });
  const { result } = await run(checkMessage(), s.deps);
  assert.equal(result.decision, 'inconclusive');
  assert.equal(s.modelBuilds(), 0);
  assert.match(s.table.item(KEY).check_note, /no audit prompt/);
});

test('without a known release an applied edit is labelled with the checked commit', async () => {
  const s = setup({ turns: [report('revise', [EDIT])], settings: { checkApplyEdits: true } });
  await run(checkMessage({ release_tag: '' }), s.deps);
  assert.ok(s.registry.record(NAME).skillMd.includes(`superseded in unstable@${TIP_SHA.slice(0, 12)}, 2026-10-13;`));
  assert.equal(s.table.item(KEY).verified_release, '');
});

test('a dry run never writes the registry and leaves the verification and standing as they were', async () => {
  const s = setup({ turns: [report('revise', [EDIT])], settings: { checkApplyEdits: true } });
  const { result, lines } = await run(checkMessage({ dry_run: true }), s.deps);
  assert.equal(result.decision, 'would-revise');
  assert.equal(s.registry.calls.some((c) => c[0] === 'update'), false);
  const item = s.table.item(KEY);
  assert.equal(item.pending_revision.reason, 'dry run');
  assert.equal(item.verified_release, '9.1.1');
  assert.equal(item.verified_sha, BASE_SHA);
  assert.equal(item.decay_score, 0.8);
  assert.equal(item.check_outcome, undefined);
  assert.equal(item.stale_names, undefined);
  assert.ok(claimGone(item));
  assert.ok(lines.some((l) => l.includes('outcome="would-revise"') && l.includes('dry_run=true')), lines.join('\n'));

  const clean = setup({ skill: { name: NAME, skillMd: CLEAN_MD }, item: record({ audit_names: new Set(['serverCron', 'src/server.c']) }) });
  await run(checkMessage({ dry_run: true }), clean.deps);
  const after = clean.table.item(KEY);
  assert.equal(after.verified_sha, BASE_SHA);
  assert.equal(after.check_outcome, undefined);
  assert.ok(claimGone(after));
});

test('the audit sees the flagged names and the skill in fenced blocks, and only read-only tools', async () => {
  const seen = [];
  const model = new ScriptedModel([report('unsure')]);
  const stream = model.stream.bind(model);
  model.stream = (messages, options) => {
    seen.push({ messages, tools: (options?.toolSpecs ?? []).map((t) => t.name) });
    return stream(messages, options);
  };
  const s = setup({ turns: model });
  await run(checkMessage(), s.deps);
  const first = JSON.stringify(seen[0].messages);
  assert.match(first, /`emptyDB`: lost/);
  assert.match(first, /<<<SKILL [0-9a-f]{24}/);
  assert.deepEqual(seen[0].tools.sort(), ['git', 'glob', 'grep', 'read', 'report_skill_check']);
});

// --- Repo check -------------------------------------------------------------

const REPO_ID = 'repo_check#valkey-review#repo-skill#2026-10-13T00:00:00.000Z';
const REPO_FILE = '# Valkey PR Reviewer Skill\n\n- Flag callers of `emptyDB` that never call `signalFlushedDb`.\n- `serverCron` runs the expire cycle.\n';
const repoMessage = (overrides = {}) => ({
  maintenance_id: REPO_ID, reason: 'repo_check', reviewer_id: REVIEWER, ...REPO_SKILL_KEY, release_tag: '9.1.2', dry_run: false, ...overrides,
});
const repoItem = (overrides = {}) => ({
  ...REPO_SKILL_KEY,
  maintenance_id: REPO_ID, maintenance_requested_at: '2026-10-13T00:00:00.000Z', maintenance_reason: 'repo_check',
  audit_names: new Set(['emptyDB', 'signalFlushedDb', 'serverCron']), verified_sha: BASE_SHA, verified_release: '9.1.1',
  ...overrides,
});
const SKILLS_REPO = { repo: 'valkey-io/valkey-review-bot', baseBranch: 'main', tokenFunction: 'skills-repo-broker' };

function repoApi() {
  const calls = [];
  return {
    calls,
    api: {
      fetchRepoFile: async (repo, ref, path) => {
        calls.push(['fetch', repo, ref, path]);
        return path === repoSkillPath(REVIEWER) ? { sha: 'c'.repeat(40), content: REPO_FILE } : null;
      },
      propose: async (p) => {
        calls.push(['propose', p]);
        return { action: 'opened', branch: `skill-check/${p.reviewerId}/${p.releaseLabel}`, url: 'https://github.com/valkey-io/valkey-review-bot/pull/9' };
      },
    },
  };
}

test('a repo check in report mode records the edits and opens no pull request', async () => {
  const r = repoApi();
  const s = setup({ item: repoItem(), turns: [report('revise', [EDIT])], settings: { skillsRepo: SKILLS_REPO }, repoSkills: async () => r.api });
  const { result } = await run(repoMessage(), s.deps);
  assert.equal(result.decision, 'suspect');
  assert.deepEqual(r.calls.map((c) => c[0]), ['fetch']);
  assert.deepEqual(r.calls[0].slice(1), ['valkey-io/valkey-review-bot', 'main', 'agents/valkey-review/config/skill.md']);
  const item = s.table.item(REPO_SKILL_KEY);
  assert.equal(item.check_outcome, 'suspect');
  assert.match(item.pending_revision.reason, /pull requests are off/);
  assert.equal(item.verified_release, '9.1.2');
  assert.ok(claimGone(item));
});

test('a repo check with pull requests on proposes code-generated text only', async () => {
  const r = repoApi();
  const s = setup({
    item: repoItem(),
    turns: [report('revise', [EDIT])],
    settings: { skillsRepo: SKILLS_REPO, checkOpenPullRequests: true },
    repoSkills: async () => r.api,
  });
  const { result } = await run(repoMessage(), s.deps);
  assert.equal(result.decision, 'proposed');
  const [, p] = r.calls.find((c) => c[0] === 'propose');
  assert.equal(p.reviewerId, REVIEWER);
  assert.equal(p.releaseLabel, '9.1.2');
  assert.equal(p.path, 'agents/valkey-review/config/skill.md');
  assert.equal(p.baseSha, 'c'.repeat(40));
  assert.equal(p.baseContent, REPO_FILE);
  assert.ok(p.newContent.includes(`${EDIT.original}\n<!-- /suppressed -->\n${EDIT.replacement}`));
  assert.equal(p.summary, `The release check of valkey-io/valkey at 9.1.2 (unstable@${TIP_SHA.slice(0, 12)}) found 1 stale piece(s) in agents/valkey-review/config/skill.md:\n- \`emptyDB\` is now \`emptyData\``);
  assert.equal(p.summary.includes('MODEL'), false);
  assert.deepEqual(p.evidence, [`valkey-io/valkey@${TIP_SHA}:src/db.c:1`]);
  const item = s.table.item(REPO_SKILL_KEY);
  assert.equal(item.check_outcome, 'proposed');
  assert.match(item.check_note, /pull request opened on skill-check\/valkey-review\/9\.1\.2/);
  assert.equal(item.verified_release, '9.1.2');
  assert.ok(claimGone(item));
});

test('a repo check in a dry run proposes nothing and leaves the release unchecked', async () => {
  const r = repoApi();
  const s = setup({
    item: repoItem(),
    turns: [report('revise', [EDIT])],
    settings: { skillsRepo: SKILLS_REPO, checkOpenPullRequests: true },
    repoSkills: async () => r.api,
  });
  await run(repoMessage({ dry_run: true }), s.deps);
  assert.equal(r.calls.some((c) => c[0] === 'propose'), false);
  const item = s.table.item(REPO_SKILL_KEY);
  assert.equal(item.verified_release, '9.1.1');
  assert.equal(item.pending_revision.reason, 'dry run');
  assert.ok(claimGone(item));
});

test('a repo check without a skills repository records why, once per release', async () => {
  const s = setup({ item: repoItem(), repoSkills: async () => repoApi().api });
  const { result } = await run(repoMessage(), s.deps);
  assert.equal(result.decision, 'skipped');
  const item = s.table.item(REPO_SKILL_KEY);
  assert.match(item.check_note, /no skills repository/);
  assert.equal(item.verified_release, '9.1.2');
});

test('a proposal whose base moved is checked again at the next pass', async () => {
  const r = repoApi();
  r.api.propose = async () => ({ action: 'base-moved', branch: 'skill-check/valkey-review/9.1.2' });
  const s = setup({
    item: repoItem(),
    turns: [report('revise', [EDIT])],
    settings: { skillsRepo: SKILLS_REPO, checkOpenPullRequests: true },
    repoSkills: async () => r.api,
  });
  const { result } = await run(repoMessage(), s.deps);
  assert.equal(result.decision, 'inconclusive');
  const item = s.table.item(REPO_SKILL_KEY);
  assert.equal(item.verified_release, '9.1.1');
  assert.ok(claimGone(item));
});

// --- Registry wiring ---------------------------------------------------------

function fakeRegistryClient(records) {
  const sent = [];
  return {
    sent,
    async send(command) {
      const op = command.constructor.name;
      sent.push(op);
      if (op === 'ListRegistryRecordsCommand') {
        const name = command.input.filters.find((f) => f.name === 'name')?.values[0];
        return { registryRecords: records.filter((r) => !name || r.name.includes(name)).map((r) => ({ recordId: r.recordId, name: r.name, status: r.status })) };
      }
      if (op === 'GetRegistryRecordCommand') {
        const r = records.find((x) => x.recordId === command.input.recordId);
        return { ...r, descriptors: { agentSkillsDefinition: { additionalData: { skillMd: { data: r.skillMd } } } } };
      }
      if (op === 'UpdateRegistryRecordStatusCommand') return { status: command.input.status };
      throw new Error(`unexpected ${op}`);
    },
  };
}

test('the feedback tools get a registry reader, and maintenance its update-only and deprecate calls', async () => {
  const client = fakeRegistryClient([{ recordId: 'r1', name: NAME, status: 'DRAFT', description: 'd', skillMd: SKILL_MD }]);
  const publisher = skillPublisher(client, 'reg');
  assert.deepEqual(Object.keys(publisher).sort(), ['exists', 'get', 'upsert']);
  const got = await publisher.get(NAME);
  assert.equal(got.skillMd, SKILL_MD);
  assert.equal(await publisher.get('db'), null);
  assert.equal(await publisher.exists(NAME), true);

  const maint = maintenanceRegistry(client, 'reg');
  assert.deepEqual(Object.keys(maint).sort(), ['deprecate', 'get', 'update']);
  assert.equal(await maint.deprecate('r1', 'valkey-reviewer: retired (decayed) 2026-10-13'), 'DEPRECATED');
  await assert.rejects(maint.update({ name: 'missing', description: 'd', skillMd: SKILL_MD }), /no skill record named "missing"/);
});

// The skills-repo PR package ships these modules; agent.ts loads them on first use.
const prModule = fileURLToPath(new URL('../dist/curator/src/repo-skill-pr.js', import.meta.url));
const tokenModule = fileURLToPath(new URL('../dist/curator/src/skills-repo-token.js', import.meta.url));
test('the skills-repo modules export what the curator loads', { skip: !existsSync(prModule) || !existsSync(tokenModule) }, async () => {
  const pr = await import(prModule);
  const token = await import(tokenModule);
  assert.equal(typeof pr.proposeRepoSkillChange, 'function');
  assert.equal(typeof pr.fetchRepoFile, 'function');
  assert.equal(typeof token.createSkillsRepoTokenSource, 'function');
});
