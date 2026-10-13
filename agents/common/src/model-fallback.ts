import type { Model, ModelStreamEvent } from '@strands-agents/sdk';
import type { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import type { OpenAIModel } from '@strands-agents/sdk/models/openai';
import { createConverseModel, createMantleModel, isMantleModel } from './models.js';

/**
 * Buffer one inference before exposing tool calls. A failed primary
 * inference can then fall back without replaying tools from prior
 * completed turns. Once switched, keep the fallback for the rest of this
 * invocation.
 */
export function bufferedFallbackStream(primary: Model['stream'], fallback: Model['stream']): Model['stream'] {
  let switched = false;
  return async function* (...args: Parameters<Model['stream']>) {
    if (switched) { yield* fallback(...args); return; }
    const events: ModelStreamEvent[] = [];
    try {
      for await (const event of primary(...args)) events.push(event);
      if (!events.some((event) => event.type === 'modelMessageStopEvent')) {
        throw new Error('Primary model stream ended without completing a message');
      }
    } catch (error) {
      if (args[1]?.cancelSignal?.aborted) throw error;
      switched = true;
      console.warn(`[model-fallback] primary inference failed; switching to the fallback model: ${error instanceof Error ? error.message : error}`);
      yield* fallback(...args);
      return;
    }
    yield* events;
  };
}

/** The curator's model: Converse primary, switching to the Mantle fallback per inference on failure. */
export function createCuratorModel(env: {
  region: string; modelId: string; maxTokens: number;
  fallbackModelId: string; mantleRegion: string; reasoningEffort: string;
  fallbackReasoningEffort?: string;
}): BedrockModel | OpenAIModel {
  const build = (modelId: string, effort: string) => (isMantleModel(modelId)
    ? createMantleModel({ modelId, maxTokens: env.maxTokens, mantleRegion: env.mantleRegion, effort })
    : createConverseModel({ region: env.region, modelId, maxTokens: env.maxTokens, effort }));
  const primary = build(env.modelId, env.reasoningEffort);
  const fallback = build(env.fallbackModelId, env.fallbackReasoningEffort ?? 'high');
  primary.stream = bufferedFallbackStream(primary.stream.bind(primary), fallback.stream.bind(fallback));
  return primary;
}
