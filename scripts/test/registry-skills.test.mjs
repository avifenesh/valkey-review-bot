import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptedRecordId } from '../lib/adopt.mjs';
import { deprecateTarget, findOrphans, graduatedNames } from '../lib/skill-records.mjs';
import { CONDITION_FAILED, fakeAws, fakeAwsCli, flag, runScript, typed } from './support/aws.mjs';
import { failingRegistry, fakeRegistry, registryEnv } from './support/registry.mjs';

const isRetired = (s) => s === 'DEPRECATED' || s === 'REJECTED';

const RECORDS = [
  { recordId: 'r-a', name: 'kept', status: 'DRAFT' },
  { recordId: 'r-b', name: 'orphan-b', status: 'APPROVED' },
  { recordId: 'r-c', name: 'gone', status: 'DEPRECATED' },
  { recordId: 'r-d', name: 'refused', status: 'REJECTED' },
  { recordId: 'r-e', name: 'orphan-a', status: 'DRAFT' },
  { recordId: 'r-f', name: 'tomb-name', status: 'DRAFT' },
];

test('findOrphans lists live records no concern record names, by name', () => {
  const referenced = new Set(['kept', 'tomb-name', 'gone']);
  assert.deepEqual(findOrphans(RECORDS, referenced, isRetired).map((r) => r.recordId), ['r-e', 'r-b']);
  assert.deepEqual(findOrphans([], referenced, isRetired), []);
});

test('graduatedNames scans the graduated names of concern records, tombstones included', () => {
  const aws = fakeAws({
    'dynamodb scan': () => ({ Items: [
      typed({ area_bucket: 'src', graduated_record_name: 'a' }),
      typed({ area_bucket: 'src', graduated_record_name: 'b', retired_at: '2026-10-01T00:00:00.000Z' }),
      typed({ area_bucket: 'src', graduated_record_name: '' }),
      // Not a concern record, so it names no skill: an orphan stays an orphan.
      typed({ area_bucket: '#maintenance', graduated_record_name: 'orphan' }),
    ] }),
  });
  assert.deepEqual([...graduatedNames(aws, 'valkey_review_concerns')], ['a', 'b']);
  const args = aws.calls[0];
  assert.equal(flag(args, '--projection-expression'), '#b, #grn');
  assert.equal(flag(args, '--filter-expression'), 'attribute_exists(#grn)');
  assert.deepEqual(JSON.parse(flag(args, '--expression-attribute-names')), { '#b': 'area_bucket', '#grn': 'graduated_record_name' });
});

test('deprecateTarget takes the one live record with the name, or the given id', () => {
  const twice = [...RECORDS, { recordId: 'r-g', name: 'kept', status: 'DEPRECATED' }, { recordId: 'r-h', name: 'dup', status: 'DRAFT' }, { recordId: 'r-i', name: 'dup', status: 'DRAFT' }];
  assert.equal(deprecateTarget(twice, { name: 'kept' }, isRetired), 'r-a', 'a retired namesake is not a candidate');
  assert.throws(() => deprecateTarget(twice, { name: 'gone' }, isRetired), /no record named gone that is not already deprecated or rejected/);
  assert.throws(() => deprecateTarget(twice, { name: 'refused' }, isRetired), /not already deprecated or rejected/);
  assert.throws(() => deprecateTarget(twice, { name: 'dup' }, isRetired), /2 records are named dup \(r-h, r-i\); pass --record-id/);
  assert.equal(deprecateTarget(twice, { recordId: 'r-c' }, isRetired), 'r-c');
  assert.throws(() => deprecateTarget(twice, { recordId: 'nope' }, isRetired), /no SKILL record nope/);
});

/** Runs registry-skills.mjs against a fake registry holding RECORDS and a fake CLI. */
async function registrySkills(args, cliResponses = {}) {
  const registry = await fakeRegistry(RECORDS);
  const cli = fakeAwsCli({
    'cloudformation describe-stacks': { stdout: [
      { OutputKey: 'SkillsRegistryId', OutputValue: 'reg-1' },
      { OutputKey: 'ConcernsTableName', OutputValue: 'valkey_review_concerns' },
    ] },
    'dynamodb scan': { stdout: { Items: [typed({ graduated_record_name: 'kept' }), typed({ graduated_record_name: 'tomb-name' })] } },
    ...cliResponses,
  });
  try {
    const r = await runScript('registry-skills.mjs', args, { env: registryEnv(cli.env, registry) });
    return { ...r, calls: cli.calls(), requests: registry.requests };
  } finally {
    await registry.close();
  }
}

test('orphans --stack reads the registry and table from the stack and lists the orphans', async () => {
  const r = await registrySkills(['orphans', '--stack', 'ValkeyReviewAgent', '--region', 'eu-west-1']);
  assert.equal(r.code, 0, r.stderr);
  const rows = r.stdout.split('\n').filter((l) => l.includes('\t'));
  assert.deepEqual(rows.map((l) => l.split('\t').slice(0, 3)), [['orphan-a', 'r-e', 'DRAFT'], ['orphan-b', 'r-b', 'APPROVED']]);
  assert.match(r.stdout, /2 live skill\(s\) in registry reg-1 that no concern record in valkey_review_concerns names/);
  // Deprecation is final; the way into the lifecycle is adopt, a dry run unless --apply is added.
  assert.match(r.stdout, /^ {2}node scripts\/registry-skills\.mjs adopt --stack ValkeyReviewAgent --region eu-west-1$/m);
  assert.ok(!r.stdout.includes('deprecate'), 'no deprecate command is offered');
  assert.deepEqual(r.calls.map((c) => c.op), ['cloudformation describe-stacks', 'dynamodb scan'], 'the stack is read once');
  assert.ok(r.calls.every((c) => flag(c.args, '--region') === 'eu-west-1'));
  assert.equal(flag(r.calls[1].args, '--table-name'), 'valkey_review_concerns');
  assert.ok(r.requests.every((q) => q.method === 'POST' && q.url === '/registries/reg-1/records-list'), 'read only');
});

test('orphans with --registry-id and --table needs no stack; none found says so', async () => {
  const r = await registrySkills(['orphans', '--registry-id', 'reg-1', '--table', 'valkey_review_concerns'], {
    'dynamodb scan': { stdout: { Items: ['kept', 'orphan-a', 'orphan-b', 'tomb-name'].map((n) => typed({ graduated_record_name: n })) } },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^no orphaned skills in registry reg-1: every live skill has a concern record in valkey_review_concerns$/m);
  assert.deepEqual(r.calls.map((c) => c.op), ['dynamodb scan']);
});

test('orphans with --registry-id points at adopt with the same registry and table', async () => {
  const r = await registrySkills(['orphans', '--registry-id', 'reg-1', '--table', 'valkey_review_concerns']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ {2}node scripts\/registry-skills\.mjs adopt --registry-id reg-1 --table valkey_review_concerns$/m);
});

test('orphans refuses a missing table, and --table outside orphans', async () => {
  for (const [args, message] of [
    [['orphans', '--registry-id', 'reg-1'], /orphans needs --stack REVIEWER_STACK, or --registry-id with --table/],
    [['list', '--registry-id', 'reg-1', '--table', 't'], /--table is only for orphans and adopt/],
    [['orphan', '--registry-id', 'reg-1'], /expected "list", "deprecate", "orphans" or "adopt"/],
  ]) {
    const r = await registrySkills(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, message);
    assert.deepEqual([r.calls.length, r.requests.length], [0, 0], 'nothing is called');
  }
});

test('a failed scan fails orphans with the table named', async () => {
  const r = await registrySkills(['orphans', '--registry-id', 'reg-1', '--table', 'valkey_review_concerns'], {
    'dynamodb scan': { stderr: 'An error occurred (AccessDeniedException) when calling the Scan operation\n', status: 254 },
  });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not scan valkey_review_concerns: aws dynamodb scan failed \(exit 254\): An error occurred \(AccessDeniedException\)/);
});

test('deprecate goes through deprecateSkill: the reason is cut to the service limit', async () => {
  const reason = `  ${'x'.repeat(300)}  `;
  const r = await registrySkills(['deprecate', '--registry-id', 'reg-1', '--name', 'orphan-b', '--reason', reason]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^deprecated r-b status=DEPRECATED$/m);
  const patch = r.requests.find((q) => q.method === 'PATCH');
  assert.equal(patch.url, '/registries/reg-1/records/r-b/status');
  assert.deepEqual(patch.body, { status: 'DEPRECATED', statusReason: 'x'.repeat(256) });
});

test('deprecate by name refuses a name whose records are all retired', async () => {
  const r = await registrySkills(['deprecate', '--registry-id', 'reg-1', '--name', 'refused', '--reason', 'r']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no record named refused that is not already deprecated or rejected in registry reg-1/);
  assert.ok(!r.requests.some((q) => q.method === 'PATCH'));
});

test('list shows registry names, ids and statuses without control or format characters', async () => {
  const registry = await fakeRegistry([{ recordId: 'r-\u001b[2J', name: 'evil\tname\u202e\n', status: 'DRAFT\u009b' }]);
  try {
    const r = await runScript('registry-skills.mjs', ['list', '--registry-id', 'reg-1'], { env: registryEnv(fakeAwsCli({}).env, registry) });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'evil name? \tr-?[2J\tDRAFT?\t2026-10-01T00:00:00.000Z\n', 'one row of four columns');
  } finally {
    await registry.close();
  }
});

test('a registry error is one printable error line, not a stack trace', async () => {
  const registry = await failingRegistry('no such registry \u001b[2J\u202e');
  try {
    for (const script of [['registry-skills.mjs', 'list'], ['publish-curator-skills.mjs']]) {
      const r = await runScript(script[0], [...script.slice(1), '--registry-id', 'reg-1'], { env: registryEnv(fakeAwsCli({}).env, registry) });
      assert.equal(r.code, 1, script[0]);
      assert.match(r.stderr, /^error: registry reg-1: .*no such registry \?\[2J\?/, script[0]);
      assert.ok(!/[\u001b\u202e]/.test(r.stderr), script[0]);
      assert.ok(!r.stderr.includes('    at '), `${script[0]}: no stack trace`);
    }
  } finally {
    await registry.close();
  }
});

const RDB_MD = '---\nname: rdb-load\ndescription: "Use when a change touches `src/rdb.c`."\n---\n\n# RDB loading rules\n\nCall `rdbLoadRio` in `src/rdb.c` and `src/rio.h`.\n';
const ADOPT_RECORDS = [
  { recordId: 'r-kept', name: 'kept', status: 'DRAFT', md: '# Kept\n' },
  { recordId: 'r-rdb', name: 'rdb-load', status: 'APPROVED', description: 'Check RDB loading.\n\nGraduated from concern record_id=old-1.', md: RDB_MD },
  { recordId: 'r-gone', name: 'gone', status: 'DEPRECATED', md: '# Gone\n' },
  { recordId: 'r-bad', name: 'Bad Name', status: 'DRAFT', md: '# Bad\n' },
  { recordId: 'r-dup1', name: 'dup', status: 'DRAFT', md: '# Dup\n' },
  { recordId: 'r-dup2', name: 'dup', status: 'DRAFT', md: '# Dup\n' },
  { recordId: 'r-busy', name: 'busy', status: 'CREATING', md: '# Busy\n' },
  { recordId: 'r-gen', name: 'general', status: 'DRAFT', description: 'Prefer small, focused changes.', md: '# General review rules\n\nNo code names here.\n' },
];

/** Runs registry-skills.mjs adopt against ADOPT_RECORDS and a fake CLI whose table names only "kept". */
async function adopt(args, cliResponses = {}) {
  const registry = await fakeRegistry(ADOPT_RECORDS);
  const cli = fakeAwsCli({
    'cloudformation describe-stacks': { stdout: [
      { OutputKey: 'SkillsRegistryId', OutputValue: 'reg-1' },
      { OutputKey: 'ConcernsTableName', OutputValue: 'valkey_review_concerns' },
      { OutputKey: 'CuratorRuntimeId', OutputValue: 'curator-abc' },
    ] },
    // The first scan lists every graduated name; each later one looks up one name just before its write.
    'dynamodb scan': [{ stdout: { Items: [typed({ area_bucket: 'src', graduated_record_name: 'kept' })] } }, { stdout: { Items: [] } }],
    'dynamodb put-item': { stdout: '' },
    ...cliResponses,
  });
  try {
    const r = await runScript('registry-skills.mjs', ['adopt', ...args], { env: registryEnv(cli.env, registry) });
    return { ...r, calls: cli.calls(), requests: registry.requests };
  } finally {
    await registry.close();
  }
}

const SKIPS = [
  'skipped name="Bad Name" record="r-bad": the name is not one the lifecycle accepts (lowercase letters, digits and hyphens, at most 100)',
  'skipped name="busy" record="r-busy": status CREATING: the release check acts only on DRAFT, PENDING_APPROVAL or APPROVED records; run adopt again once it is one',
  'skipped name="dup" record="r-dup1": 2 live records share the name, and a concern record names one skill by name',
  'skipped name="dup" record="r-dup2": 2 live records share the name, and a concern record names one skill by name',
];
const GENERAL = `name="general" record="r-gen" bucket="**" id="${adoptedRecordId('general')}" area=["**"]`;
const RDB = `name="rdb-load" record="r-rdb" bucket="src" id="${adoptedRecordId('rdb-load')}" area=["src/rdb.c","src/rio.h"]`;

test('adopt is a dry run by default: one line per skill, nothing written', async () => {
  const r = await adopt(['--stack', 'ValkeyReviewAgent', '--region', 'eu-west-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.stdout.split('\n\n')[0].split('\n'), [
    ...SKIPS,
    `would-adopt ${GENERAL}`,
    'skipped name="gone" record="r-gone": DEPRECATED: a retired skill stays out of the lifecycle',
    'skipped name="kept" record="r-kept": a concern record already names it, so it is in the lifecycle',
    `would-adopt ${RDB}`,
  ]);
  assert.match(r.stdout, /^dry run: would adopt 2 skill\(s\) into valkey_review_concerns at reinforcement_count 4 \(the curator's default; pass --threshold or --curator-stack if the deployed curator sets another\); skipped 6; errors 0\.$/m);
  assert.match(r.stdout, /^Nothing was written\. Run again with --apply to write them\.$/m);
  assert.match(r.stdout, /^1 of them cite no directory, so their bucket is "\*\*"; --bucket chooses another, such as src\.$/m);
  assert.deepEqual(r.calls.map((c) => c.op), ['cloudformation describe-stacks', 'dynamodb scan'], 'no write, and no second scan');
  assert.ok(r.calls.every((c) => flag(c.args, '--region') === 'eu-west-1'));
  assert.ok(r.requests.every((q) => q.method === 'GET' || (q.method === 'POST' && q.url === '/registries/reg-1/records-list')), 'the registry is only read');
});

test('adopt --apply writes one conditional put per skill, at the curator runtime\'s threshold', async () => {
  const r = await adopt(['--stack', 'ValkeyReviewAgent', '--curator-stack', 'ValkeyReviewerCurator', '--bucket', 'src', '--apply'], {
    'bedrock-agentcore-control get-agent-runtime': { stdout: '"6"\n' },
  });
  assert.equal(r.code, 0, r.stderr);
  const lines = r.stdout.split('\n\n')[0].split('\n');
  assert.deepEqual(lines.filter((l) => l.startsWith('adopted')), [
    `adopted name="general" record="r-gen" bucket="src" id="${adoptedRecordId('general')}" area=["**"]`,
    `adopted ${RDB}`,
  ]);
  assert.match(r.stdout, /^adopted 2 skill\(s\) into valkey_review_concerns at reinforcement_count 6 \(GRADUATION_THRESHOLD of the curator runtime of stack ValkeyReviewerCurator\); skipped 6; errors 0\.$/m);

  const runtime = r.calls.find((c) => c.op === 'bedrock-agentcore-control get-agent-runtime');
  assert.equal(flag(runtime.args, '--agent-runtime-id'), 'curator-abc');
  assert.equal(flag(runtime.args, '--query'), 'environmentVariables.GRADUATION_THRESHOLD', 'no other runtime setting is read');
  assert.deepEqual(r.calls.filter((c) => c.op.startsWith('dynamodb')).map((c) => c.op), [
    'dynamodb scan', 'dynamodb scan', 'dynamodb put-item', 'dynamodb scan', 'dynamodb put-item',
  ], 'each name is looked up again right before its write');
  const lookup = r.calls.filter((c) => c.op === 'dynamodb scan')[2];
  assert.deepEqual(JSON.parse(flag(lookup.args, '--expression-attribute-values')), { ':name': { S: 'rdb-load' } });

  const puts = r.calls.filter((c) => c.op === 'dynamodb put-item');
  assert.ok(puts.every((c) => flag(c.args, '--table-name') === 'valkey_review_concerns'));
  assert.ok(puts.every((c) => flag(c.args, '--condition-expression') === 'attribute_not_exists(#rid)'));
  const item = JSON.parse(flag(puts[1].args, '--item'));
  const now = item.created_at.S;
  assert.ok(Math.abs(Date.parse(now) - Date.now()) < 60_000);
  assert.deepEqual(item, {
    area_bucket: { S: 'src' },
    record_id: { S: adoptedRecordId('rdb-load') },
    area: { L: [{ S: 'src/rdb.c' }, { S: 'src/rio.h' }] },
    subject: { S: 'RDB loading rules' },
    concern: { S: 'Check RDB loading.' },
    context: { S: `Adopted into the skill lifecycle from registry record r-rdb on ${now.slice(0, 10)}. The skill was published outside the curator, so no maintainer reinforcement is recorded behind it.` },
    reinforcement_count: { N: '6' },
    decay_score: { N: '1' },
    created_at: { S: now },
    updated_at: { S: now },
    graduated_record_name: { S: 'rdb-load' },
    graduated_at: { S: now },
  });
});

test('adopt --apply adds no second record: a name found on the second look, or a key already written, is skipped', async () => {
  const r = await adopt(['--registry-id', 'reg-1', '--table', 'valkey_review_concerns', '--threshold', '5', '--apply'], {
    'dynamodb scan': [
      { stdout: { Items: [typed({ area_bucket: 'src', graduated_record_name: 'kept' })] } },
      { stdout: { Items: [typed({ area_bucket: 'src', record_id: 'x', graduated_record_name: 'general' })] } },
      { stdout: { Items: [] } },
    ],
    'dynamodb put-item': { stderr: CONDITION_FAILED, status: 254 },
  });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^skipped name="general" record="r-gen": a concern record has named it since adopt started$/m);
  assert.match(r.stdout, /^skipped name="rdb-load" record="r-rdb": an item with its key is in valkey_review_concerns already \(an earlier adopt wrote it\)$/m);
  assert.match(r.stdout, /^adopted 0 skill\(s\) into valkey_review_concerns at reinforcement_count 5 \(--threshold\); skipped 8; errors 0\.$/m);
  assert.equal(r.calls.filter((c) => c.op === 'dynamodb put-item').length, 1);
});

test('a failed put is an error line and exit 1; the other skills are still adopted', async () => {
  const r = await adopt(['--stack', 'ValkeyReviewAgent', '--apply'], {
    'dynamodb put-item': [{ stderr: 'An error occurred (AccessDeniedException) when calling the PutItem operation\n', status: 254 }, { stdout: '' }],
  });
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^error name="general" record="r-gen": aws dynamodb put-item failed \(exit 254\): An error occurred \(AccessDeniedException\)/m);
  assert.match(r.stdout, /^adopted name="rdb-load"/m);
  assert.match(r.stdout, /^adopted 1 skill\(s\) .*; skipped 6; errors 1\.$/m);
});

test('a curator runtime without GRADUATION_THRESHOLD gives the curator default; a bad one stops adopt', async () => {
  const unset = await adopt(['--stack', 'ValkeyReviewAgent', '--curator-stack', 'ValkeyReviewerCurator'], {
    'bedrock-agentcore-control get-agent-runtime': { stdout: 'null\n' },
  });
  assert.equal(unset.code, 0, unset.stderr);
  assert.match(unset.stdout, /at reinforcement_count 4 \(the curator's default: the runtime of ValkeyReviewerCurator sets no GRADUATION_THRESHOLD\)/);
  const bad = await adopt(['--stack', 'ValkeyReviewAgent', '--curator-stack', 'ValkeyReviewerCurator'], {
    'bedrock-agentcore-control get-agent-runtime': { stdout: '"1"\n' },
  });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /GRADUATION_THRESHOLD of the curator runtime of stack ValkeyReviewerCurator must be between 2 and 100, got 1/);
  const failed = await adopt(['--stack', 'ValkeyReviewAgent', '--curator-stack', 'ValkeyReviewerCurator'], {
    'bedrock-agentcore-control get-agent-runtime': { stderr: 'An error occurred (AccessDeniedException)\n', status: 254 },
  });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /could not read the curator runtime of stack ValkeyReviewerCurator: .*AccessDeniedException.*; pass --threshold instead/);
  for (const r of [bad, failed]) assert.ok(!r.calls.some((c) => c.op === 'dynamodb put-item'));
});

test('adopt refuses bad flags before any call, and its flags outside adopt', async () => {
  for (const [args, message] of [
    [['adopt', '--registry-id', 'reg-1'], /adopt needs --stack REVIEWER_STACK, or --registry-id with --table/],
    [['adopt', '--stack', 'S', '--threshold', '4', '--curator-stack', 'C'], /pass --threshold or --curator-stack, not both/],
    [['adopt', '--stack', 'S', '--threshold', '1'], /--threshold must be between 2 and 100, got 1/],
    [['adopt', '--stack', 'S', '--bucket', '#maintenance'], /--bucket: buckets starting with "#" are reserved/],
    [['list', '--registry-id', 'reg-1', '--apply'], /--apply is only for adopt/],
    [['orphans', '--stack', 'S', '--threshold', '4'], /--threshold is only for adopt/],
    [['list', '--registry-id', 'reg-1', '--bucket', 'src'], /--bucket is only for adopt/],
  ]) {
    const r = await registrySkills(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, message, args.join(' '));
    assert.deepEqual([r.calls.length, r.requests.length], [0, 0], `${args.join(' ')}: nothing is called`);
  }
});
