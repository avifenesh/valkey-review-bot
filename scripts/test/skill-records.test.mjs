import assert from 'node:assert/strict';
import test from 'node:test';
import { isReservedBucket, reviewerIdOfTable } from '../lib/skill-records.mjs';

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
