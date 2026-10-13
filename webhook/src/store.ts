import { randomUUID } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * The receiver's DynamoDB table, keyed by "key". It holds these kinds of
 * item, all expired by the "ttl" attribute:
 *
 *   - delivery keys, one per piece of work, so a delivery that GitHub sends
 *     twice is handled once;
 *   - daily review counters, "budget#ROUTEID#YYYY-MM-DD" (UTC), which cap
 *     automatic reviews per route;
 *   - pull request counters, "autoreviews#OWNER/NAME#PR" (lowercased), which
 *     cap automatic reviews per pull request;
 *   - pending markers, "pending#OWNER/NAME#PR" (lowercased), held by a
 *     review of new commits while it waits in the queue. The worker
 *     removes the marker when it starts the review.
 */

export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

const DELIVERY_KEY_TTL_SECONDS = 24 * 3600;
const BUDGET_TTL_SECONDS = 3 * 24 * 3600;
/** Counted from the pull request's latest automatic review. */
const AUTO_REVIEW_TTL_SECONDS = 180 * 24 * 3600;
/** How long a pending marker outlives its queue delay, in case no worker removes it. */
const PENDING_TTL_SECONDS = 3600;

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
  /**
   * Takes the pull request's next automatic review. Returns its number,
   * 1 for the first, or 0 when `cap` have been taken.
   */
  takeAutoReview(repo: string, prNumber: number, cap: number): Promise<number>;
  /** Gives back an automatic review taken for a review that was not queued. */
  returnAutoReview(repo: string, prNumber: number): Promise<void>;
  /**
   * Marks a review of new commits as waiting in the queue for the pull
   * request. Returns the marker's id, or null while another review holds
   * the marker. The marker expires an hour after the delay.
   */
  markReviewPending(repo: string, prNumber: number, delaySeconds: number): Promise<string | null>;
  /** True while a review of new commits holds the pull request's pending marker. */
  reviewPending(repo: string, prNumber: number): Promise<boolean>;
  /** Removes the pull request's pending marker if it is still `markerId`. */
  clearReviewPending(repo: string, prNumber: number, markerId: string): Promise<boolean>;
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

/** GitHub repository names are case-insensitive. */
export function autoReviewKey(repo: string, prNumber: number): string {
  return `autoreviews#${repo.toLowerCase()}#${prNumber}`;
}

export function pendingReviewKey(repo: string, prNumber: number): string {
  return `pending#${repo.toLowerCase()}#${prNumber}`;
}

/**
 * Removes the pull request's pending marker, only while it is still
 * `markerId`, so a late or repeated call cannot remove the marker of a
 * later push. The receiver calls it when a review is not queued after
 * all, the worker when it starts the review. False when the marker was
 * not there.
 */
export async function clearPendingReview(
  ddb: DocumentClient,
  tableName: string,
  repo: string,
  prNumber: number,
  markerId: string,
): Promise<boolean> {
  try {
    await ddb.send(new DeleteCommand({
      TableName: tableName,
      Key: { key: pendingReviewKey(repo, prNumber) },
      ConditionExpression: '#m = :m',
      ExpressionAttributeNames: { '#m': 'marker' },
      ExpressionAttributeValues: { ':m': markerId },
    }));
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
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

    async takeAutoReview(repo, prNumber, cap) {
      if (cap <= 0) return 0;
      try {
        const resp = await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: autoReviewKey(repo, prNumber) },
          UpdateExpression: 'SET #ttl = :ttl ADD #reviews :one',
          ConditionExpression: 'attribute_not_exists(#reviews) OR #reviews < :cap',
          ExpressionAttributeNames: { '#reviews': 'reviews', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':one': 1, ':cap': cap, ':ttl': epochSeconds() + AUTO_REVIEW_TTL_SECONDS },
          ReturnValues: 'UPDATED_NEW',
        }));
        const taken = (resp.Attributes as { reviews?: unknown } | undefined)?.reviews;
        if (typeof taken !== 'number') throw new Error(`no review count for ${autoReviewKey(repo, prNumber)}`);
        return taken;
      } catch (err) {
        if (isConditionFailure(err)) return 0;
        throw err;
      }
    },

    async returnAutoReview(repo, prNumber) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: autoReviewKey(repo, prNumber) },
          UpdateExpression: 'ADD #reviews :minusOne',
          ConditionExpression: '#reviews > :zero',
          ExpressionAttributeNames: { '#reviews': 'reviews' },
          ExpressionAttributeValues: { ':minusOne': -1, ':zero': 0 },
        }));
      } catch (err) {
        // Nothing left to give back.
        if (isConditionFailure(err)) return;
        throw err;
      }
    },

    async markReviewPending(repo, prNumber, delaySeconds) {
      const marker = randomUUID();
      try {
        await ddb.send(new PutCommand({
          TableName: tableName,
          Item: {
            key: pendingReviewKey(repo, prNumber),
            marker,
            ttl: epochSeconds() + delaySeconds + PENDING_TTL_SECONDS,
            receivedAt: now().toISOString(),
          },
          // TTL deletes lazily, so an expired marker counts as gone.
          ConditionExpression: 'attribute_not_exists(#k) OR #ttl < :now',
          ExpressionAttributeNames: { '#k': 'key', '#ttl': 'ttl' },
          ExpressionAttributeValues: { ':now': epochSeconds() },
        }));
        return marker;
      } catch (err) {
        if (isConditionFailure(err)) return null;
        throw err;
      }
    },

    async reviewPending(repo, prNumber) {
      const resp = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: { key: pendingReviewKey(repo, prNumber) },
        ConsistentRead: true,
      }));
      const ttl = (resp.Item as { ttl?: unknown } | undefined)?.ttl;
      // Expired the same way markReviewPending decides it.
      return resp.Item !== undefined && !(typeof ttl === 'number' && ttl < epochSeconds());
    },

    clearReviewPending: (repo, prNumber, markerId) => clearPendingReview(ddb, tableName, repo, prNumber, markerId),
  };
}
