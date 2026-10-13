import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeAwsCli, runShell } from './support/aws.mjs';

const S = (S) => ({ S });
const ITEMS = [
  {
    area_bucket: S('#maintenance'), record_id: S('repo-skill'), verified_release: S('9.1.2'), verified_at: S('2026-10-01T00:00:00.000Z'),
    check_outcome: S('suspect'), check_note: S('1 name missing'),
    maintenance_id: S('repo_check#valkey-review#repo-skill#2026-10-13T00:00:00.000Z'),
    maintenance_requested_at: S('2026-10-13T00:00:00.000Z'), maintenance_reason: S('repo_check'),
  },
  { area_bucket: S('#other'), record_id: S('x'), subject: S('hidden') },
  {
    area_bucket: S('src'), record_id: S('r1'), subject: S('RDB load\u001b[2J'), area: { L: [S('src/rdb.c')] },
    reinforcement_count: { N: '3' }, reinforcers: { SS: ['a', 'b'] }, decay_score: { N: '0.9' }, updated_at: S('2026-09-01T00:00:00.000Z'),
    graduated_record_name: S('rdb-load'), graduated_at: S('2026-09-02T00:00:00.000Z'), skill_generation: { N: '2' },
    verified_release: S(''), verified_ref: S('unstable@0eb4ba3c1d2e'), verified_at: S('2026-10-12T00:00:00.000Z'),
    check_outcome: S('suspect'), check_note: S('1 of 5 names missing at unstable@0eb4ba3c1d2e: `emptyDB`'),
    stale_names: { SS: ['emptyDB'] }, stale_since: S('2026-10-12T00:00:00.000Z'),
    maintenance_id: S('check#valkey-review#r1#2026-10-13T00:00:00.000Z'), maintenance_requested_at: S('2026-10-13T00:00:00.000Z'), maintenance_reason: S('check'),
    pending_revision: { M: {
      at: S('2026-10-12T00:00:00.000Z'), verdict: S('revise'), reason: S('applyEdits off'), summary: S('renamed\nfake line\u202e'),
      edits: { L: [
        { M: {
          original: S('Call `emptyDB` first.\nThen load.\n'), replacement: S('Call `emptyData` first.\nThen load.'),
          evidence: { L: [S('valkey-io/valkey@0eb4ba3c1d2e0eb4ba3c1d2e0eb4ba3c1d2e0eb4:src/db.c:12')] },
        } },
        { M: { find: S('`rdbLoad`'), replace: S('`rdbLoadRio`'), path: S('src/rdb.c'), line: { N: '40' } } },
      ] },
    } },
    concern: S('two\nlines'), context: S(''),
  },
  {
    area_bucket: S('src'), record_id: S('r2'), subject: S('old'), reinforcement_count: { N: '5' }, updated_at: S('2026-01-01T00:00:00.000Z'),
    graduated_record_name: S('old-skill'), retired_at: S('2026-10-01T00:00:00.000Z'), retired_reason: S('decayed'), retired_from_status: S('DRAFT'),
    obsolete_release: S('9.1.1'), revised_at: S('2026-09-20T00:00:00.000Z'),
  },
  { area_bucket: S('tests'), record_id: S('r3'), subject: S('plain'), reinforcement_count: { N: '1' }, updated_at: S('2026-10-01T00:00:00.000Z') },
];

async function dump(args, responses = {}) {
  const cli = fakeAwsCli({
    'cloudformation describe-stacks': { stdout: 'valkey_review_concerns\n' },
    'dynamodb scan': { stdout: { Items: ITEMS } },
    ...responses,
  });
  const r = await runShell('concerns-dump.sh', args, { env: cli.env });
  return { ...r, calls: cli.calls() };
}

test('--region applies to every call, wherever it is given', async () => {
  const r = await dump(['--stack', 'ValkeyReviewAgent', '--region', 'eu-west-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => [c.op, c.env.AWS_REGION]), [
    ['cloudformation describe-stacks', 'eu-west-1'],
    ['dynamodb scan', 'eu-west-1'],
  ]);
  assert.match(r.stdout, /^ {2}table: valkey_review_concerns$/m);
});

test('bad arguments print the usage and make no call', async () => {
  for (const args of [[], ['--bogus'], ['--region']]) {
    const r = await dump(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /usage: .*concerns-dump\.sh|--region needs a region/, args.join(' '));
    assert.deepEqual(r.calls, [], args.join(' '));
  }
});
