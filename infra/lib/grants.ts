import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

/**
 * Execution role for one AgentCore runtime, with what every runtime
 * needs: pulling its own container image and writing runtime logs.
 * Callers add the runtime-specific grants.
 */
export function createRuntimeRole(scope: Construct, id: string, props: {
  readonly description: string;
  readonly image: ecr_assets.DockerImageAsset;
}): iam.Role {
  const stack = cdk.Stack.of(scope);
  const role = new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com'),
    description: props.description,
  });

  // The runtime service pulls the image when the runtime is created and on
  // every cold start.
  props.image.repository.grantPull(role);

  // AgentCore writes runtime logs under /aws/bedrock-agentcore/.
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'RuntimeLogs',
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
    resources: ['/aws/bedrock-agentcore/*', '/aws/bedrock-agentcore/*:*'].map((resourceName) =>
      stack.formatArn({ service: 'logs', resource: 'log-group', resourceName, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })),
  }));
  return role;
}

/** ARN for a registry given as an ID or an ARN (already validated against this account). */
export function registryArn(stack: cdk.Stack, idOrArn: string): string {
  return idOrArn.startsWith('arn:')
    ? idOrArn
    : stack.formatArn({ service: 'agent-registry', resource: 'registry', resourceName: idOrArn });
}

/** The registry and every record in it. */
export function registryResources(stack: cdk.Stack, idOrArn: string): string[] {
  const arn = registryArn(stack, idOrArn);
  return [arn, `${arn}/record/*`];
}

/**
 * KMS use on a customer-managed table key, for a principal that reads and
 * writes items. DynamoDB calls KMS on the caller's behalf, so DynamoDB
 * permissions alone fail on these tables. The actions match what
 * Table.grantReadWriteData grants on the key.
 */
export function grantTableKeyUse(table: dynamodb.ITable, grantee: iam.IGrantable): void {
  table.encryptionKey?.grant(grantee, 'kms:Decrypt', 'kms:DescribeKey', 'kms:Encrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*');
}
