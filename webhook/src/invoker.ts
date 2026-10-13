import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { loadInvokerConfig } from './config.js';
import { pendingMarkerOf, type PendingMarker } from './review-envelope.js';
import { clearPendingReview } from './store.js';
import { decide, isCuratorMessage, messageTag, type HeartbeatRecord } from './watchdog.js';

/**
 * Queue worker: one message per invocation, forwarded unchanged to the
 * route's AgentCore runtime (a reviewer or the curator). The receiver
 * shaped each envelope for its runtime, so this code stays agnostic of
 * the payload. src/watchdog.ts decides whether a message runs at all.
 * Before it runs a review of new commits, it removes the pull request's
 * pending marker.
 */

const config = loadInvokerConfig(process.env);
const client = new BedrockAgentCoreClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

interface SqsRecord {
  readonly messageId: string;
  readonly body: string;
  readonly attributes?: { readonly ApproximateReceiveCount?: string; readonly SentTimestamp?: string };
}

interface SqsEvent {
  readonly Records: readonly SqsRecord[];
}

/** Thrown to leave the message on the queue without invoking: the prior attempt is still alive. */
class StillRunning extends Error {}

async function readHeartbeat(runKey: string): Promise<HeartbeatRecord | undefined> {
  const resp = await ddb.send(new GetCommand({ TableName: config.heartbeatTable, Key: { run_key: runKey } }));
  return resp.Item as HeartbeatRecord | undefined;
}

/**
 * A review of new commits holds its pull request's pending marker until
 * its run starts (src/store.ts); from then on a push can queue the next
 * round. A failure is logged and the run goes ahead: the marker then
 * expires on its own.
 */
async function clearPendingMarker(marker: PendingMarker, tag: string): Promise<void> {
  if (!config.idempotencyTable) {
    console.warn(`[pending] ${tag} IDEMPOTENCY_TABLE is not set; the pending marker stays until it expires`);
    return;
  }
  try {
    const cleared = await clearPendingReview(ddb, config.idempotencyTable, marker.repo, marker.prNumber, marker.markerId);
    console.log(`[pending] ${tag} marker=${marker.markerId} ${cleared ? 'cleared' : 'already gone'}`);
  } catch (err) {
    console.error(`[pending] ${tag} could not clear marker=${marker.markerId}; new commits are skipped until it expires`, err);
  }
}

async function handleOne(record: SqsRecord): Promise<void> {
  const envelope = JSON.parse(record.body) as Record<string, unknown>;
  const curator = isCuratorMessage(envelope);
  const receiveCount = parseInt(record.attributes?.ApproximateReceiveCount ?? '1', 10);
  const tag = messageTag(envelope);

  // Without the heartbeat table every redelivery would look like a dead
  // run and start a second review on the fallback model.
  if (!curator && !config.heartbeatTable) {
    throw new Error(`HEARTBEAT_TABLE is not set; refusing to run ${tag}`);
  }

  const decision = await decide({
    envelope,
    receiveCount,
    sentAt: parseInt(record.attributes?.SentTimestamp ?? '0', 10),
    now: Date.now(),
    runBudgetMs: config.runBudgetMs,
    staleMs: config.staleMs,
    readHeartbeat,
  });
  if (decision.action === 'delete') {
    if (decision.error) console.error(`[abandoned] ${tag} attempt=${receiveCount}: ${decision.reason}`);
    else console.log(`[watchdog] ${tag}: ${decision.reason}; nothing to do`);
    return;
  }
  if (decision.action === 'wait') {
    console.log(`[watchdog] ${tag} prior attempt alive (${decision.reason}); checking again after the visibility timeout`);
    throw new StillRunning();
  }

  const payload = decision.useFallbackModel ? { ...envelope, use_fallback_model: true } : envelope;
  console.log(`[invoke] ${tag} attempt=${receiveCount}${decision.useFallbackModel ? ` fallback_model=true (${decision.reason})` : ''}`);

  const marker = pendingMarkerOf(envelope);
  if (marker) await clearPendingMarker(marker, tag);

  const resp = await client.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: config.runtimeArn,
    contentType: 'application/json',
    accept: 'text/event-stream',
    payload: new TextEncoder().encode(JSON.stringify(payload)),
  }));
  if (!resp.response) throw new Error(`no response body for ${tag}`);

  // Read the event stream to the end. Only the done event decides the
  // outcome, the rest is logged for tracing. A review keeps running after
  // the stream closes; watchdog.ts decides what a redelivery does.
  let buffered = '';
  let done = false;
  for await (const chunk of resp.response as AsyncIterable<Uint8Array>) {
    buffered += Buffer.from(chunk).toString('utf8');
    let sep: number;
    while ((sep = buffered.indexOf('\n\n')) !== -1) {
      const frame = buffered.slice(0, sep);
      buffered = buffered.slice(sep + 2);

      let eventType = 'message';
      const data: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) eventType = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      const text = data.join('\n');
      if (eventType === 'done') {
        try {
          const parsed = JSON.parse(text) as { terminal_tool?: string; decision?: string };
          console.log(`[done] ${tag} terminal=${parsed.terminal_tool ?? parsed.decision}`);
        } catch {
          console.log(`[done] ${tag} data=${text.slice(0, 200)}`);
        }
        done = true;
      } else if (eventType === 'error') {
        console.error(`[stream-error] ${tag} data=${text}`);
      } else if (eventType === 'tool_use') {
        console.log(`[tool] ${tag} ${text}`);
      } else if (eventType === 'status') {
        console.log(`[status] ${tag} ${text}`);
      }
    }
  }

  if (!done) throw new Error(`stream closed without done event for ${tag}`);
}

export async function handler(event: SqsEvent): Promise<{ batchItemFailures: { itemIdentifier: string }[] }> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  // The event source uses batchSize 1; the loop also handles larger batches.
  for (const record of event.Records) {
    try {
      await handleOne(record);
    } catch (err) {
      if (!(err instanceof StillRunning)) {
        console.error(`[fail] messageId=${record.messageId}: ${err instanceof Error ? err.message : String(err)}`);
      }
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
