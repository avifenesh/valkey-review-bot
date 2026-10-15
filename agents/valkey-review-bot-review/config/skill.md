# valkey-review-bot reviewer skill

Repository knowledge for reviewing valkey-io/valkey-review-bot pull requests. The repository hazards in the system prompt come first; this adds the patterns behind them, each with the condition that makes it apply. Facts here were checked against `main`. Where the code at the PR head disagrees, the code wins: cite the code, not this file.

## Reviewer ids and the lists that name them

Skip unless the PR adds, renames or removes a reviewer, an agent package or a package directory.

- `REVIEWER_IDS` in `infra/lib/deployment-config.ts` is a closed `as const` list, and `ReviewerId` is its union. Four more places list every id: the `skillsRegistries` and `upstreamRepos` objects in `parseDeploymentConfig`, the object `parseAgents` returns, and `REVIEWERS` in `infra/lib/app.ts` (stack id, workspace root, description). The type-check of `infra/` flags a missing entry in those four.
- The id fixes the concerns table (`<id>_concerns` with `-` as `_`), the runtime name (`<id>_runtime`, at most 48 characters), the assets prefix and the broker's construct id. Renaming an id replaces all of them in a live deployment.
- Every id is always deployed and `skillsRegistries.<id>` is required, so a new id breaks every operator's existing deploy.config.json until its operator adds a registry. The PR should say so, and `infra/README.md` should tell operators.
- Lists kept by hand, which the type-check does not catch: `.dockerignore` (an allowlist; a missing entry fails only at `docker build`, which runs at deploy), both package loops in `.github/workflows/ci.yml`, the loop in `CONTRIBUTING.md`, the `npm` and `docker` entries in `.github/dependabot.yml`, `infra/deploy.config.example.json`, `fixture()` in `infra/test/helpers.ts`, the expected maps and per-reviewer loops in `infra/test/infra.test.ts` and `infra/test/deployment-config.test.ts`, the curator's `agents/curator/config/prompt.md` and `agents/curator/config/skill.md`, and the counts in `README.md`, `infra/README.md` and `docs/architecture.md`. `docs/landing-a-new-project.md` names them all.

## IAM grants and their pins

Skip unless the PR touches `infra/lib/grants.ts`, a stack's `PolicyStatement`, `addToRolePolicy` or `grant*` call, or `infra/test/infra.test.ts`.

- Runtime roles come from `createRuntimeRole`; registry ARNs from `registryResources`. A reviewer role may call its models, get objects under its own prefix with `kms:Decrypt`, read its own registry, use the heartbeat table, invoke its own broker, write its own log groups and pull from the bootstrap image repository. Nothing else.
- `infra/test/infra.test.ts` pins this per reviewer: no `secretsmanager:` action, registry actions limited to `agent-registry:GetRegistryRecord` and `agent-registry:ListRegistryRecords`, no DynamoDB statement on a `ConcernsTable`. Only the curator role holds `agent-registry:UpdateRegistryRecordStatus`. A PR that edits one of these expectations changes the security model; it needs the reason, and `SECURITY.md` and `docs/architecture.md` change with it.
- A grant to "every reviewer" is a grant to code from every pull request on every routed repository. `SECURITY.md` says so for the role, and the image repository grant already reaches every image in the bootstrap repository.

## Tokens and brokers

Skip unless the PR touches `webhook/src/broker.ts`, `webhook/src/token-broker.ts`, `webhook/src/skills-repo-broker.ts`, `webhook/src/github.ts` or `agents/common/src/github-auth.ts`.

- Permission sets are constants: `RECEIVER_TOKEN_PERMISSIONS` (`pull_requests: write`, `issues: read`, `metadata: read`), `TOKEN_PERMISSIONS` (`pull_requests: write`, `metadata: read`) and `SKILLS_REPO_TOKEN_PERMISSIONS` (adds `contents: write`). A new permission in the first two lets pull request code use it on every routed repository.
- `createTokenBroker` refuses a repository that is not in `ALLOWED_REPOS_JSON` (built by `tokenBrokerRepos`, review routes only, curator-only routes excluded), then asks GitHub for the App's installation on the repository and refuses unless it is the caller's installation and its account owns the repository. Both checks stay, in that order, before any token is issued.
- The skills-repo broker takes its repository from `SKILLS_REPO` and its App from `SKILLS_REPO_APP_SECRET_NAME`, never from the request. Only the curator role may invoke it.
- Tokens never go into the clone's git config, a remote URL or a command line: `gitAuthEnv` passes them per process through `GIT_CONFIG_COUNT`. `createTokenSource` refreshes five minutes before expiry. No token is logged or shown to a model.

## Processes that run pull request code

Skip unless the PR adds or changes a tool, a build wrapper or a policy module in a reviewer's tools directory, or `agents/common/src/tools/child-env.ts` or `agents/common/src/tools/spawn.ts`.

- The pattern: an argv array, a policy module with no imports that its own tests load directly (`build-policy.ts`, `make-policy.ts`), `runBounded` with an 8 minute and 1 MB limit, `buildChildEnv()` for the environment and `resolveInside` for the working directory. No shell, and no action that installs, publishes, logs in or fetches.
- `buildChildEnv()` drops names that start with `AWS_`, `AMAZON_`, `GH_` or `GITHUB_` or contain `TOKEN`, `SECRET`, `PASSWORD`, `CREDENTIAL` or `PRIVATE_KEY`. A variable added after it is called must carry no credential.
- The tool description, the prompt's Build section and the policy must list the same actions: the build-policy tests compare them. An action that writes files in the checkout (formatters, `--fix`, `-w`) moves the lines the review anchors to.
- `checkGitArgs` and `checkGhApiPath` are the allowlists of the `git` and `gh_api_read` tools. A new git subcommand or REST path is a security change: `gh_api_read` runs with the installation token.

## Untrusted text

Skip unless the PR touches `renderPrOverview`, `mentionBlock`, `webhook/src/mention.ts`, the curator's first message, or any log line that prints text from GitHub or a model.

- Text from the pull request and its comments goes inside `untrusted-pr-content` blocks, with nested tags defused. File paths written outside the blocks are JSON strings.
- The curator fences feedback, skills and diffs between random markers, and logs model text only through `quoted` (`agents/curator/src/log-text.ts`), so it cannot start a line or pass for a `[maintenance]` report line.
- The safety gate (`createSafetyGate`) denies on any error, timeout or unparsable verdict. A change that lets an error through as an allow is blocking.
- The state comment is found by `findStateComment`, which checks the App id as well as `STATE_MARKER`. `stripStateMarker` keeps model text from forging the marker.

## Receiver, queues and the watchdog

Skip unless the PR touches `webhook/src/delivery.ts`, `webhook/src/store.ts`, `webhook/src/invoker.ts`, `webhook/src/watchdog.ts` or `webhook/src/review-envelope.ts`.

- Gate order in `pullRequest` matters: claim the idempotency key, take the pending marker (`markReviewPending`), take a round (`takeAutoReview`), then a budget slot (`takeReviewSlot`). A review that is not queued gives back what it took, newest first. A new early return that skips the give-back leaks a round or a marker.
- `heartbeatRunKey` and the run key in `agents/common/src/run-agent.ts` must produce the same string.
- `isFresh` and `CLOCK_SKEW_MS` exist because pull request code can write heartbeat records. A record counts as live only when a run could have written it. Do not relax that test.
- Lambda timeouts, the 16 minute visibility timeout, `RUN_BUDGET_MINUTES` and `HEARTBEAT_STALE_MINUTES` are tuned together (`docs/architecture.md`, section 3). Changing one changes how often a long review is received before it dead-letters.

## Skill lifecycle

Skip unless the PR touches `agents/curator/src/`, `agents/common/src/skill-check/`, `agents/common/src/graduated-skills.ts`, `agents/common/src/skills-registry.ts` or `ops/src/`.

- The switches `applyEdits`, `retireSkills` and `openPullRequests` default to `false`, and the example configuration keeps them off. A change that turns one on by default is a product decision for maintainers, not a fix.
- Suppressed blocks are kept byte for byte. Only the release check writes markers, and `parseSuppressed` decides what is well formed. `submit_skill` must refuse text that adds, drops or changes one.
- `DEPRECATED` is final in AWS Agent Registry: `upsertSkill` throws `SkillRetiredError` and changes nothing. Code that deprecates a record to "clean up" loses it for good.
- Maintenance writes are conditioned on the claim (`maintenance_id`) and on `graduated_record_name`. A write without the condition can act on a stale or forged message.
- Graduated skills load within `GRADUATED_SKILLS_MAX_CHARS`; `submit_skill` accepts at most `GRADUATED_SKILL_MAX_CHARS`, half of it, so every skill fits.

## TypeScript and Node versions

Skip unless the PR touches a `tsconfig.json`, a `package.json`, a lockfile or a Dockerfile.

- TypeScript 7 loads the Node type package (@types/node) only when `compilerOptions.types` names it, and every package's `tsconfig.json` does (`node`, plus `jest` in `infra/`). Dropping it breaks the type-check of every Node API.
- `infra/` installs TypeScript 7 under the alias @typescript/native and points `typescript` at the TypeScript 6 compatibility package (@typescript/typescript6), because ts-jest and ts-node need a JavaScript compiler API that TypeScript 7 does not ship. The tsc binary there is TypeScript 7.
- The Lambdas run `NODEJS_24_X` (bundled with `target: 'node24'`); the agent images run Node 26 (`NODE_MAJOR` in the reviewer Dockerfiles, the `node:26` base image in the curator's). Code in `webhook/` and `ops/` must not use an API Node 24 lacks.
- The Strands SDK (@strands-agents/sdk) declares an optional peer of `openai` 6 while the agents use `openai` 7, so `npm ls` flags it and `npm install` can stop with ERESOLVE. The lockfiles install with `npm ci`. This was accepted in #28.
- A lockfile change without its `package.json` change, or the reverse, does not install the same way in CI (`npm ci`) as on the author's machine.

## Configuration, docs and hygiene

Skip unless the PR touches `infra/lib/deployment-config.ts`, `infra/deploy.config.example.json` or a doc.

- Every configuration key has a parser check in `parseDeploymentConfig`, a row in `infra/README.md` with its default and range, and, for lifecycle and round settings, its default value spelled out in the example. A test requires every example route to use a repository under your-org and set `threadReplyReview` to `true`.
- Real account IDs, App IDs, registry IDs and secret values never go in git: the real configuration, deploy.config.json in `infra/`, is ignored, and CI runs a scrump secret scan on every tracked file except the lockfiles.
- The docs cite code names and numbers. A change to a default, a limit, a permission or a flow updates `docs/architecture.md`, `infra/README.md`, `webhook/README.md`, `SECURITY.md` or `README.md` in the same pull request.
- Every commit needs a DCO `Signed-off-by` line (`CONTRIBUTING.md`). Prompt and skill changes (`agents/*/config/*.md`) should say which review behavior they change.
- The prompt tests pin text: the quoted first-message section names, the reply kinds, the shared "Mention-triggered reviews" section across reviewer prompts, the superseded-pieces paragraph, the tool tables, and no em dashes in prompts and skills.
