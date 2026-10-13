import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodelambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { type DecayConfig, type ReviewerId, type SkillLifecycleConfig, upstreamReposJson } from './deployment-config';
import { grantTableKeyUse } from './grants';

const DAY_SECONDS = 24 * 3600;

export interface DecayCronStackProps extends cdk.StackProps {
  /** Concerns table per reviewer. */
  readonly concernsTables: ReadonlyMap<ReviewerId, dynamodb.ITable>;
  readonly decay: DecayConfig;
  /** The curator's queue, where the pass sends check and retire requests. */
  readonly curatorQueue: sqs.IQueue;
  /** Per reviewer, the upstream "owner/name" whose GA releases trigger checks; empty for none. */
  readonly upstreamRepos: Readonly<Record<ReviewerId, string>>;
  readonly skillLifecycle: SkillLifecycleConfig;
  /** How often to run. Default: every 24 hours. */
  readonly schedule?: events.Schedule;
}

/**
 * Scheduled pass over the concerns tables (ops/src/decay.ts). It decays
 * every record's score, deletes records that never graduated once they
 * fall below the floor, and schedules skill maintenance: it sends check
 * and retire requests for graduated records to the curator queue. It
 * logs one summary line per table.
 */
export class DecayCronStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DecayCronStackProps) {
    super(scope, id, props);

    const opsRoot = path.join(__dirname, '..', '..', 'ops');
    const tables = [...props.concernsTables.values()];
    const lifecycle = props.skillLifecycle;

    const fn = new nodelambda.NodejsFunction(this, 'DecayFn', {
      entry: path.join(opsRoot, 'src', 'decay.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'DecayFnLogs', { retention: logs.RetentionDays.ONE_MONTH }),
      environment: {
        CONCERNS_TABLES_JSON: this.toJsonString(
          Object.fromEntries([...props.concernsTables].map(([reviewer, t]) => [reviewer, t.tableName])),
        ),
        DECAY_HALF_LIFE_SECONDS: String(Math.round(props.decay.halfLifeDays * DAY_SECONDS)),
        DECAY_FLOOR: String(props.decay.floor),
        DECAY_GRADUATED_HALF_LIFE_SECONDS: String(Math.round(props.decay.graduatedHalfLifeDays * DAY_SECONDS)),
        UPSTREAM_REPOS_JSON: upstreamReposJson(props.upstreamRepos),
        CURATOR_QUEUE_URL: props.curatorQueue.queueUrl,
        SKILL_CHECKS_PER_DAY: String(lifecycle.checksPerDay),
        SKILL_RECHECK_SECONDS: String(lifecycle.recheckDays * DAY_SECONDS),
        RETIRE_SKILLS: String(lifecycle.retireSkills),
        MAX_RETIREMENTS_PER_DAY: String(lifecycle.maxRetirementsPerDay),
        RETIRE_REFUSED_BACKOFF_SECONDS: String(lifecycle.retireRefusedBackoffDays * DAY_SECONDS),
      },
      projectRoot: opsRoot,
      depsLockFilePath: path.join(opsRoot, 'package-lock.json'),
      bundling: {
        externalModules: ['@aws-sdk/*'],
        target: 'node24',
        sourceMap: true,
      },
    });

    fn.addToRolePolicy(new iam.PolicyStatement({
      sid: 'ConcernsDecay',
      actions: ['dynamodb:Scan', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
      resources: tables.map((t) => t.tableArn),
    }));
    for (const table of tables) grantTableKeyUse(table, fn);
    // Check and retire requests. The release lookups are anonymous HTTPS
    // to api.github.com and need no grant.
    props.curatorQueue.grantSendMessages(fn);

    const rule = new events.Rule(this, 'DecayRule', {
      description: 'Runs the concerns decay Lambda once per day.',
      schedule: props.schedule ?? events.Schedule.rate(cdk.Duration.hours(24)),
    });
    rule.addTarget(new eventsTargets.LambdaFunction(fn));

    new cdk.CfnOutput(this, 'DecayFnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'DecayRuleName', { value: rule.ruleName });
  }
}
