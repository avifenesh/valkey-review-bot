import assert from 'node:assert/strict';
import test from 'node:test';
import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { Message, TextBlock } from '@strands-agents/sdk';

// Anthropic reasoning models on Converse can stream a reasoning block
// whose text is empty and which carries only a signature. Bedrock rejects
// the next request unless that block is replayed with an explicit empty
// text. Older Strands releases dropped the empty text and then refused to
// format the block, which the runtime used to patch around. These tests
// pin the installed SDK's behavior so the patch stays gone.

async function* converseStream(chunks) {
  for (const chunk of chunks) yield chunk;
}

function fakeClient(model, responses) {
  const requests = [];
  model._client.send = async (command) => {
    requests.push(command.input);
    return { stream: converseStream(responses.shift()) };
  };
  return requests;
}

const answer = (text) => [
  { messageStart: { role: 'assistant' } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: 'end_turn' } },
];

test('a signature-only reasoning block is replayed with an empty text', async () => {
  const model = new BedrockModel({ region: 'us-west-2', modelId: 'test-model' });
  const requests = fakeClient(model, [
    [
      { messageStart: { role: 'assistant' } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: '' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig-1' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'first answer' } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { messageStop: { stopReason: 'end_turn' } },
    ],
    answer('second answer'),
  ]);

  const history = [new Message({ role: 'user', content: [new TextBlock('first question')] })];
  const first = model.streamAggregated(history);
  let step = await first.next();
  while (!step.done) step = await first.next();
  const assistant = step.value.message;
  const reasoning = assistant.content.find((b) => b.type === 'reasoningBlock');
  assert.equal(reasoning.signature, 'sig-1');
  assert.ok(!reasoning.text, 'the aggregated block carries no text');

  history.push(assistant, new Message({ role: 'user', content: [new TextBlock('second question')] }));
  for await (const _ of model.stream(history)) { /* drain */ }

  assert.deepEqual(requests[1].messages[1].content[0], {
    reasoningContent: { reasoningText: { text: '', signature: 'sig-1' } },
  });
});
