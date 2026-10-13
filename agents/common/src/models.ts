import { BedrockModel } from '@strands-agents/sdk/models/bedrock';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import OpenAI from 'openai';
import { getTokenProvider } from '@aws/bedrock-token-generator';

/** Model ids with this prefix are served by Bedrock Mantle's OpenAI-compatible API, not Converse. */
export function isMantleModel(modelId: string): boolean {
  return modelId.startsWith('openai.');
}

/**
 * OpenAI client for Bedrock Mantle in `region`. Built by hand because the
 * SDK's bedrockMantleConfig only uses the /openai/v1 path for some model
 * id prefixes. The bearer token must be minted for the endpoint's region.
 */
export function mantleClient(region: string, opts: { timeout?: number; maxRetries?: number } = {}): OpenAI {
  return new OpenAI({
    baseURL: `https://bedrock-mantle.${region}.api.aws/openai/v1`,
    apiKey: getTokenProvider({ region }),
    ...opts,
  });
}

export function createMantleModel(opts: { modelId: string; maxTokens: number; mantleRegion: string; effort: string }): OpenAIModel {
  return new OpenAIModel({
    modelId: opts.modelId,
    maxTokens: opts.maxTokens,
    client: mantleClient(opts.mantleRegion),
    params: { reasoning: { effort: opts.effort } },
  });
}

export function createConverseModel(opts: { modelId: string; maxTokens: number; region: string; effort: string }): BedrockModel {
  return new BedrockModel({
    region: opts.region,
    modelId: opts.modelId,
    maxTokens: opts.maxTokens,
    additionalRequestFields: { output_config: { effort: opts.effort } },
  });
}
