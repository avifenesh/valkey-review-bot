// Shared pieces of the skills-registry scripts. They run the registry
// code in agents/common/src/skills-registry.ts directly (Node strips the
// TypeScript types), so `npm ci` must have been run in agents/common.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const COMMON_PACKAGE = new URL('../../agents/common/package.json', import.meta.url);

export function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

/** Parse --flags; unknown flags are an error. */
export function cliArgs(options, usage) {
  try {
    return parseArgs({ options: { ...options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  } catch (err) {
    console.error(err.message);
    console.error(usage);
    process.exit(1);
  }
}

export async function loadRegistryModule() {
  try {
    return await import('../../agents/common/src/skills-registry.ts');
  } catch (err) {
    fail(`cannot load agents/common/src/skills-registry.ts (${err.message}). Run "npm ci" in agents/common and use Node 24 or later.`);
  }
}

/** The AWS SDK module the registry code uses, resolved from agents/common so both share one copy. */
export function registrySdk() {
  return createRequire(COMMON_PACKAGE)('@aws-sdk/client-agent-registry-control');
}

/**
 * Registry id from --registry-id, or from the first of `outputKeys`
 * present on the CloudFormation stack given with --stack.
 */
export function resolveRegistryId({ registryId, stack, region }, outputKeys) {
  if (registryId && stack) fail('pass --registry-id or --stack, not both');
  if (registryId) return registryId;
  if (!stack) fail('pass --registry-id ID or --stack STACK_NAME');

  const args = ['cloudformation', 'describe-stacks', '--stack-name', stack, '--query', 'Stacks[0].Outputs', '--output', 'json'];
  if (region) args.push('--region', region);
  let outputs;
  try {
    outputs = JSON.parse(execFileSync('aws', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })) ?? [];
  } catch (err) {
    fail(`could not read the outputs of stack ${stack}: ${err.message}`);
  }
  for (const key of outputKeys) {
    const value = outputs.find((o) => o.OutputKey === key)?.OutputValue;
    if (value && value !== 'None') return value;
  }
  fail(`stack ${stack} has none of the outputs ${outputKeys.join(', ')}`);
}
