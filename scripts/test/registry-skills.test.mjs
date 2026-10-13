import assert from 'node:assert/strict';
import test from 'node:test';
import { deprecateTarget, findOrphans, graduatedNames } from '../lib/skill-records.mjs';
import { fakeAws, fakeAwsCli, flag, runScript, typed } from './support/aws.mjs';
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
  assert.match(r.stdout, /registry-skills\.mjs deprecate --stack ValkeyReviewAgent --record-id RECORD_ID/);
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

test('orphans refuses a missing table, and --table outside orphans', async () => {
  for (const [args, message] of [
    [['orphans', '--registry-id', 'reg-1'], /orphans needs --stack REVIEWER_STACK, or --registry-id with --table/],
    [['list', '--registry-id', 'reg-1', '--table', 't'], /--table is only for orphans/],
    [['orphan', '--registry-id', 'reg-1'], /expected "list", "deprecate" or "orphans"/],
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
