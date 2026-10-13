import { z } from 'zod';
import { tool } from '@strands-agents/sdk';
import { buildChildEnv } from './child-env.js';
import { runBounded } from './spawn.js';

/** Subcommands the git tool runs. Anything else is rejected. */
const GIT_READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'log', 'show', 'blame', 'diff', 'status', 'rev-parse', 'rev-list',
  'cat-file', 'ls-tree', 'ls-files', 'grep', 'shortlog', 'describe',
  'branch', 'tag', 'reflog', 'merge-base', 'name-rev',
]);

/**
 * Long options that write files, run a helper program, or read files
 * outside the repository. Git accepts any unambiguous prefix of a long
 * option, so a prefix of one of these is rejected too (see EXACT_PREFIX_OK).
 */
const FORBIDDEN_LONG_OPTIONS: readonly string[] = [
  'output',              // diff/log/show: write the output to a file
  'ext-diff',            // diff/log/show: run the configured external diff
  'textconv',            // diff/log/show/grep/cat-file: run textconv filters
  'filters',             // cat-file: run smudge filters
  'open-files-in-pager', // grep: run a pager program on the matches
  'upload-pack',         // run a program on the remote side
  'exec-path',
  'exec',
  'config-env',
  'no-index',            // diff/grep: compare or search files outside the repository
  'contents',            // blame: read the "working tree" version from any file
  'ignore-revs-file',    // blame: read any file, echoing bad lines in the error
  'pathspec-from-file',  // read pathspecs from any file
];

/** Real options that happen to be a prefix of a forbidden one. */
const EXACT_PREFIX_OK: ReadonlySet<string> = new Set(['text', 'filter', 'ignore-rev']);

interface ShortOptionRule {
  /** Letters that run a program or read a file named by their value. */
  readonly letters: string;
  /** Letters whose value is the rest of the bundle (in "-nC3", C takes "3"). */
  readonly takesValue: RegExp;
}

/**
 * Rule for the commands that take git's diff options, where
 * -O<orderfile> reads any file. In all of them a bundle such as
 * "-pO<path>" or "-RO<path>" reaches -O too. The value letters are the
 * diff and log options with an attached value, so "-SOBJ_ENCODING" (a
 * pickaxe string) and "-L/Old/,+5:file" (a line range) stay allowed.
 */
const DIFF_OPTIONS_RULE: ShortOptionRule = { letters: 'O', takesValue: /[BCGILMSUXln]/ };

/**
 * Forbidden short options per subcommand. Git lets short options share
 * one argument, so a bundle is checked letter by letter.
 */
const FORBIDDEN_SHORT_OPTIONS: Readonly<Record<string, ShortOptionRule>> = {
  // -O runs a pager on the matches; -f reads patterns from a file.
  grep: { letters: 'Of', takesValue: /[ABCem0-9]/ },
  // -S reads a revisions file, echoing bad lines in the error. Options
  // blame does not know go to the revision parser, which also takes -O.
  blame: { letters: 'OS', takesValue: /[LMC0-9]/ },
  diff: DIFF_OPTIONS_RULE,
  show: DIFF_OPTIONS_RULE,
  log: DIFF_OPTIONS_RULE,
  'rev-list': DIFF_OPTIONS_RULE,
  // shortlog's own short options (-n, -s, -e, -c) are flags, and only -w
  // takes a value, so any O in a bundle reaches -O.
  shortlog: { letters: 'O', takesValue: /w/ },
  // `git reflog` and `git reflog show` take log options.
  reflog: DIFF_OPTIONS_RULE,
};

/**
 * `branch` and `tag` list refs by default but create, rename, or delete
 * them with other options or with a bare name argument. Only these
 * listing options are accepted; a pattern argument needs --list.
 */
const LISTING_OPTIONS: Readonly<Record<'branch' | 'tag', { long: ReadonlySet<string>; short: RegExp }>> = {
  branch: {
    long: new Set([
      'list', 'all', 'remotes', 'verbose', 'contains', 'no-contains', 'merged', 'no-merged',
      'points-at', 'sort', 'format', 'show-current', 'column', 'no-column', 'color', 'no-color',
      'abbrev', 'no-abbrev', 'ignore-case', 'omit-empty',
    ]),
    // -a -r -v -l -i, bundled in any order.
    short: /^-[arvli]+$/,
  },
  tag: {
    long: new Set([
      'list', 'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format',
      'column', 'no-column', 'color', 'no-color', 'ignore-case', 'omit-empty',
    ]),
    // -l -i, and -n[<num>] (annotation lines).
    short: /^-(l|i|n\d*)$/,
  },
};

/** Listing options whose value may be the next argument rather than `--opt=value`. */
const LISTING_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  'contains', 'no-contains', 'merged', 'no-merged', 'points-at', 'sort', 'format',
]);

/** `git reflog` subcommands that rewrite or delete reflog entries. */
const REFLOG_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set(['expire', 'delete', 'drop', 'write']);

/** Options inserted after the subcommand so diff output never runs a configured helper. */
const SAFE_DIFF_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  diff: ['--no-ext-diff', '--no-textconv'],
  show: ['--no-ext-diff', '--no-textconv'],
  log: ['--no-ext-diff', '--no-textconv'],
  blame: ['--no-textconv'],
};

function longOptionName(arg: string): string | null {
  if (!arg.startsWith('--') || arg === '--') return null;
  const eq = arg.indexOf('=');
  return arg.slice(2, eq === -1 ? undefined : eq);
}

function forbiddenLongOption(name: string): string | undefined {
  return FORBIDDEN_LONG_OPTIONS.find((f) => f === name || (f.startsWith(name) && !EXACT_PREFIX_OK.has(name)));
}

/** The forbidden short option in a bundle such as "-nO", if any. */
function forbiddenShortOption(sub: string, arg: string): string | undefined {
  const rule = FORBIDDEN_SHORT_OPTIONS[sub];
  if (!rule || !arg.startsWith('-') || arg.startsWith('--')) return undefined;
  for (const ch of arg.slice(1)) {
    if (rule.letters.includes(ch)) return ch;
    if (rule.takesValue.test(ch)) return undefined;
  }
  return undefined;
}

function checkListingForm(sub: 'branch' | 'tag', rest: readonly string[]): string | null {
  const allowed = LISTING_OPTIONS[sub];
  let hasList = false;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    const long = longOptionName(arg);
    if (long !== null) {
      if (!allowed.long.has(long)) return `git ${sub} only lists refs here; "--${long}" is not allowed.`;
      if (long === 'list') hasList = true;
      if (LISTING_OPTIONS_WITH_VALUE.has(long) && !arg.includes('=')) i++;
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      if (!allowed.short.test(arg)) return `git ${sub} only lists refs here; "${arg}" is not allowed.`;
      if (arg.includes('l')) hasList = true;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length > 0 && !hasList) {
    return `git ${sub} with a name argument creates a ${sub === 'branch' ? 'branch' : 'tag'}. To filter the listing, pass --list before the pattern.`;
  }
  return null;
}

/**
 * Returns why `args` (the argv after "git") is not allowed, or null.
 * The checks keep the tool read-only: no ref changes, no file writes,
 * and no helper programs.
 */
export function checkGitArgs(args: readonly string[]): string | null {
  const sub = args[0];
  if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) {
    return `subcommand "${sub ?? ''}" is not on the allowlist. Allowed: ${[...GIT_READONLY_SUBCOMMANDS].sort().join(', ')}.`;
  }
  const rest = args.slice(1);
  for (const arg of rest) {
    // -c is git's per-command config override, and `git branch -c` copies a branch.
    if (arg === '-c') return 'argument "-c" is not allowed. Use --count with grep, or --cc for combined diffs.';
    // -O runs a pager (grep) or reads an order file from anywhere (diff).
    if (arg.startsWith('-O')) return `argument "${arg}" is not allowed: -O opens a pager or reads an arbitrary file.`;
    const short = forbiddenShortOption(sub, arg);
    if (short) return `argument "${arg}" is not allowed: git ${sub} -${short} runs a program or reads an arbitrary file.`;
    const long = longOptionName(arg);
    if (long !== null) {
      const forbidden = forbiddenLongOption(long);
      if (forbidden) return `argument "${arg}" is not allowed (--${forbidden} writes files, runs a helper, or reads outside the repository).`;
    }
  }
  if (sub === 'branch' || sub === 'tag') return checkListingForm(sub, rest);
  if (sub === 'reflog') {
    const write = rest.find((a) => REFLOG_WRITE_SUBCOMMANDS.has(a));
    if (write) return `git reflog ${write} changes the reflog; only reading it is allowed.`;
  }
  return null;
}

/** The argv actually run: helper-disabling options go right after the subcommand. */
export function gitArgv(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  return [sub!, ...(SAFE_DIFF_OPTIONS[sub!] ?? []), ...rest];
}

/**
 * Environment for the git process: no credentials, no system gitconfig
 * (which could define helpers), no index refresh on `git status`, and
 * no credential prompt when a lazy blob fetch needs the network.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...buildChildEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

export function buildGitTool(opts: { workspaceRoot: string }) {
  return tool({
    name: 'git',
    description:
`Run a read-only git command against the checked-out PR workspace.

Allowed subcommands: ${[...GIT_READONLY_SUBCOMMANDS].sort().join(', ')}. \`branch\` and \`tag\` only list refs (filter with --list <pattern>); \`reflog\` only reads.

Use this for:
- \`git log --oneline -20 <mergeBase>..<head>\`: PR commit history.
- \`git show <sha> -- <path>\`: inspect a specific commit or file.
- \`git blame -L <start>,<end> <path>\`: who last touched these lines.
- \`git diff <mergeBase>..<head> -- <path>\`: just the PR's changes on a file.
- \`git grep <pattern>\`: fast content search at the checked-out ref.

Arguments are passed as an ARRAY of tokens, with no shell interpolation.
E.g. args=["log","--oneline","-20","abc..def"], not args=["log --oneline -20 abc..def"].
Spell long options in full; abbreviations of disallowed options are rejected.

Output is capped at 500 KB and 60 s.`,
    inputSchema: z.object({
      args: z.array(z.string()).min(1).describe('git argv tokens after "git", e.g. ["log","--oneline","-20"]'),
    }),
    callback: async (input: { args: string[] }) => {
      const problem = checkGitArgs(input.args);
      if (problem) return `ERROR: ${problem}`;
      const r = await runBounded('git', gitArgv(input.args), { cwd: opts.workspaceRoot, env: gitEnv(), timeoutMs: 60_000, maxBytes: 500_000 });
      if (r.code !== 0 && !r.truncated) return `git exited ${r.code}\n${r.err}\n${r.out}`;
      return r.out;
    },
  });
}
