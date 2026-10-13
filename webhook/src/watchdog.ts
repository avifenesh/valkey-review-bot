import { heartbeatRunKey } from './review-envelope.js';

/**
 * What the invoker does with one queue message.
 *
 * Reviews routinely outlive the worker's 15-minute limit: the runtime
 * session keeps working after the stream to the worker drops, writing a
 * heartbeat record as it goes. So a redelivered review message means
 * "check on the run", not "it failed":
 *
 *   - heartbeat completed               -> done; delete the message
 *   - heartbeat running and fresh       -> alive; leave the message for
 *                                          the next visibility timeout
 *   - heartbeat stale, failed or absent -> dead; run again on the
 *                                          fallback model
 *   - older than the run budget         -> give up; delete with an error log
 *
 * The run budget must end the message before the queue dead-letters it:
 * infra/lib/webhook-stack.ts sizes maxReceiveCount from the 90-minute
 * default and the 16-minute visibility timeout.
 *
 * Curator messages have no heartbeat. Each receive runs the curator; the
 * curator queue dead-letters after three receives, and a message seen
 * more often than that (a queue without its redrive policy) is deleted
 * rather than run again.
 */

export const CURATOR_MAX_RECEIVES = 3;

export type Decision =
  | { readonly action: 'invoke'; readonly useFallbackModel: boolean; readonly reason: string }
  | { readonly action: 'delete'; readonly reason: string; readonly error?: boolean }
  | { readonly action: 'wait'; readonly reason: string };

export interface HeartbeatRecord {
  readonly last_activity?: number;
  readonly status?: string;
}

export interface WatchdogInput {
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly receiveCount: number;
  /** SentTimestamp of the message in epoch milliseconds; 0 when unknown. */
  readonly sentAt: number;
  readonly now: number;
  readonly runBudgetMs: number;
  readonly staleMs: number;
  readonly readHeartbeat: (runKey: string) => Promise<HeartbeatRecord | undefined>;
}

export function isCuratorMessage(envelope: Readonly<Record<string, unknown>>): boolean {
  return typeof envelope.feedback_id === 'string';
}

export async function decide(input: WatchdogInput): Promise<Decision> {
  const { receiveCount } = input;
  if (isCuratorMessage(input.envelope)) {
    if (receiveCount > CURATOR_MAX_RECEIVES) {
      return { action: 'delete', reason: `received ${receiveCount} times, more than ${CURATOR_MAX_RECEIVES}`, error: true };
    }
    return { action: 'invoke', useFallbackModel: false, reason: `attempt ${receiveCount}` };
  }

  if (receiveCount <= 1) return { action: 'invoke', useFallbackModel: false, reason: 'first attempt' };

  const elapsedMs = input.sentAt ? input.now - input.sentAt : 0;
  if (elapsedMs > input.runBudgetMs) {
    return {
      action: 'delete',
      reason: `run budget exceeded: ${Math.round(elapsedMs / 60_000)} min > ${Math.round(input.runBudgetMs / 60_000)} min`,
      error: true,
    };
  }

  const record = await input.readHeartbeat(heartbeatRunKey(input.envelope));
  if (record?.status === 'completed') return { action: 'delete', reason: 'prior attempt completed' };
  if (!record?.last_activity) return { action: 'invoke', useFallbackModel: true, reason: 'no heartbeat record' };
  if (record.status === 'failed') return { action: 'invoke', useFallbackModel: true, reason: 'runtime reported failed' };
  const ageMs = input.now - record.last_activity;
  if (ageMs > input.staleMs) {
    return { action: 'invoke', useFallbackModel: true, reason: `heartbeat stale ${Math.round(ageMs / 1000)}s` };
  }
  return { action: 'wait', reason: `heartbeat ${Math.round(ageMs / 1000)}s ago` };
}
