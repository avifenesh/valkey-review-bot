import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { addValkeyReviewerStacks, type ValkeyReviewerStacks } from '../lib/app';
import { type DeploymentConfig, parseDeploymentConfig } from '../lib/deployment-config';

export const ACCOUNT = '111111111111';

/** A valid configuration with placeholder values only. */
export function fixture(): any {
  return {
    aws: { account: ACCOUNT, region: 'us-west-2' },
    github: { appId: '123456', botLogin: 'example-reviewer[bot]', appSecretName: 'example/github-app' },
    skillsRegistries: {
      'valkey-review': 'valkeyRegistry1',
      'valkey-glide-review': 'glideRegistry1',
      curator: 'curatorRegistry1',
    },
    routes: [
      { id: 'valkey-review', reviewer: 'valkey-review', repo: 'example-org/valkey' },
      {
        id: 'valkey-glide-review', reviewer: 'valkey-glide-review', repo: 'example-org/valkey-glide',
        threadReplyReview: true, skipDrafts: true,
      },
      {
        id: 'valkey-review-upstream', reviewer: 'valkey-review', repo: 'upstream-org/valkey',
        mentionOnly: true, authorAllowlist: ['some-maintainer'],
      },
    ],
    curatorOnlyRoutes: [{ reviewer: 'valkey-glide-review', repo: 'upstream-org/valkey-glide' }],
  };
}

const cdkJsonContext = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8')).context;

export interface Synthesized {
  readonly config: DeploymentConfig;
  readonly stacks: ValkeyReviewerStacks;
  readonly allStacks: cdk.Stack[];
  template(stack: cdk.Stack): Template;
}

/**
 * Builds the whole app with the same feature flags as cdk.json. Lambda
 * bundling is skipped so tests do not need the webhook and ops packages
 * installed.
 */
export function synth(raw: unknown = fixture()): Synthesized {
  const config = parseDeploymentConfig(raw);
  const app = new cdk.App({ context: { ...cdkJsonContext, 'aws:cdk:bundling-stacks': [] } });
  const stacks = addValkeyReviewerStacks(app, config);
  const allStacks = app.node.children.filter((c): c is cdk.Stack => cdk.Stack.isStack(c));
  const cache = new Map<cdk.Stack, Template>();
  return {
    config,
    stacks,
    allStacks,
    template(stack) {
      if (!cache.has(stack)) cache.set(stack, Template.fromStack(stack));
      return cache.get(stack)!;
    },
  };
}

export type Statement = { Sid?: string; Action: string | string[]; Resource: unknown; Effect: string };

export const actionsOf = (st: Statement): string[] => [st.Action].flat();

/** Policy statements attached to the role with logical id `roleLogicalId`. */
export function statementsForRole(template: Template, roleLogicalId: string): Statement[] {
  return Object.values(template.findResources('AWS::IAM::Policy'))
    .filter((p: any) => (p.Properties.Roles ?? []).some((r: any) => r.Ref === roleLogicalId))
    .flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

/** Logical id of the one role that AgentCore assumes in this template. */
export function runtimeRoleId(template: Template): string {
  const roles = Object.entries(template.findResources('AWS::IAM::Role')).filter(([, r]: [string, any]) =>
    JSON.stringify(r.Properties.AssumeRolePolicyDocument).includes('bedrock-agentcore.amazonaws.com'));
  if (roles.length !== 1) throw new Error(`expected one AgentCore role, found ${roles.length}`);
  return roles[0]![0];
}

/** Logical id of the role used by the Lambda function whose logical id starts with `prefix`. */
export function functionRoleId(template: Template, prefix: string): string {
  const fns = Object.entries(template.findResources('AWS::Lambda::Function')).filter(([id]) => id.startsWith(prefix));
  if (fns.length !== 1) throw new Error(`expected one function ${prefix}, found ${fns.length}`);
  return (fns[0]![1] as any).Properties.Role['Fn::GetAtt'][0];
}

export function functionEnv(template: Template, prefix: string): Record<string, unknown> {
  const fn = Object.entries(template.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith(prefix));
  if (!fn) throw new Error(`no function ${prefix}`);
  return (fn[1] as any).Properties.Environment.Variables;
}

export function runtimeEnv(template: Template): Record<string, unknown> {
  const runtimes = Object.values(template.findResources('AWS::BedrockAgentCore::Runtime'));
  if (runtimes.length !== 1) throw new Error(`expected one runtime, found ${runtimes.length}`);
  return (runtimes[0] as any).Properties.EnvironmentVariables;
}

/** Every resource string in the statements, flattened. */
export function resourceStrings(statements: Statement[]): string[] {
  return statements.flatMap((st) => [st.Resource].flat()).map((r) => (typeof r === 'string' ? r : JSON.stringify(r)));
}
