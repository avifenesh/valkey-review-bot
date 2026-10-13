import assert from 'node:assert/strict';
import test from 'node:test';
import './support/ts-resolve.mjs';

const { sendMessageInput } = await import('../src/send-message.ts');

test('the body is JSON and the attributes keep their types', () => {
  assert.deepEqual(sendMessageInput('q', { repo: 'o/r', pr_number: 7 }, { repo: 'o/r', pr_number: 7 }), {
    QueueUrl: 'q',
    MessageBody: '{"repo":"o/r","pr_number":7}',
    MessageAttributes: {
      repo: { DataType: 'String', StringValue: 'o/r' },
      pr_number: { DataType: 'Number', StringValue: '7' },
    },
  });
});

test('a delay becomes the message\'s DelaySeconds, 0 included', () => {
  assert.equal(sendMessageInput('q', {}, {}, { delaySeconds: 300 }).DelaySeconds, 300);
  assert.equal(sendMessageInput('q', {}, {}, { delaySeconds: 0 }).DelaySeconds, 0);
  assert.equal('DelaySeconds' in sendMessageInput('q', {}, {}), false);
  assert.equal('DelaySeconds' in sendMessageInput('q', {}, {}, {}), false);
});
