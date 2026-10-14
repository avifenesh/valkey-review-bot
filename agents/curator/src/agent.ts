import { randomBytes } from 'node:crypto';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import type { AgentConfig } from '@strands-agents/sdk';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCuratorModel } from '../../common/src/model-fallback.js';
import { createRegistryClient, loadSkills } from '../../common/src/skills-registry.js';

import { renderCheckPrompt } from './check-run.js';
import { loadAssets, loadEnv, renderTemplate } from './config.js';
import { curate } from './curate.js';
import { feedbackDoneLine, normalizeFeedback, reinforcerKey, renderFeedbackMessage, untrustedReason, type CuratorRequest } from './feedback.js';
import {
  curatorRequestSchema,
  handleMaintenance,
  isMaintenanceRequest,
  maintenanceDoneLine,
  maintenanceRegistry,
  skillPublisher,
  type CuratorMessage,
  type MaintenanceRequest,
  type RepoSkillApi,
  type RepoSkillPrResult,
  type RepoSkillProposal,
} from './maintenance.js';
import { assembleCuratorTools } from './tools/index.js';
import { CuratorRun } from './tools/run.js';

/**
 * Curator entrypoint. One invocation per message on the curator queue:
 *
 * - A maintainer feedback event (feedback_id): the model reads the
 *   feedback and the reviewer's concerns store, makes at most one change
 *   to the store, and may graduate the record it reinforced into a skill
 *   in the reviewer's registry.
 * - A skill maintenance message from the decay job (maintenance_id):
 *   a release check or a retirement, see maintenance.ts.
 */

const env = loadEnv();
const assets = await loadAssets(env);
const templateValues = { GRADUATION_THRESHOLD: String(env.graduationThreshold) };
const prompt = renderTemplate(assets.prompt, templateValues);
const SYSTEM_PROMPT = assets.skill
  ? `${prompt}\n\n---\n\n## Skill: institutional memory\n\n${renderTemplate(assets.skill, templateValues)}`
  : prompt;

// A placeholder typo in skill-check.md fails here, at boot.
const CHECK_PROMPT = assets.checkPrompt ? renderCheckPrompt(assets.checkPrompt) : '';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }));
const registryClient = createRegistryClient(env.region);
// The curator registry holds a handful of authoring skills; this bounds the read.
const AUTHORING_SKILL_LIMIT = 10;

console.log(`[boot] curator model=${env.modelId} region=${env.region} reviewers=${Object.keys(env.concernsTables).join(',')} graduation_threshold=${env.graduationThreshold}`);
console.log(`[boot] skill maintenance upstreams=${JSON.stringify(env.upstreamRepos)} audit_prompt=${CHECK_PROMPT ? 'loaded' : 'none'} apply_edits=${env.checkApplyEdits} retire_skills=${env.retireSkills} open_pull_requests=${env.checkOpenPullRequests} skills_repo=${env.skillsRepo?.repo ?? 'none'}`);

/**
 * The skills-repo pull request module and its token source ship in their
 * own package. They are loaded on first use, by a specifier TypeScript
 * does not resolve, so the feedback path never loads them; the expected
 * exports are checked here.
 */
interface RepoSkillPrModule {
  proposeRepoSkillChange(p: RepoSkillProposal, deps: {
    repo: string; baseBranch: string; reviewerIds: readonly string[]; signOff?: string; getToken: () => Promise<string>;
  }): Promise<RepoSkillPrResult>;
  fetchRepoFile(repo: string, ref: string, path: string): Promise<{ sha: string; content: string } | null>;
}
interface SkillsRepoTokenModule {
  createSkillsRepoTokenSource(opts: { functionName: string; region: string }): { get(): Promise<string> };
}

async function loadModule<T>(file: string, exports: readonly string[]): Promise<T> {
  const mod = await import(new URL(file, import.meta.url).href) as Record<string, unknown>;
  const missing = exports.filter((name) => typeof mod[name] !== 'function');
  if (missing.length > 0) throw new Error(`${file} does not export ${missing.join(', ')}`);
  return mod as T;
}

let repoSkillApi: Promise<RepoSkillApi> | undefined;
function repoSkills(): Promise<RepoSkillApi> {
  repoSkillApi ??= (async () => {
    const pr = await loadModule<RepoSkillPrModule>('./repo-skill-pr.js', ['proposeRepoSkillChange', 'fetchRepoFile']);
    return {
      fetchRepoFile: (repo, ref, path) => pr.fetchRepoFile(repo, ref, path),
      propose: async (proposal) => {
        const settings = env.skillsRepo;
        if (!settings?.tokenFunction) throw new Error('no skills-repo token broker is configured');
        const { createSkillsRepoTokenSource } = await loadModule<SkillsRepoTokenModule>('./skills-repo-token.js', ['createSkillsRepoTokenSource']);
        const tokens = createSkillsRepoTokenSource({ functionName: settings.tokenFunction, region: env.region });
        return pr.proposeRepoSkillChange(proposal, {
          repo: settings.repo,
          baseBranch: settings.baseBranch,
          // The reviewers this curator serves: the only repo skill files it may propose.
          reviewerIds: Object.keys(env.concernsTables),
          ...(settings.signOff ? { signOff: settings.signOff } : {}),
          getToken: () => tokens.get(),
        });
      },
    };
  })();
  // A failed load is retried by the next run.
  repoSkillApi.catch(() => { repoSkillApi = undefined; });
  return repoSkillApi;
}

/**
 * One maintenance message, registered as an async task so the runtime's
 * /ping reports HealthyBusy while a check runs: AgentCore stops a
 * session that reports Healthy for 15 minutes.
 */
async function* maintain(req: MaintenanceRequest) {
  const table = env.concernsTables[req.reviewer_id];
  const registryId = env.skillsRegistries[req.reviewer_id];
  if (!table || !registryId) {
    throw new Error(`reviewer_id "${req.reviewer_id}" has no concerns table or skills registry configured`);
  }
  const task = app.addAsyncTask('maintenance', { maintenance_id: req.maintenance_id });
  try {
    const result = yield* handleMaintenance(req, {
      ddb,
      table,
      registry: maintenanceRegistry(registryClient, registryId),
      settings: env,
      audit: {
        // See the feedback path for the cast.
        model: () => createCuratorModel(env) as unknown as AgentConfig['model'],
        systemPrompt: CHECK_PROMPT,
      },
      repoSkills,
    });
    console.log(maintenanceDoneLine(req, result));
    yield {
      event: 'done',
      data: { status: result.status, maintenance_id: req.maintenance_id, reviewer_id: req.reviewer_id, reason: req.reason, decision: result.decision },
    };
  } finally {
    app.completeAsyncTask(task);
  }
}

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    // A feedback event or a maintenance message, told apart by maintenance_id.
    requestSchema: curatorRequestSchema,
    process: async function* (body: CuratorMessage) {
      if (isMaintenanceRequest(body)) {
        yield* maintain(body);
        return;
      }
      const request: CuratorRequest = body;
      const feedback = normalizeFeedback(request);
      const skip = untrustedReason(feedback);
      if (skip) {
        console.log(`[curator] skipped feedback=${feedback.feedbackId}: ${skip}`);
        yield { event: 'done', data: { status: 'skipped', feedback_id: feedback.feedbackId, reviewer_id: feedback.reviewerId, decision: 'skipped', summary: skip } };
        return;
      }

      const table = env.concernsTables[feedback.reviewerId];
      const registryId = env.skillsRegistries[feedback.reviewerId];
      if (!table || !registryId) {
        throw new Error(`reviewer_id "${feedback.reviewerId}" has no concerns table or skills registry configured`);
      }

      const run = new CuratorRun({
        reviewerId: feedback.reviewerId,
        kind: feedback.kind,
        reinforcer: reinforcerKey(feedback),
        graduationThreshold: env.graduationThreshold,
      });
      const tools = assembleCuratorTools({
        ddb,
        table,
        run,
        registry: skillPublisher(registryClient, registryId),
        authoring: env.curatorSkillsRegistryId
          ? {
            load: async () => (await loadSkills(registryClient, env.curatorSkillsRegistryId, AUTHORING_SKILL_LIMIT)).skills
              .map((s) => ({ name: s.name, description: s.description, body: s.skillMd })),
          }
          : {},
      });

      yield { event: 'status', data: { phase: 'curate', feedback: feedback.feedbackId, reviewer: feedback.reviewerId } };

      const result = yield* curate({
        // agents/common builds the model against its own installed copy of
        // the Strands SDK. The classes match at runtime, but TypeScript sees
        // two separate declarations.
        model: createCuratorModel(env) as unknown as AgentConfig['model'],
        systemPrompt: SYSTEM_PROMPT,
        tools,
        run,
        maxIterations: env.maxIterations,
        message: renderFeedbackMessage(feedback, {
          marker: randomBytes(12).toString('hex'),
          graduationThreshold: env.graduationThreshold,
        }),
      });

      console.log(feedbackDoneLine(feedback.feedbackId, result, run.done, run.actions));

      yield {
        event: 'done',
        data: {
          status: result.status,
          feedback_id: feedback.feedbackId,
          reviewer_id: feedback.reviewerId,
          decision: run.done?.decision ?? null,
          summary: (run.done?.summary ?? '').slice(0, 600),
          actions: run.actions,
          final_text_preview: result.finalText.slice(0, 400),
        },
      };
    },
  },
});

app.run();
