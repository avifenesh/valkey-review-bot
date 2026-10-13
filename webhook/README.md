# webhook

The Lambda functions between GitHub and the AgentCore runtimes.

| Entry point | Role |
| --- | --- |
| `src/receiver.ts` | Behind the HTTP API. Verifies each GitHub App delivery and turns it into a queue message: a review on the route's queue, or maintainer feedback on the curator queue. |
| `src/invoker.ts` | One worker per queue. Forwards each message to its AgentCore runtime and, for reviews, uses SQS redelivery to watch over long runs. |
| `src/token-broker.ts` | Gives a reviewer runtime a short-lived installation token for the one repository it reviews. The checks are in `src/broker.ts`. |
| `src/skills-repo-broker.ts` | Gives the curator a short-lived token for the bot's own repository, to open pull requests that propose edits to the reviewers' skill files. Deployed only when `skillsRepo` is configured. |

`infra/lib/webhook-stack.ts` and `infra/lib/substrate-stack.ts` deploy them
and set the environment below.

## Receiver

What happens to a delivery:

- The `X-Hub-Signature-256` header is checked against the raw body with the
  `webhook_secret` from the GitHub App secret. On a mismatch the secret is
  fetched again, at most once a minute, so a rotated secret is picked up.
  Payload fields are logged only for verified deliveries.
- `pull_request` `opened`, `reopened` and `synchronize` (new commits) start
  an automatic review on a review route. On `skipDrafts` routes a draft is
  skipped, pushes to it included, and reviewed on `ready_for_review` instead;
  other routes ignore `ready_for_review`. In order:
  1. the route gates: bot authors, `mentionOnly`, `skipDrafts` and the draft
     state, `authorAllowlist`;
  2. the idempotency key `repo#pr#head_sha`, with `#reopened`, `#ready` or
     `#push` appended for a reopen, `ready_for_review` and new commits;
  3. the pull request's pending marker, `pending#owner/name#pr`. Every
     automatic review holds it from here until the worker starts the run.
     While it is held, a push, reopen or `ready_for_review` joins the waiting
     review (`skipped:auto-review-pending`) and uses no round or budget: the
     run reviews the head the pull request has when it starts. The marker
     expires an hour after the review's queue delay, or after the worker's
     latest extension;
  4. the pull request's round counter, `autoreviews#owner/name#pr`: at most
     `MAX_AUTOMATIC_REVIEWS_PER_PR` automatic reviews, counting the first
     (`skipped:auto-review-cap` after that). It expires 180 days after the
     pull request's latest automatic review;
  5. the route's daily budget.

  The review is then sent to the route's queue, a review of new commits with
  an SQS delay of `PUSH_REVIEW_DELAY_SECONDS`, and logs
  `[auto-review] route=<id> repo=<repo> pr=<n> round=<n>/<cap> queued`, plus
  `delay=<s>s` for new commits. A review that is not sent (cap, budget, a
  failed send) gives back what it took: its key, marker and round. The
  marker and counter keys use the lowercased repository name, as the route
  lookup does. The envelope carries `trigger` (`opened`, `reopened`,
  `ready_for_review` or `push`) and `skip_drafts`, and the runtime posts
  nothing when by then the pull request is closed, merged, or a draft on a
  `skipDrafts` route.
- `closed`, and `converted_to_draft` on a `skipDrafts` route, never start a
  review. While a review waits, they release the key of a reopen, or a
  `ready_for_review`, at that head, so that event is reviewed if the waiting
  review is skipped. A reopen has its own key, so closing and reopening a
  pull request at a head that was already reviewed reviews it again and uses
  a round; only the first reopen at a head does.
- A comment that tags the bot (`@your-app-slug`) from a user with push
  access starts a review with the rest of the comment as its instruction,
  after a safety check by a Bedrock model. Tags inside quotes or code and
  bare acknowledgements such as "@your-app-slug thanks" do not count.
  A tag in a reply inside a review thread starts a review only on routes
  with `threadReplyReview`. In a thread the App started, the instruction
  quotes the App's comment (shortened with a `[comment truncated]` line when
  needed, so the reply and the directive fit in 6,000 characters) and asks
  the run to answer the reply from the code at the current head: verify a
  claimed fix, re-check a disputed finding and withdraw it if the reply is
  right, or answer a question. In any other thread the reply is an ordinary
  summons. These reviews are not counted against the budget or the rounds.
- Other comments and submitted reviews go to the curator when they are new
  (`created` or `submitted`), on a pull request, by an `OWNER`, `MEMBER` or
  `COLLABORATOR` who is not a bot, and not filtered as noise by
  `src/heuristics.ts`.

GitHub does not retry a failed delivery. When the receiver answers 500 it
has released the delivery's idempotency key, so the delivery can be
redelivered from the App's advanced settings.

| Variable | Default | Meaning |
| --- | --- | --- |
| `REVIEW_ROUTE_MAP_JSON` | required | Review routes keyed by repository full name: `{ routeId, queueUrl, reviewerId, authorAllowlist?, mentionOnly?, skipDrafts?, threadReplyReview? }`. |
| `CURATOR_ROUTE_MAP_JSON` | `{}` | Repositories whose feedback reaches the curator, keyed by full name: `{ reviewerId }`. |
| `CURATOR_QUEUE_URL` | empty | Curator queue. Empty means feedback is not forwarded. |
| `IDEMPOTENCY_TABLE` | required | DynamoDB table keyed by `key`, with TTL attribute `ttl`. Holds delivery keys (24 hours), the daily review counters `budget#ROUTEID#YYYY-MM-DD` (UTC, 3 days), the round counters `autoreviews#owner/name#pr` (180 days from the latest automatic review) and the pending markers `pending#owner/name#pr` (an hour after the queue delay). |
| `GITHUB_SECRET_ARN` | required | Secrets Manager secret with `webhook_secret`, `private_key` and `app_id`. |
| `BOT_LOGIN` | required | The App's bot login, for example `your-app-slug[bot]`. |
| `HAIKU_MODEL_ID` | required | Bedrock model for the safety check on @mention instructions. The call times out after 5 seconds; any failure declines the request. |
| `DAILY_REVIEW_BUDGET` | `40` | Automatic reviews per route per UTC day, reviews of new commits included. `0` pauses automatic reviews. |
| `MAX_AUTOMATIC_REVIEWS_PER_PR` | `3` | Automatic reviews one pull request can get, counting the first, from 1 to 20. @mentions and thread replies are not counted. |
| `PUSH_REVIEW_DELAY_SECONDS` | `300` | SQS delay of a review of new commits, from 0 to 900. Pushes during the delay join that review. |
| `INSTALLATION_ID` | none | Used only when a delivery carries no `installation.id`. Without either the delivery is rejected. |
| `KNOWN_BOT_LOGINS` | built-in list | Comma-separated logins never treated as maintainers. A non-empty value replaces the built-in list: `coderabbitai`, `coderabbitai[bot]`, `copilot`, `copilot[bot]`, `github-actions[bot]`, `dependabot[bot]`, `codecov[bot]`, `sonarcloud[bot]`, `deepsource-io-bot`, `sourcery-ai[bot]`. Users of type `Bot`, logins ending in `[bot]` and `BOT_LOGIN` always count as bots. |

## Invoker

On the first receive of a review message the invoker runs the review. A
review can outlive the worker's 15-minute limit, so on each later receive
it reads the run's heartbeat record and either deletes the message (the
run completed), leaves it for the next visibility timeout (the run is
alive), or runs it again on the fallback model (the run is dead). After the
run budget it deletes the message and logs an `[abandoned]` error, unless
the run completed.

Automatic reviews take two more steps:

- A message that still holds its pull request's pending marker has never
  run, so any receive of it is a first attempt, on the primary model.
- It waits while another review of the same pull request runs: before it
  starts, the worker reads the heartbeat records of the pull request's runs
  (a scan for keys that start with `owner/name#pr#`). While one is running
  and fresh, the message goes back to the queue and the worker moves the
  marker's expiry to an hour from then, so later events keep joining it
  (`[watchdog] ... waits for <run key>`). A review still waiting when the
  run budget is used up is dropped with an `[abandoned]` error and lets go
  of its marker. @mention runs, thread replies included, have no marker and
  never wait.

Just before it invokes a review, the worker writes the run's start record
in the heartbeat table (status `running`, the SQS message id) under the run
key, then deletes the pending marker (`[pending] ... marker=<id> cleared`).
The start record makes the run visible to other reviews at once, and the
write is conditioned so that only one receive of a message starts the run;
a second one is left on the queue (`[start] ... is already running or done;
not run twice`). The push delay and any wait count against
`RUN_BUDGET_MINUTES`, which starts at the message's `SentTimestamp`.

`infra/lib/webhook-stack.ts` gives each review worker `IDEMPOTENCY_TABLE`
and `GetItem`, `UpdateItem` and `DeleteItem` on its `pending#` keys. Without
the variable or `GetItem`, the worker runs automatic reviews and leaves their
markers to expire, about an hour after the delay; until then automatic
reviews of that pull request are skipped. Without `DeleteItem` it never runs
an automatic review: the delete fails and the message dead-letters. Without
`UpdateItem` a waiting review's marker can expire while it waits. Without
`UpdateItem` on the heartbeat table the worker runs reviews without a start
record.

Curator messages are feedback envelopes from the receiver (`feedback_id`)
and skill maintenance messages from the decay job (`maintenance_id`, with
`reason` `check`, `retire` or `repo_check`, and `dry_run`). They have no
heartbeat: they run on every receive and are deleted without running after
more than three. The worker's log lines name a maintenance message as
`curator maintenance=<id> reviewer=<id> reason=<reason> dry_run=<bool>`,
and the curator's `done` frame for it carries its `decision`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUNTIME_ARN` | required | The AgentCore runtime to invoke. |
| `HEARTBEAT_TABLE` | required for review queues | The table the reviewer runtime writes its heartbeat to. The review worker reads it (`GetItem`, and a `Scan` for a pull request's runs) and writes each run's start record (`UpdateItem`). A review worker without it refuses every message. |
| `IDEMPOTENCY_TABLE` | empty | Review workers: the receiver's table, where the worker reads, extends and deletes the pending marker of an automatic review. Its grant covers `pending#` keys only. Not set on the curator worker. |
| `RUN_BUDGET_MINUTES` | `90` | Wall-clock budget for one review across all attempts. Keep it below the visibility timeout times one less than the queue's `maxReceiveCount`, or the queue dead-letters a healthy long review first. |
| `HEARTBEAT_STALE_MINUTES` | `12` | A running review whose last heartbeat is older than this is treated as dead. It must exceed the longest quiet stretch of a live run, such as a long build. |

## Token broker

A request is `{ installation_id, repo }`. The broker refuses it unless
`repo` is in `ALLOWED_REPOS_JSON` and GitHub, asked as the App
(`GET /repos/{owner}/{name}/installation`), reports `installation_id` as
the App's installation on that repository, owned by `owner`. It then
returns a token for that one repository with `pull_requests: write` and
`metadata: read`. The checks are in `src/broker.ts`; `src/token-broker.ts`
wires them to the App key.

| Variable | Meaning |
| --- | --- |
| `GITHUB_SECRET_ARN` | Secrets Manager secret with `private_key`. |
| `GITHUB_APP_ID` | The App ID. |
| `ALLOWED_REPOS_JSON` | JSON array of the repositories a token may be issued for. |

## Skills-repo token broker

The curator's release check proposes edits to the reviewers' skill files
(`agents/<reviewer>/config/skill.md`) by pull request against the bot's own
repository. It holds no GitHub credential: it invokes this function, which
only the curator role may invoke. A request is `{ purpose? }`; the purpose
is only logged. The repository comes from `SKILLS_REPO`, never from the
request. The broker asks GitHub, as the App, for the App's installation on
that repository and refuses when there is none or when its account is not
the repository's owner. It then returns `{ token, expires_at }`: an
installation token for that one repository with `contents: write`,
`pull_requests: write` and `metadata: read`. Any refusal returns
`{ error }`. The token is never logged.

| Variable | Meaning |
| --- | --- |
| `SKILLS_REPO` | The bot's repository, `owner/name` (`skillsRepo.repo`). |
| `SKILLS_REPO_APP_SECRET_NAME` | Secrets Manager secret of the App that opens the pull requests, with `app_id` and `private_key`, the same JSON shape as the main App secret (`skillsRepo.appSecretName`, by default `github.appSecretName`). |

## Development

```sh
npm ci
npm run typecheck
npm test
```

The tests run the TypeScript sources directly with Node 24 or newer.
