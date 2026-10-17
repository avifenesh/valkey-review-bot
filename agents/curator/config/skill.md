---
name: valkey-reviewer-curator
description: "Use when curating reviewer-feedback events for the valkey-review, valkey-glide-review and valkey-review-bot-review agents. Covers the judgment calls the base prompt leaves open: reading polarity, bump versus create, area_bucket conventions, context hygiene and graduation."
---

# valkey-reviewer curator: judgment calls

The base prompt gives the workflow and the tool rules. This file covers
the judgment calls inside Phase 1 and Phase 2. Read it once per run and
let it inform your decisions; do not narrate it in your output.

## Reading polarity

The most error-prone judgment is what the person is actually saying
about the review. Common shapes:

- **Plain reinforcement**: "good catch", "you're right", "agree", `+1`.
  Bump the matching record.
- **Reinforcement with extension**: "yes, and the same thing happens in
  `<other-place>`". Bump, and when the extension widens the scope, pass
  the wider glob list as `area` in the same `bump_concern` call rather
  than creating a sibling record. Two records that cover the same diff
  shape split the reinforcements and later graduate into overlapping
  skills that produce duplicate findings.
- **Reinforcement with context**: "yes, this is intentional because
  `<history>`". Bump, and when the person gives a genuine off-code
  reason, pass it as `context_addition` in the same call. Quote their
  words; do not paraphrase.
- **Pushback with a reason**: "this is not a bug because `<reason>`". The
  review pattern got the finding wrong. If a record drove the finding,
  add the reason to it with `update_concern`. If no record covers it,
  create one that describes what makes this class of finding wrong in
  this area. Do not bump.
- **Pushback on style**: "drop the PR-number reference", "rephrase
  this", "less harsh". These are rules for the bot's prose, not code
  concerns. Do not create a record from them.
- **Author defense**: the pull request's author defends their own change.
  Low signal: drop it unless the author cites code evidence the review
  missed.
- **Off-topic chatter**: maintainers discussing something unrelated in
  the same thread. Drop.

When polarity is unclear (a one-word "ok" with no context), choose
**noop** and wait for a clearer event in the same area.

## area_bucket conventions

`area_bucket` is the partition key and decides which records
`list_concerns` returns. Pick it so the next lookup that should find the
record does.

- **Top-level directory** for monorepo roots: `glide-core`, `java`,
  `python`, `node`, `go`, `src`, `deps`, `tests`, `tests/unit/cluster`,
  and for the reviewer's own repository `infra`, `webhook`, `ops`,
  `scripts`, `docs`.
- **One level deeper on shared roots** when the concern belongs to one
  subsystem: `src/replication.c`, `src/reply_blocking.c`,
  `glide-core/src/client`, and `agents/common`, `agents/curator` or
  `infra/lib` in the reviewer's own repository. `agents` alone is too
  broad: it holds every reviewer and the curator.
- **No deeper than two levels.** A bucket such as
  `src/replication.c/handshake/seed-phase` is never looked up and the
  record becomes invisible.

If a concern spans several top-level areas, use the broadest useful
bucket and list the file globs in the record's `area`.

## Bump, create, update, merge

- **Bump before create.** A missed reinforcement only delays
  graduation; a near-duplicate record splits the reinforcements and can
  graduate into a second, overlapping skill.
- **Create only when no record covers the new shape.** "Does not cover"
  means a reviewer who read the existing records before this pull
  request would still have made the bot's mistake.
- **Update when the feedback explains or rescopes without agreeing.**
  The record keeps its count; the reviewer gets the reason or the
  corrected globs.
- **Merge only after reading both records and confirming the overlap.**
  The merged record inherits both areas, subjects and contexts; a lossy
  merge produces a vague record that fires too often.
- **noop is a real choice.** Use it when the signal is ambiguous, or the
  person did not engage with the substance of the finding.

## Concern wording

A concern is text the next reviewer reads before reviewing this area.

- **Affirmative voice.** "When reviewing X, check that Y" rather than
  "Don't forget Y".
- **Concrete identifiers.** Name the function, struct, file or invariant
  by its symbol: `replicationHandlePrimaryDisconnection`, not "the
  disconnect handler".
- **No PR numbers, maintainer names, logins or review ids** in any field
  of the record.
- **Two to four sentences.**
- **No rules for the curator.** A concern says what to flag in the code,
  not what the curator should do later.

## Context field

`context` carries the off-code reason the reviewer cannot derive from
the diff. Examples that belong there:

- "A synchronous waitForClientIO call used to make freeClient(primary)
  run inline; the async-free path that replaced it is what makes this
  race possible."
- "The asymmetry between immediate module notifications and deferred
  client pub/sub is intentional: modules must observe state at the
  originating call site."
- "Vendored from upstream lz4; the project re-vendors byte-identical
  copies and does not modernize them."

Examples that do not:

- The bot's reasoning ("the bot suspected this because ...").
- Restated diff content ("this code calls freeClient async ...").
- General programming knowledge ("a condvar wait must hold the guard
  ...").
- Guesses about what the maintainer "probably" meant.

When the feedback gives no genuine off-code reason, leave `context`
empty.

## Graduation

By the time a record is eligible it has {{GRADUATION_THRESHOLD}} or more
reinforcements from different people or pull requests. The skill should
show that: patterns at this strength have several call-site examples,
and one or two of them in `## Patterns` make the skill convincing to the
next reviewer.

The rules that are easy to miss:

- **The description uses pull request vocabulary.** The reviewer loads
  every skill in its registry, so concrete file names, function names
  and domain terms help it apply the right skill and skip near misses.
  Take the symbols from the record's `area` and `concern`.
- **Every pattern has a `Skip unless:` line.** If you cannot say what
  must appear in the diff for the pattern to fire, it is not ready.
- **`## Do NOT flag` is required** when the concern ever drew a style
  correction or a "this is intentional" clarification.
- **No PR numbers in the body.** End with the source record_id and
  nothing else.
- **A skill that graduated before is edited, not rewritten.** Start
  from the text `get_skill` returns, which can hold the release
  check's corrections, and change only what the feedback changes.
  Suppressed blocks (`<!-- suppressed: ... -->` to
  `<!-- /suppressed -->`) stay exactly as they are.
- **Code names in backticks, spelled as in code.** Every file path,
  function, struct, macro and config name goes in backticks exactly as
  the code spells it; placeholders go only in fenced blocks. The
  release check looks up every backticked name upstream.

## Things to never do

- Never call `submit_skill` unless a `bump_concern` or `merge_concerns`
  in this run reported `eligible_for_graduation: true`, or an
  `update_concern` in this run corrected a graduated record whose
  skill is live.
- Retired records are bumped, never recreated. When the feedback
  matches a record whose `skill_state` is `retired`, bump it: a
  reinforcement can restore its skill. A new record for the same
  concern would split its reinforcements and publish a second skill.
- Never write, edit or remove a suppression marker. Only the release
  check's code writes them.
- Never delete a record after it graduated; it is the provenance of the
  published skill.
- Never paraphrase the maintainer's words into `context`. Quote and
  trim. Their wording is evidence; yours is not.
- Never pick `created` when the bucket already holds five or more
  records. That is a sign the bucket needs merging. Prefer `noop` and
  let later events bump or merge the existing records.

## Failure modes

- **Over-curation cascade**: one noisy thread produces three records on
  slightly different aspects of one concern; none reaches the threshold,
  or several graduate and the reviewer over-fires in that area. Symptom: a bucket with
  four or more records at reinforcement_count 1 and overlapping `area`
  globs. Fix: merge them on a later event.
- **Under-curation drift**: the same maintainer correction recurs across
  several pull requests, but each time the curator chose `noop` because
  the wording differed. Fix: compare the substance of existing concerns,
  not their phrasing.
- **Style-rule contamination**: a record that says "do not cite PR
  numbers in surfaced text". That is a rule for the bot's prose, not a
  code concern. Fix: delete it; never let it graduate.
- **Polarity flip**: reading "I disagree" as reinforcement because the
  reply was long. Fix: read the bot comment and the reply side by side
  and ask whether the person confirmed or challenged the finding.

## Calibration reminder

Over-curation dilutes the records that matter; under-curation loses
real patterns. When in doubt, prefer under-curation: the next event
picks up a real pattern, while noise in the store is expensive to clean
out.
