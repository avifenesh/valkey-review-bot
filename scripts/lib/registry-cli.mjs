// Shared pieces of the skills-registry scripts. They run the registry
// code in agents/common/src/skills-registry.ts directly (Node strips the
// TypeScript types), so `npm ci` must have been run in agents/common.

import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { awsRunner, stackOutputs } from './aws-cli.mjs';

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
 * The outputs of the stack given with --stack, read once per stack.
 * Exits with an error when the stack cannot be read.
 */
const outputsCache = new Map();
export function outputsOf(stack, region) {
  if (!outputsCache.has(stack)) {
    try {
      outputsCache.set(stack, stackOutputs(awsRunner(region), stack));
    } catch (err) {
      fail(`could not read the outputs of stack ${stack}: ${err.message}`);
    }
  }
  return outputsCache.get(stack);
}

/** The first of `outputKeys` present on `stack`, or exit with an error. */
export function stackOutput(stack, region, outputKeys) {
  const outputs = outputsOf(stack, region);
  for (const key of outputKeys) {
    const value = outputs.get(key);
    if (value) return value;
  }
  fail(`stack ${stack} has none of the outputs ${outputKeys.join(', ')}`);
}

/**
 * Registry id from --registry-id, or from the first of `outputKeys`
 * present on the CloudFormation stack given with --stack. `values` is
 * what cliArgs returned, keyed by flag name.
 */
export function resolveRegistryId({ 'registry-id': registryId, stack, region }, outputKeys) {
  if (registryId && stack) fail('pass --registry-id or --stack, not both');
  if (registryId) return registryId;
  if (!stack) fail('pass --registry-id ID or --stack STACK_NAME');
  return stackOutput(stack, region, outputKeys);
}
