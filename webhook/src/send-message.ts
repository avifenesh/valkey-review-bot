import type { SendMessageCommandInput } from '@aws-sdk/client-sqs';
import type { SendOptions } from './delivery.js';

/** The SQS request for one queue message from the receiver. */
export function sendMessageInput(
  queueUrl: string,
  body: object,
  attributes: Readonly<Record<string, string | number>>,
  options: SendOptions = {},
): SendMessageCommandInput {
  return {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify(body),
    ...(options.delaySeconds !== undefined ? { DelaySeconds: options.delaySeconds } : {}),
    MessageAttributes: Object.fromEntries(Object.entries(attributes).map(([name, value]) => [
      name,
      typeof value === 'number'
        ? { DataType: 'Number', StringValue: String(value) }
        : { DataType: 'String', StringValue: value },
    ])),
  };
}
