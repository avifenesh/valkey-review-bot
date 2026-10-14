import { AfterToolsEvent, Agent, type AgentConfig, type Tool } from '@strands-agents/sdk';
import { quoted } from './log-text.js';

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
  /** Log the model's output (ModelEcho), quoted. Default true. */
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

/** A streamed model event, whether or not the SDK wraps it in a modelStreamUpdateEvent. */
function modelEvent(event: any): any {
  return event?.type === 'modelStreamUpdateEvent' ? event.event : event;
}

/** Text of a streamed model delta. */
function textDelta(event: any): string {
  const inner = modelEvent(event);
  return inner?.type === 'modelContentBlockDeltaEvent' && inner.delta?.type === 'textDelta' ? String(inner.delta.text ?? '') : '';
}

/**
 * The model's output for the runtime log, in place of the SDK's printer,
 * which writes it to stdout as it comes. The model reads text that others
 * wrote (upstream code, maintainers' comments), which can steer what it
 * writes, so each text or reasoning block is one line, its text quoted
 * (log-text.ts): `[model] text "..."`, `[model] reasoning "..."`, and
 * `[model] tool "<name>"` for each tool call.
 */
class ModelEcho {
  private kind: 'text' | 'reasoning' | null = null;
  private buffer = '';
  private readonly write: (line: string) => void;

  constructor(write: (line: string) => void) {
    this.write = write;
  }

  event(event: any): void {
    const inner = modelEvent(event);
    if (inner?.type === 'modelContentBlockDeltaEvent') {
      const delta = inner.delta;
      if (delta?.type === 'textDelta') this.append('text', delta.text);
      else if (delta?.type === 'reasoningContentDelta') this.append('reasoning', delta.text);
    } else if (inner?.type === 'modelContentBlockStopEvent' || inner?.type === 'modelMessageStopEvent') {
      this.flush();
    } else if (event?.type === 'beforeToolCallEvent' && event.toolUse?.name !== undefined) {
      this.flush();
      this.write(`[model] tool ${quoted(String(event.toolUse.name))}${event.cancel ? ' denied' : ''}`);
    }
  }

  private append(kind: 'text' | 'reasoning', text: unknown): void {
    if (typeof text !== 'string' || text.length === 0) return;
    if (this.kind !== kind) this.flush();
    this.kind = kind;
    this.buffer += text;
  }

  /** Log the block collected so far, if any. */
  flush(): void {
    if (this.kind && this.buffer) this.write(`[model] ${this.kind} ${quoted(this.buffer)}`);
    this.kind = null;
    this.buffer = '';
  }
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
    // The SDK's printer writes model text raw; ModelEcho logs it quoted.
    printer: false,
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
  const echo = (opts.printer ?? true) ? new ModelEcho((line) => console.log(line)) : null;
  try {
    const options = opts.deadlineMs === undefined ? undefined : { cancelSignal: cancel.signal };
    for await (const event of agent.stream(opts.message, options) as AsyncIterable<any>) {
      echo?.event(event);
      const text = textDelta(event);
      if (text) {
        finalText += text;
        yield { event: 'message', data: { text } };
      } else if (event?.type === 'beforeToolCallEvent' && event.toolUse?.name) {
        yield { event: 'tool_use', data: { name: event.toolUse.name } };
      }
    }
  } catch (err) {
    echo?.flush();
    const msg = err instanceof Error ? err.message : String(err);
    // Some models end the stream without a final message after a
    // terminal tool call; once the terminal tool ran that is a normal end.
    // A model call cancelled at the deadline ends the run the same way.
    if (!(run.done && msg.includes('Stream ended without completing a message')) && !cancel.signal.aborted) {
      // The actions hold ids the model passed to tools, and the error can quote its output.
      console.error(`[stream] unhandled error (done=${quoted(doneLabel(run.done))} actions=${quoted(run.actions.join(';') || 'none')}): ${quoted(msg)}`);
      throw err;
    }
    console.log(cancel.signal.aborted
      ? '[stream] model call cancelled at the deadline'
      : '[stream] model stopped after the terminal tool; treating as normal completion');
  } finally {
    echo?.flush();
    clearTimeout(timer);
  }

  const status = run.done ? 'completed' : hitLimit ? 'iteration_limit' : hitDeadline ? 'deadline' : 'incomplete';
  return { status, rounds, finalText };
}
