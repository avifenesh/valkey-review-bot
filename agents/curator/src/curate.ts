import { AfterToolsEvent, Agent, type AgentConfig, type Tool } from '@strands-agents/sdk';

/**
 * The agent loop for one curator run, a feedback event or a release
 * check's audit, separate from the runtime entrypoint so it can run
 * against a scripted model in tests.
 */

/**
 * What the loop reads of a run: `done` is set by the run's terminal tool
 * (curator_done, report_skill_check), and `actions` lists what it changed.
 */
export interface CurateRun {
  readonly done: unknown;
  readonly actions: readonly string[];
}

export interface CurateOpts {
  readonly model: AgentConfig['model'];
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly run: CurateRun;
  /** Tool rounds before the loop is stopped. */
  readonly maxIterations: number;
  /**
   * Epoch milliseconds after which the loop stops: at the end of the
   * tool round that passes it, or by cancelling a model call still
   * running then.
   */
  readonly deadlineMs?: number;
  readonly message: string;
  /** Echo model output to stdout (the runtime log). */
  readonly printer?: boolean;
}

export interface CurateResult {
  readonly status: 'completed' | 'iteration_limit' | 'deadline' | 'incomplete';
  readonly rounds: number;
  readonly finalText: string;
}

export interface StreamFrame {
  readonly event: string;
  readonly data: unknown;
}

/** Text of a streamed model delta, whether or not the SDK wraps it in a modelStreamUpdateEvent. */
function textDelta(event: any): string {
  const inner = event?.type === 'modelStreamUpdateEvent' ? event.event : event;
  return inner?.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta' ? String(inner.delta.text ?? '') : '';
}

/** The terminal decision for a log line: curator_done's decision, a report's verdict, or "none". */
function doneLabel(done: unknown): string {
  if (!done) return 'none';
  const d = done as { decision?: unknown; verdict?: unknown };
  return String(d.decision ?? d.verdict ?? 'yes');
}

export async function* curate(opts: CurateOpts): AsyncGenerator<StreamFrame, CurateResult> {
  const { run } = opts;
  const agent = new Agent({
    model: opts.model,
    systemPrompt: opts.systemPrompt,
    tools: opts.tools,
    printer: opts.printer ?? true,
    // One tool at a time keeps the per-run write limit and the
    // curator_done cut-off in call order.
    toolExecutor: 'sequential',
  });

  // The SDK has no iteration cap of its own. End the loop after the
  // tool round that called the terminal tool, after maxIterations
  // rounds, or at the deadline.
  let rounds = 0;
  let hitLimit = false;
  let hitDeadline = false;
  const pastDeadline = () => opts.deadlineMs !== undefined && Date.now() >= opts.deadlineMs;
  agent.addHook(AfterToolsEvent, (event) => {
    rounds += 1;
    if (run.done) {
      event.endTurn = true;
    } else if (rounds >= opts.maxIterations) {
      hitLimit = true;
      event.endTurn = `Stopped after ${rounds} tool rounds without the terminal tool.`;
    } else if (pastDeadline()) {
      hitDeadline = true;
      event.endTurn = `Stopped at the deadline after ${rounds} tool rounds without the terminal tool.`;
    }
  });

  // A model call can outlast the deadline; cancel it then.
  let timer: NodeJS.Timeout | undefined;
  const cancel = new AbortController();
  if (opts.deadlineMs !== undefined) {
    timer = setTimeout(() => {
      hitDeadline = true;
      cancel.abort();
    }, Math.max(0, opts.deadlineMs - Date.now()));
  }

  let finalText = '';
  try {
    const options = opts.deadlineMs === undefined ? undefined : { cancelSignal: cancel.signal };
    for await (const event of agent.stream(opts.message, options) as AsyncIterable<any>) {
      const text = textDelta(event);
      if (text) {
        finalText += text;
        yield { event: 'message', data: { text } };
      } else if (event?.type === 'beforeToolCallEvent' && event.toolUse?.name) {
        yield { event: 'tool_use', data: { name: event.toolUse.name } };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Some models end the stream without a final message after a
    // terminal tool call; once the terminal tool ran that is a normal end.
    // A model call cancelled at the deadline ends the run the same way.
    if (!(run.done && msg.includes('Stream ended without completing a message')) && !cancel.signal.aborted) {
      console.error(`[stream] unhandled error (done=${doneLabel(run.done)} actions=${run.actions.join(';') || 'none'}): ${msg}`);
      throw err;
    }
    console.log(cancel.signal.aborted
      ? '[stream] model call cancelled at the deadline'
      : '[stream] model stopped after the terminal tool; treating as normal completion');
  } finally {
    clearTimeout(timer);
  }

  const status = run.done ? 'completed' : hitLimit ? 'iteration_limit' : hitDeadline ? 'deadline' : 'incomplete';
  return { status, rounds, finalText };
}
