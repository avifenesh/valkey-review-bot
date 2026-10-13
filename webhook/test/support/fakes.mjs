/**
 * Stand-ins for the AWS and GitHub clients the webhook code talks to.
 */

export function conditionFailed() {
  return Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
}

/**
 * An in-memory DynamoDB document client for the receiver's table. It
 * understands the three commands src/store.ts sends, including the
 * budget counter's condition, and records every call.
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
        if (items.has(input.Item.key)) throw conditionFailed();
        items.set(input.Item.key, { ...input.Item });
        return {};
      }
      if (op === 'DeleteCommand') {
        items.delete(input.Key.key);
        return {};
      }
      if (op === 'UpdateCommand') {
        const item = items.get(input.Key.key) ?? { key: input.Key.key };
        const budget = input.ExpressionAttributeValues[':budget'];
        if (item.reviews !== undefined && !(item.reviews < budget)) throw conditionFailed();
        item.reviews = (item.reviews ?? 0) + input.ExpressionAttributeValues[':one'];
        item.ttl = input.ExpressionAttributeValues[':ttl'];
        items.set(input.Key.key, item);
        return {};
      }
      throw new Error(`unexpected ${op}`);
    },
  };
}

/** An in-memory DeliveryStore with the same behavior as src/store.ts. */
export function fakeStore({ budget = Infinity } = {}) {
  const keys = new Map();
  const released = [];
  let slots = 0;
  return {
    keys,
    released,
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
