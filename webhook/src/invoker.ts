import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { loadInvokerConfig } from './config.js';
import { pendingMarkerOf, type PendingMarker } from './review-envelope.js';
import { clearPendingReview, extendPendingReview, holdsPendingReview } from './store.js';
import { decide, isCuratorMessage, messageTag, type HeartbeatRecord, type PullRequestRun } from './watchdog.js';

/**
 * Queue worker: one message per invocation, forwarded unchanged to the
 * route's AgentCore runtime (a reviewer or the curator). The receiver
 * shaped each envelope for its runtime, so this code stays agnostic of
 * the payload. src/watchdog.ts decides whether a message runs at all.
 * Just before it runs an automatic review, it removes the pull request's
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

/**
 * Thrown to leave the message on the queue without invoking: the prior
 * attempt, or another review of the pull request, is still alive.
 */
class StillRunning extends Error {}

async function readHeartbeat(runKey: string): Promise<HeartbeatRecord | undefined> {
  const resp = await ddb.send(new GetCommand({ TableName: config.heartbeatTable, Key: { run_key: runKey } }));
  return resp.Item as HeartbeatRecord | undefined;
}

/**
 * The running records of a pull request's runs. The heartbeat table is
 * keyed by run key alone, so this scans it with a filter on the key
 * prefix. That stays cheap: the table holds a day or two of runs (a
 * 24-hour TTL), and only an automatic review that is about to start
 * reads it.
 */
async function readPullRequestRuns(prefix: string): Promise<PullRequestRun[]> {
  const runs: PullRequestRun[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const resp = await ddb.send(new ScanCommand({
      TableName: config.heartbeatTable,
      FilterExpression: 'begins_with(#k, :prefix) AND #s = :running',
      ProjectionExpression: '#k, #a, #s',
      ExpressionAttributeNames: { '#k': 'run_key', '#a': 'last_activity', '#s': 'status' },
      ExpressionAttributeValues: { ':prefix': prefix, ':running': 'running' },
      ConsistentRead: true,
      ...(start ? { ExclusiveStartKey: start } : {}),
    }));
    runs.push(...((resp.Items ?? []) as PullRequestRun[]));
    start = resp.LastEvaluatedKey;
  } while (start);
  return runs;
}

/**
 * An automatic review holds its pull request's pending marker until its
 * run starts (src/store.ts); from then on the next event can queue the
 * next round. A message that still holds it has never run. Without
 * IDEMPOTENCY_TABLE, or without the grant to read it, the worker cannot
 * tell: it runs the message like any review and the marker expires on
 * its own. Any other failed read throws, and the message is retried.
 */
async function holdsMarker(marker: PendingMarker | undefined, tag: string): Promise<boolean> {
  if (!marker) return false;
  if (!config.idempotencyTable) {
    console.warn(`[pending] ${tag} IDEMPOTENCY_TABLE is not set; the pending marker stays until it expires`);
    return false;
  }
  try {
    return await holdsPendingReview(ddb, config.idempotencyTable, marker.repo, marker.prNumber, marker.markerId);
  } catch (err) {
    if ((err as { name?: string } | null)?.name !== 'AccessDeniedException') throw err;
    console.error(`[pending] ${tag} may not read ${config.idempotencyTable}; the pending marker stays until it expires`, err);
    return false;
  }
}

/**
 * Removes the marker just before the run starts. A failed delete throws,
 * so the message is retried instead of run: a marker left in place would
 * make the next receive run the review a second time.
 */
async function clearMarkerForRun(marker: PendingMarker, tag: string): Promise<void> {
  const cleared = await clearPendingReview(ddb, config.idempotencyTable, marker.repo, marker.prNumber, marker.markerId);
  console.log(`[pending] ${tag} marker=${marker.markerId} ${cleared ? 'cleared' : 'already gone'}`);
}

/** A review that gave up waiting lets go of its marker, so the next event can queue a review. */
async function clearMarkerQuietly(marker: PendingMarker, tag: string): Promise<void> {
  try {
    await clearMarkerForRun(marker, tag);
  } catch (err) {
    console.error(`[pending] ${tag} could not clear marker=${marker.markerId}; automatic reviews are skipped until it expires`, err);
  }
}

/**
 * A review that waits for another one keeps its marker an hour past
 * this receive. The next receive comes after the visibility timeout, so
 * the marker outlives the wait, and expires soon after the message ends
 * some other way.
 */
async function extendMarkerQuietly(marker: PendingMarker, tag: string): Promise<void> {
  try {
    const kept = await extendPendingReview(ddb, config.idempotencyTable, marker.repo, marker.prNumber, marker.markerId);
    if (!kept) console.warn(`[pending] ${tag} marker=${marker.markerId} is gone while the review waits`);
  } catch (err) {
    console.error(`[pending] ${tag} could not extend marker=${marker.markerId}; it may expire while the review waits`, err);
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

  // Every automatic review has a pending marker, and waits while any
  // other review of the pull request runs (src/watchdog.ts), so that two
  // automatic runs of a pull request do not overlap. @mention runs,
  // thread replies included, have no marker and do not wait: a
  // maintainer asked for the run and watches its status comment, which
  // would sit unanswered behind a review that can take an hour; and
  // after a wait the worker could not tell that such a run never
  // started, so it would run it on the fallback model.
  const marker = pendingMarkerOf(envelope);
  const held = await holdsMarker(marker, tag);
  const decision = await decide({
    envelope,
    receiveCount,
    sentAt: parseInt(record.attributes?.SentTimestamp ?? '0', 10),
    now: Date.now(),
    runBudgetMs: config.runBudgetMs,
    staleMs: config.staleMs,
    readHeartbeat,
    holdsMarker: held,
    ...(marker ? { readPullRequestRuns } : {}),
  });
  if (decision.action === 'delete') {
    if (decision.error) console.error(`[abandoned] ${tag} attempt=${receiveCount}: ${decision.reason}`);
    else console.log(`[watchdog] ${tag}: ${decision.reason}; nothing to do`);
    if (marker && held) await clearMarkerQuietly(marker, tag);
    return;
  }
  if (decision.action === 'wait') {
    if (decision.otherRun) {
      console.log(`[watchdog] ${tag} waits for ${decision.otherRun} (${decision.reason}); checking again after the visibility timeout`);
    } else {
      console.log(`[watchdog] ${tag} prior attempt alive (${decision.reason}); checking again after the visibility timeout`);
    }
    if (marker && held) await extendMarkerQuietly(marker, tag);
    throw new StillRunning();
  }

  if (marker && held) await clearMarkerForRun(marker, tag);

  const payload = decision.useFallbackModel ? { ...envelope, use_fallback_model: true } : envelope;
  console.log(`[invoke] ${tag} attempt=${receiveCount}${decision.useFallbackModel ? ` fallback_model=true (${decision.reason})` : ''}`);

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
