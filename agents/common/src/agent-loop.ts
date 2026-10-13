import {
  BeforeModelCallEvent,
  DefaultModelRetryStrategy,
  Message,
  SlidingWindowConversationManager,
  type Agent,
  type AgentStreamEvent,
  type ConversationManagerReduceOptions,
  type DefaultModelRetryStrategyOptions,
} from '@strands-agents/sdk';

/**
 * Pieces of the reviewer's Strands loop that are worth testing on their
 * own: which model errors are retried, the cap on model calls, how the
 * conversation history is kept, and how text is read out of the agent's
 * event stream.
 */

const STALL_MESSAGE = 'Stream timed out because of no activity';
export const TRUNCATED_STREAM_MESSAGE = 'Stream ended without completing a message';

interface ErrorFields {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly $fault?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: unknown };
  readonly status?: unknown;
  readonly cause?: unknown;
}

/** Retryable failure modes, checked on the error and each `cause` below it. */
function isTransient(e: ErrorFields): boolean {
  if (e.name === 'TimeoutError') return true;
  if (typeof e.message === 'string' && e.message.includes(STALL_MESSAGE)) return true;
  if (e.$fault === 'server') return true;
  const status = typeof e.status === 'number' ? e.status : e.$metadata?.httpStatusCode;
  return typeof status === 'number' && (status >= 500 || status === 429);
}

/**
 * True for transient provider failures: a stalled stream, a server-side
 * fault, a 5xx, or throttling. The model providers wrap what the AWS and
 * OpenAI clients throw in a ModelError, so the useful fields are usually
 * on `cause`, not on the error itself.
 */
export function isTransientModelError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    const e = current as ErrorFields;
    if (isTransient(e)) return true;
    current = e.cause;
  }
  return false;
}

/**
 * Retries model calls that failed for transient reasons, on top of the
 * Strands default (ModelThrottledError only), and streams that ended
 * without a complete message. The agent loop replays the turn from the
 * accumulated messages, so a retry is safe.
 *
 * Nothing is retried once a terminal tool (post_review or skip_review)
 * has succeeded: the review is done, run-agent treats a later error as
 * completion, and a retry would only spend backoff time.
 */
export class StreamStallRetryStrategy extends DefaultModelRetryStrategy {
  private readonly isTerminal: () => boolean;

  constructor(isTerminal: () => boolean, opts?: DefaultModelRetryStrategyOptions) {
    super(opts);
    this.isTerminal = isTerminal;
  }

  protected override isRetryable(error: Error): boolean {
    if (this.isTerminal()) return false;
    return super.isRetryable(error)
      || error.message.includes(TRUNCATED_STREAM_MESSAGE)
      || isTransientModelError(error);
  }
}

export const MODEL_CALL_LIMIT_MESSAGE = 'The model call limit for this review was reached.';

/**
 * Caps the number of model calls in a run (retries included). When the
 * cap is reached the next call is replaced by a fixed assistant message,
 * which ends the agent's turn; reserve() then guarantees a few calls for
 * the prompt that asks the model to finish with a terminal tool.
 */
export class ModelCallLimit {
  private calls = 0;
  private limit: number;

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`model call limit must be a positive integer, got ${limit}`);
    this.limit = limit;
  }

  get used(): number {
    return this.calls;
  }

  get reached(): boolean {
    return this.calls >= this.limit;
  }

  /** Make sure at least `calls` more model calls are allowed, raising the cap if needed. */
  reserve(calls: number): void {
    this.limit = Math.max(this.limit, this.calls + calls);
  }

  /** Count or cancel one model call; registered as a BeforeModelCallEvent hook. */
  onBeforeModelCall(event: Pick<BeforeModelCallEvent, 'cancel'>): void {
    if (this.reached) {
      event.cancel = MODEL_CALL_LIMIT_MESSAGE;
      return;
    }
    this.calls++;
  }

  attach(agent: Agent): void {
    agent.addHook(BeforeModelCallEvent, (event) => this.onBeforeModelCall(event));
  }
}

/**
 * Conversation history for one review.
 *
 * The Strands default keeps a 40-message window and trims to it after
 * every agent.stream() call. A review makes far more than 20 tool calls,
 * so the terminal-retry turn would start without most of the evidence
 * the model gathered. The window here holds every message a run can
 * produce, so nothing is trimmed by count during a review: each model
 * call adds at most its reply and one tool-result message, and the other
 * four are the PR overview, the terminal-retry prompt, and the fixed
 * reply that ends a stream at the call limit (once per stream).
 *
 * History is still trimmed when the model reports a context overflow.
 * The first message, the PR overview, is pinned so that trim keeps it.
 */
export class ReviewConversationManager extends SlidingWindowConversationManager {
  /** @param maxModelCalls - the most model calls the run can make, terminal retry included */
  constructor(maxModelCalls: number) {
    super({ windowSize: 2 * maxModelCalls + 4, pinFirst: 1 });
  }

  override reduce(options: ConversationManagerReduceOptions): boolean {
    const reduced = super.reduce(options);
    if (reduced) joinLeadingUserMessages(options.agent.messages);
    return reduced;
  }
}

/**
 * A trim can leave a plain user message right after the pinned overview,
 * such as the terminal-retry prompt. Converse rejects two user messages
 * in a row, so the two are joined into one.
 */
function joinLeadingUserMessages(messages: Message[]): void {
  const [first, second] = messages;
  if (first?.role !== 'user' || second?.role !== 'user') return;
  messages.splice(0, 2, new Message({
    role: 'user',
    content: [...first.content, ...second.content],
    trackingId: first.trackingId,
    metadata: first.metadata,
  }));
}

/** Streamed model text in an agent event, or null for any other event. */
export function textDelta(event: AgentStreamEvent): string | null {
  if (event.type !== 'modelStreamUpdateEvent') return null;
  const inner = event.event;
  return inner.type === 'modelContentBlockDeltaEvent' && inner.delta.type === 'textDelta' ? inner.delta.text : null;
}
