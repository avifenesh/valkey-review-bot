import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * Liveness ledger for long-running reviews.
 *
 * The reviewer model is slow and rate-limited; a healthy review can run
 * 30-60+ minutes, far past the worker Lambda's 15-minute cap. The runtime
 * upserts last_activity here on agent events, and the SQS worker reads it
 * on redelivery to distinguish "still working" (wait and recheck) from
 * "dead" (fall back to the secondary model). Slowness alone must never
 * trigger the fallback.
 */

export interface Heartbeat {
  /** Throttled fire-and-forget liveness write. Call on every agent event. */
  beat(): void;
  /**
   * Terminal status write. Waits for any write still in flight first, so a
   * late "running" write cannot land after the final status. Beats after
   * this are ignored.
   */
  finish(status: 'completed' | 'failed'): Promise<void>;
}

const noop: Heartbeat = { beat: () => {}, finish: async () => {} };

export function createHeartbeat(opts: {
  tableName: string;
  region: string;
  runKey: string;
  modelId: string;
  intervalMs?: number;
}): Heartbeat {
  if (!opts.tableName) return noop;

  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: opts.region }));
  const intervalMs = opts.intervalMs ?? 60_000;
  let lastWrite = 0;
  let finished = false;
  // Writes run one at a time, in call order.
  let pending: Promise<void> = Promise.resolve();

  const write = (status: 'running' | 'completed' | 'failed'): Promise<void> => {
    lastWrite = Date.now();
    pending = pending.then(async () => {
      const now = Date.now();
      try {
        await ddb.send(new UpdateCommand({
          TableName: opts.tableName,
          Key: { run_key: opts.runKey },
          UpdateExpression: 'SET last_activity = :now, #s = :status, model = :model, #t = :ttl',
          ExpressionAttributeNames: { '#s': 'status', '#t': 'ttl' },
          ExpressionAttributeValues: {
            ':now': now,
            ':status': status,
            ':model': opts.modelId,
            ':ttl': Math.floor(now / 1000) + 24 * 3600,
          },
        }));
      } catch (err) {
        console.error(`[heartbeat] write failed (non-fatal): ${err instanceof Error ? err.message : err}`);
      }
    });
    return pending;
  };

  return {
    beat(): void {
      if (finished || Date.now() - lastWrite < intervalMs) return;
      void write('running');
    },
    async finish(status): Promise<void> {
      if (finished) return pending;
      finished = true;
      await write(status);
    },
  };
}
