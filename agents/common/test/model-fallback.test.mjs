import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { bufferedFallbackStream, createCuratorModel } = await import('../src/model-fallback.ts');

const stop = { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
const collect = (stream) => Array.fromAsync(stream);

async function* brokenPrimary() {
  yield {
    type: 'modelContentBlockStartEvent',
    start: { type: 'toolUseStart', name: 'write', toolUseId: 'partial' },
  };
  throw new Error('simulated stream failure');
}

test('partial primary tool calls are discarded and fallback stays selected', async () => {
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const stream = bufferedFallbackStream(
    async function* () { primaryCalls++; yield* brokenPrimary(); },
    async function* () { fallbackCalls++; yield stop; },
  );
  assert.deepEqual(await collect(stream([])), [stop]);
  assert.deepEqual(await collect(stream([])), [stop]);
  assert.equal(primaryCalls, 1);
  assert.equal(fallbackCalls, 2);
});

test('successful primary completes without fallback; truncated primary falls back', async () => {
  let fallbackCalls = 0;
  const fallback = async function* () { fallbackCalls++; yield stop; };
  assert.deepEqual(await collect(bufferedFallbackStream(async function* () { yield stop; }, fallback)([])), [stop]);
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(await collect(bufferedFallbackStream(async function* () {}, fallback)([])), [stop]);
  assert.equal(fallbackCalls, 1);
});

test('cancellation is propagated without starting fallback', async () => {
  const controller = new AbortController();
  controller.abort();
  let fallbackCalled = false;
  const stream = bufferedFallbackStream(brokenPrimary, async function* () {
    fallbackCalled = true;
    yield stop;
  });
  await assert.rejects(collect(stream([], { cancelSignal: controller.signal })));
  assert.equal(fallbackCalled, false);
});

test('failure on a later inference preserves history; fallback errors propagate', async () => {
  let primaryCalls = 0;
  const history = [{ role: 'user', content: [{ text: 'Previously completed tool result' }] }];
  const stream = bufferedFallbackStream(
    async function* () {
      if (++primaryCalls > 1) throw new Error('later inference failed');
      yield stop;
    },
    async function* (messages) { assert.equal(messages, history); yield stop; },
  );
  assert.deepEqual(await collect(stream([])), [stop]);
  assert.deepEqual(await collect(stream(history)), [stop]);
  assert.equal(primaryCalls, 2);
  const failingFallback = async function* () { throw new Error('fallback failed'); };
  await assert.rejects(collect(bufferedFallbackStream(brokenPrimary, failingFallback)([])), /fallback failed/);
});

test('curator primary passes its reasoning effort to Converse', () => {
  const env = {
    region: 'us-west-2', modelId: 'primary-model', maxTokens: 128,
    fallbackModelId: 'openai.fallback-model', mantleRegion: 'us-east-1',
    reasoningEffort: 'medium',
  };
  assert.deepEqual(createCuratorModel(env).getConfig().additionalRequestFields, { output_config: { effort: 'medium' } });
});

test('curator switches to a high-effort fallback request while preserving completed tool history', async (t) => {
  const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock');
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
  let primaryCalls = 0;
  let fallbackCalls = 0;
  const history = [
    { role: 'user', content: [{ type: 'textBlock', text: 'Process feedback' }] },
    { role: 'assistant', content: [{ type: 'toolUseBlock', toolUseId: 'completed', name: 'list_concerns', input: {} }] },
    { role: 'user', content: [{ type: 'toolResultBlock', toolUseId: 'completed', status: 'success', content: [{ type: 'textBlock', text: 'existing concerns' }] }] },
  ];
  t.mock.method(BedrockModel.prototype, 'stream', async function* () {
    primaryCalls++;
    assert.equal(this.getConfig().additionalRequestFields.output_config.effort, 'medium');
    if (primaryCalls > 1) throw new Error('primary inference unavailable');
    yield stop;
  });
  t.mock.method(OpenAIModel.prototype, 'stream', async function* (messages) {
    fallbackCalls++;
    assert.equal(this.getConfig().modelId, 'openai.fallback-model');
    assert.equal(this.getConfig().params.reasoning.effort, 'high');
    assert.equal(messages, history);
    yield stop;
  });
  const model = createCuratorModel({
    region: 'us-west-2', modelId: 'primary-model', maxTokens: 128,
    fallbackModelId: 'openai.fallback-model', mantleRegion: 'us-east-1',
    reasoningEffort: 'medium', fallbackReasoningEffort: 'high',
  });
  assert.deepEqual(await collect(model.stream([])), [stop]);
  assert.deepEqual(await collect(model.stream(history)), [stop]);
  assert.deepEqual(await collect(model.stream(history)), [stop]);
  assert.equal(primaryCalls, 2);
  assert.equal(fallbackCalls, 2);
});

test('createCuratorModel builds each side from its own model id', async () => {
  const { createCuratorModel } = await import('../src/model-fallback.ts');
  const { BedrockModel } = await import('@strands-agents/sdk/models/bedrock');
  const { OpenAIModel } = await import('@strands-agents/sdk/models/openai');
  const base = { region: 'us-west-2', maxTokens: 1000, mantleRegion: 'us-east-1', reasoningEffort: 'medium' };
  assert.ok(createCuratorModel({ ...base, modelId: 'us.anthropic.claude-opus-5-5', fallbackModelId: 'openai.gpt-6.1-sol' }) instanceof BedrockModel);
  assert.ok(createCuratorModel({ ...base, modelId: 'openai.gpt-6.1-sol', fallbackModelId: 'us.anthropic.claude-opus-5-5' }) instanceof OpenAIModel);
  // Bedrock-only deployments: both sides on Converse.
  assert.ok(createCuratorModel({ ...base, modelId: 'us.anthropic.claude-opus-5-5', fallbackModelId: 'us.anthropic.claude-haiku-5-5' }) instanceof BedrockModel);
});
