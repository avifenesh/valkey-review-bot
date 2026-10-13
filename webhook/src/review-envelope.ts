/**
 * The message a review queue carries. The invoker forwards it to the
 * reviewer runtime as the invocation payload; agents/common/src/run-agent.ts
 * validates it there.
 */
export interface ReviewEnvelope {
  readonly repo: string;
  readonly pr_number: number;
  readonly installation_id: number;
  readonly head_sha: string;
  /** Set by the invoker when it retries a dead run. */
  readonly use_fallback_model?: boolean;
  /** @mention runs: the maintainer's instruction, already screened by the safety gate. */
  readonly instruction?: string;
  readonly instruction_actor?: string;
  /** @mention runs: the acknowledgement comment the runtime keeps updated. */
  readonly status_comment_id?: number;
  /**
   * Separates this run's heartbeat from an earlier run on the same head
   * SHA: "m<comment id>" for @mention runs, "ready" for the review that a
   * draft PR gets when it is marked ready.
   */
  readonly run_nonce?: string;
  readonly trigger_path?: string;
  readonly trigger_line?: number;
  /**
   * Reviews of new commits: the id of the pull request's pending marker
   * (src/store.ts), which the worker removes when it starts the run. The
   * runtime ignores it.
   */
  readonly pending_marker?: string;
  /**
   * "push" on reviews of new commits, which wait in the queue. The pull
   * request may have changed meanwhile, so the runtime skips such a run
   * when the pull request is closed or merged, or is a draft and
   * skip_drafts is true.
   */
  readonly trigger?: 'push';
  /** Reviews of new commits: the route's skipDrafts setting. */
  readonly skip_drafts?: boolean;
}

/** A review of new commits, which src/delivery.ts marks with trigger "push". */
export function isPushReview(envelope: Readonly<Record<string, unknown>>): boolean {
  return envelope.trigger === 'push';
}

export interface PendingMarker {
  readonly repo: string;
  readonly prNumber: number;
  readonly markerId: string;
}

/** The pending marker a review of new commits holds, if the envelope names one. */
export function pendingMarkerOf(envelope: Readonly<Record<string, unknown>>): PendingMarker | undefined {
  const { repo, pr_number: prNumber, pending_marker: markerId } = envelope;
  if (typeof markerId !== 'string' || !markerId) return undefined;
  if (typeof repo !== 'string' || !repo || typeof prNumber !== 'number' || !Number.isInteger(prNumber)) return undefined;
  return { repo, prNumber, markerId };
}

/**
 * The start of the heartbeat key of every run of the envelope's pull
 * request, whatever the head SHA or nonce: repo#pr_number#.
 */
export function pullRequestRunPrefix(envelope: { readonly repo?: unknown; readonly pr_number?: unknown }): string {
  return `${envelope.repo}#${envelope.pr_number}#`;
}

/**
 * Key of the run's heartbeat record. Must produce the same string as the
 * runKey in agents/common/src/run-agent.ts, which writes the record:
 * repo#pr_number#head_sha, "unknown" for a missing head SHA, and
 * "#run_nonce" appended when there is a nonce.
 */
export function heartbeatRunKey(envelope: {
  readonly repo?: unknown;
  readonly pr_number?: unknown;
  readonly head_sha?: unknown;
  readonly run_nonce?: unknown;
}): string {
  const headSha = envelope.head_sha ?? 'unknown';
  return `${envelope.repo}#${envelope.pr_number}#${headSha}${envelope.run_nonce ? `#${envelope.run_nonce}` : ''}`;
}
