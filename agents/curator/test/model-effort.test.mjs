import assert from 'node:assert/strict';
import test from 'node:test';
import { Model } from '@strands-agents/sdk';
import { createCuratorModel } from '../dist/common/src/model-fallback.js';
import { createConverseModel, createMantleModel } from '../dist/common/src/models.js';
import { loadEnv } from '../dist/curator/src/config.js';

// The model classes the common modules build.
const converseProto = Object.getPrototypeOf(createConverseModel({ region: 'us-west-2', modelId: 'm', maxTokens: 1, effort: 'low' }));
const mantleProto = Object.getPrototypeOf(createMantleModel({ modelId: 'openai.m', maxTokens: 1, mantleRegion: 'us-east-1', effort: 'low' }));

const BASE = {
  BEDROCK_MODEL_ID: 'primary-model',
  FALLBACK_MODEL_ID: 'openai.fallback-model',
  MANTLE_REGION: 'us-east-1',
  AWS_REGION: 'us-west-2',
  ASSETS_BUCKET: 'bucket',
  PROMPT_S3_KEY: 'curator/prompt.md',
  CONCERNS_TABLES_JSON: '{"valkey-review":"valkey_review_concerns"}',
  SKILLS_REGISTRIES_JSON: '{"valkey-review":"registry-1"}',
};

test('curator efforts default to medium primary and high fallback, and are set independently', async (t) => {
  // Each inference fails on the primary, so both models report the effort they were built with.
  let seen = {};
  t.mock.method(console, 'warn', () => {});
  t.mock.method(converseProto, 'stream', async function* () {
    seen.primary = this.getConfig().additionalRequestFields.output_config.effort;
    throw new Error('primary unavailable');
  });
  t.mock.method(mantleProto, 'stream', async function* () {
    seen.fallback = this.getConfig().params.reasoning.effort;
    yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
  });

  const cases = [
    [{}, { primary: 'medium', fallback: 'high' }],
    [{ REASONING_EFFORT: ' ', FALLBACK_REASONING_EFFORT: '' }, { primary: 'medium', fallback: 'high' }],
    [{ REASONING_EFFORT: 'low' }, { primary: 'low', fallback: 'high' }],
    [{ FALLBACK_REASONING_EFFORT: 'max' }, { primary: 'medium', fallback: 'max' }],
    [{ REASONING_EFFORT: 'high', FALLBACK_REASONING_EFFORT: 'medium' }, { primary: 'high', fallback: 'medium' }],
  ];
  for (const [vars, expected] of cases) {
    const label = JSON.stringify(vars);
    const env = loadEnv({ ...BASE, ...vars });
    assert.deepEqual({ primary: env.reasoningEffort, fallback: env.fallbackReasoningEffort }, expected, label);
    seen = {};
    await Array.fromAsync(createCuratorModel(env).stream([]));
    assert.deepEqual(seen, expected, `${label}: the models get the efforts loadEnv read`);
  }
});

test('common modules load the SDK from the curator package, like the image does', () => {
  // The build compiles agents/common into dist/common, and the image has
  // only the curator's node_modules. A second SDK copy would give model
  // errors that the curator Agent's retry strategy does not recognise.
  const env = loadEnv(BASE);
  assert.ok(createCuratorModel(env) instanceof Model);
  assert.ok(createConverseModel({ region: 'us-west-2', modelId: 'm', maxTokens: 1, effort: 'low' }) instanceof Model);
  assert.ok(createMantleModel({ modelId: 'openai.m', maxTokens: 1, mantleRegion: 'us-east-1', effort: 'low' }) instanceof Model);
});
