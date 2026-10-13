import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodelambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as path from 'node:path';
import type { GitHubConfig, ReviewerId } from './deployment-config';

export interface SubstrateStackProps extends cdk.StackProps {
  readonly github: Pick<GitHubConfig, 'appId' | 'appSecretName'>;
  /** Per reviewer, the repositories ("owner/name") its token broker may issue tokens for. */
  readonly allowedRepos: Readonly<Record<ReviewerId, readonly string[]>>;
}

/**
 * Resources shared by every agent in one account and region: the KMS key,
 * the prompt and skill bucket, the GitHub App secret, the token broker and
 * the run heartbeat table. Each agent stack creates its own execution role
 * and grants it only what that agent uses.
 */
export class SubstrateStack extends cdk.Stack {
  readonly key: kms.Key;
  readonly assetsBucket: s3.Bucket;
  readonly githubAppSecret: secretsmanager.ISecret;
  readonly heartbeatTable: dynamodb.Table;
  readonly tokenBrokers: ReadonlyMap<ReviewerId, lambda.IFunction>;

  constructor(scope: Construct, id: string, props: SubstrateStackProps) {
    super(scope, id, props);

    // One customer-managed key for assets and concerns tables, so access
    // can be audited and revoked in one place.
    this.key = new kms.Key(this, 'SubstrateKey', {
      alias: 'alias/valkey-reviewer-substrate',
      description: 'Encrypts valkey-reviewer prompt and skill assets and the concerns tables.',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Prompts and skills, one prefix per agent (for example
    // valkey-review/prompt.md). Versioned so a bad prompt can be rolled
    // back without a redeploy.
    this.assetsBucket = new s3.Bucket(this, 'AgentAssets', {
      bucketName: `valkey-reviewer-assets-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.key,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // The secret is created by the operator (see infra/README.md) and only
    // referenced here, so a stack update can never replace the App key.
    this.githubAppSecret = secretsmanager.Secret.fromSecretNameV2(
      this,
      'GitHubAppSecret',
      props.github.appSecretName,
    );

    // Reviewer runtimes build and run code from the pull request under
    // review, so they never see the App private key. Each reviewer gets its
    // own broker (webhook/src/token-broker.ts) that issues short-lived
    // tokens only for that reviewer's routed repositories, and each runtime
    // role may invoke only its own broker.
    const webhookRoot = path.join(__dirname, '..', '..', 'webhook');
    const brokers = new Map<ReviewerId, lambda.IFunction>();
    for (const [reviewerId, repos] of Object.entries(props.allowedRepos) as [ReviewerId, readonly string[]][]) {
      const name = brokerConstructName(reviewerId);
      const broker = new nodelambda.NodejsFunction(this, `TokenBroker${name}Fn`, {
        entry: path.join(webhookRoot, 'src', 'token-broker.ts'),
        depsLockFilePath: path.join(webhookRoot, 'package-lock.json'),
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        timeout: cdk.Duration.seconds(15),
        memorySize: 256,
        description: `Issues repo-scoped GitHub installation tokens to the ${reviewerId} runtime.`,
        environment: {
          GITHUB_SECRET_ARN: this.githubAppSecret.secretArn,
          GITHUB_APP_ID: props.github.appId,
          ALLOWED_REPOS_JSON: JSON.stringify(repos),
        },
        logGroup: new logs.LogGroup(this, `TokenBroker${name}Logs`, { retention: logs.RetentionDays.ONE_MONTH }),
        bundling: { externalModules: ['@aws-sdk/*'], target: 'node24', minify: false, sourceMap: true },
      });
      this.githubAppSecret.grantRead(broker);
      brokers.set(reviewerId, broker);
      new cdk.CfnOutput(this, `TokenBroker${name}FunctionName`, { value: broker.functionName });
    }
    this.tokenBrokers = brokers;

    // Liveness record for long reviews. The runtime updates last_activity
    // on every agent event; on SQS redelivery the worker reads it to tell a
    // slow run (normal for large reviews) from a dead one, which it retries
    // on the fallback model. Key: run_key = repo#pr#head_sha.
    this.heartbeatTable = new dynamodb.Table(this, 'RunHeartbeatTable', {
      tableName: 'valkey_reviewer_run_heartbeat',
      partitionKey: { name: 'run_key', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'AssetsBucketName', { value: this.assetsBucket.bucketName });
    new cdk.CfnOutput(this, 'SubstrateKeyArn', { value: this.key.keyArn });
  }
}

/** "valkey-glide-review" -> "ValkeyGlideReview", for construct ids. */
function brokerConstructName(reviewerId: string): string {
  return reviewerId.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}
