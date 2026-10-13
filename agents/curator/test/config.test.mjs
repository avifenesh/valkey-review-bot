import assert from 'node:assert/strict';
import test from 'node:test';
import { intSetting, loadEnv, parseReviewerMap, renderTemplate } from '../dist/curator/src/config.js';

const BASE = {
  BEDROCK_MODEL_ID: 'primary-model',
  FALLBACK_MODEL_ID: 'fallback-model',
  MANTLE_REGION: 'us-east-1',
  AWS_REGION: 'us-west-2',
  ASSETS_BUCKET: 'bucket',
  PROMPT_S3_KEY: 'curator/prompt.md',
  CONCERNS_TABLES_JSON: '{"valkey-review":"valkey_review_concerns"}',
  SKILLS_REGISTRIES_JSON: '{"valkey-review":"registry-1"}',
};

test('loadEnv reads the documented defaults', () => {
  const env = loadEnv(BASE);
  assert.equal(env.modelId, 'primary-model');
  assert.equal(env.graduationThreshold, 4);
  assert.equal(env.maxIterations, 40);
  assert.equal(env.maxTokens, 16384);
  assert.equal(env.reasoningEffort, 'medium');
  assert.equal(env.fallbackReasoningEffort, 'high');
  assert.equal(env.skillKey, '');
  assert.equal(env.curatorSkillsRegistryId, '');
  assert.deepEqual(env.concernsTables, { 'valkey-review': 'valkey_review_concerns' });
});

test('loadEnv requires model ids and regions', () => {
  for (const key of ['BEDROCK_MODEL_ID', 'FALLBACK_MODEL_ID', 'MANTLE_REGION', 'AWS_REGION', 'CONCERNS_TABLES_JSON', 'SKILLS_REGISTRIES_JSON']) {
    const env = { ...BASE, [key]: '' };
    assert.throws(() => loadEnv(env), new RegExp(key));
  }
});

test('integer settings reject values that are not integers in range', () => {
  assert.equal(intSetting({}, 'N', 7, 1, 10), 7);
  assert.equal(intSetting({ N: ' 3 ' }, 'N', 7, 1, 10), 3);
  for (const bad of ['abc', '4.5', '-1', '1e3', '0x10']) {
    assert.throws(() => intSetting({ N: bad }, 'N', 7, 1, 10), /must be an integer/, bad);
  }
  assert.throws(() => intSetting({ N: '11' }, 'N', 7, 1, 10), /between 1 and 10/);
  assert.throws(() => loadEnv({ ...BASE, GRADUATION_THRESHOLD: '1' }), /GRADUATION_THRESHOLD/);
  assert.throws(() => loadEnv({ ...BASE, MAX_ITERATIONS: 'many' }), /MAX_ITERATIONS/);
});

test('reviewer maps must be objects of non-empty strings', () => {
  assert.throws(() => parseReviewerMap('X', 'not json'), /X is not valid JSON/);
  assert.throws(() => parseReviewerMap('X', '["a"]'), /JSON object/);
  assert.throws(() => parseReviewerMap('X', '{"a":""}'), /X\.a/);
  assert.throws(() => parseReviewerMap('X', '{}'), /no entries/);
});

test('renderTemplate fills placeholders and rejects unknown ones', () => {
  assert.equal(renderTemplate('needs {{GRADUATION_THRESHOLD}} votes', { GRADUATION_THRESHOLD: '4' }), 'needs 4 votes');
  assert.throws(() => renderTemplate('{{TYPO}}', { GRADUATION_THRESHOLD: '4' }), /TYPO/);
});
