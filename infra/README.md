# valkey-reviewer infrastructure

This CDK app deploys valkey-reviewer into one AWS account and region. All
values that differ between installations come from one JSON file, described
below. The code holds no account IDs, App IDs, registry IDs, routes or
secret names.

## Stacks

| Stack | Contents |
| --- | --- |
| `ValkeyReviewerSubstrate` | KMS key, prompt and skill bucket, reference to the GitHub App secret, one token broker Lambda per reviewer, the skills-repo token broker Lambda when `skillsRepo` is set, run heartbeat table |
| `ValkeyReviewAgent`, `ValkeyGlideReviewAgent` | One reviewer each: AgentCore runtime, its execution role, its concerns table, prompt and skill upload |
| `ValkeyReviewerCurator` | Curator runtime and its execution role, and the upload of `prompt.md`, `skill.md` and `skill-check.md` under `curator/` |
| `ValkeyReviewWebhook` | HTTP API, receiver Lambda, idempotency table, one queue and worker per route, the curator queue and worker, dead-letter queues |
| `ValkeyReviewerDecay` | Daily Lambda that decays concerns and queues skill checks and retirements on the curator queue |

Each runtime has its own role:

- A reviewer runs code from the pull request it reviews, and that code can
  use the reviewer's role. The role can:
  - call its models;
  - get objects under its own prefix in the assets bucket (no listing),
    with `kms:Decrypt` on the substrate key. The key also encrypts the
    concerns tables, but the role has no DynamoDB access to them;
  - read its own skills registry;
  - get, put and update any item in the shared heartbeat table;
  - invoke its own token broker;
  - write its own runtime log groups
    (`/aws/bedrock-agentcore/runtimes/<runtime name>-*`, for example
    `valkey_review_runtime-*`);
  - pull from the CDK bootstrap container-assets repository
    (`ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer` and
    `ecr:BatchCheckLayerAvailability`, plus `ecr:GetAuthorizationToken`
    on `*`). ECR cannot grant less than a whole repository, and that
    repository holds the images of every CDK app in the account and
    region that uses the same bootstrap qualifier.

  It has no Secrets Manager access, no concerns table access and no
  registry writes. GitHub tokens come from its token broker, which
  issues a short-lived token for one routed repository.
- The curator role can call its models, read its own prefix in the
  assets bucket (and list the bucket), read and write the concerns
  tables, create, update and read records in the reviewer registries and
  set their status (`agent-registry:UpdateRegistryRecordStatus`, which
  retires a skill), read its own registry, invoke the skills-repo broker
  when there is one, write its own runtime log groups and pull from the
  same container-assets repository. It runs on the `PUBLIC` network mode
  and holds no GitHub credentials. Its skill checks fetch the public
  upstream repositories from `github.com` with git, and read the skill
  files of the bot repository from `api.github.com` and
  `raw.githubusercontent.com`, all without credentials.

Other functions:

- The decay Lambda can scan, update and delete items in the concerns
  tables, use their key, and send messages to the curator queue
  (`sqs:SendMessage`, `sqs:GetQueueAttributes` and `sqs:GetQueueUrl`, on
  that queue only). It reads the GitHub releases API without credentials.
- Each review worker can invoke its route's runtime, read the heartbeat
  table and update its items (the run's start record), and get, update
  and delete the receiver's `pending#` items in the idempotency table
  (the grant is limited to that key prefix). The curator worker can only
  invoke the curator runtime.
- The skills-repo broker can read only its App secret
  (`secretsmanager:GetSecretValue` on that secret). Only the curator role
  may invoke it.

Deploy into an AWS account used for nothing else, or at least give this
app a bootstrap qualifier of its own (`aws.bootstrapQualifier`), so that
the container-assets repository holds only this app's images.

Model permissions are derived from the `models` settings. Mantle
permissions are granted only when an `openai.*` model is configured.

## Before the first deployment

1. Install Node.js 24 or later, Docker and the AWS CLI. `cdk deploy`
   builds the three agent images for linux/arm64. On an x86 machine
   Docker needs arm64 emulation (buildx with QEMU; Docker Desktop
   includes it), or deploy from an arm64 machine. The operator scripts in
   `scripts/` use the AWS CLI.
2. Bootstrap CDK in the target account and region, preferably an account
   used for nothing else (see [Stacks](#stacks)):
   `npx cdk bootstrap aws://ACCOUNT/REGION`. If you use a custom qualifier,
   pass `--qualifier` and set `aws.bootstrapQualifier` to the same value.
3. Create a GitHub App. Give it at least Pull requests (read and write),
   Issues (read) and Metadata (read). The token broker requests only Pull
   requests and Metadata; Issues (read) is what lets the App subscribe to
   `issue_comment`. Subscribe it to the `pull_request`,
   `pull_request_review`, `pull_request_review_comment` and
   `issue_comment` events, and install it on the repositories you route.
   It needs no Contents permission. The pull requests that propose edits
   to the reviewers' skill files are opened by a second App; see
   [The skills-repo App](#the-skills-repo-app).
4. Store the App credentials in Secrets Manager, in the target account and
   region, under the name you set in `github.appSecretName`. The secret is a
   JSON object:
   ```json
   { "app_id": "123456", "private_key": "-----BEGIN RSA PRIVATE KEY-----\n...", "webhook_secret": "..." }
   ```
5. Create three registries in AWS Agent Registry in the same account and
   region: one per reviewer and one for the curator. This app does not
   create them. Put their IDs or ARNs under `skillsRegistries`.
6. Make sure the account can invoke every model in `models`.
7. Copy `deploy.config.example.json` to `deploy.config.json` and fill it in.
   `deploy.config.json` is ignored by git. The example sets
   `skillsRepo.repo` to the placeholder `your-org/valkey-review-bot`. Set it
   to your bot repository, or remove the `skillsRepo` block until you set
   up [the skills-repo App](#the-skills-repo-app). While it is set, the
   substrate stack creates the skills-repo broker and the curator may
   invoke it, even with `skillLifecycle.openPullRequests` off, and every
   release's repo skill check reads the file from that repository. A
   placeholder repository makes each of those checks end inconclusive.

## Commands

From the repository root:

```sh
(cd webhook && npm ci) && (cd ops && npm ci)
cd infra
npm ci
npm run typecheck
npm test                            # unit tests; no AWS access needed
npx cdk synth
npx cdk deploy --all
```

`cdk synth` bundles the Lambda functions from `webhook/` and `ops/` with
esbuild, so those packages need their dependencies installed first.
`npm test` skips the bundling and needs only `infra/`.

The app reads its configuration from the first of:

1. `-c config=PATH` on the cdk command line,
2. the `VALKEY_REVIEWER_CONFIG` environment variable,
3. `infra/deploy.config.json`.

Relative paths resolve against the current directory. The file is validated
before any stack is built, and every problem is reported at once. If the
AWS credentials in use belong to a different account than `aws.account`,
synthesis stops.

After the first deployment, set the App's webhook URL to the `ApiUrl`
output of `ValkeyReviewWebhook` and its webhook secret to the
`webhook_secret` value from step 4.

Then publish the curator's reference skills to its registry. From the
repository root:

```sh
(cd agents/common && npm ci)
node scripts/publish-curator-skills.mjs --stack ValkeyReviewerCurator --region REGION
```

The script runs the registry code in `agents/common`, so that package
needs its dependencies. `--stack` reads the `CuratorSkillsRegistryId`
output with the AWS CLI. Each reviewer stack has a `SkillsRegistryId`
output, which `scripts/registry-skills.mjs --stack` reads.

## Configuration reference

Unknown keys are rejected, so a misspelled key fails instead of being
ignored. Keys with a default may be left out.

### `aws`

| Key | Default | Meaning |
| --- | --- | --- |
| `account` | required | 12-digit account ID. Must equal the account of the current AWS credentials when the CDK CLI reports one. |
| `region` | required | Region for every stack, for example `us-west-2`. |
| `bootstrapQualifier` | `hnb659fds` | CDK bootstrap qualifier. Selects the bootstrap bucket, roles and container repository. |

### `github`

| Key | Default | Meaning |
| --- | --- | --- |
| `appId` | required | Numeric GitHub App ID. |
| `botLogin` | required | The App's bot login, ending in `[bot]`, for example `your-app-slug[bot]`. Used to recognize the bot's own comments and @mentions. |
| `appSecretName` | required | Secrets Manager secret name (see step 4 above). |
| `installationId` | none | Numeric installation ID. Only used when a webhook payload carries no installation. |
| `knownBotLogins` | receiver's built-in list | Logins of other bots to ignore. See [Known bot logins](#known-bot-logins). |

#### Known bot logins

The receiver ignores bot authors. Their pull requests get no automatic
review, their comments and reviews are not maintainer feedback, and
their @mentions do not summon the bot. An author is a bot when GitHub
reports the user type `Bot`, when the login ends in `[bot]`, when the
login is `botLogin`, or when the login is in the known bot list. Logins
are compared case-insensitively.

The stack passes `knownBotLogins` to the receiver as the comma-separated
`KNOWN_BOT_LOGINS` variable. A non-empty list replaces the built-in list
(`DEFAULT_KNOWN_BOT_LOGINS` in `webhook/src/config.ts`), so copy any
built-in logins you still want.
Leave the key out, or set it to `[]`, to keep the built-in list. The
variable is then not set at all, because the receiver would read an empty
value as an empty list.

### `skillsRegistries`

All three are required. Each value is a registry ID (letters, digits, `_`,
`-`, up to 64 characters) or an `agent-registry` registry ARN in the same
partition, region and account as `aws`.

| Key | Meaning |
| --- | --- |
| `valkey-review` | Graduated skills for the Valkey reviewer. |
| `valkey-glide-review` | Graduated skills for the Valkey GLIDE reviewer. |
| `curator` | The curator's own reference material, such as how to write a skill. |

### `routes`

A list with at least one entry. Each route connects one repository to one
reviewer. The token broker issues tokens only for these repositories.

| Key | Default | Meaning |
| --- | --- | --- |
| `id` | required | Route name: letters, digits and hyphens. It names the route's queue and worker, so keep it stable once deployed. Ids must stay unique after hyphens are removed. |
| `reviewer` | required | `valkey-review` or `valkey-glide-review`. |
| `repo` | required | `owner/name`, spelled as GitHub shows it. A repository can appear in one route only (compared case-insensitively). |
| `threadReplyReview` | `false` | A maintainer tagging the bot in a reply inside any review thread starts a review. In a thread the bot started, that review answers the reply from the code: it verifies a claimed fix, re-checks a disputed finding (and withdraws it if the reply is right), or answers a question. In any other thread the tag is an ordinary summons. When `false`, tags in review-thread replies start nothing (the replies are still feedback). Enable it on every route where maintainers should be able to answer the bot; the example does so on both routes. |
| `skipDrafts` | `false` | Draft pull requests are not reviewed when opened or pushed to; the review runs when the draft is marked ready. |
| `mentionOnly` | `false` | No automatic reviews, on open, reopen or new commits. Reviews run only when a maintainer tags the bot. |
| `authorAllowlist` | `[]` | When not empty, only pull requests by these logins get automatic reviews. |

### `curatorOnlyRoutes`

Default `[]`. Repositories the curator learns from but where no reviewer
ever runs. Each entry has `reviewer` and `repo` as above. A repository
cannot be both a route and a curator-only route.

### `upstreamRepos`

The canonical repository of each reviewer's project. The reviewer fetches
its release branches for backport checks. The skill lifecycle uses it too:
its GitHub releases trigger skill checks, and the checks read its default
branch. It must be public, because both are read without credentials. An
empty string means "use the pull request's repository" for backport checks
and turns skill checks off for that reviewer; decay and retirement still
apply. A repository named `.` or `..` is refused.

| Key | Default |
| --- | --- |
| `valkey-review` | `valkey-io/valkey` |
| `valkey-glide-review` | `valkey-io/valkey-glide` |

### `models`

Model IDs are Bedrock model IDs or inference profile IDs. IDs that start
with `openai.` are called through Bedrock Mantle. An ID that starts with a
region-group token and a dot, such as `us.anthropic.claude-opus-5-5`, is a
cross-Region inference profile. Any other ID is a foundation model, called
and granted in `aws.region` only.

The role that calls a profile gets the profile ARN in `aws.region` and the
foundation model in `aws.region` and in every `profileRegions` entry.
`aws.region` and every `profileRegions` entry must also pass the region
check for the profile's group:

| Prefix | Regions allowed |
| --- | --- |
| `us.` | `us-*`, except `us-gov-*` |
| `us-gov.` | `us-gov-*` |
| `eu.` | `eu-*` |
| `apac.`, `jp.`, `au.`, `in.` | `ap-*` |
| `ca.` | `ca-*` |

The check uses region names only. It catches a profile from the wrong
geography, but it cannot tell whether Bedrock serves a given profile from,
or routes it to, a given region; for example, `jp.*` profiles run in only
some `ap-*` regions. Bedrock sets those per profile and per calling
region. To find them, call `aws bedrock get-inference-profile` in
`aws.region` and list the regions of the model ARNs it returns in
`profileRegions`. If you use profiles from more than one group,
`profileRegions` must pass the check for each of them.

Global profiles (`global.*`) are rejected. They can route a request to any
commercial region, which `profileRegions` cannot bound. To use a region
group that is not in the table, add it to `PROFILE_GEOGRAPHIES` in
`lib/deployment-config.ts`; until then its IDs are treated as foundation
models.

| Key | Default | Meaning |
| --- | --- | --- |
| `reviewer.primary` | `us.anthropic.claude-opus-5-5` | Reviewer model. |
| `reviewer.fallback` | `openai.gpt-6.1-sol` | Used when a review is retried after the primary failed. |
| `reviewer.effort` | `high` | Effort for both reviewer models. One of `low`, `medium`, `high`, `xhigh`, `max`. |
| `curator.primary` | `us.anthropic.claude-opus-5-5` | Curator model. |
| `curator.fallback` | `openai.gpt-6.1-sol` | Curator model after a primary failure. |
| `curator.effort` | `medium` | Effort for `curator.primary`. |
| `curator.fallbackEffort` | `high` | Effort for `curator.fallback`. |
| `summarizer.primary` | `us.anthropic.claude-haiku-5-5` | Writes the one-line progress note in the status comment of a summoned review. |
| `summarizer.fallback` | `openai.gpt-6.1-sol` | Used when the summarizer primary fails. |
| `safetyGate` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` | Screens maintainer instructions in @mentions before a review is queued. Must be a Bedrock model; the receiver calls it through the Converse API. |
| `profileRegions` | `["us-east-1", "us-east-2", "us-west-2"]` | Regions an inference profile may send a request to. Each gets a foundation-model grant. |
| `mantleRegion` | `us-east-1` | Region the Mantle client calls. Required when any model is `openai.*`; may be `""` otherwise. |
| `mantleGrantRegions` | `[mantleRegion]` | Regions where Mantle inference is granted. Must include `mantleRegion`. Add a region here before you move `mantleRegion` to it. |
| `extraGrants` | `[]` | More model IDs granted to the reviewer and curator roles, for example a model you may roll back to. |

### `agents`

| Key | Default | Meaning |
| --- | --- | --- |
| `valkey-review.maxIterations`, `valkey-glide-review.maxIterations` | `150` | Maximum model calls per review, retries included (1 to 500). |
| `valkey-review.maxTokens`, `valkey-glide-review.maxTokens` | `32768` | Output token limit per model call (1024 to 200000). |
| `valkey-review.allowBuild`, `valkey-glide-review.allowBuild` | `true` | Lets the reviewer run the repository's build and tests. |
| `valkey-review.allowWrite`, `valkey-glide-review.allowWrite` | `true` | Lets the reviewer write files in its checkout, for example a test that checks a claim. |
| `curator.maxIterations` | `40` | Maximum tool rounds per feedback event (1 to 500). |
| `curator.maxTokens` | `16384` | Output token limit per model call (1024 to 200000). |
| `curator.graduationThreshold` | `4` | Distinct reinforcements a concern needs before the curator may write it to a reviewer's skills registry (2 to 100). |

The ranges are the ones the curator checks when it starts, so a value it
would reject fails synthesis instead. The reviewers use the same ranges.

### `decay`

| Key | Default | Meaning |
| --- | --- | --- |
| `halfLifeDays` | `30` | Days it takes the `decay_score` of an unreinforced record that never graduated to halve. Passed to the decay Lambda as `DECAY_HALF_LIFE_SECONDS`. Greater than 0 and at most 3650. |
| `floor` | `0.05` | Records that never graduated are deleted when their `decay_score` falls below this; graduated records are retired instead. Greater than 0 and less than 1. |
| `graduatedHalfLifeDays` | `180` | Half-life of records that graduated into a skill: the skill's standing. Passed as `DECAY_GRADUATED_HALF_LIFE_SECONDS`. Greater than 0, at most 3650, and at least `halfLifeDays`. |

The curator sets a record's `decay_score` to 1 each time a maintainer
reinforces the concern. Once a day the decay Lambda (`ops/src/decay.ts`)
multiplies the score by `0.5 ^ (elapsed / halfLife)`, where `elapsed` is
the time since the score was last set. A record nobody reinforces falls
below the floor after `halfLife * log2(1 / floor)` days.

- A record that never graduated is deleted then. With the defaults that is
  `30 * log2(20)`, about 130 days.
- A graduated record is never deleted. Below the floor its skill is
  retired, when `skillLifecycle.retireSkills` is on, and the record stays
  as a tombstone. With the defaults that is `180 * log2(20)`, about 778
  days. A release check that finds names missing also lowers the score,
  and one that finds the skill's subject gone sets it to 0.

Scores lowered under an earlier half-life keep their value; the new one
applies from the next pass.

### `skillLifecycle`

How the decay job schedules skill maintenance and what the curator may
change. Every switch that changes a skill, retires one or opens a pull
request is off by default: report mode. See
[Skill lifecycle operations](#skill-lifecycle-operations) before turning
one on.

| Key | Default | Meaning |
| --- | --- | --- |
| `checksPerDay` | `10` | Check requests per reviewer per daily pass, the repo skill check included (0 to 100). `0` turns checks off. Passed to the decay Lambda as `SKILL_CHECKS_PER_DAY`. |
| `recheckDays` | `90` | A check is also due when the last one is older than this (7 to 3650). `SKILL_RECHECK_SECONDS`. |
| `applyEdits` | `false` | Write validated edits to the registry skills. When `false`, they are kept in the record's `pending_revision` for the operator. Curator `CHECK_APPLY_EDITS`. |
| `retireSkills` | `false` | Deprecate skills that decayed below the floor or whose subject is gone. When `false`, the decay job logs them as `would-retire`. `RETIRE_SKILLS`, on both the decay Lambda and the curator. |
| `openPullRequests` | `false` | Propose edits to the reviewers' repo skill files by pull request against `skillsRepo.repo`. Does nothing without `skillsRepo`. Curator `CHECK_OPEN_PULL_REQUESTS`. |
| `maxRetirementsPerDay` | `3` | Retire requests per reviewer per pass (1 to 50). `MAX_RETIREMENTS_PER_DAY`. |
| `maxCheckRounds` | `25` | Tool rounds of one audit (5 to 100). Curator `CHECK_MAX_ROUNDS`. |
| `retireRefusedBackoffDays` | `30` | After the registry refused a retirement, the decay job waits this long before it asks again (1 to 3650). `RETIRE_REFUSED_BACKOFF_SECONDS`. |

### `skillsRepo`

Optional. The bot's own repository, where the reviewers' repo skill files
(`agents/<reviewer>/config/skill.md`) live. When it is absent, the repo
skill check of each release is recorded as skipped, no skills-repo broker
is created, and nothing is ever proposed. When it is set, the curator reads
the files from it without credentials, so it must be public.

| Key | Default | Meaning |
| --- | --- | --- |
| `repo` | required | `owner/name` of the bot repository, for example `valkey-io/valkey-review-bot`. Passed to the curator and the broker as `SKILLS_REPO`. |
| `baseBranch` | `main` | The branch the files are read from and pull requests target: at most 100 characters, a name git accepts. `SKILLS_REPO_BASE_BRANCH`. |
| `appSecretName` | `github.appSecretName` | Secrets Manager secret of the App that opens the pull requests, with `app_id` and `private_key` (the same JSON shape as the main App secret; `webhook_secret` is not needed). See [The skills-repo App](#the-skills-repo-app). Passed to the broker as `SKILLS_REPO_APP_SECRET_NAME`. |
| `signOff` | the App's bot identity | `Name <email>` on one line for the commit's `Signed-off-by` line. The name is 1 to 100 characters, with no control characters, no `<` or `>`, and no space or other whitespace at either end. `SKILLS_REPO_SIGN_OFF`. |

### `dailyReviewBudget`

Default `40`. Automatic reviews allowed per route per UTC day, reviews of
new commits included. Reviews beyond it are skipped and logged. Reviews
summoned by a maintainer are not counted, and neither are events that join
a waiting review. `0` pauses automatic reviews.

### `maxAutomaticReviewsPerPr`

Default `3`, from 1 to 20. Automatic reviews one pull request can get,
counting the first: on open, reopen, `ready_for_review` and new commits.
Further events are skipped as `auto-review-cap`. @mentions and thread
replies are not counted. Passed to the receiver as
`MAX_AUTOMATIC_REVIEWS_PER_PR`. The count lives in the idempotency table and
expires 180 days after the pull request's latest automatic review.

### `pushReviewDelaySeconds`

Default `300`, from 0 to 900 (the SQS limit). How long a review that new
commits started waits in the queue. Pushes, reopens and `ready_for_review`
events while it waits join it, so a burst gets one review of the newest
head. Passed to the receiver as `PUSH_REVIEW_DELAY_SECONDS`. The delay comes
out of the review's 90-minute run budget.

## Operational limits

These are constants in `lib/webhook-stack.ts`, except the session limits,
which are in `lib/valkey-review-agent-stack.ts`:

- Review workers: at most 5 concurrent per route. Curator worker: at most 2.
- Reviewer runtime sessions: 15-minute idle timeout and 2-hour maximum
  lifetime. While a review runs, the runtime reports `HealthyBusy` on
  `/ping`, so the idle timeout does not stop it after the worker has
  gone. The 2-hour limit is above the 90-minute run budget and ends a
  session that hangs. The curator runtime keeps AgentCore's defaults and
  does not report `HealthyBusy`.
- Receiver: 10 reserved concurrent executions. Reserving concurrency needs
  enough unreserved account concurrency; a new account with a low Lambda
  quota may need an increase first.
- HTTP API: 20 requests per second, burst 40. GitHub does not retry a
  throttled delivery by itself; you can redeliver it from the App's
  advanced settings.
- Dead-letter queues: a review queue message moves to its dead-letter
  queue after 8 receives (`maxReceiveCount: 8`), and a curator message
  after 3 (`maxReceiveCount: 3`). The stack outputs each dead-letter
  queue name; alarm on `AWS/SQS` `ApproximateNumberOfMessagesVisible`
  above 0 for those queues.
  - Reviews often outlive the 15-minute worker. The runtime keeps working
    after the worker times out, and the worker uses redelivery as a
    watchdog. The queue hides a message for 16 minutes, so it comes back
    every 16 minutes. On each receive after the first, the worker reads
    the run heartbeat. It acks a finished run, waits again for a live
    one, and retries a dead one on the fallback model. A message older
    than the run budget (`RUN_BUDGET_MINUTES`, default 90, in
    `webhook/src/config.ts`) is acked
    and dropped. A healthy long review is therefore received at most
    `ceil(90 / 16) + 1 = 7` times. The limit of 8 leaves one spare
    receive, so the run budget ends the message instead of the
    dead-letter queue.
  - The curator has no watchdog. Each receive invokes it again. Three
    receives give a feedback event two retries for a passing failure,
    such as throttling, and then stop an event that keeps failing from
    spending more model calls.
