import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { Agent, ConstantBackoff, ContextWindowOverflowError, ModelError, ModelThrottledError, tool } from '@strands-agents/sdk';
import './support/ts-resolve.mjs';
import { failingTurn, ScriptedModel, textOf, textTurn, toolTurn } from './support/scripted-model.mjs';

const {
  isTransientModelError, ModelCallLimit, MODEL_CALL_LIMIT_MESSAGE, ReviewConversationManager, StreamStallRetryStrategy, textDelta, TRUNCATED_STREAM_MESSAGE,
} = await import('../src/agent-loop.ts');

const noop = tool({ name: 'noop', description: 'does nothing', inputSchema: z.object({}), callback: () => 'ok' });

const retryNow = (isTerminal = () => false) =>
  new StreamStallRetryStrategy(isTerminal, { backoff: new ConstantBackoff({ delayMs: 0 }) });

/** Ask the strategy what it would do for one failed call, the way the agent loop does. */
async function wouldRetry(strategy, error) {
  const event = { attemptCount: 1, error, agent: { cancelSignal: undefined }, retry: undefined };
  await strategy.retryModel(event);
  return event.retry === true;
}

test('transient errors are found on the error or on its causes', () => {
  const timeout = Object.assign(new Error('socket idle'), { name: 'TimeoutError' });
  const serverFault = Object.assign(new Error('internal'), { $fault: 'server', $metadata: { httpStatusCode: 500 } });
  const throttled = Object.assign(new Error('slow down'), { $fault: 'client', $metadata: { httpStatusCode: 429 } });
  const openAi5xx = Object.assign(new Error('server_error'), { status: 502 });
  const validation = Object.assign(new Error('bad request'), { $fault: 'client', $metadata: { httpStatusCode: 400 } });

  for (const cause of [timeout, serverFault, throttled, openAi5xx]) {
    assert.equal(isTransientModelError(new ModelError(cause.message, { cause })), true, cause.message);
  }
  assert.equal(isTransientModelError(new ModelError('wrapped', { cause: new ModelError('again', { cause: timeout }) })), true);
  assert.equal(isTransientModelError(new ModelError('Stream timed out because of no activity for 60000 ms')), true);
  assert.equal(isTransientModelError(new ModelError(validation.message, { cause: validation })), false);
  assert.equal(isTransientModelError(new Error('plain')), false);
});

test('the strategy retries wrapped transient errors and throttling, not client errors', async () => {
  const strategy = retryNow();
  const cause = Object.assign(new Error('Stream timed out'), { name: 'TimeoutError' });
  assert.equal(await wouldRetry(strategy, new ModelError(cause.message, { cause })), true);
  assert.equal(await wouldRetry(strategy, new ModelThrottledError('throttled')), true);
  const badRequest = Object.assign(new Error('ValidationException'), { $fault: 'client', $metadata: { httpStatusCode: 400 } });
  assert.equal(await wouldRetry(strategy, new ModelError(badRequest.message, { cause: badRequest })), false);
});

test('nothing is retried after a terminal tool succeeded', async () => {
  let terminal = false;
  const strategy = retryNow(() => terminal);
  const serverFault = Object.assign(new Error('internal'), { $fault: 'server' });
  assert.equal(await wouldRetry(strategy, new ModelError(TRUNCATED_STREAM_MESSAGE)), true);
  assert.equal(await wouldRetry(strategy, new ModelError(serverFault.message, { cause: serverFault })), true);
  terminal = true;
  assert.equal(await wouldRetry(strategy, new ModelError(TRUNCATED_STREAM_MESSAGE)), false);
  assert.equal(await wouldRetry(strategy, new ModelError(serverFault.message, { cause: serverFault })), false);
  assert.equal(await wouldRetry(strategy, new ModelThrottledError('throttled')), false);
});

test('the agent retries a model call whose stream stalled', async () => {
  const stall = Object.assign(new Error('Stream timed out because of no activity for 30000 ms'), { name: 'TimeoutError' });
  const model = new ScriptedModel([failingTurn(stall), textTurn('done')]);
  const agent = new Agent({ model, printer: false, retryStrategy: retryNow() });
  const result = await agent.invoke('go');
  assert.equal(model.calls, 2);
  assert.equal(result.stopReason, 'endTurn');
});

test('the call limit stops a model that never finishes, and reserve() allows a few more', async () => {
  const model = new ScriptedModel([toolTurn('noop', {})]);
  const limit = new ModelCallLimit(3);
  const agent = new Agent({ model, printer: false, tools: [noop] });
  limit.attach(agent);

  const result = await agent.invoke('loop forever');
  assert.equal(model.calls, 3);
  assert.equal(limit.used, 3);
  assert.equal(limit.reached, true);
  assert.equal(result.stopReason, 'endTurn');
  assert.equal(result.lastMessage.content[0].text, MODEL_CALL_LIMIT_MESSAGE);

  limit.reserve(2);
  assert.equal(limit.reached, false);
  await agent.invoke('one more time');
  assert.equal(model.calls, 5);
  assert.equal(limit.used, 5);
});

test('reserve() only raises the cap when fewer calls are left', () => {
  const limit = new ModelCallLimit(10);
  for (let i = 0; i < 4; i++) limit.onBeforeModelCall({ cancel: false });
  limit.reserve(3);
  for (let i = 0; i < 6; i++) limit.onBeforeModelCall({ cancel: false });
  assert.equal(limit.used, 10);
  const event = { cancel: false };
  limit.onBeforeModelCall(event);
  assert.equal(event.cancel, MODEL_CALL_LIMIT_MESSAGE);
});

test('the call limit rejects a non-positive limit', () => {
  assert.throws(() => new ModelCallLimit(0));
  assert.throws(() => new ModelCallLimit(Number.NaN));
});

const OVERVIEW = 'PR OVERVIEW: valkey-io/valkey#7';
const RETRY = 'Call post_review or skip_review now.';

/** Tool calls in a row, then a closing text turn, then whatever `after` holds. */
const review = (toolCalls, after = []) => [
  ...Array.from({ length: toolCalls }, () => toolTurn('noop', {})),
  textTurn('I am done.'),
  ...after,
];

function assertAlternates(messages) {
  assert.equal(messages[0].role, 'user');
  for (let i = 1; i < messages.length; i++) assert.notEqual(messages[i].role, messages[i - 1].role, `messages ${i - 1} and ${i}`);
}

test('a long review keeps its whole history, overview first, into the terminal-retry turn', async () => {
  const toolCalls = 30; // 62 messages, past the Strands default window of 40
  const model = new ScriptedModel(review(toolCalls, [textTurn('Posted.')]));
  const agent = new Agent({ model, printer: false, tools: [noop], conversationManager: new ReviewConversationManager(toolCalls + 2) });

  await agent.invoke(OVERVIEW);
  assert.equal(agent.messages.length, 2 * toolCalls + 2);
  await agent.invoke(RETRY);

  const retryCall = model.sent.at(-1);
  assert.equal(retryCall.length, 2 * toolCalls + 3);
  assert.equal(textOf(retryCall[0]), OVERVIEW);
  assert.equal(textOf(retryCall.at(-1)), RETRY);
});

test('an overflow trim keeps the overview and a history that alternates', async () => {
  const model = new ScriptedModel([
    ...Array.from({ length: 6 }, () => toolTurn('noop', {})),
    failingTurn(new ContextWindowOverflowError('Input is too long for requested model.')),
    textTurn('I am done.'),
  ]);
  const agent = new Agent({ model, printer: false, tools: [noop], conversationManager: new ReviewConversationManager(20) });
  await agent.invoke(OVERVIEW);

  const afterTrim = model.sent.at(-1);
  assert.ok(afterTrim.length < model.sent.at(-2).length, 'the overflow trimmed the history');
  assert.equal(textOf(afterTrim[0]), OVERVIEW);
  assertAlternates(afterTrim);
});

test('an overflow in the terminal-retry turn keeps the overview, joined with the retry prompt', async () => {
  const model = new ScriptedModel(review(6, [
    failingTurn(new ContextWindowOverflowError('Input is too long for requested model.')),
    textTurn('Posted.'),
  ]));
  const agent = new Agent({ model, printer: false, tools: [noop], conversationManager: new ReviewConversationManager(20) });
  await agent.invoke(OVERVIEW);
  await agent.invoke(RETRY);

  const afterTrim = model.sent.at(-1);
  assert.equal(afterTrim[0].content[0].text, OVERVIEW);
  assert.match(textOf(afterTrim[0]), new RegExp(`${OVERVIEW}\\n${RETRY}`));
  assertAlternates(afterTrim);
});

test('streamed text is read from model stream updates', async () => {
  const agent = new Agent({ model: new ScriptedModel([textTurn('hello'), textTurn('again')]), printer: false });
  let text = '';
  for await (const event of agent.stream('hi')) text += textDelta(event) ?? '';
  assert.equal(text, 'hello');
  assert.equal(textDelta({ type: 'beforeModelCallEvent' }), null);
});
