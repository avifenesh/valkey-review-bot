import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { inferenceProfileGroup } from './deployment-config';

/**
 * IAM resources for model access, derived from model IDs.
 *
 * Three kinds of model ID appear in the configuration:
 *   - openai.*: served by Bedrock Mantle (OpenAI-compatible endpoint).
 *   - a region-group token and a dot, such as us.*, eu.*, apac.*, jp.*
 *     or global.* (see PROFILE_GEOGRAPHIES): a cross-Region inference
 *     profile. The caller invokes the profile in its own region, and
 *     Bedrock checks the foundation model in that region and in the
 *     region that runs the request, so the grant needs the profile ARN
 *     plus the foundation model in the stack region and every profile
 *     region. A global profile can also run the request in a region
 *     outside that list, which Bedrock authorizes against the foundation
 *     model ARN without a region.
 *   - anything else: a foundation model invoked in the stack's region.
 *
 * The Converse API is authorized as bedrock:InvokeModel and ConverseStream
 * as bedrock:InvokeModelWithResponseStream; there is no separate Converse
 * IAM action.
 */

export function isMantleModel(modelId: string): boolean {
  return modelId.startsWith('openai.');
}

function foundationModelArn(stack: cdk.Stack, region: string, modelId: string): string {
  return stack.formatArn({ service: 'bedrock', region, account: '', resource: 'foundation-model', resourceName: modelId });
}

/** Resources bedrock:InvokeModel needs for one model ID; empty for Mantle models. */
export function bedrockModelArns(stack: cdk.Stack, modelId: string, profileRegions: readonly string[]): string[] {
  if (isMantleModel(modelId)) return [];
  const group = inferenceProfileGroup(modelId);
  if (!group) return [foundationModelArn(stack, stack.region, modelId)];
  const baseModel = modelId.slice(group.length + 1);
  return [
    stack.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: modelId }),
    ...[...new Set([stack.region, ...profileRegions])].map((region) => foundationModelArn(stack, region, baseModel)),
    ...(group === 'global' ? [foundationModelArn(stack, '', baseModel)] : []),
  ];
}

export interface ModelAccessOptions {
  readonly profileRegions: readonly string[];
  readonly mantleGrantRegions: readonly string[];
}

/**
 * Policy statements that let a role call `modelIds`: streaming and
 * non-streaming Bedrock invocation, and Mantle only when an openai.*
 * model is in the list.
 */
export function modelAccessStatements(
  stack: cdk.Stack,
  modelIds: readonly string[],
  opts: ModelAccessOptions,
): iam.PolicyStatement[] {
  const ids = [...new Set(modelIds)];
  const statements: iam.PolicyStatement[] = [];

  const bedrockArns = [...new Set(ids.flatMap((id) => bedrockModelArns(stack, id, opts.profileRegions)))];
  if (bedrockArns.length > 0) {
    statements.push(new iam.PolicyStatement({
      sid: 'BedrockInvoke',
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: bedrockArns,
    }));
  }

  if (ids.some(isMantleModel)) {
    // The Mantle client presents a bearer token that
    // @aws/bedrock-token-generator mints by presigning CallWithBearerToken.
    // The request is signed for the bedrock service, but Mantle authorizes
    // it as bedrock-mantle:CallWithBearerToken, so both are granted. The
    // action has no resource-level scoping.
    statements.push(new iam.PolicyStatement({
      sid: 'BedrockMantleBearerToken',
      actions: ['bedrock:CallWithBearerToken', 'bedrock-mantle:CallWithBearerToken'],
      resources: ['*'],
    }));
    // Mantle authorizes inference against the account's project, not a
    // model ARN. The account's default project is project/default.
    statements.push(new iam.PolicyStatement({
      sid: 'BedrockMantleInference',
      actions: ['bedrock-mantle:CreateInference'],
      resources: opts.mantleGrantRegions.map((region) =>
        stack.formatArn({ service: 'bedrock-mantle', region, resource: 'project', resourceName: 'default' })),
    }));
  }
  return statements;
}
