// Graduated concern records and the registry records they point at, for
// the operator scripts. Reads go through an `aws` runner (aws-cli.mjs),
// so tests can pass a fake.

import { scanItems } from './aws-cli.mjs';

/**
 * area_bucket values starting with this hold skill-lifecycle items, not
 * concern records (RESERVED_BUCKET_PREFIX in ops/src/decay.ts).
 */
export const RESERVED_BUCKET_PREFIX = '#';

export const isReservedBucket = (bucket) => typeof bucket === 'string' && bucket.startsWith(RESERVED_BUCKET_PREFIX);

/**
 * The reviewer id a concerns table belongs to. infra names each table
 * `<reviewer id with - as _>_concerns`, and reviewer ids are lowercase
 * words joined by hyphens. Null for any other name.
 */
export function reviewerIdOfTable(table) {
  const m = /^([a-z0-9]+(?:_[a-z0-9]+)*)_concerns$/.exec(table);
  return m ? m[1].replaceAll('_', '-') : null;
}

/** Every graduated_record_name in a concerns table, tombstones included. */
export function graduatedNames(aws, table) {
  const items = scanItems(aws, table, {
    projection: '#grn',
    filter: 'attribute_exists(#grn)',
    names: { '#grn': 'graduated_record_name' },
  });
  return new Set(items.map((i) => i.graduated_record_name).filter((n) => typeof n === 'string' && n));
}

/**
 * Registry record summaries that are not retired and that no concern
 * record names: the skills whose source record the decay job deleted
 * before graduated records were kept. Sorted by name.
 */
export function findOrphans(summaries, referenced, isRetired) {
  return summaries
    .filter((r) => !isRetired(r.status) && !referenced.has(r.name))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || (a.recordId ?? '').localeCompare(b.recordId ?? ''));
}

/**
 * The record id `deprecate` acts on: the one given, which must exist,
 * or the only record with the name that is not already retired. Throws
 * an Error with the reason otherwise.
 */
export function deprecateTarget(summaries, { name, recordId }, isRetired) {
  if (recordId) {
    if (!summaries.some((r) => r.recordId === recordId)) throw new Error(`no SKILL record ${recordId}`);
    return recordId;
  }
  const live = summaries.filter((r) => r.name === name && !isRetired(r.status));
  if (live.length === 0) throw new Error(`no record named ${name} that is not already deprecated or rejected`);
  if (live.length > 1) throw new Error(`${live.length} records are named ${name} (${live.map((r) => r.recordId).join(', ')}); pass --record-id`);
  return live[0].recordId;
}
