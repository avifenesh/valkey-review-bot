import { randomBytes } from 'node:crypto';
import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import type { AgentConfig } from '@strands-agents/sdk';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createCuratorModel } from '../../common/src/model-fallback.js';
import { createRegistryClient, loadSkills } from '../../common/src/skills-registry.js';

import { loadAssets, loadEnv, renderTemplate } from './config.js';
import { curate } from './curate.js';
import { normalizeFeedback, reinforcerKey, renderFeedbackMessage, requestSchema, untrustedReason, type CuratorRequest } from './feedback.js';
import { skillPublisher } from './maintenance.js';
import { assembleCuratorTools } from './tools/index.js';
import { CuratorRun } from './tools/run.js';

/**
 * Curator entrypoint. One invocation per maintainer feedback event: the
 * model reads the feedback and the reviewer's concerns store, makes at
 * most one change to the store, and may graduate the record it
 * reinforced into a skill in the reviewer's registry.
 */

const env = loadEnv();
const assets = await loadAssets(env);
const templateValues = { GRADUATION_THRESHOLD: String(env.graduationThreshold) };
const prompt = renderTemplate(assets.prompt, templateValues);
const SYSTEM_PROMPT = assets.skill
  ? `${prompt}\n\n---\n\n## Skill: institutional memory\n\n${renderTemplate(assets.skill, templateValues)}`
  : prompt;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: env.region }));
const registryClient = createRegistryClient(env.region);
// The curator registry holds a handful of authoring skills; this bounds the read.
const AUTHORING_SKILL_LIMIT = 10;

console.log(`[boot] curator model=${env.modelId} region=${env.region} reviewers=${Object.keys(env.concernsTables).join(',')} graduation_threshold=${env.graduationThreshold}`);

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    process: async function* (request: CuratorRequest) {
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

      console.log(`[curator] ${result.status} feedback=${feedback.feedbackId} decision=${run.done?.decision ?? 'none'} actions=${run.actions.join(';') || 'none'} rounds=${result.rounds} summary=${run.done?.summary ?? ''}`);

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
