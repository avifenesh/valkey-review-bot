/**
 * Wire the harness-tools read/write/grep/glob/lsp tools with a permission
 * policy scoped to the workspace.
 */
import {
  read, readToolDefinition,
  write, writeToolDefinition, edit, editToolDefinition,
  multiEdit, multieditToolDefinition,
  grep, grepToolDefinition, defaultGrepEngine,
  glob, globToolDefinition,
  lsp, lspToolDefinition,
  type GrepEngine,
  type TextReadResult,
} from '@agent-sh/harness-tools';
import {
  defaultNodeOperations,
  defaultNodeWriteOperations,
  InMemoryLedger,
  InMemoryCache,
  isInsideAnyRoot,
  matchesAnyPattern,
  type PermissionPolicy,
  type WriteOperations,
} from '@agent-sh/harness-core';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { createSpawnLspClient, type LspManifest } from '@agent-sh/harness-tools/lsp';
import { adaptHarnessTool } from './adapter.js';

export interface HarnessToolsBundle {
  readonly tools: readonly unknown[];
  readonly workspaceRoot: string;
}

/** The real path of `target`'s nearest existing ancestor, joined with the rest of `target`. */
async function realpathOfExisting(target: string): Promise<string> {
  const rest: string[] = [];
  let p = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(p), ...rest);
    } catch (err) {
      const parent = path.dirname(p);
      if (parent === p) throw err;
      rest.unshift(path.basename(p));
      p = parent;
    }
  }
}

/**
 * harness-write checks a path that does not exist yet without resolving
 * the symlinks in it, so a write or mkdir under a directory symlink from
 * the PR would land wherever the symlink points. Check where each one
 * really lands, and refuse it outside the workspace or on a sensitive
 * path such as .git/hooks.
 */
function fenceWriteOps(inner: WriteOperations, root: string, sensitivePatterns: readonly string[]): WriteOperations {
  let realRoot: Promise<string> | undefined;
  const check = async (target: string, what: string) => {
    realRoot ??= realpath(root);
    const resolved = await realpathOfExisting(target);
    if (!isInsideAnyRoot(resolved, [await realRoot]) || matchesAnyPattern(resolved, sensitivePatterns)) {
      throw new Error(`refusing to ${what} ${target}: it resolves to ${resolved}, outside the workspace or on a sensitive path`);
    }
  };
  return {
    async writeAtomic(target, bytes) {
      await check(target, 'write');
      return inner.writeAtomic(target, bytes);
    },
    async mkdirp(dir) {
      await check(dir, 'create');
      return inner.mkdirp(dir);
    },
  };
}

/**
 * harness-grep checks the sensitive patterns against the search root
 * only. Drop matches in files that match them, as read refuses those.
 */
function fenceGrepEngine(inner: GrepEngine, sensitivePatterns: readonly string[]): GrepEngine {
  return {
    async *search(input) {
      for await (const m of inner.search(input)) if (!matchesAnyPattern(m.path, sensitivePatterns)) yield m;
    },
    async *count(input) {
      for await (const c of inner.count(input)) if (!matchesAnyPattern(c.path, sensitivePatterns)) yield c;
    },
  };
}

export async function buildHarnessTools(opts: { workspaceRoot: string; allowWrite?: boolean }): Promise<HarnessToolsBundle> {
  const roots = [opts.workspaceRoot] as const;
  const ledger = new InMemoryLedger();
  const readCache = new InMemoryCache<TextReadResult>();

  const permissions: PermissionPolicy = {
    roots,
    sensitivePatterns: [
      '**/.env*', '**/.aws/**', '**/id_rsa*', '**/*.pem', '**/*.key',
      '**/node_modules/**', '**/.git/**',
    ],
    bypassWorkspaceGuard: false,
  };

  const ops = defaultNodeOperations();
  const writeOps = fenceWriteOps(defaultNodeWriteOperations(), opts.workspaceRoot, permissions.sensitivePatterns);

  const readSession = { cwd: opts.workspaceRoot, permissions, ops, cache: readCache, ledger };
  const grepSession = { cwd: opts.workspaceRoot, permissions, ops, engine: fenceGrepEngine(defaultGrepEngine, permissions.sensitivePatterns) };
  const globSession = { cwd: opts.workspaceRoot, permissions, ops };
  const writeSession = { cwd: opts.workspaceRoot, permissions, ops, writeOps, ledger };

  // LSP servers come from this fixed manifest only. A .lsp.json in the
  // checkout is ignored: it belongs to the PR under review, and would let
  // it choose the command the LSP client starts.
  const lspManifest: LspManifest = {
    servers: {
      clangd: {
        language: 'c',
        extensions: ['.c', '.h'],
        command: ['clangd', '--background-index', '--header-insertion=never'],
        rootPatterns: ['compile_commands.json', '.git'],
      },
    },
  };
  const lspSession = {
    cwd: opts.workspaceRoot,
    permissions,
    manifest: lspManifest,
    client: createSpawnLspClient(),
  };

  // No shell tool: the reviewer works through these file tools plus the
  // argv-only git / gh_api_read / make (or build) wrappers, none of which
  // goes through a shell.
  const tools: unknown[] = [
    adaptHarnessTool({ def: readToolDefinition, fn: read, session: readSession }),
    adaptHarnessTool({ def: grepToolDefinition, fn: grep, session: grepSession }),
    adaptHarnessTool({ def: globToolDefinition, fn: glob, session: globSession }),
    adaptHarnessTool({ def: lspToolDefinition, fn: lsp, session: lspSession }),
  ];

  // Write/edit/multi_edit exist for assumption-testing: the agent may
  // patch the workspace to validate a hypothesis (add an assert, write a
  // repro, rebuild). Edits never leave the container: there is no
  // push/commit surface, and prepareWorkspace hard-resets the tree per
  // invocation.
  if (opts.allowWrite) {
    tools.push(adaptHarnessTool({ def: writeToolDefinition, fn: write, session: writeSession }));
    tools.push(adaptHarnessTool({ def: editToolDefinition, fn: edit, session: writeSession }));
    tools.push(adaptHarnessTool({ def: multieditToolDefinition, fn: multiEdit, session: writeSession }));
  }

  return { tools, workspaceRoot: opts.workspaceRoot };
}

