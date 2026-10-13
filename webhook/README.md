# webhook

The Lambda functions between GitHub and the AgentCore runtimes.

| Entry point | Role |
| --- | --- |
| `src/receiver.ts` | Behind the HTTP API. Verifies each GitHub App delivery and turns it into a queue message: a review on the route's queue, or maintainer feedback on the curator queue. |
| `src/invoker.ts` | One worker per queue. Forwards each message to its AgentCore runtime and, for reviews, uses SQS redelivery to watch over long runs. |
| `src/token-broker.ts` | Gives a reviewer runtime a short-lived installation token for the one repository it reviews. The checks are in `src/broker.ts`. |

`infra/lib/webhook-stack.ts` and `infra/lib/substrate-stack.ts` deploy them
and set the environment below.

## Receiver

What happens to a delivery:

- The `X-Hub-Signature-256` header is checked against the raw body with the
  `webhook_secret` from the GitHub App secret. On a mismatch the secret is
  fetched again, at most once a minute, so a rotated secret is picked up.
  Payload fields are logged only for verified deliveries.
- `pull_request` `opened`, `reopened` and `ready_for_review` start an
  automatic review on a review route, after the route gates (bot authors,
  `mentionOnly`, `skipDrafts`, `authorAllowlist`), an idempotency check on
  `repo#pr#head_sha` and the route's daily budget. New commits do not start
  a review.
- A comment that tags the bot (`@your-app-slug`) from a user with push
  access starts a review with the rest of the comment as its instruction,
  after a safety check by a Bedrock model. Tags inside quotes or code and
  bare acknowledgements such as "@your-app-slug thanks" do not count.
  A tag in a reply inside a review thread starts a review only on routes
  with `threadReplyReview`; in a thread the App started, that review checks
  the claimed fix against the App's comment. These reviews are not counted
  against the budget.
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
| `IDEMPOTENCY_TABLE` | required | DynamoDB table keyed by `key`, with TTL attribute `ttl`. Holds delivery keys and the daily review counters `budget#ROUTEID#YYYY-MM-DD` (UTC). |
| `GITHUB_SECRET_ARN` | required | Secrets Manager secret with `webhook_secret`, `private_key` and `app_id`. |
| `BOT_LOGIN` | required | The App's bot login, for example `your-app-slug[bot]`. |
| `HAIKU_MODEL_ID` | required | Bedrock model for the safety check on @mention instructions. The call times out after 5 seconds; any failure declines the request. |
| `DAILY_REVIEW_BUDGET` | `40` | Automatic reviews per route per UTC day. `0` pauses automatic reviews. |
| `INSTALLATION_ID` | none | Used only when a delivery carries no `installation.id`. Without either the delivery is rejected. |
| `KNOWN_BOT_LOGINS` | built-in list | Comma-separated logins never treated as maintainers. A non-empty value replaces the built-in list: `coderabbitai`, `coderabbitai[bot]`, `copilot`, `copilot[bot]`, `github-actions[bot]`, `dependabot[bot]`, `codecov[bot]`, `sonarcloud[bot]`, `deepsource-io-bot`, `sourcery-ai[bot]`. Users of type `Bot`, logins ending in `[bot]` and `BOT_LOGIN` always count as bots. |

## Invoker

On the first receive of a review message the invoker runs the review. A
review can outlive the worker's 15-minute limit, so on each later receive
it reads the run's heartbeat record and either deletes the message (the
run completed), leaves it for the next visibility timeout (the run is
alive), or runs it again on the fallback model (the run is dead). After the
run budget it deletes the message and logs an error. Curator messages run
on every receive and are deleted without running after more than three.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RUNTIME_ARN` | required | The AgentCore runtime to invoke. |
| `HEARTBEAT_TABLE` | required for review queues | The table the reviewer runtime writes its heartbeat to. A review worker without it refuses every message. |
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

## Development

```sh
npm ci
npm run typecheck
npm test
```

The tests run the TypeScript sources directly with Node 24 or newer.
