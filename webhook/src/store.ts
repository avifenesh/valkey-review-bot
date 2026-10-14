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
 *   - pending markers, "pending#OWNER/NAME#PR" (lowercased), held by an
 *     automatic review while it waits in the queue, and while it waits
 *     for another review of the pull request to finish. The worker
 *     removes the marker when it starts the review. A marker also notes
 *     when the receiver gave back the waiting review's round because the
 *     pull request left (closed, or back to draft) while it waited.
 */

export type DocumentClient = Pick<DynamoDBDocumentClient, 'send'>;

const DELIVERY_KEY_TTL_SECONDS = 24 * 3600;
const BUDGET_TTL_SECONDS = 3 * 24 * 3600;
/** Counted from the pull request's latest automatic review. */
const AUTO_REVIEW_TTL_SECONDS = 180 * 24 * 3600;
/**
 * How long a pending marker outlives its queue delay, or the worker's
 * latest extension, in case no worker removes it.
 */
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
  /**
   * Gives back an automatic review taken for a review that was not
   * queued, or for a waiting review that the runtime is going to skip.
   */
  returnAutoReview(repo: string, prNumber: number): Promise<void>;
  /**
   * Notes on the pull request's pending marker that the waiting review's
   * round is given back. True when this call made the note, and the
   * caller gives the round back; false when no review waits, or its
   * round was already given back. So a marker's round is given back at
   * most once, however often the pull request leaves.
   */
  markRoundGivenBack(repo: string, prNumber: number): Promise<boolean>;
  /**
   * Removes that note when an event joins the waiting review: the pull
   * request is back, so the review runs after all. True when there was a
   * note, and the caller takes the round again.
   */
  clearRoundGivenBack(repo: string, prNumber: number): Promise<boolean>;
  /**
   * Marks an automatic review as waiting in the queue for the pull
   * request. Returns the marker's id, or null while another review holds
   * the marker. The marker expires an hour after the delay.
   */
  markReviewPending(repo: string, prNumber: number, delaySeconds: number): Promise<string | null>;
  /** Removes the pull request's pending marker if it is still `markerId`. */
  clearReviewPending(repo: string, prNumber: number, markerId: string): Promise<boolean>;
  /**
   * True while an automatic review of the pull request waits: its
   * pending marker is there and has not expired. Read consistently.
   */
  hasPendingReview(repo: string, prNumber: number): Promise<boolean>;
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
 * later review. The receiver calls it when a review is not queued after
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

/**
 * True while the pull request's pending marker is still `markerId`. The
 * worker removes its marker just before it starts the review, so a
 * message that finds its marker still there has never run. Expiry is not
 * checked: a marker that is still this one was not replaced by a later
 * review's.
 */
export async function holdsPendingReview(
  ddb: DocumentClient,
  tableName: string,
  repo: string,
  prNumber: number,
  markerId: string,
): Promise<boolean> {
  const resp = await ddb.send(new GetCommand({
    TableName: tableName,
    Key: { key: pendingReviewKey(repo, prNumber) },
    ConsistentRead: true,
  }));
  return (resp.Item as { marker?: unknown } | undefined)?.marker === markerId;
}

/**
 * Moves the expiry of the pull request's pending marker to an hour from
 * now, while it is still `markerId`. An automatic review that waits for
 * another review of the pull request keeps its marker this way, so later
 * events keep joining it. False when the marker is not there.
 */
export async function extendPendingReview(
  ddb: DocumentClient,
  tableName: string,
  repo: string,
  prNumber: number,
  markerId: string,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { key: pendingReviewKey(repo, prNumber) },
      UpdateExpression: 'SET #ttl = :ttl',
      ConditionExpression: '#m = :m',
      ExpressionAttributeNames: { '#ttl': 'ttl', '#m': 'marker' },
      ExpressionAttributeValues: { ':ttl': Math.floor(now.getTime() / 1000) + PENDING_TTL_SECONDS, ':m': markerId },
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

    clearReviewPending: (repo, prNumber, markerId) => clearPendingReview(ddb, tableName, repo, prNumber, markerId),

    async markRoundGivenBack(repo, prNumber) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: pendingReviewKey(repo, prNumber) },
          UpdateExpression: 'SET #r = :true',
          // A marker that is there and has not expired, as hasPendingReview counts it.
          ConditionExpression: 'attribute_exists(#m) AND #ttl >= :now AND attribute_not_exists(#r)',
          ExpressionAttributeNames: { '#m': 'marker', '#ttl': 'ttl', '#r': 'roundGivenBack' },
          ExpressionAttributeValues: { ':true': true, ':now': epochSeconds() },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async clearRoundGivenBack(repo, prNumber) {
      try {
        await ddb.send(new UpdateCommand({
          TableName: tableName,
          Key: { key: pendingReviewKey(repo, prNumber) },
          UpdateExpression: 'REMOVE #r',
          ConditionExpression: 'attribute_exists(#r)',
          ExpressionAttributeNames: { '#r': 'roundGivenBack' },
        }));
        return true;
      } catch (err) {
        if (isConditionFailure(err)) return false;
        throw err;
      }
    },

    async hasPendingReview(repo, prNumber) {
      const resp = await ddb.send(new GetCommand({
        TableName: tableName,
        Key: { key: pendingReviewKey(repo, prNumber) },
        ConsistentRead: true,
      }));
      if (!resp.Item) return false;
      // Expired as markReviewPending counts it: TTL deletes lazily.
      const ttl = (resp.Item as { ttl?: unknown }).ttl;
      return !(typeof ttl === 'number' && ttl < epochSeconds());
    },
  };
}
