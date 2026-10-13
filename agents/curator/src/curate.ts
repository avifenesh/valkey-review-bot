import { AfterToolsEvent, Agent, type AgentConfig, type Tool } from '@strands-agents/sdk';
import type { CuratorRun } from './tools/run.js';

/**
 * The agent loop for one feedback event, separate from the runtime
 * entrypoint so it can run against a scripted model in tests.
 */

export interface CurateOpts {
  readonly model: AgentConfig['model'];
  readonly systemPrompt: string;
  readonly tools: Tool[];
  readonly run: CuratorRun;
  /** Tool rounds before the loop is stopped. */
  readonly maxIterations: number;
  readonly message: string;
  /** Echo model output to stdout (the runtime log). */
  readonly printer?: boolean;
}

export interface CurateResult {
  readonly status: 'completed' | 'iteration_limit' | 'incomplete';
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
  // tool round that called curator_done, or after maxIterations rounds.
  let rounds = 0;
  let hitLimit = false;
  agent.addHook(AfterToolsEvent, (event) => {
    rounds += 1;
    if (run.done) {
      event.endTurn = true;
    } else if (rounds >= opts.maxIterations) {
      hitLimit = true;
      event.endTurn = `Stopped after ${rounds} tool rounds without curator_done.`;
    }
  });

  let finalText = '';
  try {
    for await (const event of agent.stream(opts.message) as AsyncIterable<any>) {
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
    // terminal tool call; once curator_done ran that is a normal end.
    if (!(run.done && msg.includes('Stream ended without completing a message'))) {
      console.error(`[stream] unhandled error (done=${run.done?.decision ?? 'none'} actions=${run.actions.join(';') || 'none'}): ${msg}`);
      throw err;
    }
    console.log('[stream] model stopped after curator_done; treating as normal completion');
  }

  return { status: run.done ? 'completed' : hitLimit ? 'iteration_limit' : 'incomplete', rounds, finalText };
}
