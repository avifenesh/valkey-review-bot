# valkey-reviewer infrastructure

This CDK app deploys valkey-reviewer into one AWS account and region. All
values that differ between installations come from one JSON file, described
below. The code holds no account IDs, App IDs, registry IDs, routes or
secret names.

## Stacks

| Stack | Contents |
| --- | --- |
| `ValkeyReviewerSubstrate` | KMS key, prompt and skill bucket, reference to the GitHub App secret, one token broker Lambda per reviewer, run heartbeat table |
| `ValkeyReviewAgent`, `ValkeyGlideReviewAgent` | One reviewer each: AgentCore runtime, its execution role, its concerns table, prompt and skill upload |
| `ValkeyReviewerCurator` | Curator runtime and its execution role |
| `ValkeyReviewWebhook` | HTTP API, receiver Lambda, idempotency table, one queue and worker per route, the curator queue and worker, dead-letter queues |
| `ValkeyReviewerDecay` | Daily Lambda that decays and prunes concerns records |

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
  tables, write records in the reviewer registries, read its own
  registry, write its own runtime log groups and pull from the same
  container-assets repository.

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
   `deploy.config.json` is ignored by git.

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
| `threadReplyReview` | `false` | A maintainer tagging the bot in a reply inside any review thread starts a review; in a thread the bot started, that review checks the claimed fix. When `false`, tags in review-thread replies start nothing (the replies are still feedback). |
| `skipDrafts` | `false` | Draft pull requests are not reviewed when opened; the review runs when the draft is marked ready. |
| `mentionOnly` | `false` | No automatic reviews. Reviews run only when a maintainer tags the bot. |
| `authorAllowlist` | `[]` | When not empty, only pull requests by these logins get automatic reviews. |

### `curatorOnlyRoutes`

Default `[]`. Repositories the curator learns from but where no reviewer
ever runs. Each entry has `reviewer` and `repo` as above. A repository
cannot be both a route and a curator-only route.

### `upstreamRepos`

The canonical repository each reviewer fetches release branches from, for
backport checks. An empty string means "use the pull request's
repository".

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
| `halfLifeDays` | `30` | Days it takes an unreinforced record's `decay_score` to halve. Passed to the decay Lambda as `DECAY_HALF_LIFE_SECONDS`. Greater than 0 and at most 3650. |
| `floor` | `0.05` | Records whose `decay_score` falls below this are deleted. Greater than 0 and less than 1. |

The curator sets a record's `decay_score` to 1 each time a maintainer
reinforces the concern. Once a day the decay Lambda (`ops/src/decay.ts`)
multiplies the score by `0.5 ^ (elapsed / halfLife)`, where `elapsed` is
the time since the score was last set, and deletes the record if the
result is below `floor`. A record nobody reinforces falls below the floor
after `halfLifeDays * log2(1 / floor)` days. With the defaults that is
`30 * log2(20)`, about 130 days, and the next daily run deletes it.

### `dailyReviewBudget`

Default `40`. Automatic reviews allowed per route per UTC day. Reviews
beyond it are skipped and logged. Reviews summoned by a maintainer are not
counted. `0` pauses automatic reviews.

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
