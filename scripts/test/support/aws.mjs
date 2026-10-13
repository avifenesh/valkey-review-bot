// Fakes of the AWS CLI for the script tests. No test calls AWS.
//
// Run the tests from the repository root with
//   node --test scripts/test/*.test.mjs
// after `npm ci` in agents/common and ops.

import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AwsCliError } from '../../lib/aws-cli.mjs';

const FAKE_CLI = fileURLToPath(new URL('./fake-aws-cli.mjs', import.meta.url));

export const SCRIPTS_DIR = fileURLToPath(new URL('../../', import.meta.url));
export const REPO_ROOT = path.dirname(SCRIPTS_DIR.replace(/\/$/, ''));

/** Run a script with node in a child process; resolves with its exit code and output, never rejects on exit status. */
export function runScript(script, args, { env = process.env, cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], { env, cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

/** Run a shell script with bash in a child process, like runScript. */
export function runShell(script, args, { env = process.env, cwd = REPO_ROOT } = {}) {
  return new Promise((resolve) => {
    execFile('bash', [path.join(SCRIPTS_DIR, script), ...args], { env, cwd, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

export const tempDir = (prefix) => realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));

/** The stderr of a conditional write that lost, as the CLI prints it. */
export const CONDITION_FAILED = 'An error occurred (ConditionalCheckFailedException) when calling the UpdateItem operation: The conditional request failed\n';

// The fake CLI directories, deleted when the test process exits.
const fakeDirs = [];
process.on('exit', () => {
  for (const dir of fakeDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * An `aws` executable on a fresh PATH directory that answers from
 * `responses` (see fake-aws-cli.mjs). `env` is what a child process
 * needs; `calls()` lists what it was asked, in order.
 */
export function fakeAwsCli(responses) {
  const dir = tempDir('fake-aws-');
  fakeDirs.push(dir);
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses));
  writeFileSync(path.join(bin, 'aws'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`);
  chmodSync(path.join(bin, 'aws'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_AWS_DIR: dir };
  for (const k of Object.keys(env)) if (k.startsWith('AWS_')) delete env[k];
  return {
    dir,
    env,
    calls() {
      try {
        return readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
  };
}

/**
 * An in-process `aws` runner (aws-cli.mjs awsRunner's shape). `handlers`
 * maps "<service> <operation>" to a function of the argv that returns the
 * parsed output, or throws. `calls` records every argv.
 */
export function fakeAws(handlers) {
  const calls = [];
  const aws = (args) => {
    calls.push(args);
    const handler = handlers[`${args[0]} ${args[1]}`];
    if (!handler) throw new Error(`unexpected aws ${args.slice(0, 2).join(' ')}`);
    return handler(args);
  };
  aws.calls = calls;
  return aws;
}

/** What a failed CLI call throws. */
export const cliError = (args, stderr) => new AwsCliError(args, 254, stderr);

/** The value after `flag` in an argv. */
export const flag = (args, name) => args[args.indexOf(name) + 1];

/**
 * A DynamoDB item in the CLI's typed JSON: strings become S, numbers N,
 * string arrays SS, or L of S for the keys in `lists`.
 */
export function typed(item, lists = []) {
  const out = {};
  for (const [k, v] of Object.entries(item)) {
    if (v === undefined) continue;
    if (typeof v === 'string') out[k] = { S: v };
    else if (typeof v === 'number') out[k] = { N: String(v) };
    else if (Array.isArray(v)) out[k] = lists.includes(k) ? { L: v.map((S) => ({ S })) } : { SS: v };
    else throw new Error(`typed: unsupported value for ${k}`);
  }
  return out;
}
