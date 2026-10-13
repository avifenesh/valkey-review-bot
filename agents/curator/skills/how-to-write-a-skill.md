---
name: how-to-write-a-skill
description: "Use when graduating a concern record to a skill_md submission for a reviewer's skills registry. Loads the trigger-phrasing rules, body template, mandatory structural elements (Skip unless, Do NOT flag, confidence ladder), length budgets, naming and failure modes the curator must follow when composing skill_md. Retrieve at the start of Phase 2, before writing any markdown."
---

# How to compose a reviewer skill from a graduated concern record

This skill is the curator's reference for **Phase 2 only**. Phase 1
decisions (bump, update, merge, create, delete, drop, noop) do not need
this content. Read it after `bump_concern` or `merge_concerns` reports
`eligible_for_graduation: true` in this run.

If the record already has a `graduated_record_name`, its skill is live.
Submit again only when this feedback changes what the skill should say
(new context, wider or narrower scope); otherwise finish with `bumped`.

The reviewer loads the usable skills in its registry into its prompt at
the start of every review. Whatever you write here becomes the
reviewer's textbook entry. A vague body fires too often and degrades
review quality.

## Scope mechanics: what the reviewer sees

The reviewer receives three things for each skill in its registry:
`name` (the registry record name), `description` (the scope summary)
and the full skill_md body.

Your description should use the *vocabulary of real PRs* (title, file
list, body), not abstract implementation categories:

- Good: `"Use when reviewing PRs that touch glide-core/src/timeout_watchdog.rs or call into ConnectionManager::reconnect"`
- Bad: `"Use when reviewing connection-management code"`

Specific identifiers in the body
(`hashtableTwoPhasePopDelete`, `cancelReplicationHandshake`,
`safe_iterators`) act as anchors that help the model recognize when
the skill applies.

## Frontmatter rules

```
---
name: <registry record name>      # see "Naming" below
description: <imperative trigger> # 1-3 sentences, at most 512 characters
---
```

The description is the skill's scope in the reviewer's prompt.
Non-negotiable rules:

- **Imperative trigger phrasing.** Start with `Use when reviewing a PR that touches <specific-area>`. Never noun phrases. Never first person.
- **Concrete vocabulary, not abstract framing.** Lift the verbatim file paths, function names, struct names, and domain terms from the source concern record's `area` and `concern` fields. The reviewer loads every skill in its registry, so concrete scope cues help the model apply the right one and skip near misses.
- **Bound the scope.** Add `"Does NOT apply to <adjacent-area>"` if the description could otherwise fire on near misses.
- **Third person.** "Reviews ..." not "I review ...". Inconsistent point of view makes the scope harder to read.
- **At most 512 characters.** `submit_skill` rejects a longer description.

## Naming

`submit_skill` decides the registry record name; you do not choose it
directly.

- If the record has a `graduated_record_name`, it graduated before.
  That name is kept and `submit_skill` updates that skill.
- Otherwise the name is the slug of the `subject` you pass: lowercase
  words joined by hyphens. When another record's skill already has that
  name, the tool adds a short suffix derived from the record_id, so the
  two skills stay separate. The name is stored on the record as
  `graduated_record_name`, and later graduations reuse it.

In the frontmatter, write the earlier name when there is one and the
slug of your subject otherwise. `submit_skill` sets the frontmatter
`name` to the final record name and returns it as `record_name`.

## Body template

Write sections in this order. Omit any that don't apply.

```
## Use when
[One paragraph elaborating the description's trigger: what file, function or diff shape activates this skill.]

## Confidence ladder
[How confident the reviewer must be before posting:
 - Post HIGH: source-line evidence + named pattern + invariant break
 - Post MEDIUM: named pattern match + plausible source-line violation
 - Drop LOW: pattern suspicion only, no source confirmation]

## Always-on checks
[Deterministic, cheap gates that run regardless of diff shape: file presence, sign-off, format.
 Express them as shell one-liners or exact greps, not pattern-match guidance. Optional.]

## Patterns
[One ### subsection per named pattern. Every pattern follows this template:

### <Pattern name: specific, not generic>
The diff looks OK but is wrong when: <what the model will see that looks fine but is actually wrong>
Reviewer memory: <the invariant the model can't derive from the code; lift verbatim from the concern's `context` field if present>
Skip unless: <exact diff condition: file name, function name, or identifier that must appear>
]

## Do NOT flag
[Named carve-outs that prevent false-positive noise. Use exact identifiers, not concepts:
 - `<symbol>` coexisting with `<other-symbol>`: intentional, <reason>
 - `<file-path>`: predates the convention, tracked separately
 Without this section the reviewer fires the pattern on cosmetic and compat-shim cases.]
```

## Mandatory structural rules

Failure to follow any of these produces a skill that misfires:

1. **Every pattern has a `Skip unless:` line.** No exceptions. A pattern without a gate fires on every PR and generates noise. If you cannot say what must appear in the diff for the pattern to fire, the pattern is not ready to ship as a skill.
2. **The confidence ladder goes near the top**, not buried. Models attend to early-body content more reliably than late.
3. **Name specific identifiers, not categories.** `cancelReplicationHandshake`, `safe_iterators`, `t_hash.c`, not `replication code`, `iterators`, `the hash module`.
4. **No maintainer names, logins, PR numbers, or review IDs anywhere in the skill.** The pattern is the signal; identities are not. They rot.
5. **No time-sensitive language.** Don't write "as of 2026" or "before the rebase". The skill outlives its source PR.
6. **No filler.** Cut anything the model already knows. Cut narration about the skill itself ("This skill helps you..."). Cut general-knowledge restatements.

## Length budget

- Target: 50 to 250 lines. Most graduations land at 80 to 150.
- Hard ceiling: 500 lines. Above that, instructions get buried mid-body and the model ignores them.
- `submit_skill` rejects markdown over 40,000 characters, frontmatter included.
- A long skill earns its length only through institutional-memory density across many subsystems.

## Voice and citation

- Plain prose. No emojis. No greetings. No sign-offs.
- Cite the originating concern at the bottom: `_(graduated from concern record_id=<id>)_`. Nothing else.

## Common failure modes

**Vague description, so the skill is misapplied or ignored.** The description uses abstract terms; real PRs use domain vocabulary. Fix: lift verbatim identifiers from the concern's `area` and `concern` fields into the description.

**Too-broad description, so the skill fires on everything.** The description lacks exclusion signals. Fix: add `"Does NOT apply to X"` clauses.

**Buried instructions mid-body.** A long body dilutes attention; rules at line 400 don't get followed. Fix: confidence ladder and always-on checks first, patterns after.

**Contradictory patterns.** Two patterns overlap on the same diff shape but prescribe different actions. Fix: make each pattern's `Skip unless:` mutually exclusive; if they can't be, merge them.

**Non-deterministic always-on guidance.** "Check for missing DCO" is sometimes followed, sometimes not. Fix: express deterministic checks as shell one-liners (`git log --format='%B' -1 | grep -q 'Signed-off-by'`), not pattern-match guidance.

**Stylistic-rule contamination.** A "do not cite PR numbers" rule ends up as a graduated skill. Fix: stylistic rules are curator-level; never graduate them. They live in the curator's prompt and skill, not in the reviewer's registry.

## What to do at Phase 2 entry

1. Read this skill. Internalize the mandatory rules.
2. Read the bumped or merged source concern record in full: `area`, `subject`, `concern`, `context`, and `graduated_record_name` if present.
3. Compose the `subject` and the `description` per the rules above, and write the frontmatter name as described in "Naming". The description scopes the skill for humans and the reviewer model; spend disproportionate effort here.
4. Compose the body following the template. Every pattern needs `Skip unless:`. Add `## Do NOT flag` if the underlying concern has ever attracted a stylistic edit or a "this is intentional" clarification.
5. Call `submit_skill` with the record's `area_bucket` and `source_record_id`, and the composed `subject`, `description` and `skill_md`. The `description` argument must match the frontmatter description word for word.
6. Call `curator_done` with decision `graduated` and include the returned `record_name` in the summary.
7. Keep the source record. It stays in the store as the skill's provenance, and decay removes it eventually. Do not call `delete_concern` on it; the tool refuses to delete a graduated record, and `merge_concerns` accepts it only as the target.

_(curator-owned skill; source: agents/curator/skills/how-to-write-a-skill.md)_
