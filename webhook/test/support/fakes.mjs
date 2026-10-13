/**
 * Stand-ins for the AWS and GitHub clients the webhook code talks to.
 */

export function conditionFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

/**
 * An in-memory DynamoDB document client for the receiver's table. It
 * understands the commands src/store.ts sends, including the conditions
 * on the review counters, and records every call. Any other condition
 * fails the test.
 */
export function fakeDdb() {
  const items = new Map();
  const calls = [];
  return {
    items,
    calls,
    async send(command) {
      const op = command.constructor.name;
      const input = command.input;
      calls.push({ op, input });
      if (op === 'PutCommand') {
        const existing = items.get(input.Item.key);
        if (input.ConditionExpression === 'attribute_not_exists(#k)') {
          if (existing) throw conditionFailed();
        } else if (input.ConditionExpression === 'attribute_not_exists(#k) OR #ttl < :now') {
          if (existing && !(existing.ttl < input.ExpressionAttributeValues[':now'])) throw conditionFailed();
        } else {
          throw new Error(`unexpected condition ${input.ConditionExpression}`);
        }
        items.set(input.Item.key, { ...input.Item });
        return {};
      }
      if (op === 'DeleteCommand') {
        if (input.ConditionExpression === '#m = :m') {
          if (items.get(input.Key.key)?.marker !== input.ExpressionAttributeValues[':m']) throw conditionFailed();
        } else if (input.ConditionExpression !== undefined) {
          throw new Error(`unexpected condition ${input.ConditionExpression}`);
        }
        items.delete(input.Key.key);
        return {};
      }
      if (op === 'UpdateCommand') {
        const item = items.get(input.Key.key) ?? { key: input.Key.key };
        const values = input.ExpressionAttributeValues;
        const below = /^attribute_not_exists\(#reviews\) OR #reviews < (:\w+)$/.exec(input.ConditionExpression);
        if (below) {
          if (item.reviews !== undefined && !(item.reviews < values[below[1]])) throw conditionFailed();
        } else if (input.ConditionExpression === '#reviews > :zero') {
          if (!(item.reviews > values[':zero'])) throw conditionFailed();
        } else {
          throw new Error(`unexpected condition ${input.ConditionExpression}`);
        }
        const add = /ADD #reviews (:\w+)/.exec(input.UpdateExpression);
        item.reviews = (item.reviews ?? 0) + values[add[1]];
        if (/SET #ttl = :ttl/.test(input.UpdateExpression)) item.ttl = values[':ttl'];
        items.set(input.Key.key, item);
        return input.ReturnValues === 'UPDATED_NEW' ? { Attributes: { reviews: item.reviews, ttl: item.ttl } } : {};
      }
      throw new Error(`unexpected ${op}`);
    },
  };
}

/**
 * An in-memory DeliveryStore with the same behavior as src/store.ts.
 * autoReviews counts automatic reviews and pending holds the pending
 * marker ids ("pending-1", "pending-2", ...), both per "owner/name#pr",
 * lowercased. Pending markers never expire here.
 */
export function fakeStore({ budget = Infinity } = {}) {
  const keys = new Map();
  const released = [];
  const autoReviews = new Map();
  const returned = [];
  const pending = new Map();
  let slots = 0;
  let markers = 0;
  const prKey = (repo, prNumber) => `${repo.toLowerCase()}#${prNumber}`;
  return {
    keys,
    released,
    autoReviews,
    returned,
    pending,
    get slotsTaken() { return slots; },
    async claim(key, attributes = {}) {
      if (keys.has(key)) return false;
      keys.set(key, attributes);
      return true;
    },
    async release(key) {
      released.push(key);
      keys.delete(key);
    },
    async takeReviewSlot(_routeId, dailyBudget) {
      if (slots >= Math.min(budget, dailyBudget)) return false;
      slots += 1;
      return true;
    },
    async takeAutoReview(repo, prNumber, cap) {
      const taken = autoReviews.get(prKey(repo, prNumber)) ?? 0;
      if (taken >= cap) return 0;
      autoReviews.set(prKey(repo, prNumber), taken + 1);
      return taken + 1;
    },
    async returnAutoReview(repo, prNumber) {
      const taken = autoReviews.get(prKey(repo, prNumber)) ?? 0;
      returned.push(prKey(repo, prNumber));
      if (taken > 0) autoReviews.set(prKey(repo, prNumber), taken - 1);
    },
    async markReviewPending(repo, prNumber, delaySeconds) {
      if (typeof delaySeconds !== 'number') throw new Error('markReviewPending needs the delay');
      if (pending.has(prKey(repo, prNumber))) return null;
      markers += 1;
      pending.set(prKey(repo, prNumber), `pending-${markers}`);
      return `pending-${markers}`;
    },
    async clearReviewPending(repo, prNumber, markerId) {
      if (pending.get(prKey(repo, prNumber)) !== markerId) return false;
      pending.delete(prKey(repo, prNumber));
      return true;
    },
  };
}

/**
 * A GitHubApi that answers from a route table. Each handler key is
 * "METHOD path" and returns { status, json }. Unknown calls fail the test.
 */
export function fakeGitHub(routes) {
  const calls = [];
  const api = async (method, path, body) => {
    calls.push({ method, path, body });
    const handler = routes[`${method} ${path}`];
    if (!handler) throw new Error(`unexpected GitHub call ${method} ${path}`);
    return typeof handler === 'function' ? handler(body) : handler;
  };
  api.calls = calls;
  return api;
}
