import assert from 'node:assert/strict';
import { CuratorRun } from '../dist/curator/src/tools/run.js';

/**
 * Stand-in for DynamoDBDocumentClient. Routes each command by class name
 * to a handler and records every call. Handlers that are not given throw,
 * so a test fails when a tool sends something unexpected.
 */
export function fakeDdb(handlers) {
  const calls = [];
  return {
    calls,
    ops: () => calls.map((c) => c.op),
    async send(command) {
      const op = command.constructor.name;
      calls.push({ op, input: command.input });
      const handler = handlers[op];
      if (!handler) throw new Error(`unexpected ${op}`);
      return handler(command.input, calls);
    },
  };
}

export function conditionFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

/** `codes` are the per-item CancellationReasons codes, in TransactItems order. */
export function transactionCanceled(codes = []) {
  return Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: codes.map((Code) => ({ Code })),
  });
}

/**
 * Evaluate a ConditionExpression of attribute_exists(#n),
 * attribute_not_exists(#n) and `#n = :v` clauses joined by AND against
 * an item (undefined when the item does not exist). Other syntax throws,
 * so a test cannot pass on a clause it did not evaluate.
 */
export function conditionHolds(item, input) {
  const names = input.ExpressionAttributeNames ?? {};
  const values = input.ExpressionAttributeValues ?? {};
  const attr = (placeholder) => (item === undefined ? undefined : item[names[placeholder]]);
  return input.ConditionExpression.split(' AND ').every((clause) => {
    let m;
    if ((m = clause.match(/^attribute_exists\((#\w+)\)$/))) return attr(m[1]) !== undefined;
    if ((m = clause.match(/^attribute_not_exists\((#\w+)\)$/))) return attr(m[1]) === undefined;
    if ((m = clause.match(/^(#\w+) = (:\w+)$/))) return attr(m[1]) !== undefined && attr(m[1]) === values[m[2]];
    throw new Error(`conditionHolds cannot evaluate "${clause}"`);
  });
}

export const REINFORCER = 'maintainer#valkey-io/valkey#42';

export function newRun(overrides = {}) {
  return new CuratorRun({
    reviewerId: 'valkey-review',
    kind: 'review_comment_reply',
    reinforcer: REINFORCER,
    graduationThreshold: 4,
    ...overrides,
  });
}

/**
 * DynamoDB rejects requests whose ExpressionAttributeNames or Values
 * hold a placeholder no expression uses, or whose expressions use one
 * that is not defined. Check both directions.
 */
export function assertPlaceholdersMatch(input) {
  const expressions = [input.UpdateExpression, input.ConditionExpression, input.KeyConditionExpression]
    .filter(Boolean)
    .join(' ');
  const usedNames = new Set(expressions.match(/#[A-Za-z0-9_]+/g) ?? []);
  const usedValues = new Set(expressions.match(/:[A-Za-z0-9_]+/g) ?? []);
  assert.deepEqual(new Set(Object.keys(input.ExpressionAttributeNames ?? {})), usedNames);
  assert.deepEqual(new Set(Object.keys(input.ExpressionAttributeValues ?? {})), usedValues);
}

export function parse(text) {
  return JSON.parse(text);
}
