import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import '../../../ops/test/support/ts-resolve.mjs';
import { handleMaintenance } from '../dist/curator/src/maintenance.js';
import { buildUpdateConcernTool } from '../dist/curator/src/tools/concerns-ddb.js';
import { buildSubmitSkillTool } from '../dist/curator/src/tools/submit-skill.js';
import { captureLogs, drain, fakeRegistry, makeUpstream, memoryTable, ScriptedModel, tempDir } from './maintenance-fakes.mjs';
import { newRun, parse } from './helpers.mjs';

// The decay pass from ops, run on the curator's writes, so its rules are
// the ones these tests hold to. Needs `npm ci` in ops.
const decay = await import('../../../ops/src/decay.ts');

/**
 * The skill lifecycle across its three writers: the curator's release
 * check, the feedback path's submit_skill, and the daily decay pass.
 */

const TABLE = 'valkey_review_concerns';
const REVIEWER = 'valkey-review';
const NAME = 'module-loading';
const KEY = { area_bucket: 'src', record_id: 'rec-1' };
const DAY_MS = 24 * 3600 * 1000;
// submit_skill stamps the wall clock, so the other writers run around it.
const START = Date.now();
const iso = (ms) => new Date(ms).toISOString();

const SKILL_MD = [
  '---',
  `name: ${NAME}`,
  'description: Use when a PR changes how modules are loaded.',
  '---',
  '',
  '# Loading modules',
  '',
  '- `moduleLoad` reads the shared object; flag callers that skip `serverCron` bookkeeping.',
  '',
].join('\n');
const CORRECTED_MD = SKILL_MD.replace('`moduleLoad` reads', '`moduleLoadFromDisk` reads');

// The module code moved from src/module.c to src/modules/, with a rename.
const up = makeUpstream([
  { 'src/module.c': 'int moduleLoad(void) {\n    return 0;\n}\n', 'src/server.c': 'int serverCron(void) {\n    return 0;\n}\n' },
  { 'src/module.c': null, 'src/modules/load.c': 'int moduleLoadFromDisk(void) {\n    return 0;\n}\n' },
]);
const checkRoot = tempDir('lifecycle-checkouts-');
after(() => up.cleanup());

const CHECK_ID = `check#${REVIEWER}#${KEY.record_id}#${iso(START - 2 * 3600_000)}`;

function record() {
  return {
    ...KEY,
    subject: 'Loading modules',
    concern: 'Module loading skips bookkeeping.',
    area: ['src/module.c'],
    reinforcement_count: 5,
    reinforcers: new Set(['a#valkey-io/valkey#1']),
    decay_score: 0.8,
    updated_at: iso(START - 30 * DAY_MS),
    decayed_at: iso(START - 1 * DAY_MS),
    graduated_record_name: NAME,
    graduated_at: iso(START - 60 * DAY_MS),
    audit_names: new Set(['moduleLoad', 'serverCron']),
    verified_sha: up.shas[0],
    verified_release: '9.1.1',
    verified_at: iso(START - 20 * DAY_MS),
    maintenance_id: CHECK_ID,
    maintenance_requested_at: iso(START - 2 * 3600_000),
    maintenance_reason: 'check',
  };
}

/** The deps of one maintenance run at `nowMs`; `turns` script the audit. */
function maintenanceDeps(table, registry, nowMs, turns) {
  return {
    ddb: table,
    table: TABLE,
    registry,
    settings: {
      upstreamRepos: { [REVIEWER]: 'valkey-io/valkey' },
      checkApplyEdits: false,
      retireSkills: true,
      checkOpenPullRequests: false,
      skillsRepo: null,
      checkDir: checkRoot,
      checkMaxRounds: 10,
    },
    audit: { model: () => new ScriptedModel(turns), systemPrompt: 'audit' },
    upstreamUrl: () => up.url,
    now: () => new Date(nowMs),
    printer: false,
  };
}

/** submit_skill's registry calls on the fake registry, whose record the release check also reads. */
function publisher(registry) {
  return {
    get: (name) => registry.get(name),
    exists: async (name) => registry.record(name) !== undefined,
    async upsert(input) {
      const r = registry.record(input.name);
      Object.assign(r, { skillMd: input.skillMd, description: input.description });
      return { action: 'updated', recordArn: r.recordArn, status: r.status };
    },
  };
}

/** One decay pass at `nowMs` with checks and retirement on; returns the messages it queued. */
async function decayPass(table, nowMs) {
  const sent = [];
  const sqs = { async send(command) { sent.push(JSON.parse(command.input.MessageBody)); return {}; } };
  const config = decay.loadDecayConfig({
    CONCERNS_TABLES_JSON: JSON.stringify({ [REVIEWER]: TABLE }),
    UPSTREAM_REPOS_JSON: JSON.stringify({ [REVIEWER]: 'valkey-io/valkey' }),
    CURATOR_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/curator',
    RETIRE_SKILLS: 'true',
  });
  await captureLogs(() => decay.decayTable(table, TABLE, config, nowMs, { reviewerId: REVIEWER, releaseTag: '9.1.2', recheckAll: false, dryRun: false, sqs }));
  return sent;
}

test('a skill corrected after an obsolete finding is checked again by the next decay pass, not retired', async () => {
  const table = memoryTable([
    record(),
    // Checked at this release already, so the pass queues no repo skill.md check.
    { area_bucket: '#maintenance', record_id: 'repo-skill', verified_release: '9.1.2', verified_at: iso(START - DAY_MS) },
  ]);
  const registry = fakeRegistry([{ name: NAME, skillMd: SKILL_MD, description: 'Use when.\n\nGraduated from concern record_id=rec-1.' }]);

  // 1. The release check finds the subject gone: src/module.c, the whole area, has no file left.
  const checkMessage = {
    maintenance_id: CHECK_ID, reason: 'check', reviewer_id: REVIEWER, ...KEY, record_name: NAME,
    release_tag: '9.1.2', seen_updated_at: record().updated_at, dry_run: false,
  };
  const obsolete = { tool: 'report_skill_check', input: { verdict: 'obsolete', summary: 'src/module.c is gone', edits: [] } };
  const checked = await captureLogs(() => drain(handleMaintenance(checkMessage, maintenanceDeps(table, registry, START - 3600_000, [obsolete]))));
  assert.equal(checked.value.result.decision, 'obsolete');
  assert.equal(table.item(KEY).decay_score, 0);
  assert.equal(table.item(KEY).obsolete_release, '9.1.2');

  // 2. A maintainer says the code moved; the feedback run corrects the area and re-publishes.
  const run = newRun();
  const deps = { ddb: table, table: TABLE, run, registry: publisher(registry) };
  const updated = parse(await buildUpdateConcernTool(deps).invoke({ ...KEY, area: ['src/modules/**'], context_addition: 'Module loading moved to src/modules/.' }));
  assert.equal(updated.ok, true, updated.error);
  const submitted = parse(await buildSubmitSkillTool(deps).invoke({
    area_bucket: KEY.area_bucket, source_record_id: KEY.record_id, subject: 'Loading modules',
    description: 'Use when a PR changes how modules are loaded.', skill_md: CORRECTED_MD,
  }));
  assert.equal(submitted.ok, true, submitted.error);
  const published = table.item(KEY);
  assert.equal(published.obsolete_release, undefined);
  assert.equal(published.decay_score, 1, 'the standing the obsolete finding took is back');
  assert.ok(Date.parse(published.decayed_at) >= START, 'counted from the re-publication');

  // 3. The next decay pass queues a check of the new text and no retirement.
  const sent = await decayPass(table, Date.now() + DAY_MS);
  assert.deepEqual(sent.map((m) => [m.reason, m.record_id]), [['check', KEY.record_id]]);
  assert.ok(table.item(KEY).decay_score > 0.99, String(table.item(KEY).decay_score));

  // 4. That check confirms the corrected text with no audit.
  const confirmed = await captureLogs(() => drain(handleMaintenance(sent[0], maintenanceDeps(table, registry, Date.now() + DAY_MS, []))));
  assert.equal(confirmed.value.result.decision, 'clean');
  const item = table.item(KEY);
  assert.equal(item.check_outcome, 'clean');
  assert.equal(item.retired_at, undefined);
  assert.equal(registry.record(NAME).status, 'DRAFT');
});
