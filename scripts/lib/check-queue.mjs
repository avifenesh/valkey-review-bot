// Check requests for the curator queue, made the way the daily decay
// pass makes them (ops/src/decay.ts): the same claim on the concerns
// record, the same message body and the same SQS attributes. The curator
// runs a check only while the record's maintenance_id equals the
// message's, so the claim is what makes a message count.

import { isConditionFailure, quoted, scanItems } from './aws-cli.mjs';
import { isReservedBucket } from './skill-records.mjs';
import { printable } from './text.mjs';

// The limits ops/src/decay.ts applies, so the curator accepts every
// message this sends. test/check-queue.test.mjs checks the messages and
// claims against what decayTable sends and writes.
export const MAINTENANCE_RETRY_DAYS = 7;
/** Checks queued per run unless the caller says otherwise: the decay pass's default SKILL_CHECKS_PER_DAY. */
export const DEFAULT_CHECK_LIMIT = 10;
const DAY_MS = 24 * 3600 * 1000;
const CHECK_STAGGER_SECONDS = 60;
const MAX_DELAY_SECONDS = 900;
/** A graduated_record_name the decay pass can put in a maintenance message (RECORD_NAME_RE in ops/src/decay.ts). */
export const RECORD_NAME_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
export const REVIEWER_ID_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const MAX_MAINTENANCE_ID = 200;
const MAX_AREA_BUCKET = 200;
const MAX_RECORD_ID = 100;

const ATTRIBUTES = {
  '#b': 'area_bucket',
  '#rid': 'record_id',
  '#grn': 'graduated_record_name',
  '#ua': 'updated_at',
  '#ga': 'graduated_at',
  '#va': 'verified_at',
  '#ret': 'retired_at',
  '#mra': 'maintenance_requested_at',
  '#mr': 'maintenance_reason',
};

export const maintenanceId = (reviewerId, recordId, nowIso) => `check#${reviewerId}#${recordId}#${nowIso}`;

/** DelaySeconds of the i-th check of a run, as the decay pass staggers them. */
export const checkDelay = (i) => Math.min(MAX_DELAY_SECONDS, CHECK_STAGGER_SECONDS * i);

/** A record's table and key for an output line; the values are model-chosen, so quoted. */
export const recordRef = (key) => `bucket=${quoted(key.area_bucket)} id=${quoted(key.record_id)}`;

const timeOf = (value) => Date.parse(typeof value === 'string' ? value : '');

/**
 * Where a record sorts, as the decay pass orders its checks: never
 * checked first (oldest graduation first), then re-published since its
 * check, then the oldest check.
 */
function checkOrder(item) {
  const verifiedMs = timeOf(item.verified_at);
  const graduatedMs = timeOf(item.graduated_at);
  if (!Number.isFinite(verifiedMs)) return { rank: 0, sinceMs: Number.isFinite(graduatedMs) ? graduatedMs : 0 };
  return { rank: Number.isFinite(graduatedMs) && graduatedMs > verifiedMs ? 1 : 2, sinceMs: verifiedMs };
}

/**
 * Which live graduated records get a check, and why the others do not.
 * `name` narrows it to the record that graduated under that name.
 * Records in reserved buckets are not concern records and are left out.
 * Returns `checks` in the decay pass's order (checkOrder, then bucket
 * and id), `skipped` with a reason each, sorted by bucket and id, and
 * `matched`, how many records `name` matched.
 */
export function planChecks(items, { reviewerId, name, nowMs }) {
  const nowIso = new Date(nowMs).toISOString();
  const checks = [];
  const skipped = [];
  let matched = 0;
  for (const item of items) {
    const { area_bucket: bucket, record_id: recordId, graduated_record_name: grn } = item;
    if (typeof bucket !== 'string' || typeof recordId !== 'string' || isReservedBucket(bucket)) continue;
    if (typeof grn !== 'string' || !grn) continue;
    if (name !== undefined && grn !== name) continue;
    matched += 1;
    const key = { area_bucket: bucket, record_id: recordId };
    const skip = (reason) => skipped.push({ key, name: grn, reason });
    if (item.retired_at !== undefined) {
      skip('retired; a tombstone gets no checks');
      continue;
    }
    const requestedAt = typeof item.maintenance_requested_at === 'string' ? item.maintenance_requested_at : undefined;
    const requestedMs = Date.parse(requestedAt ?? '');
    if (Number.isFinite(requestedMs) && nowMs - requestedMs < MAINTENANCE_RETRY_DAYS * DAY_MS) {
      skip(`in flight: ${quoted(item.maintenance_reason ?? '?')} requested at ${quoted(requestedAt)}; a new request is allowed ${MAINTENANCE_RETRY_DAYS} days after it`);
      continue;
    }
    if (typeof item.updated_at !== 'string' || !item.updated_at) {
      skip('no updated_at');
      continue;
    }
    if (!RECORD_NAME_RE.test(grn)) {
      skip('graduated_record_name is not a registry record name');
      continue;
    }
    if (bucket.length > MAX_AREA_BUCKET || recordId.length > MAX_RECORD_ID || maintenanceId(reviewerId, recordId, nowIso).length > MAX_MAINTENANCE_ID) {
      skip('area_bucket or record_id is too long for a maintenance message');
      continue;
    }
    checks.push({ key, name: grn, updatedAt: item.updated_at, requestedAt, ...checkOrder(item) });
  }
  const byKey = (a, b) => a.key.area_bucket.localeCompare(b.key.area_bucket) || a.key.record_id.localeCompare(b.key.record_id);
  checks.sort((a, b) => a.rank - b.rank || a.sinceMs - b.sinceMs || byKey(a, b));
  return { checks, skipped: skipped.sort(byKey), matched };
}

/** The message body, as decay builds a CheckMessage. */
export function checkMessage({ id, reviewerId, check, releaseTag, dryRun }) {
  return {
    maintenance_id: id,
    reason: 'check',
    reviewer_id: reviewerId,
    area_bucket: check.key.area_bucket,
    record_id: check.key.record_id,
    record_name: check.name,
    release_tag: releaseTag,
    seen_updated_at: check.updatedAt,
    dry_run: dryRun,
  };
}

const typedKey = (key) => JSON.stringify({ area_bucket: { S: key.area_bucket }, record_id: { S: key.record_id } });

/**
 * `aws dynamodb update-item` arguments that claim the check: SET
 * maintenance_id, maintenance_requested_at and maintenance_reason, as
 * decay does, while the record is still live under the name, unchanged
 * since it was read and has no newer request. Nothing else is written;
 * any other maintenance_* attribute (a curator marker) is kept.
 */
export function claimArgs(table, check, id, nowIso) {
  const names = {
    '#grn': ATTRIBUTES['#grn'], '#ret': ATTRIBUTES['#ret'], '#ua': ATTRIBUTES['#ua'],
    '#mid': 'maintenance_id', '#mra': ATTRIBUTES['#mra'], '#mr': ATTRIBUTES['#mr'],
  };
  const values = { ':mid': { S: id }, ':now': { S: nowIso }, ':mr': { S: 'check' }, ':grn': { S: check.name }, ':ua': { S: check.updatedAt } };
  let condition = '#grn = :grn AND attribute_not_exists(#ret) AND #ua = :ua';
  if (check.requestedAt === undefined) {
    condition += ' AND attribute_not_exists(#mra)';
  } else {
    condition += ' AND #mra = :mra';
    values[':mra'] = { S: check.requestedAt };
  }
  return [
    'dynamodb', 'update-item', '--table-name', table, '--key', typedKey(check.key),
    '--update-expression', 'SET #mid = :mid, #mra = :now, #mr = :mr',
    '--condition-expression', condition,
    '--expression-attribute-names', JSON.stringify(names),
    '--expression-attribute-values', JSON.stringify(values),
  ];
}

/** `aws sqs send-message` arguments, with the attributes decay sets. */
export function sendArgs(queueUrl, message, delaySeconds) {
  const attr = (value) => ({ DataType: 'String', StringValue: value });
  return [
    'sqs', 'send-message', '--queue-url', queueUrl, '--message-body', JSON.stringify(message),
    '--delay-seconds', String(delaySeconds),
    '--message-attributes', JSON.stringify({
      reviewer_id: attr(message.reviewer_id),
      maintenance_id: attr(message.maintenance_id),
      reason: attr(message.reason),
    }),
  ];
}

/** `aws dynamodb update-item` arguments that drop a claim whose message was not sent. */
export function releaseArgs(table, key, id) {
  return [
    'dynamodb', 'update-item', '--table-name', table, '--key', typedKey(key),
    '--update-expression', 'REMOVE #mid, #mra, #mr',
    '--condition-expression', '#mid = :mid',
    '--expression-attribute-names', JSON.stringify({ '#mid': 'maintenance_id', '#mra': 'maintenance_requested_at', '#mr': 'maintenance_reason' }),
    '--expression-attribute-values', JSON.stringify({ ':mid': { S: id } }),
  ];
}

/**
 * Claim and queue a check of the live graduated records of `table` (or
 * the one graduated as `name`), at most `limit` of them, in the decay
 * pass's order and with its delays. With `plan`, only print what it
 * would queue. Returns the counts; `deferred` is how many were left over
 * `limit`. The caller turns errors into the exit code.
 */
export function queueChecks({
  aws, table, queueUrl, reviewerId, name, releaseTag, dryRun, plan, nowMs, limit = DEFAULT_CHECK_LIMIT, log = console.log,
}) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error(`the limit must be a whole number of at least 1, got ${limit}`);
  const nowIso = new Date(nowMs).toISOString();
  const items = scanItems(aws, table, {
    projection: Object.keys(ATTRIBUTES).join(', '),
    filter: 'attribute_exists(#grn)',
    names: ATTRIBUTES,
  });
  const { checks, skipped, matched } = planChecks(items, { reviewerId, name, nowMs });
  if (name !== undefined && matched === 0) throw new Error(`no concern record in ${table} graduated as ${quoted(name)}`);
  for (const s of skipped) log(`skipped ${recordRef(s.key)} name=${quoted(s.name)}: ${s.reason}`);

  let claims = 0;
  let queued = 0;
  let lost = 0;
  let deferred = 0;
  let errors = 0;
  for (const check of checks) {
    const id = maintenanceId(reviewerId, check.key.record_id, nowIso);
    const line = `${recordRef(check.key)} name=${quoted(check.name)}`;
    // As in the decay pass, only claims made count, so a record that changed under us frees its slot.
    if (claims >= limit) {
      deferred += 1;
      log(`over the limit ${line}: a later run can queue it`);
      continue;
    }
    if (plan) {
      log(`would queue ${line} delay=${checkDelay(claims)}s`);
      claims += 1;
      queued += 1;
      continue;
    }
    try {
      aws(claimArgs(table, check, id, nowIso));
    } catch (err) {
      if (isConditionFailure(err)) {
        lost += 1;
        log(`skipped ${line}: it changed since it was read (reinforced, retired or claimed by the decay pass)`);
      } else {
        errors += 1;
        log(`error ${line}: claim failed: ${printable(err.message)}`);
      }
      continue;
    }
    // Staggered like the decay pass, so the checks do not hold up maintainer feedback on the shared queue.
    const delay = checkDelay(claims);
    claims += 1;
    const message = checkMessage({ id, reviewerId, check, releaseTag, dryRun });
    try {
      aws(sendArgs(queueUrl, message, delay));
      queued += 1;
      log(`queued ${line} delay=${delay}s maintenance=${quoted(id)}`);
    } catch (err) {
      errors += 1;
      log(`error ${line}: send failed: ${printable(err.message)}`);
      try {
        aws(releaseArgs(table, check.key, id));
      } catch (releaseErr) {
        if (!isConditionFailure(releaseErr)) {
          log(`error ${line}: could not release maintenance=${quoted(id)}; the record gets no new request for ${MAINTENANCE_RETRY_DAYS} days: ${printable(releaseErr.message)}`);
        }
      }
    }
  }
  return { queued, skipped: skipped.length + lost, deferred, errors };
}
