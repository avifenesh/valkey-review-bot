import { heartbeatRunKey, pullRequestRunPrefix } from './review-envelope.js';

/**
 * What the invoker does with one queue message.
 *
 * Reviews routinely outlive the worker's 15-minute limit: the runtime
 * session keeps working after the stream to the worker drops, writing a
 * heartbeat record as it goes. So a redelivered review message means
 * "check on the run", not "it failed":
 *
 *   - heartbeat completed               -> done; delete the message
 *   - older than the run budget         -> give up; delete with an error log
 *   - heartbeat running and fresh       -> alive; leave the message for
 *                                          the next visibility timeout
 *   - heartbeat stale, failed or absent -> dead; run again on the
 *                                          fallback model
 *
 * In that order: a run that completed after the last check is not
 * reported as abandoned just because the budget ran out since.
 *
 * The run budget must end the message before the queue dead-letters it:
 * infra/lib/webhook-stack.ts sizes maxReceiveCount from the 90-minute
 * default and the 16-minute visibility timeout.
 *
 * An automatic review holds its pull request's pending marker until the
 * worker removes it, just before the run starts. While the message still
 * holds it, the review has never run: any receive is its first attempt,
 * on the primary model, and its heartbeat is not read.
 *
 * A review of new commits does not start while another review of the
 * same pull request runs. Before it runs, on any attempt, the heartbeats
 * of the pull request's runs are read; while one of them is running and
 * fresh (any review, automatic or @mention), the message waits as it
 * does for its own live run, and keeps its marker, so later pushes still
 * join it. The wait and the push delay both count against the run
 * budget, from SentTimestamp: a review still waiting when the budget is
 * used up is dropped with an error, and one that starts late is watched
 * only until the budget ends (the run itself goes on, without the
 * fallback). A run shows up once its runtime writes the first heartbeat,
 * a few seconds after its worker invokes it; with no push delay, a review
 * of new commits that starts in those seconds can still run alongside.
 *
 * Curator messages, feedback or maintenance, have no heartbeat. Each
 * receive runs the curator; the curator queue dead-letters after three
 * receives, and a message seen more often than that (a queue without its
 * redrive policy) is deleted rather than run again.
 */

export const CURATOR_MAX_RECEIVES = 3;

export type Decision =
  | { readonly action: 'invoke'; readonly useFallbackModel: boolean; readonly reason: string }
  | { readonly action: 'delete'; readonly reason: string; readonly error?: boolean }
  /** otherRun: the run key of another review of the pull request that this one waits for. */
  | { readonly action: 'wait'; readonly reason: string; readonly otherRun?: string };

export interface HeartbeatRecord {
  readonly last_activity?: number;
  readonly status?: string;
}

export interface PullRequestRun extends HeartbeatRecord {
  readonly run_key: string;
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
  /** True while the message still holds its pull request's pending marker. */
  readonly holdsMarker?: boolean;
  /**
   * Reviews of new commits: the heartbeat records of the pull request's
   * runs, keys starting with `prefix`. Records that are not running may
   * be left out.
   */
  readonly readPullRequestRuns?: (prefix: string) => Promise<readonly PullRequestRun[]>;
}

/**
 * The receiver sends feedback envelopes (feedback_id) and the decay job
 * sends maintenance envelopes (maintenance_id) to the curator queue.
 * Anything else is a review.
 */
export function isCuratorMessage(envelope: Readonly<Record<string, unknown>>): boolean {
  return typeof envelope.feedback_id === 'string' || typeof envelope.maintenance_id === 'string';
}

/**
 * How the invoker's log lines name a message. A maintenance message also
 * shows its reason (check, retire or repo_check) and whether it is a dry
 * run, so a report-only pass can be told apart in the logs.
 */
export function messageTag(envelope: Readonly<Record<string, unknown>>): string {
  if (typeof envelope.maintenance_id === 'string') {
    return `curator maintenance=${envelope.maintenance_id} reviewer=${envelope.reviewer_id} reason=${envelope.reason} dry_run=${envelope.dry_run === true}`;
  }
  if (isCuratorMessage(envelope)) return `curator repo=${envelope.repo} feedback=${envelope.feedback_id}`;
  return `review repo=${envelope.repo} pr=${envelope.pr_number} head=${envelope.head_sha}`;
}

/** A run whose heartbeat says running and is no older than `staleMs`. */
export function liveRun(
  runs: readonly PullRequestRun[],
  now: number,
  staleMs: number,
): (PullRequestRun & { readonly last_activity: number }) | undefined {
  return runs.find((r): r is PullRequestRun & { readonly last_activity: number } =>
    r.status === 'running' && typeof r.last_activity === 'number' && now - r.last_activity <= staleMs);
}

const minutes = (ms: number): number => Math.round(ms / 60_000);

export async function decide(input: WatchdogInput): Promise<Decision> {
  const { receiveCount } = input;
  if (isCuratorMessage(input.envelope)) {
    if (receiveCount > CURATOR_MAX_RECEIVES) {
      return { action: 'delete', reason: `received ${receiveCount} times, more than ${CURATOR_MAX_RECEIVES}`, error: true };
    }
    return { action: 'invoke', useFallbackModel: false, reason: `attempt ${receiveCount}` };
  }

  const decision = await reviewDecision(input);
  if (decision.action !== 'invoke' || !input.readPullRequestRuns) return decision;

  const other = liveRun(await input.readPullRequestRuns(pullRequestRunPrefix(input.envelope)), input.now, input.staleMs);
  if (!other) return decision;
  const age = `heartbeat ${Math.round((input.now - other.last_activity) / 1000)}s ago`;
  const elapsedMs = input.sentAt ? input.now - input.sentAt : 0;
  if (elapsedMs > input.runBudgetMs) {
    return {
      action: 'delete',
      reason: `still waiting for ${other.run_key} (${age}) past the run budget: ${minutes(elapsedMs)} min > ${minutes(input.runBudgetMs)} min`,
      error: true,
    };
  }
  return { action: 'wait', reason: age, otherRun: other.run_key };
}

/** What a review message would do if no other run of its pull request mattered. */
async function reviewDecision(input: WatchdogInput): Promise<Decision> {
  const { receiveCount } = input;
  if (receiveCount <= 1) return { action: 'invoke', useFallbackModel: false, reason: 'first attempt' };
  if (input.holdsMarker) return { action: 'invoke', useFallbackModel: false, reason: 'first attempt, still holding the pending marker' };

  const record = await input.readHeartbeat(heartbeatRunKey(input.envelope));
  if (record?.status === 'completed') return { action: 'delete', reason: 'prior attempt completed' };

  const elapsedMs = input.sentAt ? input.now - input.sentAt : 0;
  if (elapsedMs > input.runBudgetMs) {
    return {
      action: 'delete',
      reason: `run budget exceeded: ${minutes(elapsedMs)} min > ${minutes(input.runBudgetMs)} min`,
      error: true,
    };
  }

  if (!record?.last_activity) return { action: 'invoke', useFallbackModel: true, reason: 'no heartbeat record' };
  if (record.status === 'failed') return { action: 'invoke', useFallbackModel: true, reason: 'runtime reported failed' };
  const ageMs = input.now - record.last_activity;
  if (ageMs > input.staleMs) {
    return { action: 'invoke', useFallbackModel: true, reason: `heartbeat stale ${Math.round(ageMs / 1000)}s` };
  }
  return { action: 'wait', reason: `heartbeat ${Math.round(ageMs / 1000)}s ago` };
}
