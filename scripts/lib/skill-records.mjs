// Graduated concern records and the registry records they point at, for
// the operator scripts. Reads go through an `aws` runner (aws-cli.mjs),
// so tests can pass a fake.

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
