# Curator skills

This directory holds the curator's own skills: reference material the
curator reads at graduation time through the `list_skill_authoring`
tool. The files here are the source of truth; the curator's skills
registry in AWS Agent Registry only delivers them at runtime.

## What lives here

Each `*.md` file with frontmatter is one skill. The frontmatter is
required and `name` must match the file name:

```
---
name: <slug>                  # lowercase words joined by hyphens
description: <imperative>     # 1-3 sentences, at most 512 characters
---
```

These skills are curator-only. They hold general guidance for the
curator's workflow (for example, how to write a skill_md at graduation),
not project knowledge. The skills the curator graduates for each
reviewer live in that reviewer's own registry and are not mirrored
here.

Files without frontmatter, such as this README, are not published.

## Publishing

Publishing uses the shared registry module in
`agents/common/src/skills-registry.ts`, so install that package first:

```
(cd agents/common && npm ci)
node scripts/publish-curator-skills.mjs --registry-id <curator-registry-id>
```

`--stack <curator-stack-name>` reads the registry id from the stack's
`CuratorSkillsRegistryId` output instead. `--dry-run` lists what would
be published without calling the registry.

For each skill the script creates a SKILL record named after the file,
or updates the record with that name when it already exists. The
record's status is whatever the registry assigns; the curator does not
use status as an approval step, but it skips records that are still
being written, failed, deprecated or rejected.

The curator's runtime role can only read this registry
(`agent-registry:GetRegistryRecord`, `agent-registry:ListRegistryRecords`).

## Adding a skill

1. Create `agents/curator/skills/<name>.md` with frontmatter.
2. Run the publish script.
3. Check it with `node scripts/registry-skills.mjs list --registry-id <curator-registry-id>`.
4. The next curator run that reaches graduation reads it.

## Retiring a skill

```
node scripts/registry-skills.mjs deprecate --registry-id <registry-id> --name <name> --reason "<why>"
```

The same script lists and deprecates the skills the curator graduated
into a reviewer's registry; pass that reviewer's registry id, or
`--stack <reviewer-stack-name>` to read its `SkillsRegistryId` output.
