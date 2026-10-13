# Architecture

This document describes how the reviewer works, following the code. Paths are
relative to the repository root. Deployment settings are documented in the
[configuration reference](../infra/README.md#configuration-reference), Lambda
environment variables in [webhook/README.md](../webhook/README.md), and the
security model in [SECURITY.md](../SECURITY.md).

## 1. Components and flows

| Component | Code | Runs as |
| --- | --- | --- |
| Receiver | `webhook/src/receiver.ts`, logic in `webhook/src/delivery.ts` | Lambda behind an API Gateway HTTP API (`POST /webhook`) |
| Invoker | `webhook/src/invoker.ts`, `webhook/src/watchdog.ts` | One Lambda per review route and one for the curator, each fed by its own SQS queue |
| Token broker | `webhook/src/token-broker.ts`, checks in `webhook/src/broker.ts` | One Lambda per reviewer, invoked by that reviewer's runtime |
| Reviewers | `agents/common`, plus `agents/valkey-review` or `agents/valkey-glide-review` | One Bedrock AgentCore runtime and container image per reviewer |
| Curator | `agents/curator` | Its own AgentCore runtime |
| Decay job | `ops/src/decay.ts` | Lambda on a daily EventBridge schedule |
| Infrastructure | `infra/lib/*.ts` | CDK app; the stacks are listed in [infra/README.md](../infra/README.md#stacks) |

```text
GitHub App webhook
  |
  v
HTTP API -> receiver -+-> route queue -> route worker -> reviewer runtime -> GitHub (review, state comment)
                      |   (one per route)    ^               |    |
                      |                      |               |    +-> token broker (repo-scoped token)
                      |                      +-- heartbeat --+
                      |                          table
                      |
                      +-> curator queue -> curator worker -> curator runtime -> concerns table
                                                                             -> reviewer's skills registry
```

### Automatic pull request review

1. A pull request on a review route is opened or reopened, or, on a
   `skipDrafts` route, marked ready for review. GitHub sends a
   `pull_request` delivery to the HTTP API.
2. The receiver checks the signature, applies the route's gates, claims the
   idempotency key and takes a slot from the route's daily budget
   (`pullRequest` in `webhook/src/delivery.ts`). It sends a review envelope
   (`webhook/src/review-envelope.ts`) to the route's queue.
3. The route's worker calls `InvokeAgentRuntime` on the route's reviewer
   runtime with the envelope as the payload and reads the event stream
   (`handleOne` in `webhook/src/invoker.ts`).
4. The runtime (`bootstrap` in `agents/common/src/run-agent.ts`) starts a
   heartbeat record, gets a token from its token broker, fetches the pull
   request into the clone in its image, loads graduated skills and runs the
   model with its tools.
5. The model ends with `post_review` (a `COMMENT` review with inline
   comments) or `skip_review`. Both rewrite the pull request's review state
   comment.
6. The runtime marks the heartbeat `completed` and sends a `done` event, and
   SQS deletes the message. If the worker's 15 minute limit ends its read
   first, later receives of the message decide from the heartbeat whether to
   wait, stop or retry (section 3).

### Review on @mention

1. A user tags the bot (`@<app-slug>`) in a pull request comment or a review
   comment. GitHub sends `issue_comment` or `pull_request_review_comment`
   with action `created`.
2. The receiver detects the tag (`detectMention` in `webhook/src/mention.ts`),
   requires a review route and push permission, claims the comment, reads the
   pull request (it must be open) and posts an acknowledgement comment.
3. The instruction (the comment without the tag) goes through a safety check
   on a Bedrock model. A denial edits the acknowledgement into a decline and
   nothing is queued.
4. The envelope adds the instruction, the requester, the acknowledgement
   comment id (`status_comment_id`), a run nonce and, for inline tags, the
   file and line. It goes to the route's queue and does not use the daily
   budget.
5. The worker and runtime proceed as above. The runtime turns the
   acknowledgement into a status comment, puts the instruction in the first
   message as the main directive, and replaces the status comment with its
   reply at the end.
6. A tag in a reply inside a review thread starts a run only on routes with
   `threadReplyReview`. If the App started that thread, the instruction quotes
   the App's comment and asks the run to check the claimed fix. The reply is
   handled as feedback either way.

### Curator feedback

1. An owner, member or collaborator comments on a pull request, replies in a
   review thread or submits a review.
2. The receiver drops summons, untrusted authors, unrouted repositories and
   noise (`extractFeedback` in `webhook/src/feedback.ts`,
   `classifyCommentBody` in `webhook/src/heuristics.ts`). For a thread reply
   it reads the thread's first comment and attaches it when the App wrote it.
3. It claims the feedback id and sends a curator envelope to the curator
   queue.
4. The curator worker invokes the curator runtime
   (`agents/curator/src/agent.ts`). The runtime repeats the trust check, binds
   its tools to the reviewer's concerns table and skills registry, and runs
   the model.
5. The model makes at most one change to the concerns store. When the record
   it reinforced has enough reinforcements, it publishes the record as a skill
   to the reviewer's registry, and every later review loads it.

## 2. The receiver

### Signature check

`verifySignature` (`webhook/src/signature.ts`) computes the HMAC-SHA256 of
the raw body bytes with `webhook_secret` and compares it with
`X-Hub-Signature-256` in constant time. The secret is cached for five minutes
(`createAppSecretSource` in `webhook/src/github.ts`). On a mismatch the
receiver fetches it again, at most once a minute, so a rotated secret is
picked up without letting forged requests drive Secrets Manager calls. A bad
signature gets 401. Payload fields are logged only after the signature
checks out; each delivery logs one `[delivery]` line with a `decision=` value,
which `scripts/dump-hour.sh` summarizes.

### Events and actions

`dispatch` in `webhook/src/delivery.ts`:

- `ping`: answered with 200.
- `pull_request`: the automatic review path. Only `opened`, `reopened` and
  `ready_for_review` can start a review. New commits (`synchronize`) never do.
- `issue_comment` and `pull_request_review_comment`: @mention detection,
  then the feedback path.
- `pull_request_review`: the feedback path only (action `submitted`). A tag
  in a review body does not start a review.
- Anything else is skipped with 200. A payload without a repository or an
  installation id (from the payload, or `INSTALLATION_ID`), or one that is not
  JSON, gets 400. A failure to queue or any unexpected error gets 500.

A user counts as a bot (`botMatcher` in `webhook/src/config.ts`) when its type
is `Bot`, its login ends in `[bot]`, it is the App's own login, or it is on the
known-bots list. The same test applies to pull request authors, mention
authors and feedback authors.

### Gates for automatic reviews

In order (`pullRequest`):

1. The action is one of the three above.
2. The pull request author is not a bot.
3. The repository has a review route (case-insensitive).
4. The route is not `mentionOnly`.
5. Drafts: on `skipDrafts` routes a draft is skipped when opened and reviewed
   on `ready_for_review`. Other routes review on open, draft or not, and
   ignore `ready_for_review`.
6. When the route's `authorAllowlist` is not empty, the author is on it.
7. The idempotency key is new.
8. The route's daily budget has a slot.

### Gates for @mentions

`detectMention` accepts a created comment whose author is not a bot and that
tags the bot outside quotes and code (`mentionPattern` matches `@` plus the
login without `[bot]`, at a word boundary). After the tag is removed the
comment must be more than an acknowledgement or emoji. An `issue_comment`
must be on a pull request. A review comment with `in_reply_to_id` is a thread
reply; anything else is a summons.

`handleMention` and `startRun` then check, in order: a review route exists
(summons on other repositories are dropped; thread replies run only on
`threadReplyReview` routes), the author has push permission (the collaborator
permission endpoint; any failure counts as no permission, and an
unauthorized tag gets no reply), the claim `mention#<surface>-<comment id>`
is new, and the pull request is open.

The safety gate (`createSafetyGate`) sends at most 4,000 characters of
instruction to the model in `HAIKU_MODEL_ID` through Converse, between two
random marker lines, with a 5 second timeout. No verdict, an unparsable
verdict, an error or a timeout all deny. A bare tag has no instruction, skips
the gate, and gets a standard full review. Failures a redelivery could fix
(reading the pull request, posting the acknowledgement, queuing) release the
claim and return 500; a failed queue send also edits the acknowledgement to
say so.

### Daily review budget

`takeReviewSlot` (`webhook/src/store.ts`) increments the item
`budget#<route id>#<YYYY-MM-DD>` (UTC) in the idempotency table, on condition
that it is below `DAILY_REVIEW_BUDGET` (default 40; 0 pauses automatic
reviews). The slot is taken after the idempotency claim. When the budget is
used up, the claim is released, so a redelivery after the day resets can
still review. A slot whose queue send then fails is not returned. Only
automatic reviews count.

### Idempotency

`claim` is a conditional put on `key` with a 24 hour TTL. The keys are:

- `owner/name#<pr>#<head sha>` for automatic reviews, with `#ready` appended
  for `ready_for_review`, so the same head can be reviewed again once a draft
  is marked ready;
- `mention#issue_comment-<id>` or `mention#review_comment-<id>`;
- `curator#rc-<id>`, `curator#ic-<id>` or `curator#pr-<id>` for review
  comments, issue comments and reviews.

An existing key is a duplicate and is skipped with 200. When the work cannot
be queued, the key is released and the receiver answers 500. GitHub does not
retry failed deliveries; an operator can redeliver from the App's advanced
settings.

### Feedback forwarded to the curator

A delivery reaches the curator queue only when all of these hold:

- It is a created `issue_comment` on a pull request, a created
  `pull_request_review_comment`, or a submitted `pull_request_review`. Edits
  and deletions never count.
- The author has a login, is not a bot, and has `author_association` `OWNER`,
  `MEMBER` or `COLLABORATOR`.
- It is not a summons. A thread reply that started a re-review still counts.
- The repository has a curator route: every review route plus the
  `curatorOnlyRoutes`.
- `classifyCommentBody` does not call it noise. It drops empty text,
  acknowledgements, "same"/"ditto", emoji-only and URL-only comments, test
  markers, mostly quoted replies, short @pings, and anything with fewer than
  four words of the author's own prose. A `?` in that prose or a suggestion
  block keeps a comment regardless of the quote, ping and length rules.
- For a thread reply, the receiver reads the thread's first comment. A reply
  by the pull request author in a thread the App did not start is dropped
  (`isAuthorReplyOutsideBotThread`). When the App started the thread, its
  comment goes into the envelope. If the lookup fails, the reply is forwarded
  without it.

## 3. Queues and the invoker

### Queues and workers

`infra/lib/webhook-stack.ts` gives each review route its own SQS queue,
dead-letter queue and worker, and the curator one of each, so a backlog on one
route does not hold up another. Workers take one message at a time, report
partial batch failures, and run for at most 15 minutes. Queues use a 16 minute
visibility timeout and 14 day retention. Concurrency limits are listed under
[Operational limits](../infra/README.md#operational-limits).

The worker forwards the message body unchanged (adding `use_fallback_model`
on a retry) to `InvokeAgentRuntime` and reads the server-sent event stream to
the end. It logs `tool_use`, `status` and `error` frames; only a `done` frame
counts as success. A stream that closes without one is an error, so the
message returns after the visibility timeout.

### Heartbeat watchdog

The runtime writes one item per run to the heartbeat table (`createHeartbeat`
in `agents/common/src/heartbeat.ts`): `last_activity` in milliseconds,
`status` (`running`, `completed` or `failed`), the model, and a 24 hour TTL.
It writes at most once a minute while agent events arrive, writes
`completed` as soon as a terminal tool succeeds, and writes the final status
after any write still in flight. The key is
`owner/name#<pr>#<head sha>`, plus `#<nonce>` when the envelope has one: `ready`
for a draft marked ready, `m<comment id>` for an @mention run. The nonce keeps
a completed automatic review from making the watchdog drop a later run on the
same head. `heartbeatRunKey` in `webhook/src/review-envelope.ts` and the run
key in `run-agent.ts` must produce the same string.

A worker stops reading when its 15 minute limit ends, and the message comes
back after the visibility timeout. For a review message, `decide` in
`webhook/src/watchdog.ts` returns:

- first receive: invoke on the primary model;
- heartbeat `completed`: delete, at any age;
- message older than the run budget (from `SentTimestamp`): delete it and log
  `[abandoned]`;
- no heartbeat, status `failed`, or last activity older than
  `HEARTBEAT_STALE_MINUTES` (default 12): invoke again on the fallback model;
- otherwise the run is alive: report the message as failed without invoking,
  and check again after the next visibility timeout.

A review worker without `HEARTBEAT_TABLE` refuses every message, because
every redelivery would otherwise look like a dead run.

### Primary and fallback model

The first attempt runs on `BEDROCK_MODEL_ID`. Every attempt the watchdog
starts later sets `use_fallback_model`, and the runtime switches to
`FALLBACK_MODEL_ID`. Slowness alone never triggers this, only a missing,
failed or stale heartbeat. Within one attempt the reviewer retries transient
model errors on the same model (section 4). The curator works differently: it
falls back per model call inside one invocation (section 6).

### Run budget and dead-letter queues

`RUN_BUDGET_MINUTES` defaults to 90 and is not overridden by the CDK app. With
a 16 minute visibility timeout a healthy long review is received at most
seven times, so review queues dead-letter after eight receives. Curator
messages have no heartbeat: every receive invokes the curator, the curator
queue dead-letters after three receives, and the worker deletes a curator
message seen more than three times (which only happens without a redrive
policy). The webhook stack outputs every dead-letter queue name for alarms.

## 4. A review run inside the runtime

### Startup and model

When the container starts, `bootstrap` reads its settings (`loadEnv` in
`agents/common/src/config.ts`) and loads `prompt.md` and `skill.md` from the
assets bucket once. The base system prompt is the prompt, then a "Skill:
institutional memory" section with the skill file.

Each invocation validates the payload against `requestSchema` and picks the
model. IDs that start with `openai.` go through the Bedrock Mantle
OpenAI-compatible endpoint in `MANTLE_REGION` (`createMantleModel` in
`agents/common/src/models.ts`); any other ID goes through Converse
(`createConverseModel`). Both get `REASONING_EFFORT` and `MAX_TOKENS`. The run
then writes its first heartbeat, gets a token (failing at once if the broker
refuses), opens the status comment on @mention runs, prepares the workspace,
loads graduated skills, assembles the tools and starts the loop.

### Workspace preparation

`prepareWorkspace` in `agents/common/src/workspace.ts`:

- Works in the clone baked into the image (`/workspace/valkey` or
  `/workspace/valkey-glide`, cloned with `--filter=blob:limit=1m`). A warm
  container is reused across runs, so the clone may hold the previous run's
  state.
- Reads the pull request, then runs the git work in parallel with listing
  reviews, review comments, issue comments and changed files (at most 3,000).
- Points `origin` at the pull request's base repository with a URL that holds
  no credentials, force-fetches `pull/<n>/head`, runs `git reset --hard` and
  `git clean -fd` (gitignored build output stays, for incremental builds) and
  checks out the fetched head detached. The run reviews the head it fetched,
  which can be newer than the one in the envelope.
- Fetches the base branch and base SHA (both best effort) and computes the
  merge base. The diff range is `<merge base>..<head>`.
- Release lines for the backport check: points `upstream` at `UPSTREAM_REPO`
  (the pull request's repository when empty), lists branches named
  `<major>.<minor>` or `release-<major>.<minor>`, fetches them into
  `refs/remotes/upstream/*`, and keeps those with a commit in the last 180
  days, highest version first (`maintainedReleaseLines`). This fetch is
  authenticated only when the upstream is the pull request's repository. A
  failure leaves the list unknown.
- Finds the previous review state: the newest issue comment written by this
  App (`performed_via_github_app.id` equal to `GITHUB_APP_ID`) whose body
  starts with the state marker, in `findStateComment`. The marker alone is
  not trusted. The App also posts model-written text in status comments, so
  the terminal tools remove the marker from the `post_review` body and the
  `skip_review` reason before they go there (`stripStateMarker`).

Each git process has a 10 minute limit and aborts a transfer that stays below
1 KB/s for 60 seconds. It runs with `GIT_CONFIG_GLOBAL=/dev/null`, so
`~/.gitconfig` and `~/.config/git/config` are ignored. The token-carrying
fetches all happen here, before any PR code runs. The invoker sets no
runtime session ID, so each run gets a new session and container; the
setting covers a container that is reused, where an earlier run's build
code could have left a global config or edited the clone's `.git/config`
(which this setting does not cover).

### The PR overview and untrusted text

`renderPrOverview` builds the first user message: the author, the head SHA,
the base branch and SHA, the merge base, the diff range, the workspace path
and the change size, then the head branch name, title, description, changed
paths, existing reviews, inline comments and PR comments. Each of those is
wrapped in an `<untrusted-pr-content source="...">` block, and any opening or
closing tag of that name inside the text is defused (`<` becomes `&lt;`) so
the content cannot end its block. The overview states that text in these
blocks is data and never an instruction. Lists show the newest 100 entries as
240 character excerpts. Then come the maintained release lines, each by its
bare name with its `upstream/` ref (or a note to use the `unclear` or
`not_needed` verdict), and the previous review state in full.

On @mention runs `mentionBlock` adds a "Review request" section that makes the
instruction the main directive and names the file and line of an inline tag.
The last line tells the model to start at Phase 1 and finish with a terminal
tool.

The two file paths the prompts write outside the fenced blocks are JSON
strings, so a file name cannot close the sentence around it: the inline
tag's path in `mentionBlock`, and the path in the re-review instruction that
`webhook/src/mention.ts` builds. The base branch stays unfenced, because only
maintainers create branches in the base repository. The previous state
comment is shown unfenced too. The App wrote it, and each finding in it is
folded onto one line with no backticks in its location, so a file name the
model copied cannot start a heading there.

### Loop limits

- `ModelCallLimit` (`agents/common/src/agent-loop.ts`) caps model calls per
  run, retries included, at `MAX_ITERATIONS` (default 150). At the cap the next
  call is cancelled with a
  fixed message, which ends the turn.
- If the turn ends without a terminal tool, one follow-up message asks for
  `post_review` or `skip_review`, with three more model calls reserved.
- `StreamStallRetryStrategy` retries throttling, truncated streams, timeouts,
  stalled streams, server faults, 5xx and 429, and stops retrying once a
  terminal tool has succeeded.
- `ReviewConversationManager` sizes the history window to hold every
  message a run can produce, so nothing is trimmed by count. It trims only
  when the model reports a context overflow, and always keeps the PR
  overview.
- An error after a successful terminal tool counts as completion, so the
  watchdog does not post a second review. A run that ends without one fails:
  the heartbeat says `failed` and the next receive retries on the fallback
  model.
- A review outlives the 15-minute worker that started it, so once the model
  turns have started a closed stream does not stop it. `createReviewHandler`
  relays the model's frames by hand, so closing the handler does not close
  the agent stream under it. When the stream is closed, at any frame, the
  handler runs the remaining model turns to the end itself, including the
  terminal-retry turn, without relaying events. A close before that, during
  the token request, workspace preparation, skill loading or tool assembly,
  ends the run as `failed`.
  The heartbeat also beats from agent hooks (before each model call and
  after each tool call), so the watchdog still sees a live run. When the
  handler exits, the run is recorded as `completed` if a terminal tool
  succeeded and `failed` otherwise. A drained run that ends without one
  logs its model call count and the first 400 characters of its final
  text; one that ends in an error logs the error.
- While a run is in progress, `asBusyTask` keeps it registered as an async
  task of the `BedrockAgentCoreApp`, so the runtime's `/ping` reports
  `HealthyBusy` and AgentCore does not stop the session at its 15-minute
  idle timeout after the worker has gone. The reviewer runtimes end a
  session two hours after it starts at the latest (`lifecycleConfiguration`
  in `infra/lib/valkey-review-agent-stack.ts`), above the watchdog's
  90-minute run budget. The curator has neither (section 6).

### Tools

There is no shell tool. `assembleCommonTools` (`agents/common/src/tools/index.ts`)
builds the common set, and each reviewer adds its build tool when
`ALLOW_BUILD` is true. The GLIDE reviewer removes `lsp`, because its image has
no language server.

| Tool | Code | What it is limited to |
| --- | --- | --- |
| `read`, `grep`, `glob` | `tools/harness.ts` | Files under the workspace root. Paths matching `.env*`, `.aws/`, `id_rsa*`, `*.pem`, `*.key`, `node_modules/` and `.git/` are refused as a `read` target or a search root, and `grep` drops matches in such files. `glob` checks only its search root, so it can still list the names of matching files. |
| `lsp` (Valkey) | `tools/harness.ts` | clangd for `.c` and `.h`, from a fixed manifest. A `.lsp.json` in the checkout is ignored. There is no compilation database, so `references` and `workspaceSymbol` cover only the files clangd has opened and the headers they include; the prompt finds callers with `git grep`. |
| `write`, `edit`, `multi_edit` | `tools/harness.ts` | Only when `ALLOW_WRITE` is true; workspace files only. A target whose real location (the realpath of its nearest existing ancestor) is outside the workspace or matches the refused patterns, for example `.git/` reached through a symlink, is refused. For testing assumptions; nothing is committed or pushed, and the next run resets the tree. |
| `git` | `tools/git.ts` | Read-only subcommands (`log`, `show`, `blame`, `diff`, `status`, `rev-parse`, `rev-list`, `cat-file`, `ls-tree`, `ls-files`, `grep`, `shortlog`, `describe`, `branch`, `tag`, `reflog`, `merge-base`, `name-rev`). `checkGitArgs` rejects options that write files, run helpers or pagers, read files outside the repository, or override config (`-c`); `git diff` refuses absolute paths and paths that climb out with `..`; `branch` and `tag` only list and `reflog` only reads. `--no-ext-diff` and `--no-textconv` are added. No credentials, no system or global gitconfig (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), 60 seconds, 500 KB. |
| `gh_api_read` | `tools/gh.ts` | `GET` through `gh api`, only under `repos/<PR repository or upstream>/`, only for allowlisted pull request, review, comment, commit, contents and check-run endpoints (`checkGhApiPath`). Paths with `..`, `%`, backslashes, whitespace or `#` are refused. 30 seconds, 2 MB. |
| `post_review`, `skip_review` | `tools/gh.ts` | Terminal tools, described below. |
| `make` (Valkey) | `agents/valkey-review/src/tools/make.ts` | Targets `all`, `valkey-server`, `valkey-cli`, `valkey-benchmark`, `valkey-sentinel`, `test-unit`, `clean`, `Makefile.dep`; an allowlist of variables with a restricted character set; `-j` 1 to 16; run from the repository root or `src/`. 8 minutes, 1 MB (see below). |
| `build` (GLIDE) | `agents/valkey-glide-review/src/tools/build.ts` | `cargo`, `gradle` (`./gradlew`), `go`, `npm` and `npx`, each with allowed actions and blocked tokens (`checkBuildArgs` in `build-policy.ts`): no publish, install or login, exact Gradle task names only, `go mod` limited to `graph`, `verify` and `why`, no `npm run` script that rewrites sources or deletes lock files, and no `npx` option that writes files. Working directory inside the checkout. 8 minutes, 1 MB (see below). |

Paths under `tools/` are in `agents/common/src/tools/`. The tool tables in
each `config/prompt.md` describe the same set to the model.

`git`, `gh_api_read`, `make` and `build` run their command through
`runBounded` (`tools/spawn.ts`), in a process group of its own. The time and
output limits apply to everything in that group, such as sub-makes and test
binaries: at either limit the whole group gets SIGTERM, then SIGKILL after a
grace period (3 seconds for `make` and `build`, 2 seconds otherwise). A
process that starts its own session or group is not stopped.

### Review phases

Both reviewer prompts follow the same workflow headings:

- Phase 1: Orient (at most 5 tool calls)
- Phase 1b: Question the approach
- Phase 2: Select candidate claims
- Phase 3: Gather evidence
- Phase 4: Experiment
- Phase 4b: Backport check
- Phase 5: Compose and post
- The review state, then Completion criteria

The GLIDE prompt adds a "Grep hazards" section and two worked examples.

### Terminal tools

`post_review` and `skip_review` share one `TerminalGate`: one of them can
succeed per run, a second call (including a concurrent one) is refused, and a
call that wrote nothing gives the gate back so the model can retry. Both
validate their input before writing anything: text fields and the rendered
state are capped at 60,000 characters, and the state must pass
`validateReviewState`.

- `post_review` creates a review with event `COMMENT` at the head SHA the run
  checked out, with the inline comments. The bot cannot approve or request
  changes. On automatic runs a non-empty `body` becomes the review body. On
  @mention runs the body goes to the status comment instead, and no review
  object is created when there are no inline comments. It then writes the
  state comment.
- `skip_review` writes only the state comment.

A failed review submission gives the gate back. A failed state comment write
does not: it is reported in the result as `state_comment_error` and the call
still completes, so a run never ends without a terminal tool because of it.

A successful call reports back through `onTerminal`, which is how the run
knows the review is done. `run-agent.ts` refuses to start the loop if the
reviewer's `assembleTools` did not wire that callback.

### The review state comment

`agents/common/src/review-state.ts`. Each pull request has one state comment,
marked with `<!-- valkey-reviewer:state -->` and rewritten by every run. The
model fills `reviewStateSchema`:

- `status`: `needs_work` or `ready_for_human_review`;
- `summary`, `risk` (`low`, `medium`, `high`) and `risk_reason`;
- `findings`: location, summary, `blocking`, `resolved`; findings from the
  previous state are carried forward;
- `backport`: `verdict` (`needed`, `not_needed`, `unclear`), `branches`,
  `reason`;
- `direction`: an alternative approach, or empty.

`validateReviewState` rejects `ready_for_human_review` with open blocking
findings or a non-empty `direction`, and a `needed` backport with no branches
or with branches outside the maintained release lines found for this run.
`renderReviewState` produces the comment, so its shape is the same across runs
and models. `createStateCommentWriter` edits the previous comment, or creates
a new one when the old one returns 404 or a 403 that is not rate limiting; a
retried terminal call edits the comment the run already created.

### The status comment on @mention runs

`agents/common/src/status-comment.ts`. The runtime edits the receiver's
acknowledgement comment:

1. At the start, a line saying the review is under way. On a fallback run it
   says another agent took over, without naming models.
2. Every 15 minutes, a timestamped line describing current activity, written
   by the summarizer model from the latest tool calls (primary, then
   fallback, each through Mantle for `openai.*` ids and Converse otherwise; a
   fixed sentence if both fail).
3. At the end, the terminal tool replaces the whole body with the reply (or
   the skip reason) and a link to the state comment.

Edits run one at a time and never fail the review. A failed run stops the
progress edits without a final edit.

## 5. Credentials

### Token broker

The GitHub App secret (`app_id`, `private_key`, `webhook_secret`) lives in
Secrets Manager. Only the receiver and the token brokers can read it. The
receiver uses the webhook secret to verify deliveries and acts as the
installation for @mention handling and thread lookups. The reviewer runtimes
never see the secret. Each reviewer has its own broker (one instance of
`webhook/src/token-broker.ts` per reviewer, created in
`infra/lib/substrate-stack.ts`), and each runtime role may invoke only its
own. The runtime calls it with `{ installation_id, repo }`.

`createTokenBroker` in `webhook/src/broker.ts` refuses a malformed request
and any repository that is not one of its reviewer's review routes
(`ALLOWED_REPOS_JSON`, built by `tokenBrokerRepos(config, reviewerId)` in
`infra/lib/deployment-config.ts`; curator-only repositories are excluded).
It then asks GitHub, as the App, for the App's installation on the
repository (`GET /repos/{owner}/{name}/installation`), and refuses the
request when there is none, when it is not the caller's `installation_id`,
or when its account is not the repository's owner. GitHub resolves
repository names inside the installation a token is requested from, so
without this check another installation of the App could give a token for
a same-named repository of another owner. The broker then returns an installation token for that one
repository with `pull_requests: write` and `metadata: read`, and its
expiry. The installation check adds one GitHub call per token.

### Token scope and refresh

`createTokenSource` (`agents/common/src/github-auth.ts`) caches the token and
asks the broker again five minutes before it expires, with one refresh in
flight at a time, so runs longer than the token's one hour lifetime keep
working. `createOctokit` attaches the current token to every REST request. The
`gh_api_read` tool passes it to its `gh` process only.

### Git authentication

`gitAuthEnv` in `agents/common/src/workspace.ts` authenticates each fetch
through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0` and `GIT_CONFIG_VALUE_0`,
setting `http.https://github.com/.extraheader` for that process only. Remote
URLs carry no credentials and nothing is written to `.git/config`. An upstream
other than the pull request's repository is fetched anonymously. The
model-facing `git` tool runs with no credentials at all.

### Build process environment

`buildChildEnv` (`agents/common/src/tools/child-env.ts`) gives `make` and
`build` the runtime's environment minus every variable whose name starts with
`AWS_`, `AMAZON_`, `GH_` or `GITHUB_`, or contains `TOKEN`, `SECRET`,
`PASSWORD`, `CREDENTIAL` or `PRIVATE_KEY`. `resolveInside` requires the
working directory to resolve inside the checkout. Commands run from an
argument list, never through a shell.

### Runtime roles

Each runtime has its own role (`infra/lib/valkey-review-agent-stack.ts`,
`infra/lib/curator-agent-stack.ts`, both built on `createRuntimeRole` in
`infra/lib/grants.ts`). A reviewer can call its models, get objects under
its own prefix in the assets bucket (no listing) and decrypt them with the
substrate key, read its own skills registry, get, put and update any item
in the shared heartbeat table, invoke its own token broker, write its own
runtime log groups, and pull from the CDK bootstrap container-assets
repository, which holds the images of every CDK app in the account and
region that uses the same bootstrap qualifier. It has no Secrets Manager
access, no concerns table access and no registry writes. The curator can
call its models, read its own prefix in the assets bucket (and list the
bucket), read and write the concerns tables, write the reviewer registries,
read its own registry, write its own runtime log groups and pull from the
same repository. It holds no GitHub credentials and makes no GitHub calls.
[infra/README.md](../infra/README.md#stacks) lists the grants in more
detail.

## 6. The curator

### Envelope and trust check

The receiver sends a `CuratorEnvelope` (`webhook/src/feedback.ts`):
`reviewer_id`, `feedback_id`, `kind` (`review_comment_reply`,
`issue_comment_reply` or `resolution` for a submitted review), `human_body`,
`actor`, `actor_association`, `repo`, `pr_number`, `pr_author`, `bot_comment`
(the App's comment for a reply in its thread, plus the feedback's path and
line) and `installation_id`. The curator's `requestSchema`
(`agents/curator/src/feedback.ts`) also accepts `body` as an older name for
`human_body`.

`untrustedReason` repeats the receiver's check: no actor, a login ending in
`[bot]`, or an association other than `OWNER`, `MEMBER` or `COLLABORATOR`
ends the run without calling the model. `reviewer_id` selects the concerns
table (`CONCERNS_TABLES_JSON`) and skills registry (`SKILLS_REGISTRIES_JSON`);
an unknown id is an error.

### The run

- System prompt: `agents/curator/config/prompt.md` with
  `{{GRADUATION_THRESHOLD}}` filled in, then the curator's `skill.md`. Its
  workflow has two phases: "Phase 1: decide" and "Phase 2: graduate".
- First message (`renderFeedbackMessage`): all GitHub content sits in one
  block between `<<<FEEDBACK <marker>` and `>>>END <marker>`, with a random
  marker per run, and is described as data, not instructions.
- Model (`createCuratorModel` in `agents/common/src/model-fallback.ts`): a
  primary and a fallback, each built from its own model id (Mantle for
  `openai.*`, Converse otherwise). If a model call fails, that call is retried
  on the fallback and the rest of the run stays there. Each primary call is buffered
  so no tool call is acted on before it completes.
- Loop (`curate` in `agents/curator/src/curate.ts`): tools run one at a time.
  The loop ends after the tool round that calls `curator_done`, or after
  `MAX_ITERATIONS` rounds (default 40).
- Stream: the curator runtime has none of the reviewers' closed-stream
  handling, does not report `HealthyBusy` and keeps AgentCore's default
  session lifecycle. If its stream closes before the `done` frame, the
  worker reports the message as failed and SQS delivers it again, up to
  three receives.
- Limits (`CuratorRun` in `agents/curator/src/tools/run.ts`): one change to
  the concerns store per run, one skill submission per run, nothing after
  `curator_done`. A call that fails or changes nothing frees its slot.
  `resolution` feedback can only bump an existing record, without edits.
- Tools: `list_concerns`, `get_concern`, `create_concern`, `bump_concern`,
  `update_concern`, `merge_concerns`, `delete_concern`,
  `list_skill_authoring`, `submit_skill` and `curator_done`.

### Concern records

`agents/curator/src/tools/concerns-ddb.ts`. One table per reviewer, keyed by
`area_bucket` (for example a directory or file) and `record_id` (a random
UUID). A record holds `area` (globs it applies to), `subject`, `concern`,
`context` (the maintainer's "why", at most 4,000 characters, appended to by
edits), `reinforcement_count`, `reinforcers`, `decay_score`, `created_at`,
`updated_at` (last reinforcement), `edited_at`, and after graduation
`graduated_record_name` and `graduated_at`. The decay job adds `decayed_at`.
Every write is conditioned on the state it was computed from. `list_concerns`
returns the 20 most reinforced records in a bucket. The model sees how many
people reinforced a record, never their logins (`recordView`).

### Reinforcers and graduation threshold

A reinforcer is `actor#repo#pr`, lowercased (`reinforcerKey`), so each person
counts once per pull request.

- `create_concern` starts a record at count 1 with that reinforcer.
- `bump_concern` adds 1 and the reinforcer only when the reinforcer is not
  already in the set; a repeat returns `reinforced: false`. It resets
  `decay_score` to 1.0 and sets `updated_at`.
- `merge_concerns` gives the target the merged fields, the union of both
  reinforcer sets and a combined count in which a person who reinforced both
  records counts once, resets its decay, and deletes the source in the same
  transaction. The transaction fails if either record changed since it was
  read. A graduated record can only be the target.
- `delete_concern` refuses graduated records.

`GRADUATION_THRESHOLD` (default 4) is the count a record needs before it may
graduate. The curator accepts values from 2 to 100.

### Publishing skills to AWS Agent Registry

`submit_skill` (`agents/curator/src/tools/submit-skill.ts`) accepts only the
record this run bumped or merged into, and only when its stored count meets
the threshold. It accepts at most 40,000 characters of `skill_md`
(`GRADUATED_SKILL_MAX_CHARS`), half the reviewers' load budget, so every
published skill can be loaded. The record name is the record's existing
`graduated_record_name`. A first graduation uses a slug of the subject (at
most 60 characters), or, when another skill already holds that name, the
slug with a suffix derived from the record id; if both are taken the call
fails and asks for another subject. The tool claims the name on the record
with a conditional write, sets the frontmatter `name` to it
(`withRecordName`), then calls `upsertSkill`
(`agents/common/src/skills-registry.ts`), which updates the `SKILL` record
with that name or creates one. The markdown goes in
`descriptors.agentSkillsDefinition.additionalData.skillMd.data` and gets
minimal frontmatter if it has none; `upsertSkill` refuses markdown over the
registry's limit of 102,400 characters. The description notes the source
`record_id`. Finally `graduated_at` is set.

`list_skill_authoring` returns up to 10 skills from the curator's own registry
(sources in `agents/curator/skills/`, published with
`scripts/publish-curator-skills.mjs`). Without that registry the curator
follows the prompt's inline rules.

On the reviewer side, `loadGraduatedSkills`
(`agents/common/src/graduated-skills.ts`) runs after workspace preparation.
It skips records in status `CREATING`, `CREATE_FAILED`, `UPDATE_FAILED`,
`DEPRECATED` or `REJECTED`, takes the 30 most recently updated, and caps their
combined markdown at 80,000 characters (`GRADUATED_SKILLS_MAX_CHARS`). Newest
skills come first; a skill that does not fit is skipped and later ones are
still tried, and the number of skills left out is logged. All registry calls
share one 10 second deadline. Any failure means no graduated skills
for that run. `renderGraduatedSkills` appends them to the system prompt.
Concerns below the threshold never reach a reviewer. `scripts/registry-skills.mjs`
lists skills and deprecates one to retire it.

### Decay

`infra/lib/decay-cron-stack.ts` runs `ops/src/decay.ts` every 24 hours.
`decayTable` scans each concerns table and multiplies each score by
`0.5 ^ (elapsed / half-life)`, where elapsed time counts from the later of
`updated_at` and `decayed_at`. A record below the floor is deleted; any other
record gets its new `decay_score` and `decayed_at`. Writes are conditioned on
the timestamps the scan saw, so a record reinforced during the pass is
skipped. With the defaults (30 day half-life, 0.05 floor) an unreinforced
record is deleted after about 130 days. Graduated records decay the same
way, but decay never touches a registry: a published skill stays until it is
deprecated.

## 7. Where state lives

| Store | Holds | Written by | Read by |
| --- | --- | --- | --- |
| Idempotency table (DynamoDB, webhook stack) | Delivery keys (24 hour TTL) and daily budget counters `budget#<route>#<date>` (3 day TTL) | Receiver | Receiver |
| `valkey_reviewer_run_heartbeat` (DynamoDB, substrate stack) | One item per run key: `last_activity`, `status`, `model`, 24 hour TTL | Reviewer runtimes | Review workers |
| `valkey_review_concerns`, `valkey_glide_review_concerns` (DynamoDB, reviewer stacks) | Concern records. Customer-managed KMS key, point-in-time recovery, retained on stack deletion | Curator, decay job | Curator, decay job, `scripts/concerns-dump.sh` |
| Assets bucket (S3, substrate stack) | `<agent>/prompt.md` and `<agent>/skill.md` for each reviewer and `curator/`. KMS encrypted and versioned | CDK deploy | Each runtime reads its own prefix at container start |
| Reviewer skills registries (AWS Agent Registry, one per reviewer) | Graduated `SKILL` records | Curator (`submit_skill`) | That reviewer |
| Curator registry (AWS Agent Registry) | Skill-writing guidance | `scripts/publish-curator-skills.mjs` | Curator (`list_skill_authoring`) |
| GitHub App secret (Secrets Manager) | `app_id`, `private_key`, `webhook_secret`. Created by the operator and referenced by name, so a deploy never replaces it | Operator | Receiver, token broker |
| SQS queues | Envelopes in flight (14 days), and dead-lettered messages | Receiver, SQS redrive | Workers, operators |
| GitHub | Reviews, the review state comment (the carry-over between runs) and status comments | Reviewer runtimes, receiver (acknowledgements) | Reviewer runtimes, people |
| Container image | The repository clone each run fetches into. Warm containers keep gitignored build output between runs | Image build | Reviewer runtime |

The registries and the secret are created outside the CDK app; see
[Before the first deployment](../infra/README.md#before-the-first-deployment).
