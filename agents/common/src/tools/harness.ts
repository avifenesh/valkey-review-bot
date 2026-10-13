/**
 * Wire the harness-tools read/write/grep/glob/lsp tools with a permission
 * policy scoped to the workspace.
 */
import {
  read, readToolDefinition,
  write, writeToolDefinition, edit, editToolDefinition,
  multiEdit, multieditToolDefinition,
  grep, grepToolDefinition,
  glob, globToolDefinition,
  lsp, lspToolDefinition,
  type TextReadResult,
} from '@agent-sh/harness-tools';
import {
  defaultNodeOperations,
  defaultNodeWriteOperations,
  InMemoryLedger,
  InMemoryCache,
  type PermissionPolicy,
} from '@agent-sh/harness-core';
import { createSpawnLspClient, type LspManifest } from '@agent-sh/harness-tools/lsp';
import { adaptHarnessTool } from './adapter.js';

export interface HarnessToolsBundle {
  readonly tools: readonly unknown[];
  readonly workspaceRoot: string;
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
  const writeOps = defaultNodeWriteOperations();

  const readSession = { cwd: opts.workspaceRoot, permissions, ops, cache: readCache, ledger };
  const grepSession = { cwd: opts.workspaceRoot, permissions, ops };
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

