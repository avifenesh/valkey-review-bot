import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { modelAccessStatements } from './bedrock-arns';
import {
  type CuratorAgentConfig,
  type ModelsConfig,
  type ReviewerId,
  type SkillLifecycleConfig,
  upstreamReposJson,
} from './deployment-config';
import { createRuntimeRole, grantTableKeyUse, registryResources } from './grants';

const CURATOR_RUNTIME_NAME = 'valkey_reviewer_curator_runtime';

export interface CuratorAgentStackProps extends cdk.StackProps {
  /** Docker build context; the repository root. */
  readonly agentSourcePath: string;
  readonly promptPath: string;
  /** The curator's own skill.md; must sit next to promptPath. */
  readonly skillPath: string;
  /** The release check's audit prompt (config/skill-check.md); must sit next to promptPath. */
  readonly checkPromptPath: string;
  readonly assetsBucket: s3.IBucket;
  /** Concerns table per reviewer. */
  readonly concernsTables: ReadonlyMap<ReviewerId, dynamodb.ITable>;
  /** Skills registry (ID or ARN) per reviewer; submit_skill writes graduated skills here. */
  readonly skillsRegistries: ReadonlyMap<ReviewerId, string>;
  /** The curator's own registry of reference material, such as how to write a skill. */
  readonly curatorSkillsRegistry: string;
  readonly agent: CuratorAgentConfig;
  readonly models: Pick<ModelsConfig, 'curator' | 'profileRegions' | 'mantleRegion' | 'mantleGrantRegions' | 'extraGrants'>;
  /** Per reviewer, the public upstream "owner/name" whose default branch the release check reads; empty for none. */
  readonly upstreamRepos: Readonly<Record<ReviewerId, string>>;
  readonly skillLifecycle: SkillLifecycleConfig;
}

/**
 * Curator runtime. It records maintainer feedback in the reviewers'
 * concerns tables and graduates reinforced concerns into the reviewers'
 * skills registries. It also runs the skill maintenance messages the
 * decay job queues: release checks against the public upstreams, and
 * edits and retirements of registry skills.
 */
export class CuratorAgentStack extends cdk.Stack {
  readonly runtime: agentcore.CfnRuntime;
  readonly role: iam.Role;

  constructor(scope: Construct, id: string, props: CuratorAgentStackProps) {
    super(scope, id, props);

    const promptDir = path.dirname(props.promptPath);
    const promptBasename = path.basename(props.promptPath);
    const skillBasename = path.basename(props.skillPath);
    const checkPromptBasename = path.basename(props.checkPromptPath);
    for (const [name, file] of [['skillPath', props.skillPath], ['checkPromptPath', props.checkPromptPath]] as const) {
      if (path.dirname(file) !== promptDir) {
        throw new Error(`curator ${name} must be in the same directory as promptPath (got ${file} and ${promptDir})`);
      }
    }
    new s3deploy.BucketDeployment(this, 'CuratorAssets', {
      sources: [
        s3deploy.Source.asset(promptDir, {
          exclude: ['*', `!${promptBasename}`, `!${skillBasename}`, `!${checkPromptBasename}`],
        }),
      ],
      destinationBucket: props.assetsBucket,
      destinationKeyPrefix: 'curator/',
      prune: false,
    });

    const image = new ecr_assets.DockerImageAsset(this, 'CuratorImage', {
      directory: props.agentSourcePath,
      file: 'agents/curator/Dockerfile',
      platform: ecr_assets.Platform.LINUX_ARM64,
    });

    this.role = createRuntimeRole(this, 'CuratorRole', {
      description: 'Execution role for the curator runtime.',
      image,
      runtimeName: CURATOR_RUNTIME_NAME,
    });
    props.assetsBucket.grantRead(this.role, 'curator/*');
    const m = props.models;
    for (const statement of modelAccessStatements(this, [m.curator.primary, m.curator.fallback, ...m.extraGrants], m)) {
      this.role.addToPrincipalPolicy(statement);
    }

    const tables = [...props.concernsTables.values()];
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ConcernsReadWrite',
      actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: tables.map((t) => t.tableArn),
    }));
    for (const table of tables) grantTableKeyUse(table, this.role);

    // UpdateRegistryRecordStatus is the retirement: a maintenance run
    // sets a skill to DEPRECATED (deprecateSkill in
    // agents/common/src/skills-registry.ts).
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'WriteReviewerSkills',
      actions: [
        'agent-registry:CreateRegistryRecord',
        'agent-registry:UpdateRegistryRecord',
        'agent-registry:UpdateRegistryRecordStatus',
        'agent-registry:GetRegistryRecord',
        'agent-registry:ListRegistryRecords',
      ],
      resources: [...props.skillsRegistries.values()].flatMap((registry) => registryResources(this, registry)),
    }));
    this.role.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadCuratorSkills',
      actions: ['agent-registry:GetRegistryRecord', 'agent-registry:ListRegistryRecords'],
      resources: registryResources(this, props.curatorSkillsRegistry),
    }));

    const lifecycle = props.skillLifecycle;

    this.runtime = new agentcore.CfnRuntime(this, 'CuratorRuntime', {
      agentRuntimeName: CURATOR_RUNTIME_NAME,
      description: 'Curator for the valkey-reviewer agents: records maintainer feedback and graduates skills.',
      agentRuntimeArtifact: {
        containerConfiguration: { containerUri: image.imageUri },
      },
      networkConfiguration: { networkMode: 'PUBLIC' },
      roleArn: this.role.roleArn,
      environmentVariables: {
        BEDROCK_MODEL_ID: m.curator.primary,
        FALLBACK_MODEL_ID: m.curator.fallback,
        MANTLE_REGION: m.mantleRegion || this.region,
        REASONING_EFFORT: m.curator.effort,
        FALLBACK_REASONING_EFFORT: m.curator.fallbackEffort,
        AWS_REGION: this.region,
        ASSETS_BUCKET: props.assetsBucket.bucketName,
        PROMPT_S3_KEY: `curator/${promptBasename}`,
        SKILL_S3_KEY: `curator/${skillBasename}`,
        CONCERNS_TABLES_JSON: this.toJsonString(
          Object.fromEntries([...props.concernsTables].map(([reviewer, t]) => [reviewer, t.tableName])),
        ),
        SKILLS_REGISTRIES_JSON: JSON.stringify(Object.fromEntries(props.skillsRegistries)),
        CURATOR_SKILLS_REGISTRY_ID: props.curatorSkillsRegistry,
        GRADUATION_THRESHOLD: String(props.agent.graduationThreshold),
        MAX_ITERATIONS: String(props.agent.maxIterations),
        MAX_TOKENS: String(props.agent.maxTokens),
        // Skill maintenance. The decay job gets the same RETIRE_SKILLS.
        UPSTREAM_REPOS_JSON: upstreamReposJson(props.upstreamRepos),
        CHECK_PROMPT_S3_KEY: `curator/${checkPromptBasename}`,
        CHECK_MAX_ROUNDS: String(lifecycle.maxCheckRounds),
        CHECK_APPLY_EDITS: String(lifecycle.applyEdits),
        RETIRE_SKILLS: String(lifecycle.retireSkills),
        CHECK_OPEN_PULL_REQUESTS: String(lifecycle.openPullRequests),
      },
    });
    // The service checks image access when it creates the runtime, so the
    // role's policies must exist first.
    this.runtime.node.addDependency(this.role);

    new cdk.CfnOutput(this, 'CuratorRuntimeArn', {
      value: this.runtime.attrAgentRuntimeArn,
      description: 'AgentCore Runtime ARN for the curator.',
    });
    new cdk.CfnOutput(this, 'CuratorRuntimeId', { value: this.runtime.attrAgentRuntimeId });
    new cdk.CfnOutput(this, 'CuratorImageUri', { value: image.imageUri });
    // scripts/publish-curator-skills.mjs --stack reads this. The stack has
    // no SkillsRegistryId output, so registry-skills.mjs --stack cannot
    // pick a reviewer registry here by mistake.
    new cdk.CfnOutput(this, 'CuratorSkillsRegistryId', {
      value: props.curatorSkillsRegistry,
      description: "The curator's own skills registry.",
    });
  }
}
