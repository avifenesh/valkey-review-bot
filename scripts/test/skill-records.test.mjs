import assert from 'node:assert/strict';
import test from 'node:test';
import { findGraduatedRecord, isReservedBucket, reviewerIdOfTable } from '../lib/skill-records.mjs';
import { fakeAws, flag, typed } from './support/aws.mjs';

test('reserved buckets start with #', () => {
  assert.ok(isReservedBucket('#maintenance'));
  assert.ok(!isReservedBucket('src'));
  assert.ok(!isReservedBucket(undefined));
});

test('reviewerIdOfTable reads the reviewer id from the infra table name', () => {
  assert.equal(reviewerIdOfTable('valkey_review_concerns'), 'valkey-review');
  assert.equal(reviewerIdOfTable('valkey_glide_review_concerns'), 'valkey-glide-review');
  for (const bad of ['concerns', 'Valkey_concerns', 'valkey__review_concerns', 'valkey_review_concerns_old', '_concerns']) {
    assert.equal(reviewerIdOfTable(bad), null, bad);
  }
});

test('findGraduatedRecord reads the check state of the record that graduated as the name', () => {
  const record = typed({ area_bucket: 'src', record_id: 'r1', graduated_record_name: 'rdb', audit_names: ['emptyDB'], verified_sha: 'a'.repeat(40), area: ['src/rdb.c'] }, ['area']);
  const aws = fakeAws({ 'dynamodb scan': () => ({ Items: [record, typed({ area_bucket: '#maintenance', record_id: 'repo-skill', graduated_record_name: 'rdb' })] }) });
  assert.deepEqual(findGraduatedRecord(aws, 'concerns', 'rdb'), {
    area_bucket: 'src', record_id: 'r1', graduated_record_name: 'rdb', audit_names: ['emptyDB'], verified_sha: 'a'.repeat(40), area: ['src/rdb.c'],
  });
  const [args] = aws.calls;
  const names = JSON.parse(flag(args, '--expression-attribute-names'));
  const projected = flag(args, '--projection-expression').split(', ').map((p) => names[p]);
  for (const a of ['audit_names', 'ignored_names', 'verified_sha', 'area', 'retired_at']) assert.ok(projected.includes(a), a);
  assert.equal(names[flag(args, '--filter-expression').split(' ')[0]], 'graduated_record_name');
  assert.deepEqual(JSON.parse(flag(args, '--expression-attribute-values')), { ':name': { S: 'rdb' } });

  assert.equal(findGraduatedRecord(fakeAws({ 'dynamodb scan': () => ({ Items: [] }) }), 'concerns', 'rdb'), null);
  const twice = fakeAws({ 'dynamodb scan': () => ({ Items: [record, typed({ area_bucket: 'src', record_id: 'r2', graduated_record_name: 'rdb' })] }) });
  assert.throws(() => findGraduatedRecord(twice, 'concerns', 'rdb'), /2 concern records in concerns graduated as rdb: "src"\/"r1", "src"\/"r2"/);
});

