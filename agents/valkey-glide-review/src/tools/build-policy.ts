/**
 * What the build tool lets the reviewer run in the glide checkout. This
 * file has no imports so the tests can load it directly.
 *
 * Each subcommand allows a fixed set of actions in args[0] and rejects a
 * few tokens anywhere in argv. The blocked tokens publish, install, log in,
 * or write files in the checkout: a rewrite would move the lines the review
 * anchors to.
 */

export const SUBCOMMAND_NAMES = ['cargo', 'gradle', 'go', 'npm', 'npx'] as const;
export type Subcommand = (typeof SUBCOMMAND_NAMES)[number];

export interface SubcommandSpec {
  readonly binary: string;
  /** Allowed args[0]. For gradle, the allowed task names (see checkGradle). */
  readonly actions: readonly string[];
  /** Rejected anywhere in argv, alone or as `token=value`. */
  readonly forbidden: readonly string[];
  /** Working directory when the call names none, relative to the checkout. */
  readonly defaultDir: string;
}

/**
 * valkey-glide scripts that `npm run` refuses. lint:fix, prettier:format,
 * staged and the format scripts in rust-client/ run eslint --fix,
 * prettier --write or cargo fmt. clean deletes the lock files that npm ci
 * needs.
 */
export const NPM_BLOCKED_SCRIPTS: readonly string[] = [
  'lint:fix', 'prettier:format', 'staged', 'format', 'format:prettier', 'format:rs', 'clean',
];

export const SUBCOMMANDS: Readonly<Record<Subcommand, SubcommandSpec>> = {
  cargo: {
    binary: 'cargo',
    actions: ['build', 'check', 'test', 'clippy', 'metadata', 'tree'],
    forbidden: ['--fix', 'publish', 'install', 'uninstall', 'login', 'logout', 'owner'],
    // There is no workspace Cargo.toml at the repo root; each crate builds
    // from its own directory.
    defaultDir: 'glide-core',
  },
  gradle: {
    binary: './gradlew',
    actions: ['build', 'test', 'compileJava', 'compileTestJava', 'spotlessCheck'],
    forbidden: [],
    defaultDir: 'java',
  },
  go: {
    binary: 'go',
    actions: ['build', 'test', 'vet', 'list', 'env', 'mod', 'doc'],
    // -mod=mod lets build, test and vet rewrite go.mod and go.sum.
    forbidden: ['install', 'get', 'clean', 'tool', '-mod', '--mod'],
    defaultDir: 'go',
  },
  npm: {
    binary: 'npm',
    actions: ['run', 'test', 'ci'],
    forbidden: [
      'publish', 'adduser', 'login', 'logout', 'install', 'update', 'audit', 'fund',
      ...NPM_BLOCKED_SCRIPTS,
    ],
    defaultDir: 'node',
  },
  npx: {
    binary: 'npx',
    actions: ['tsc', 'eslint', 'prettier'],
    // prettier writes with -w, --w and --write. eslint -o writes its report
    // to the path it is given, which can be a source file. checkNpx covers
    // eslint --fix and short-option clusters.
    forbidden: ['-w', '--w', '--write', '-o', '--output-file'],
    defaultDir: 'node',
  },
};

/** Gradle options whose next token is a value rather than a task. */
const GRADLE_VALUE_OPTIONS: readonly string[] = ['--tests', '-x', '--exclude-task'];

/**
 * Task names that publish or upload artifacts. Abbreviations such as
 * `pTML` do not match this, but they fail the exact-name check below.
 */
const PUBLISH_TASK = /^(publish|upload)/i;

/**
 * Gradle takes tasks as `task` or `:project:task`. A task is allowed when
 * the segment after the last ':' is in the allowed set. Exact names only:
 * Gradle expands abbreviations such as `pTML` to publishToMavenLocal.
 */
function checkGradle(args: readonly string[], allowed: readonly string[]): string | null {
  for (const a of args) {
    if (a.split(':').some((segment) => PUBLISH_TASK.test(segment))) {
      return `gradle argument "${a}" is not allowed: publish and upload tasks are blocked.`;
    }
  }
  if (args[0]?.startsWith('-')) {
    return `the first gradle argument must be a task, e.g. ":client:test". Got "${args[0]}".`;
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) {
      if (GRADLE_VALUE_OPTIONS.includes(a)) i++;
      continue;
    }
    const task = a.slice(a.lastIndexOf(':') + 1);
    if (!allowed.includes(task)) {
      return `gradle task "${a}" not allowed. Allowed tasks: ${allowed.join(', ')}, alone or with a project path such as ":client:test".`;
    }
  }
  return null;
}

/**
 * The `go mod` subcommands that leave go.mod and go.sum alone. tidy, edit
 * and download write them, and vendor and init create files.
 */
export const GO_MOD_READ_ONLY: readonly string[] = ['graph', 'verify', 'why'];

/**
 * A single-dash token of two or more letters. prettier and eslint read it
 * as a cluster of short options, so `-lw` means `-l -w` and writes files.
 */
const SHORT_OPTION_CLUSTER = /^-[A-Za-z]{2,}/;

/**
 * Rules for npx beyond the forbidden tokens. Every option that starts with
 * --fix is refused: --fix rewrites files, and a review needs neither
 * --fix-dry-run nor --fix-type.
 */
function checkNpx(args: readonly string[]): string | null {
  for (const a of args) {
    if (a.startsWith('--fix')) return `npx argument "${a}" is not allowed: eslint --fix rewrites files.`;
    if (SHORT_OPTION_CLUSTER.test(a)) {
      return `npx argument "${a}" is not allowed: prettier reads "-lw" as "-l -w". Give each short option its own argument and long options two dashes.`;
    }
  }
  return null;
}

/** Why the argv is refused, or null when it may run. */
export function checkBuildArgs(subcommand: Subcommand, args: readonly string[]): string | null {
  const spec = SUBCOMMANDS[subcommand];
  if (args.length === 0) return `${subcommand} needs an action in args[0].`;
  for (const a of args) {
    for (const f of spec.forbidden) {
      if (a === f || a.startsWith(`${f}=`)) return `argument "${a}" is not allowed for ${subcommand}.`;
    }
  }
  if (subcommand === 'gradle') return checkGradle(args, spec.actions);
  if (!spec.actions.includes(args[0])) {
    return `${subcommand} action "${args[0]}" not allowed. Allowed: ${spec.actions.join(', ')}.`;
  }
  if (subcommand === 'npx') return checkNpx(args);
  if (subcommand === 'go' && args[0] === 'mod' && !GO_MOD_READ_ONLY.includes(args[1] ?? '')) {
    return `go mod "${args[1] ?? ''}" not allowed. Allowed: ${GO_MOD_READ_ONLY.join(', ')}. The others write go.mod, go.sum or new files.`;
  }
  return null;
}

/** The tool description. It lists exactly what checkBuildArgs accepts. */
export function describeBuildTool(): string {
  const list = (s: Subcommand) => SUBCOMMANDS[s].actions.join(', ');
  return `Run a targeted build, test or lint command in the valkey-glide checkout. \`args\` is an argv array with no shell. \`args[0]\` is the action and the rest are its arguments.

- \`cargo\`: ${list('cargo')}. Runs in \`glide-core/\` unless \`subdir\` names another crate directory, such as \`ffi\`, \`java\`, \`node/rust-client\` or \`rust\`. There is no workspace Cargo.toml at the repo root.
- \`gradle\` (\`./gradlew\` in \`java/\`): tasks ${list('gradle')}, alone or with a project path such as \`:client:test\`. Arguments starting with "-" are options. Publish and upload tasks are rejected.
- \`go\` (in \`go/\`): ${list('go')}. \`go mod\` takes only ${GO_MOD_READ_ONLY.join(', ')}: the others write go.mod, go.sum or new files.
- \`npm\` (in \`node/\`): ${list('npm')}. \`npm run\` refuses ${NPM_BLOCKED_SCRIPTS.join(', ')}: they rewrite sources or delete lock files.
- \`npx\` (in \`node/\`): ${list('npx')}. Options that write files are rejected: ${SUBCOMMANDS.npx.forbidden.join(', ')}, and any option starting with \`--fix\`. A cluster of short options such as \`-lw\` is rejected too, because prettier reads it as \`-l -w\`. Give each short option its own argument and long options two dashes.

Blocked anywhere in argv: cargo ${SUBCOMMANDS.cargo.forbidden.join(', ')}; go ${SUBCOMMANDS.go.forbidden.join(', ')}; npm ${SUBCOMMANDS.npm.forbidden.join(', ')}.

Output is capped at 1 MB and 8 minutes. Use it when a claim hinges on a compile or test result, not to "just check".`;
}

/**
 * Whether the build tool is offered at all. ALLOW_BUILD is the setting.
 * ALLOW_MAKE is its older name and is read only when ALLOW_BUILD is unset.
 */
export function buildToolEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.ALLOW_BUILD || env.ALLOW_MAKE || 'false';
  return value.toLowerCase() === 'true';
}
