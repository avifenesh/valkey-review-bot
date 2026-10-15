/**
 * What the build tool lets the reviewer run in the valkey-review-bot
 * checkout. This file has no imports so the tests can load it directly.
 *
 * The image installs every package's dependencies when it is built, from
 * main at that time. The tool runs what CI runs on them: type-checks,
 * tests, builds and the credential-free CDK synth. Nothing installs,
 * publishes, logs in, fetches or deploys, and no option outside a short
 * allowlist reaches npm, tsc or cdk.
 */

export const SUBCOMMAND_NAMES = ['npm', 'npx', 'node'] as const;
export type Subcommand = (typeof SUBCOMMAND_NAMES)[number];

export interface SubcommandSpec {
  readonly binary: string;
  /** Put before the model's argv. */
  readonly prefix: readonly string[];
  /** Allowed args[0]. */
  readonly actions: readonly string[];
}

/**
 * The package scripts `npm run` may start. `cdk` (any CDK command,
 * deploy included), `watch` and `start` are left out.
 */
export const NPM_SCRIPTS: readonly string[] = ['build', 'typecheck', 'test'];

export const SUBCOMMANDS: Readonly<Record<Subcommand, SubcommandSpec>> = {
  npm: { binary: 'npm', prefix: [], actions: ['run', 'test'] },
  // --no and --offline: npx never installs or downloads a missing
  // package, it fails instead. `--` ends npx's own options.
  npx: { binary: 'npx', prefix: ['--offline', '--no', '--'], actions: ['tsc', 'cdk'] },
  node: { binary: 'node', prefix: [], actions: ['--test'] },
};

/**
 * Added to buildChildEnv() for every command. The AWS settings hide every
 * credential source the CDK CLI and the AWS SDK would try (config files and
 * instance metadata), as the credential-free synth in CONTRIBUTING.md does.
 * buildChildEnv has already removed the AWS_ variables that carry
 * credentials. The npm settings keep npm, and the npx that cdk.json runs,
 * off the network.
 */
export const OFFLINE_ENV: Readonly<Record<string, string>> = {
  AWS_CONFIG_FILE: '/dev/null',
  AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
  AWS_EC2_METADATA_DISABLED: 'true',
  CDK_DISABLE_CLI_TELEMETRY: 'true',
  NPM_CONFIG_OFFLINE: 'true',
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
};

/** The tsc options allowed besides --noEmit. */
export const TSC_OPTIONS: readonly string[] = ['--noEmit', '-p', '--project', '--pretty', '--listFiles', '--extendedDiagnostics'];

/** The cdk synth options allowed besides -c / --context config=<file>. */
export const CDK_OPTIONS: readonly string[] = ['--quiet', '-q', '--no-notices', '--strict'];

/** `config=<file>`, a relative .json path inside the checkout. */
const CDK_CONFIG = /^config=(?!\/)(?!(.*\/)?\.\.(\/|$))[\w./-]+\.json$/;

/** A relative path inside the checkout, for tsc -p and node --test files. */
const RELATIVE_PATH = /^(?![/-])(?!(.*\/)?\.\.(\/|$))[\w./@-]+$/;

/** A stack name or pattern for cdk synth. */
const STACK_NAME = /^[A-Za-z][A-Za-z0-9*-]*$/;

/** The node --test options allowed besides the test files. */
const NODE_TEST_OPTIONS = /^--(experimental-strip-types|test-name-pattern=.+|test-skip-pattern=.+)$/;

/** "./infra/" and "infra" are the same directory. */
function normalizeDir(dir: string): string {
  return dir.replace(/^(\.\/)+/, '').replace(/\/+$/, '') || '.';
}

/** `run <script>` or `test`, then nothing or `--` and the script's own arguments. */
function checkNpm(args: readonly string[]): string | null {
  let rest: readonly string[];
  if (args[0] === 'run') {
    if (!NPM_SCRIPTS.includes(args[1] ?? '')) {
      return `npm run "${args[1] ?? ''}" not allowed. Allowed scripts: ${NPM_SCRIPTS.join(', ')}.`;
    }
    rest = args.slice(2);
  } else {
    rest = args.slice(1);
  }
  if (rest.length > 0 && rest[0] !== '--') {
    return `npm takes no options of its own here. Pass arguments for the script after "--", e.g. ["test", "--", "--testNamePattern=Webhook"]. Got "${rest[0]}".`;
  }
  return null;
}

function checkTsc(args: readonly string[]): string | null {
  if (!args.includes('--noEmit')) return 'npx tsc needs --noEmit. To write dist/, use npm run build.';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!TSC_OPTIONS.includes(a)) return `tsc option "${a}" not allowed. Allowed: ${TSC_OPTIONS.join(', ')}.`;
    if (a === '-p' || a === '--project') {
      const value = args[++i] ?? '';
      if (!RELATIVE_PATH.test(value)) return `tsc ${a} needs a relative path inside the checkout. Got "${value}".`;
    }
  }
  return null;
}

function checkCdk(args: readonly string[], dir: string): string | null {
  if (args[1] !== 'synth') return `npx cdk runs only "synth". Got "${args[1] ?? ''}".`;
  if (normalizeDir(dir) !== 'infra') return `npx cdk synth runs only in infra. Got dir "${dir}".`;
  let config = false;
  for (let i = 2; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--context') {
      const value = args[++i] ?? '';
      if (!CDK_CONFIG.test(value)) {
        return `cdk ${a} takes only config=<file>, a relative .json path such as config=deploy.config.example.json. Got "${value}".`;
      }
      config = true;
    } else if (a.startsWith('-')) {
      if (!CDK_OPTIONS.includes(a)) return `cdk option "${a}" not allowed. Allowed: ${CDK_OPTIONS.join(', ')}, and -c config=<file>.`;
    } else if (!STACK_NAME.test(a)) {
      return `cdk synth argument "${a}" is not a stack name.`;
    }
  }
  if (!config) return 'npx cdk synth needs -c config=<file>, e.g. -c config=deploy.config.example.json. There is no deploy.config.json in the checkout.';
  return null;
}

function checkNodeTest(args: readonly string[]): string | null {
  let files = 0;
  for (const a of args.slice(1)) {
    if (a.startsWith('-')) {
      if (!NODE_TEST_OPTIONS.test(a)) {
        return `node option "${a}" not allowed. Allowed: --experimental-strip-types, --test-name-pattern=<pattern>, --test-skip-pattern=<pattern>.`;
      }
    } else if (/\.test\.(mjs|js|ts|mts)$/.test(a) && RELATIVE_PATH.test(a)) {
      files++;
    } else {
      return `node --test takes test files by relative path, such as test/prompt.test.mjs. Got "${a}".`;
    }
  }
  if (files === 0) return 'node --test needs at least one test file, such as test/prompt.test.mjs.';
  return null;
}

/** Why the argv is refused in `dir`, or null when it may run. */
export function checkBuildArgs(subcommand: Subcommand, args: readonly string[], dir: string): string | null {
  const spec = SUBCOMMANDS[subcommand];
  if (args.length === 0) return `${subcommand} needs an action in args[0].`;
  if (!spec.actions.includes(args[0])) {
    return `${subcommand} action "${args[0]}" not allowed. Allowed: ${spec.actions.join(', ')}.`;
  }
  if (subcommand === 'npm') return checkNpm(args);
  if (subcommand === 'node') return checkNodeTest(args);
  return args[0] === 'tsc' ? checkTsc(args) : checkCdk(args, dir);
}

/** The tool description. It lists exactly what checkBuildArgs accepts. */
export function describeBuildTool(): string {
  const list = (s: Subcommand) => SUBCOMMANDS[s].actions.join(', ');
  return `Run a type-check, test, build or CDK synth in one package of the valkey-review-bot checkout. \`args\` is an argv array with no shell. \`args[0]\` is the action. \`dir\` is the package directory, such as \`infra\`, \`webhook\`, \`ops\`, \`scripts\` or \`agents/common\`.

- \`npm\`: ${list('npm')}. \`npm run\` starts only ${NPM_SCRIPTS.join(', ')}. npm takes no options of its own. Arguments after \`--\` go to the script.
- \`npx\`: ${list('npx')}. \`npx tsc\` needs \`--noEmit\` and takes ${TSC_OPTIONS.filter((o) => o !== '--noEmit').join(', ')}. \`npx cdk\` runs only \`synth\`, only in \`infra\`, with \`-c config=<file>\` (for example \`config=deploy.config.example.json\`), stack names, and ${CDK_OPTIONS.join(', ')}. npx never installs a missing package.
- \`node\`: ${list('node')} with test files by relative path, and only --experimental-strip-types, --test-name-pattern=<pattern> and --test-skip-pattern=<pattern>.

Every command gets an environment without credentials, with the AWS config files and instance metadata turned off and npm offline. The packages installed are those of main when the image was built. Nothing installs, publishes or deploys.

Output is capped at 1 MB and 8 minutes. Use it when a claim hinges on a type-check, test or synth result, not to "just check".`;
}

/**
 * Whether the build tool is offered at all. ALLOW_BUILD is the setting.
 * ALLOW_MAKE is its older name and is read only when ALLOW_BUILD is unset.
 */
export function buildToolEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.ALLOW_BUILD || env.ALLOW_MAKE || 'false';
  return value.toLowerCase() === 'true';
}
