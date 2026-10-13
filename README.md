# Valkey reviewer

An automated code reviewer for pull requests to [Valkey](https://github.com/valkey-io/valkey)
and [Valkey GLIDE](https://github.com/valkey-io/valkey-glide). It reads the change in a
real checkout of the repository, checks its claims against the code (and, when it helps,
by building and running tests), and posts a review with inline comments.

The reviewer runs as a GitHub App. On the Valkey repositories it appears as
`valkey-review-bot`.

## What a review contains

- **Inline comments** for problems it can back with evidence: a source line, a build or
  test result, a contract the change breaks. It stays quiet on a clean change rather
  than inventing comments.
- **A review state comment**, one per pull request, rewritten on every review:
  - whether the change is ready for a human reviewer, or what still blocks it;
  - the risk of merging it, and why;
  - open and resolved findings, carried over between reviews;
  - whether the fix needs a backport, and to which maintained release lines;
  - a different approach, only when the reviewer checked one against the code and found
    it clearly better.
- The reviewer never approves or requests changes. Those decisions stay with maintainers.

## How to use it

- **Automatic reviews** run when a pull request is opened, reopened, or marked ready for
  review, within a daily budget per repository.
- **Ask for a review** by mentioning the bot in a pull request comment, for example
  `@valkey-review-bot please check the replica path`. Any user with write access can do
  this. The instruction becomes the main focus of that review.
- **Ask for a re-check**, on repositories where it is enabled (GLIDE today), by replying
  to one of the bot's review comments and mentioning the bot, for example "fixed in the
  last push". The bot verifies the fix against the current head instead of taking the
  reply on trust.

## How it learns

Replies from repository owners, members and collaborators to the bot's comments are
feedback. A curator agent records each piece of feedback as a concern. Each maintainer
counts once per pull request, and when the same point has been made enough times the
concern graduates into a skill that every later review loads. Feedback from other
accounts is not used.

## Architecture

```text
GitHub App webhook
      |
      v
API Gateway -> receiver Lambda ---- verify signature, filter, budget, dedupe
                     |
                     v
              SQS queue per route -> invoker Lambda -> AgentCore runtime (reviewer)
                     |                                    |  checkout, file and git tools,
                     |                                    |  build and test, post review
                     |                                    v
                     |                              token broker (repo-scoped GitHub token)
                     v
              curator queue -> AgentCore runtime (curator) -> concerns (DynamoDB)
                                                           -> skills (AWS Agent Registry)
```

- `agents/common`: shared runtime for the reviewers: workspace preparation, the agent
  loop, tools, the review state comment, skill loading.
- `agents/valkey-review`, `agents/valkey-glide-review`: one reviewer per project, each
  with its container image, prompt (`config/prompt.md`) and project knowledge
  (`config/skill.md`).
- `agents/curator`: turns maintainer feedback into concerns and graduated skills.
- `webhook`: the receiver, the per-route invoker and the token broker.
- `ops`: the daily job that decays old concerns.
- `infra`: the AWS CDK app that deploys all of it.
- `scripts`: operator tools, for example publishing curator reference skills.

See [docs/architecture.md](docs/architecture.md) for the request flow in detail, and
[SECURITY.md](SECURITY.md) for how credentials are kept away from the code under review.

## Deploying your own

The reviewer runs on AWS: Amazon Bedrock models, Bedrock AgentCore runtimes, AWS Agent
Registry, Lambda, SQS and DynamoDB. [infra/README.md](infra/README.md) lists the
prerequisites (Docker that can build linux/arm64 images, a GitHub App, a Secrets Manager
secret, three registries, model access), every configuration key, and the deploy
commands. All deployment-specific values live in `infra/deploy.config.json`, which is not
committed. Use an AWS account that runs nothing else: code from the pull requests under
review can use the reviewer runtime's AWS role, as [SECURITY.md](SECURITY.md) describes.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Every commit needs a DCO sign-off
(`git commit -s`). Please report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

BSD 3-Clause. See [LICENSE](LICENSE).
