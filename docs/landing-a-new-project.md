# Landing a new project for the reviewer

This guide adds a reviewer for another project. It follows the code: every list of
reviewer ids, every file to copy and every setting to add is named. Paths are relative
to the repository root. The worked example is
[valkey-search](https://github.com/valkey-io/valkey-search) with the reviewer id
`valkey-search-review`. [architecture.md](architecture.md) describes how the parts fit
together, and [infra/README.md](../infra/README.md) documents every deployment setting.

## 0. Is it a new project?

- A fork or mirror of a project the bot already reviews (another copy of
  `valkey-io/valkey`, for example) needs no code. Add a route for it with the existing
  reviewer, install the GitHub App on it and deploy. `upstreamRepos.<id>` already names
  the canonical repository, so backport checks and skill checks keep using it.
- A new project needs a reviewer of its own: a reviewer id, an agent package with its
  container image, prompt and skill file, a skills registry, and the wiring below. Its
  concerns table, token broker, decay, skill checks and retirement then follow from the
  id.
- Open an issue first, as [CONTRIBUTING.md](../CONTRIBUTING.md#how-to-propose-a-change)
  asks for a large change. Name the project, who maintains it and which toolchain the
  image needs.

## 1. Decide before coding

| Decision | Rules and what it affects | valkey-search |
| --- | --- | --- |
| Reviewer id | `<name>-review`: lowercase letters, digits and hyphens, starting with a letter, at most 40 characters, and not `curator` or `common`. It becomes the assets prefix `<id>/`, the concerns table `<id>_concerns` and the runtime `<id>_runtime` (both with `-` replaced by `_`; AgentCore allows letters, digits and `_`, at most 48 characters), the runtime's log groups, and the branch prefix `skill-check/<id>/` of skill pull requests. | `valkey-search-review`; table `valkey_search_review_concerns`; runtime `valkey_search_review_runtime` |
| Stack id | The CloudFormation stack name. Keep it stable once deployed. | `ValkeySearchReviewAgent` |
| Workspace root | Where the Dockerfile clones the repository. It must equal `workspaceRoot` in `REVIEWERS` (`infra/lib/app.ts`), which becomes `WORKSPACE_ROOT`. | `/workspace/valkey-search` |
| Upstream repository | `upstreamRepos.<id>`. Release branches for backport checks and GA releases for skill checks come from it. It must be public: the curator fetches it and the decay job lists its releases without credentials. | `valkey-io/valkey-search` |
| Default branch | Named in the prompt. The skill check finds it itself (`git ls-remote --symref`) and checks skills against its tip. | `main` |
| Toolchain and image size | The build tool the reviewer gets and the packages in the image's runtime stage. | C++ with CMake and Ninja, `build.sh`, `submodules/` and `third_party/` |
| Language server | `lsp` starts clangd for `.c` and `.h` files only, from a fixed manifest in `agents/common/src/tools/harness.ts`. Without clangd in the image, filter `lsp` out, as `agents/valkey-glide-review/src/tools/index.ts` does. | Filter it out, or extend the manifest to `.cc` and ship a `compile_commands.json` |
| Release branches | The backport check sees only branches named `X.Y` or `release-X.Y` with a commit in the last 180 days (`RELEASE_BRANCH_RE` and `MAINTAINED_WINDOW_DAYS` in `agents/common/src/workspace.ts`). | `1.0` to `1.3` match |
| Release tags | Skill checks start when the highest GitHub release that is neither a draft nor a prerelease, with a tag of the form `X.Y.Z` or `vX.Y.Z` (`RELEASE_TAG_RE` in `ops/src/releases.ts`), changes. Without such a release, graduated skills are still checked every `skillLifecycle.recheckDays`, but the repo skill file is never checked. | `1.2.1` today; `1.3.0-rc1` does not count |

## 2. The reviewer id in the code

`REVIEWER_IDS` in `infra/lib/deployment-config.ts` is a closed list. Add the id there,
then run `npm run typecheck` in `infra/`. TypeScript flags the four other places that
list every id:

1. the `skillsRegistries` object in `parseDeploymentConfig`: add
   `'valkey-search-review': registry('valkey-search-review')`;
2. the `upstreamRepos` object in `parseDeploymentConfig`: add an entry with the
   default upstream, `fallback: 'valkey-io/valkey-search'`;
3. the object `parseAgents` returns: add `'valkey-search-review': reviewer('valkey-search-review')`;
4. `REVIEWERS` in `infra/lib/app.ts`: `stackId: 'ValkeySearchReviewAgent'`,
   `workspaceRoot: '/workspace/valkey-search'` and a one-line `description`.

Everything else follows the id, with no code change:

- `ValkeyReviewerSubstrate` gets a token broker for it (`TokenBrokerValkeySearchReviewFn`)
  that issues tokens only for that reviewer's review routes.
- One reviewer stack: the runtime, its role, the concerns table (customer-managed KMS
  key, point-in-time recovery, retained on stack deletion), and the upload of
  `config/prompt.md` and `config/skill.md` under `valkey-search-review/`.
- The curator's `CONCERNS_TABLES_JSON`, `SKILLS_REGISTRIES_JSON` and
  `UPSTREAM_REPOS_JSON`, and its grants on the new table and registry.
- The decay job's table list, its release lookup for the upstream, and its checks and
  retirements of the reviewer's skills.
- The check of the reviewer's repo skill file, `agents/valkey-search-review/config/skill.md`,
  and the pull requests that propose edits to it: the curator accepts the skill file of
  any reviewer in its `CONCERNS_TABLES_JSON`.
- The webhook reads the reviewer id from the route as a string.

Every id in `REVIEWER_IDS` is always deployed and needs `skillsRegistries.<id>`, so
adding an id breaks every existing `deploy.config.json` until its operator adds a
registry for it. Tell the other operators before the change merges.

## 3. The agent package

Copy the closest reviewer. `agents/valkey-review` fits a C or C++ project,
`agents/valkey-glide-review` a project with several language toolchains. For
valkey-search, copy `agents/valkey-review` to `agents/valkey-search-review`.

- `package.json`: set `name` and `description`. `main` and the `start` script point at
  `dist/valkey-search-review/src/agent.js`: `tsconfig.json` compiles `agents/common`
  too, with `rootDir: "../"`. Keep the dependencies of the agent you copied, then run
  `npm install` to regenerate `package-lock.json`. `tsconfig.json` is the same for
  every agent.
- `src/agent.ts` is the same for every agent: `bootstrap({ assembleTools })`.
- `src/tools/index.ts`: `assembleCommonTools`, plus the build tool when
  `buildToolEnabled(process.env)` is true (`ALLOW_BUILD`, set from
  `agents.<id>.allowBuild`). Filter out `lsp` here when the image has no clangd.
- The build tool. Neither `make` (Valkey) nor `build` (GLIDE) fits CMake and Ninja, so
  valkey-search needs its own wrapper, for example `cmake`, `ninja` and `ctest`. Follow
  the existing two:
  - an argument list with allowlisted actions and values, checked in a separate policy
    module (`make-policy.ts`, `build-policy.ts`) that has its own tests;
  - `runBounded` (`agents/common/src/tools/spawn.ts`) with an 8 minute and 1 MB limit,
    `buildChildEnv` and `resolveInside` (`agents/common/src/tools/child-env.ts`);
  - no shell, and no action that installs, publishes, logs in or fetches.
- `Dockerfile`:
  - keep the `base` and `build` stages as they are, with the paths changed to the
    new agent;
  - the `runtime` stage installs the toolchain, `git`, `gh`, `ripgrep` and `jq` (and
    clangd if `lsp` stays), and creates the `agent` user (uid 1000) that owns
    `/workspace`;
  - as that user, `git clone --filter=blob:limit=1m https://github.com/valkey-io/valkey-search.git /workspace/valkey-search`;
  - `ENV WORKSPACE_ROOT=/workspace/valkey-search` and
    `CMD ["node", "--enable-source-maps", "/app/agents/valkey-search-review/dist/valkey-search-review/src/agent.js"]`;
  - no secrets and no tokens in the image. Every reviewer role can pull every image in
    the CDK bootstrap repository ([SECURITY.md](../SECURITY.md#what-a-deployment-holds)).
- Tests, copied and adapted:
  - `test/prompt.test.mjs`: the prompt quotes the first message's section names, covers
    each kind of thread reply, and describes superseded skill pieces with the labels
    reviewers see;
  - `test/assemble-tools.test.mjs`: the exact tool list, and that the prompt's tool
    tables name exactly those tools;
  - the policy and tool tests of the build wrapper;
  - `agents/valkey-review/test/prompt.test.mjs` also checks that the reviewer prompts
    share the "Mention-triggered reviews" section and the superseded-pieces paragraph.
    Add the new prompt to that test.

## 4. Prompt and built-in skill

`config/prompt.md` is the system prompt. Start from the copied one and change what is
project-specific: identity, workspace path, language and build system, default branch,
the tool tables, the review categories, the always-on checks and the examples. Keep:

- the workflow headings (Phase 1 to Phase 5, listed in
  [architecture.md](architecture.md#review-phases));
- the quoted section names "Existing inline comments", "Maintained release lines" and
  "Your previous review state";
- the "Mention-triggered reviews" section, including the "Replies in your review
  thread" bullet with its three cases (fix claimed, finding disputed, question);
- the paragraph on superseded skill pieces ("Some skill pieces, ...") in "The
  correctness bar";
- tool tables that name exactly the tools `assembleTools` returns.

`config/skill.md` is the reviewer's built-in knowledge, appended to every system
prompt. Write it by hand from the project's own guides and from recent maintainer
review comments. For valkey-search: `AGENTS.md`, `BACKPORTING.md`, `COMPATIBILITY.md`,
`CONTRIBUTING.md` and `build.sh`.

- Keep it compact. Write patterns with gates ("Skip unless the PR touches ...") rather
  than general advice.
- Put every file path, function, struct, macro and config name in backticks, exactly
  as spelled in the code. The skill check finds names by their backticks.
- Put placeholder or hypothetical names only in fenced code blocks, which the check
  skips.
- Before the pull request, check the file against the upstream and name the ref you
  checked in the pull request:

  ```sh
  node scripts/skill-facts.mjs --file agents/valkey-search-review/config/skill.md --repo valkey-io/valkey-search
  ```

  It makes an anonymous checkout of the default branch tip in a temporary directory,
  prints the cited names that are absent there, and exits 0 when the file is clean, 2
  when it is not and 1 on error. The `upstream:` line of its output names the ref. It
  needs Node 24 or later and git, and no credentials.

## 5. Repository wiring

Each of these lists the agents or reviewer ids by hand:

- `.dockerignore` is an allowlist: add the agent's `Dockerfile`, `package.json`,
  `package-lock.json`, `tsconfig.json` and `src/`. A missing entry fails only at
  `docker build`, which runs at deploy; CI builds no image.
- `.github/workflows/ci.yml`: both package loops of the `build-and-test` job.
- `CONTRIBUTING.md`: the package loop under "Building and testing".
- `.github/dependabot.yml`: an `npm` entry and a `docker` entry for the agent directory.
- `infra/deploy.config.example.json`: `skillsRegistries.<id>` with a placeholder, and
  a route for the new reviewer. A test requires every example route to use a
  `your-org/` repository and set `threadReplyReview: true`.
- `infra/test/helpers.ts`: `skillsRegistries.<id>` in `fixture()`. Without it every
  configuration test fails on `skillsRegistries.valkey-search-review is required`.
- `infra/test/deployment-config.test.ts` and `infra/test/infra.test.ts`: the expected
  defaults and environment maps, and every `test.each` list and loop over reviewer ids.
  With the five code changes, the fixture and the agent's files in place, about eight
  infra tests fail on expected maps that miss the new id. The `test.each` lists do not
  fail: they skip the new reviewer, so the security pins (no secrets, no registry
  writes, no concerns access for the reviewer role) do not cover it until you add the
  id to them.
- `agents/curator/config/prompt.md` and `agents/curator/config/skill.md`: the list of
  reviewers and their repositories, and the `area_bucket` examples. They ship with the
  curator stack at deploy.
- Docs that count reviewers, images or registries: `README.md`, `infra/README.md`
  ("three images", "three registries", the `skillsRegistries` and `agents` tables) and
  [architecture.md](architecture.md).

## 6. AWS and GitHub setup

These steps are for the operator of each deployment.

1. Create a registry for the reviewer in AWS Agent Registry, in the same account and
   region as the deployment (the `CreateRegistry` API; neither CDK nor a script here
   creates it). Put its ID or ARN in `skillsRegistries.valkey-search-review`.
2. Install the same GitHub App on the repository. Its permissions, events and secret do
   not change. The token broker refuses a token unless the installation's account owns
   the repository, so install it from the account that owns `valkey-io/valkey-search`.
3. Add a route in `infra/deploy.config.json`. Start narrow: `mentionOnly` or an
   `authorAllowlist`. `threadReplyReview` (default `false`) can be on from the start:
   it only lets maintainers answer the bot in threads it started, and those runs do not
   use the daily budget. The example below turns it on.

   ```json
   {
     "id": "valkey-search-review",
     "reviewer": "valkey-search-review",
     "repo": "valkey-io/valkey-search",
     "mentionOnly": true,
     "threadReplyReview": true
   }
   ```

   Automatic reviews per pull request (`maxAutomaticReviewsPerPr`, default 3), the delay
   of a review of new commits (`pushReviewDelaySeconds`, default 300) and the daily
   budget (`dailyReviewBudget`, default 40 per route) are top-level settings that apply
   to every route.
4. Set `upstreamRepos.valkey-search-review` if the default from step 2 of section 2 is
   not the canonical public repository. An empty string turns skill checks off for the
   reviewer (decay and retirement still apply) and makes backport checks use the pull
   request's own repository.
5. Optionally set `agents.valkey-search-review` (`maxIterations`, `maxTokens`,
   `allowBuild`, `allowWrite`). The reviewer model is `models.reviewer`, shared by every
   reviewer.
6. From `infra/`, run `npx cdk deploy --all`. It builds the new image, so it rebuilds
   the others too (see [Known friction](#10-known-friction)).

## 7. The skills registry and the skill lifecycle

An empty registry is valid. Reviewers then load no graduated skills, and the curator
fills the registry from maintainer feedback: a concern with enough distinct
reinforcements (`agents.curator.graduationThreshold`, default 4) is published there as
a skill.

Do not seed the registry by hand. A record that no concern record names
(`graduated_record_name`) is outside the skill lifecycle: it never decays, is never
checked and is never retired. `node scripts/registry-skills.mjs orphans --stack ValkeySearchReviewAgent`
lists such records. Seeded records would also count against what a review loads: the
30 most recently updated skills, at most 80,000 characters in all. Put hand-written
knowledge in `config/skill.md` instead. `scripts/publish-curator-skills.mjs` only
publishes the curator's own skills (`agents/curator/skills/`).

What the lifecycle does with the reviewer's graduated skills, with no setting of its
own:

- The daily decay job lowers each graduated record's standing on
  `decay.graduatedHalfLifeDays` (default 180). A reinforcement resets it. Below
  `decay.floor` (0.05) the skill is due for retirement: with
  `skillLifecycle.retireSkills` on, the curator deprecates its registry record and
  keeps the concern record as a tombstone; with it off, the decay job only logs
  `would-retire`.
- After each GA release of `upstreamRepos.<id>`, and at least every
  `skillLifecycle.recheckDays` (90), the curator checks the names each skill cites on
  the upstream default branch. It confirms the skill, revises it in suppress-and-add
  form (with `applyEdits` on), or marks it obsolete, which leads to its retirement.
- `skillLifecycle.checksPerDay` (10) and `maxRetirementsPerDay` (3) are per reviewer
  and per pass.

The switches that change anything (`applyEdits`, `retireSkills`, `openPullRequests`)
are deployment-wide, so a new reviewer gets whatever the deployment has. See
[docs/architecture.md](architecture.md#skill-checks) for the checks and
[infra/README.md](../infra/README.md#skill-lifecycle-operations) for the operations.

## 8. The repo skill file and release-check pull requests

`agents/valkey-search-review/config/skill.md` ships with the code. It changes by pull
request only, never in place. Merge it to `skillsRepo.baseBranch` before the first
deploy of the new reviewer: the first decay pass after a known GA release queues a check
of the file, and if the file is not on that branch yet the check finds nothing to read,
is recorded as an error, and runs again at each daily pass until the file is there.

- The decay job queues one check of the file per GA release of the upstream. The
  curator reads the file from `skillsRepo.repo` at `skillsRepo.baseBranch` without
  credentials, so the bot's repository must be public, and without `skillsRepo` the
  check is only recorded as skipped.
- When the audit proposes valid edits and `skillLifecycle.openPullRequests` is on, the
  curator opens a pull request against `skillsRepo.repo`. Its branch is
  `skill-check/valkey-search-review/<release>`, for example
  `skill-check/valkey-search-review/1.2.1`. It holds one commit on the base branch tip,
  made with a token from the skills-repo token broker, with the edits in
  suppress-and-add form. The body lists the cited upstream lines as links. A re-run
  updates the same branch and pull request, and a maintainer's own commits on the
  branch are never overwritten.
- To reject a proposal, close the pull request. Nothing more is proposed for that
  release; the next release proposes again on a new branch.
- With `openPullRequests` off, the findings go to the log and to the item
  `#maintenance` / `repo-skill` in the reviewer's concerns table, which
  `scripts/concerns-dump.sh` prints.

Between releases, check the file yourself with `scripts/skill-facts.mjs` (section 4).

## 9. Roll out and verify

1. Run the checks locally: `npm ci`, `npm run typecheck` and `npm test` in every
   package (the loop in [CONTRIBUTING.md](../CONTRIBUTING.md#building-and-testing)),
   and the credential-free synth:

   ```sh
   cd infra
   env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY -u AWS_SESSION_TOKEN \
     AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_EC2_METADATA_DISABLED=true \
     npx cdk synth --quiet -c config=deploy.config.example.json
   ```

2. Optionally, let the curator learn before the reviewer posts anything: put the
   repository in `curatorOnlyRoutes` instead of `routes` for a while. Maintainer
   feedback on its pull requests then reaches the curator and nothing else. A
   repository cannot be in both lists.
3. Deploy with the route on `mentionOnly`, and mention the bot on a test pull request.
   Then check:
   - the receiver logs `[mention] ... decision=enqueued:mention#issue_comment-<id>`;
   - the reviewer runtime's log group has `[invoke]` and `[tool]` lines and no
     `[graduated-skills] registry load failed`;
   - the review and the state comment appear on the pull request;
   - the `DeadLetterQueueName<route>` queue of the webhook stack stays empty.
4. `node scripts/registry-skills.mjs list --stack ValkeySearchReviewAgent` reads the
   registry. An empty list is fine.
5. After the next daily decay pass, the decay job's log has
   `[release] valkey-io/valkey-search tag=1.2.1` and a summary line for the new table,
   `[decay] valkey_search_review_concerns scanned=...`.
6. Then widen the route: `threadReplyReview` if it is not on yet, then automatic reviews
   (remove `mentionOnly`, keep or drop the `authorAllowlist`), and watch
   `dailyReviewBudget`.

## 10. Known friction

- `ReviewerId` is a closed union, and five places in `infra/lib` list every id.
- Every id in `REVIEWER_IDS` is always deployed (image, runtime, broker, table) and
  needs a registry, even with no route.
- All images share one build context, the repository root, so any agent change
  rebuilds and redeploys every image.
- CI builds no image, so a missing `.dockerignore` entry shows up at deploy.
- The release-branch pattern `X.Y` / `release-X.Y` is fixed in
  `agents/common/src/workspace.ts`.
- `models.reviewer` is shared by all reviewers.
- `lsp` is on unless the agent filters it out, and its manifest knows clangd for `.c`
  and `.h` only.
- The skill lifecycle switches, the review rounds and the push delay apply to every
  reviewer.
- The package lists are repeated in CI, `CONTRIBUTING.md` and Dependabot, and the
  curator prompt names the reviewers.

## 11. Worked example: valkey-search

| Item | Value |
| --- | --- |
| Reviewer id | `valkey-search-review` |
| Stack | `ValkeySearchReviewAgent` |
| Agent package | `agents/valkey-search-review`, copied from `agents/valkey-review` |
| Clone | `/workspace/valkey-search`, from `https://github.com/valkey-io/valkey-search.git` |
| Concerns table | `valkey_search_review_concerns` |
| Runtime | `valkey_search_review_runtime` |
| Upstream | `valkey-io/valkey-search`, default branch `main` |
| Release branches | `1.0`, `1.1`, `1.2`, `1.3` |
| Highest GA release | `1.2.1` (`1.3.0-rc1` is a prerelease) |
| Skill pull request branch | `skill-check/valkey-search-review/1.2.1` |
| Build | CMake with the Ninja generator through `build.sh`; needs a new `cmake`/`ninja`/`ctest` wrapper |
| Skill sources | `AGENTS.md`, `BACKPORTING.md`, `COMPATIBILITY.md`, recent maintainer review comments |

Open choices for that change:

- Whether to prebuild the third-party dependencies (`build.sh --no-system-modules`
  builds them from `submodules/`) in the image, which makes the image larger and the
  first build of each review faster.
- Whether to ship clangd with a `compile_commands.json` and extend the `lsp` manifest
  to C++ sources, or filter `lsp` out and rely on `grep` and `git grep`.

## 12. Removing a project

- Delete its routes and curator-only routes and deploy. Its broker then issues no
  token, and no review or feedback reaches its runtime or the curator. The decay job
  still decays, checks and retires the skills in its concerns table.
- Its stacks and resources stay as long as the id is in `REVIEWER_IDS`.
- Taking the id out of the code needs care: the curator, webhook and decay stacks
  import the reviewer stack's outputs, and the reviewer stack imports its broker from
  `ValkeyReviewerSubstrate`. Plan the order with `npx cdk diff`.
- The concerns table is retained when its stack is deleted, and the registry lives
  outside CDK. Delete either by hand when it is no longer needed.

## 13. Security checklist

- No shell tool. The build tool is an argument-list wrapper with allowlisted actions,
  run through `runBounded` in the checkout (`resolveInside`).
- Build processes get `buildChildEnv`: no `AWS_`, `AMAZON_`, `GH_` or `GITHUB_`
  variables, and none whose name holds `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or
  `PRIVATE_KEY`.
- No secrets in the image.
- No new grant on the reviewer role. Add the id to the `test.each` lists in
  `infra/test/infra.test.ts`, so the tests that pin the reviewer role (no Secrets
  Manager, no registry writes, no concerns table access) cover it.
- The reviewer's broker issues tokens with `pull_requests: write` and `metadata: read`
  only, for that reviewer's review routes. No reviewer ever gets `contents`
  permission. The only path to `contents: write` is the skills-repo broker, which the
  curator alone may invoke and which is limited to the bot's own repository.
- The GitHub App needs no new permission or event for the new repository. If the
  deployment opens skill pull requests, use a separate App for `skillsRepo`
  ([infra/README.md](../infra/README.md#the-skills-repo-app)), so the App installed on
  the new repository holds no Contents permission.
- The upstream is read without credentials: the curator's skill checks make anonymous
  git fetches, and the decay job makes one anonymous call a day to the GitHub releases
  API.
- Deploy into an AWS account used for nothing else, or give the app its own bootstrap
  qualifier (`aws.bootstrapQualifier`), because every reviewer role can pull every
  image in the bootstrap repository.
