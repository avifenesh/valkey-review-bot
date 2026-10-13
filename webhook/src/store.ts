import { DeleteCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * The receiver's DynamoDB table, keyed by "key". It holds two kinds of
 * item, both expired by the "ttl" attribute:
 *
 *   - delivery keys, one per piece of work, so a delivery that GitHub sends
 *     twice is handled once;
 *   - daily review counters, "budget#ROUTEID#YYYY-MM-DD" (UTC), which cap
 *     automatic reviews per route.
 */

export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

const DELIVERY_KEY_TTL_SECONDS = 24 * 3600;
const BUDGET_TTL_SECONDS = 3 * 24 * 3600;

function isConditionFailure(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'ConditionalCheckFailedException';
}

export interface DeliveryStore {
  /** Records the key. False when it is already there: the work was already accepted. */
  claim(key: string, attributes?: Readonly<Record<string, string>>): Promise<boolean>;
  /**
   * Removes a claimed key after the work could not be handed on, so a
   * redelivery from the App settings is processed instead of being
   * dropped as a duplicate.
   */
  release(key: string): Promise<void>;
  /**
   * Takes one automatic review from the route's budget for the current
   * UTC day. False when the day's budget is used up.
   */
  takeReviewSlot(routeId: string, dailyBudget: number): Promise<boolean>;
}

/**
 * Releases a key while another error is already being handled. A failed
 * release is logged, not thrown, so it does not hide the first error.
 */
export async function releaseQuietly(release: (key: string) => Promise<void>, key: string): Promise<void> {
  try {
    await release(key);
  } catch (err) {
    console.error(`[store] could not release ${key}; a redelivery will be skipped as a duplicate`, err);
  }
}

export function budgetKey(routeId: string, now: Date): string {
  return `budget#${routeId}#${now.toISOString().slice(0, 10)}`;
}

export function createDeliveryStore(ddb: DocumentClient, tableName: string, now: () => Date = () => new Date()): DeliveryStore {
  const epochSeconds = (): number => Math.floor(now().getTime() / 1000);
  return {
    async claim(key, attributes = {}) {
      try {
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: { ...attributes, key, ttl: epochSeconds() + DELIVERY_KEY_TTL_SECONDS, receivedAt: now().toISOString() },
          ConditionExpression: 'attribute_not_exists(#k)',
          ExpressionAttributeNames: { '#k': 'key' },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async release(key) {
      await ddb.send(new DeleteCommand({ TableName: tableName, Key: { key } }));
    },

    async takeReviewSlot(routeId, dailyBudget) {
      // The condition below always admits the first review of the day, so
      // a zero budget is decided here.
      if (dailyBudget <= 0) return false;
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: budgetKey(routeId, now()) },
          UpdateExpression: 'SET #ttl = :ttl ADD #reviews :one',
          ConditionExpression: 'attribute_not_exists(#reviews) OR #reviews < :budget',
          ExpressionAttributeNames: { '#reviews': 'reviews', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':budget': dailyBudget, ':ttl': epochSeconds() + BUDGET_TTL_SECONDS },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },
  };
}
