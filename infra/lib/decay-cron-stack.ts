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
import type { DecayConfig, ReviewerId } from './deployment-config';
import { grantTableKeyUse } from './grants';

export interface DecayCronStackProps extends cdk.StackProps {
  /** Concerns table per reviewer. */
  readonly concernsTables: ReadonlyMap<ReviewerId, dynamodb.ITable>;
  readonly decay: DecayConfig;
  /** How often to run. Default: every 24 hours. */
  readonly schedule?: events.Schedule;
}

/**
 * Scheduled pass that decays every concerns record's score and deletes
 * records that fall below the floor (ops/src/decay.ts). It logs one
 * summary line per table.
 */
export class DecayCronStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: DecayCronStackProps) {
    super(scope, id, props);

    const opsRoot = path.join(__dirname, '..', '..', 'ops');
    const tables = [...props.concernsTables.values()];

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
        DECAY_HALF_LIFE_SECONDS: String(Math.round(props.decay.halfLifeDays * 24 * 3600)),
        DECAY_FLOOR: String(props.decay.floor),
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

    const rule = new events.Rule(this, 'DecayRule', {
      description: 'Runs the concerns decay Lambda once per day.',
      schedule: props.schedule ?? events.Schedule.rate(cdk.Duration.hours(24)),
    });
    rule.addTarget(new eventsTargets.LambdaFunction(fn));

    new cdk.CfnOutput(this, 'DecayFnName', { value: fn.functionName });
    new cdk.CfnOutput(this, 'DecayRuleName', { value: rule.ruleName });
  }
}
