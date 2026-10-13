// AWS CLI helpers for the operator scripts: argv only (no shell), JSON
// output, and DynamoDB's typed JSON read into plain values. Account and
// region come from the CLI's usual sources unless --region is given.

import { execFileSync } from 'node:child_process';

/** The CLI exited non-zero. `stderr` holds its message (AWS errors carry no secret values). */
export class AwsCliError extends Error {
  constructor(args, status, stderr) {
    super(`aws ${args.slice(0, 2).join(' ')} failed (exit ${status}): ${stderr.trim().slice(0, 2000)}`);
    this.name = 'AwsCliError';
    this.status = status;
    this.stderr = stderr;
  }
}

/**
 * A function that runs `aws <args> --output json [--region R]` and
 * returns the parsed output, or null when the CLI prints nothing. The
 * scripts take one of these so tests can pass a fake.
 */
export function awsRunner(region) {
  return (args) => {
    const argv = [...args, '--output', 'json'];
    if (region) argv.push('--region', region);
    let out;
    try {
      out = execFileSync('aws', argv, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AWS_PAGER: '' },
        maxBuffer: 512 * 1024 * 1024,
      });
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('the AWS CLI (aws) is required but not installed');
      throw new AwsCliError(args, err.status ?? -1, String(err.stderr ?? err.message));
    }
    return out.trim() ? JSON.parse(out) : null;
  };
}

/** A conditional write that lost: the item changed since it was read. */
export function isConditionFailure(err) {
  return err instanceof AwsCliError && err.stderr.includes('ConditionalCheckFailedException');
}

/** The outputs of a CloudFormation stack, OutputKey -> OutputValue. */
export function stackOutputs(aws, stack) {
  const outputs = aws(['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs']) ?? [];
  const out = new Map();
  for (const o of outputs) {
    if (o.OutputValue && o.OutputValue !== 'None') out.set(o.OutputKey, o.OutputValue);
  }
  return out;
}

/** One DynamoDB attribute value (typed JSON) as a plain value. Binary values stay base64. */
export function fromAttribute(av) {
  if (av === null || typeof av !== 'object') return undefined;
  if ('S' in av) return av.S;
  if ('N' in av) return Number(av.N);
  if ('BOOL' in av) return av.BOOL;
  if ('NULL' in av) return null;
  if ('SS' in av) return [...av.SS];
  if ('NS' in av) return av.NS.map(Number);
  if ('L' in av) return av.L.map(fromAttribute);
  if ('M' in av) return fromItem(av.M);
  if ('B' in av) return av.B;
  if ('BS' in av) return [...av.BS];
  return undefined;
}

/** A DynamoDB item (typed JSON) as a plain object. */
export function fromItem(item) {
  return Object.fromEntries(Object.entries(item ?? {}).map(([k, v]) => [k, fromAttribute(v)]));
}

/**
 * Every item of a table, read with `aws dynamodb scan` (the CLI follows
 * pagination), as plain objects. `names` maps #placeholders to attribute
 * names for `projection` and `filter`; `values` holds typed values.
 */
export function scanItems(aws, table, { projection, names, filter, values } = {}) {
  const args = ['dynamodb', 'scan', '--table-name', table];
  if (projection) args.push('--projection-expression', projection);
  if (filter) args.push('--filter-expression', filter);
  if (names) args.push('--expression-attribute-names', JSON.stringify(names));
  if (values) args.push('--expression-attribute-values', JSON.stringify(values));
  return ((aws(args) ?? {}).Items ?? []).map(fromItem);
}

/**
 * A value read from a table or the registry, for one output line:
 * JSON-quoted, with non-ASCII escaped too, so it can neither break the
 * line nor reorder how the terminal shows it.
 */
export function quoted(value) {
  return JSON.stringify(String(value)).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
