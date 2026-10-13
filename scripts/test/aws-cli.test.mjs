import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { AwsCliError, awsRunner, fromItem, isConditionFailure, quoted, scanItems, stackOutputs } from '../lib/aws-cli.mjs';
import { CONDITION_FAILED, fakeAws, fakeAwsCli, REPO_ROOT } from './support/aws.mjs';

/** Runs `fn` with the fake CLI's PATH and FAKE_AWS_DIR in this process's environment. */
function withEnv(env, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

test('awsRunner asks for JSON in the given region, with no pager, and parses the output', () => {
  const cli = fakeAwsCli({ 'dynamodb scan': { stdout: { Items: [] } }, 'sqs send-message': { stdout: '' } });
  withEnv(cli.env, () => {
    assert.deepEqual(awsRunner('eu-west-1')(['dynamodb', 'scan', '--table-name', 't']), { Items: [] });
    assert.equal(awsRunner(undefined)(['sqs', 'send-message']), null, 'no output is null');
  });
  const [scan, send] = cli.calls();
  assert.deepEqual(scan.args, ['dynamodb', 'scan', '--table-name', 't', '--output', 'json', '--region', 'eu-west-1']);
  assert.equal(scan.env.AWS_PAGER, '');
  assert.deepEqual(send.args, ['sqs', 'send-message', '--output', 'json'], 'no --region unless given');
});

test('a failed call throws AwsCliError with the CLI message; a lost condition is recognised', () => {
  const cli = fakeAwsCli({
    'dynamodb update-item': [{ stderr: CONDITION_FAILED, status: 254 }, { stderr: 'An error occurred (AccessDeniedException)', status: 254 }],
  });
  withEnv(cli.env, () => {
    const aws = awsRunner();
    assert.throws(() => aws(['dynamodb', 'update-item']), (err) => {
      assert.ok(err instanceof AwsCliError);
      assert.equal(err.status, 254);
      assert.match(err.message, /aws dynamodb update-item failed \(exit 254\): An error occurred \(ConditionalCheckFailedException\)/);
      assert.ok(isConditionFailure(err));
      return true;
    });
    assert.throws(() => aws(['dynamodb', 'update-item']), (err) => !isConditionFailure(err) && /AccessDenied/.test(err.message));
  });
  assert.equal(isConditionFailure(new Error('ConditionalCheckFailedException')), false, 'only a CLI error counts');
});

test('stackOutputs maps output keys to values and drops empty ones', () => {
  const aws = fakeAws({
    'cloudformation describe-stacks': () => [
      { OutputKey: 'ConcernsTableName', OutputValue: 'valkey_review_concerns' },
      { OutputKey: 'Empty', OutputValue: 'None' },
    ],
  });
  const outputs = stackOutputs(aws, 'ValkeyReviewAgent');
  assert.deepEqual([...outputs], [['ConcernsTableName', 'valkey_review_concerns']]);
  assert.deepEqual(aws.calls[0], ['cloudformation', 'describe-stacks', '--stack-name', 'ValkeyReviewAgent', '--query', 'Stacks[0].Outputs']);
});

test('fromItem reads every DynamoDB type', () => {
  assert.deepEqual(fromItem({
    s: { S: 'x' }, n: { N: '0.25' }, b: { BOOL: true }, nul: { NULL: true }, ss: { SS: ['a', 'b'] }, ns: { NS: ['1', '2'] },
    l: { L: [{ S: 'p' }, { N: '3' }] }, m: { M: { k: { S: 'v' }, l: { L: [] } } }, bin: { B: 'AAE=' },
  }), { s: 'x', n: 0.25, b: true, nul: null, ss: ['a', 'b'], ns: [1, 2], l: ['p', 3], m: { k: 'v', l: [] }, bin: 'AAE=' });
});

test('scanItems passes the expressions and returns plain items', () => {
  const aws = fakeAws({ 'dynamodb scan': () => ({ Items: [{ area_bucket: { S: 'src' } }], Count: 1 }) });
  const items = scanItems(aws, 'concerns', { projection: '#a', filter: '#a = :v', names: { '#a': 'area_bucket' }, values: { ':v': { S: 'src' } } });
  assert.deepEqual(items, [{ area_bucket: 'src' }]);
  assert.deepEqual(aws.calls[0], [
    'dynamodb', 'scan', '--table-name', 'concerns', '--projection-expression', '#a', '--filter-expression', '#a = :v',
    '--expression-attribute-names', '{"#a":"area_bucket"}', '--expression-attribute-values', '{":v":{"S":"src"}}',
  ]);
});

test('quoted keeps a value on one line and escapes non-ASCII', () => {
  assert.equal(quoted('src'), '"src"');
  assert.equal(quoted('a\nb'), '"a\\nb"');
  assert.equal(quoted('x\u202ey'), '"x\\u202ey"', 'a bidi override cannot reorder the line');
  assert.equal(quoted('\u00e9'), '"\\u00e9"');
});

test('the registry id and concerns table come from the stack outputs, in the given region', () => {
  const cli = fakeAwsCli({
    'cloudformation describe-stacks': { stdout: [{ OutputKey: 'SkillsRegistryId', OutputValue: 'reg-1' }, { OutputKey: 'ConcernsTableName', OutputValue: 'valkey_review_concerns' }] },
  });
  const code = [
    "const m = await import('./scripts/lib/registry-cli.mjs');",
    "console.log(m.resolveRegistryId({ stack: 'ValkeyReviewAgent', region: 'us-west-2' }, ['SkillsRegistryId']));",
    "console.log(m.stackOutput('ValkeyReviewAgent', 'us-west-2', ['ConcernsTableName']));",
    "m.stackOutput('ValkeyReviewAgent', 'us-west-2', ['CuratorSkillsRegistryId']);",
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: cli.env, cwd: REPO_ROOT });
  assert.equal(r.stdout, 'reg-1\nvalkey_review_concerns\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stack ValkeyReviewAgent has none of the outputs CuratorSkillsRegistryId/);
  const calls = cli.calls();
  assert.equal(calls.length, 1, 'the outputs are read once per stack');
  assert.deepEqual(calls[0].args.slice(-4), ['--output', 'json', '--region', 'us-west-2']);
});
