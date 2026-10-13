import type { Octokit } from '@octokit/rest';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ReasoningEffort } from './config.js';
import { isMantleModel, mantleClient } from './models.js';

/**
 * Status-comment lifecycle for mention-triggered reviews.
 *
 * The receiver already posted the ack comment; the runtime takes over
 * editing it through the run:
 *   1. an opener when the loop starts, or on fallback runs a note that
 *      another agent took over (without naming either model)
 *   2. every 15 min, a timestamped one-line summary of what the agent is
 *      doing, written by a small model from recent tool activity
 *   3. at the end, the final review summary replaces the comment body,
 *      so the bot's top-level presence on the PR is this one comment
 *      rather than an ack plus a separate summary.
 *
 * Edits run one at a time. Once finish() or stop() is called no progress
 * edit is sent, so a slow progress tick cannot overwrite the final body.
 */

const PROGRESS_INTERVAL_MS = 15 * 60_000;
const SUMMARIZER_MAX_EVENTS = 30;
const DEFAULT_ACTIVITY = 'The agent is still working through the change.';

export interface StatusCommentOpts {
  readonly octokit: Octokit;
  readonly owner: string;
  readonly repo: string;
  readonly commentId: number;
  readonly region: string;
  readonly summarizerModelId: string;
  readonly summarizerFallbackModelId: string;
  readonly mantleRegion: string;
  readonly reasoningEffort: ReasoningEffort;
  readonly isFallback: boolean;
  /** Overrides the model-written progress line (tests). */
  readonly summarize?: (recentActivity: string) => Promise<string>;
  readonly progressIntervalMs?: number;
}

export interface StatusComment {
  /** Edit in the opener (or fallback notice). Call once at loop start. */
  open(): Promise<void>;
  /** Record a tool event; feeds the 15-min progress summaries. */
  note(activity: string): void;
  /** Replace the comment body with the final review summary. */
  finish(finalBody: string): Promise<void>;
  /** Stop progress edits without a final edit (failure paths). */
  stop(): void;
}

function utcClock(): string {
  return new Date().toISOString().slice(11, 16) + ' UTC';
}

const SUMMARY_INSTRUCTIONS = 'You observe an autonomous code-review agent\'s recent tool calls. In ONE short present-tense sentence, state what the agent is currently doing (e.g. "The agent is currently writing a test to validate its assumptions about the CRC chaining."). No preamble, no model names, and no tool names verbatim: describe the activity.';

/** One summary call to `modelId`, through Mantle for openai.* ids and Converse otherwise. */
function summaryCall(opts: StatusCommentOpts, modelId: string): (input: string) => Promise<string> {
  if (isMantleModel(modelId)) {
    return async (input) => {
      const response = await mantleClient(opts.mantleRegion, { timeout: 60_000, maxRetries: 1 }).responses.create({
        model: modelId,
        instructions: SUMMARY_INSTRUCTIONS,
        input,
        reasoning: { effort: opts.reasoningEffort },
        max_output_tokens: 1024,
      });
      return response.output_text.trim();
    };
  }
  const bedrock = new BedrockRuntimeClient({ region: opts.region });
  return async (input) => {
    const resp = await bedrock.send(new ConverseCommand({
      modelId,
      system: [{ text: SUMMARY_INSTRUCTIONS }],
      messages: [{ role: 'user', content: [{ text: input }] }],
      inferenceConfig: { maxTokens: 100 },
    }));
    return resp.output?.message?.content?.map((c) => c.text ?? '').join('').trim() ?? '';
  };
}

function summarizeWithModels(opts: StatusCommentOpts): (recentActivity: string) => Promise<string> {
  const primary = summaryCall(opts, opts.summarizerModelId);
  const fallback = summaryCall(opts, opts.summarizerFallbackModelId);
  return async (events) => {
    const input = `Recent tool activity (oldest first):\n${events || '(no tool calls yet)'}`;
    try {
      return (await primary(input)) || DEFAULT_ACTIVITY;
    } catch (err) {
      console.warn(`[status-comment] primary summary failed; trying fallback: ${err instanceof Error ? err.message : err}`);
      try {
        return (await fallback(input)) || DEFAULT_ACTIVITY;
      } catch (fallbackError) {
        console.warn(`[status-comment] fallback summary failed: ${fallbackError instanceof Error ? fallbackError.message : fallbackError}`);
        return DEFAULT_ACTIVITY;
      }
    }
  };
}

export function createStatusComment(opts: StatusCommentOpts): StatusComment {
  const summarize = opts.summarize ?? summarizeWithModels(opts);
  const startedAt = Date.now();
  const recent: string[] = [];
  let timer: NodeJS.Timeout | null = null;
  let progressLines: string[] = [];
  let header = '';
  let closed = false;
  let queue: Promise<void> = Promise.resolve();

  function stopTimer(): void {
    if (timer) { clearInterval(timer); timer = null; }
  }

  async function send(body: string): Promise<void> {
    try {
      await opts.octokit.issues.updateComment({
        owner: opts.owner,
        repo: opts.repo,
        comment_id: opts.commentId,
        body,
      });
    } catch (err) {
      // The status comment is UX, not control flow: never fail the
      // review because an edit bounced.
      console.warn(`[status-comment] edit failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Queue an edit behind any edit in flight. Non-final edits are dropped once the comment is closed. */
  function edit(body: () => string, final: boolean): Promise<void> {
    queue = queue.then(() => (closed && !final ? undefined : send(body())));
    return queue;
  }

  async function progressTick(): Promise<void> {
    if (closed) return;
    const what = await summarize(recent.slice(-SUMMARIZER_MAX_EVENTS).join('\n'));
    if (closed) return;
    const mins = Math.round((Date.now() - startedAt) / 60_000);
    progressLines.push(`- ${utcClock()} (${mins} min in): ${what}`);
    await edit(() => `${header}\n\n${progressLines.join('\n')}`, false);
  }

  return {
    async open(): Promise<void> {
      header = opts.isFallback
        ? 'The main review agent ran into trouble on this request, so another strong agent has taken over. Review in progress; this comment tracks its status.'
        : 'Review under way. The agent is reading the change and will post its findings here when done; this comment tracks its status.';
      progressLines = [`- ${utcClock()}: loop started`];
      await edit(() => `${header}\n\n${progressLines.join('\n')}`, false);
      if (closed) return;
      timer = setInterval(() => { void progressTick(); }, opts.progressIntervalMs ?? PROGRESS_INTERVAL_MS);
      // Don't let the timer hold the process open after the run ends.
      timer.unref?.();
    },

    note(activity: string): void {
      recent.push(activity);
      if (recent.length > 200) recent.splice(0, recent.length - SUMMARIZER_MAX_EVENTS);
    },

    async finish(finalBody: string): Promise<void> {
      closed = true;
      stopTimer();
      await edit(() => finalBody, true);
    },

    stop(): void {
      closed = true;
      stopTimer();
    },
  };
}
