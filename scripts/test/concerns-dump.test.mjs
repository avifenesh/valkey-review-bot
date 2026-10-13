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
    area_bucket: S('src'), record_id: S('r1'), subject: S('RDB load\u001b[2J'), area: { L: [S('src/rdb.c'), S('src/\u200b\u2066x\ufeff\t.c')] },
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
        { M: { find: S('`a\u00adb`'), replace: S('`ab\u{e0041}`'), path: S('src/x.c'), line: { S: '4\u001b[2J\n2' } } },
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

/** The output block of one record, from its subject line to the blank line after it. */
const block = (out, subject) => {
  const start = out.indexOf(`  * subject       : ${subject}`);
  assert.ok(start >= 0, `no record ${subject}`);
  return out.slice(start, out.indexOf('\n\n', start));
};

test('--region applies to every call, wherever it is given', async () => {
  const r = await dump(['--stack', 'ValkeyReviewAgent', '--region', 'eu-west-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => [c.op, c.env.AWS_REGION]), [
    ['cloudformation describe-stacks', 'eu-west-1'],
    ['dynamodb scan', 'eu-west-1'],
  ]);
  assert.match(r.stdout, /^ {2}table: valkey_review_concerns$/m);
});

test('reserved items are not concern records: the repo skill.md item is shown on its own, others are counted', async () => {
  const { stdout, code } = await dump(['--table', 'valkey_review_concerns']);
  assert.equal(code, 0);
  assert.match(stdout, /^ {2}records: 3$/m);
  assert.match(stdout, /^ {2}not shown: 1 item\(s\) in buckets that start with #, which are not concern records$/m);
  assert.ok(!stdout.includes('hidden'));
  assert.ok(!stdout.includes('--- bucket: #'));
  assert.ok(stdout.includes([
    '--- repo skill.md check (#maintenance repo-skill) ---',
    '    verified      : 9.1.2 on 2026-10-01T00:00:00.000Z',
    '    last check    : suspect: 1 name missing',
    '    maintenance   : repo_check requested at 2026-10-13T00:00:00.000Z (repo_check#valkey-review#repo-skill#2026-10-13T00:00:00.000Z)',
  ].join('\n')));
});

test('a live graduated record shows its check state, the request in flight and the pending edits', async () => {
  const { stdout } = await dump(['--table', 'valkey_review_concerns']);
  assert.equal(block(stdout, 'RDB load?[2J'), [
    '  * subject       : RDB load?[2J',
    '    record_id     : r1',
    '    area          : src/rdb.c, src/??x? .c',
    '    reinforcement : 3 (distinct: 2)  decay: 0.9  updated: 2026-09-01T00:00:00.000Z',
    '    graduated as  : rdb-load at 2026-09-02T00:00:00.000Z (generation 2)',
    '    skill state   : live',
    '    verified      : no release tag, unstable@0eb4ba3c1d2e on 2026-10-12T00:00:00.000Z',
    '    last check    : suspect: 1 of 5 names missing at unstable@0eb4ba3c1d2e: `emptyDB`',
    '    stale names   : emptyDB (since 2026-10-12T00:00:00.000Z)',
    '    maintenance   : check requested at 2026-10-13T00:00:00.000Z (check#valkey-review#r1#2026-10-13T00:00:00.000Z)',
    '    pending edit  : revise at 2026-10-12T00:00:00.000Z (applyEdits off)',
    '      summary     : renamed fake line?',
    '      edit 1, evidence: valkey-io/valkey@0eb4ba3c1d2e0eb4ba3c1d2e0eb4ba3c1d2e0eb4:src/db.c:12',
    '        - Call `emptyDB` first.',
    '        - Then load.',
    '        + Call `emptyData` first.',
    '        + Then load.',
    '      edit 2, evidence: src/rdb.c:40',
    '        - `rdbLoad`',
    '        + `rdbLoadRio`',
    '      edit 3, evidence: src/x.c:4?[2J 2',
    '        - `a?b`',
    '        + `ab?`',
    '    concern       : two',
    'lines',
    '    context       : (none)',
  ].join('\n'));
});

test('a tombstone shows how it was retired; a record that never graduated shows no lifecycle', async () => {
  const { stdout } = await dump(['--table', 'valkey_review_concerns']);
  const tomb = block(stdout, 'old');
  assert.match(tomb, /^ {4}skill state {3}: retired \(decayed\) at 2026-10-01T00:00:00.000Z, registry status was DRAFT$/m);
  assert.match(tomb, /^ {4}verified {6}: never$/m);
  assert.match(tomb, /^ {4}obsolete at {3}: 9\.1\.1$/m);
  assert.match(tomb, /^ {4}revised at {4}: 2026-09-20T00:00:00.000Z \(the text before it is kept in previous_skill_md\)$/m);
  const plain = block(stdout, 'plain');
  for (const label of ['graduated as', 'skill state', 'verified', 'maintenance', 'pending edit']) assert.ok(!plain.includes(label), label);
});

test('no control, escape or format character from the table reaches the terminal', async () => {
  const { stdout } = await dump(['--table', 'valkey_review_concerns']);
  assert.ok(!/[^\n\P{Cc}]|[\p{Cf}\p{Zl}\p{Zp}]/u.test(stdout));
});

test('bad arguments print the usage and make no call', async () => {
  for (const args of [[], ['--bogus'], ['--region']]) {
    const r = await dump(args);
    assert.equal(r.code, 1, args.join(' '));
    assert.match(r.stderr, /usage: .*concerns-dump\.sh|--region needs a region/, args.join(' '));
    assert.deepEqual(r.calls, [], args.join(' '));
  }
});
