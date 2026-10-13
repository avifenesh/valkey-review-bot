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

- **Automatic reviews** run when a pull request is opened or reopened and when new
  commits are pushed to it, within a daily budget per repository. A pull request gets at
  most 3 automatic reviews, counting the first (the deployment can set 1 to 20).
  - A review of new commits starts 5 minutes after the push. Pushes in those 5 minutes
    join it, so a burst of pushes gets one review, of the newest head.
  - A push while a review runs queues the next review, which waits for the running one
    to end.
  - On repositories set to skip drafts, a draft is reviewed when it is marked ready for
    review instead, and pushes to a draft start nothing.
- **Ask for a review** by mentioning the bot in a pull request comment, for example
  `@valkey-review-bot please check the replica path`. Any user with write access can do
  this. The instruction becomes the main focus of that review. These reviews, and the
  thread replies below, do not count toward the limit of automatic reviews.
- **Reply in a review thread**, on repositories where it is enabled (`threadReplyReview`,
  which the example configuration turns on for both Valkey and GLIDE). Reply to one of
  the bot's review comments, mention the bot, and do one of these:
  - say the concern is fixed, for example "fixed in the last push". The bot checks the
    fix at the current head and confirms it, or says exactly what remains.
  - dispute the finding. The bot checks its claim against the code again. It withdraws
    the finding if the reply is right, and shows its evidence if not.
  - ask a question about the finding. The bot answers from the code.

  The bot never takes a reply on trust and never acts as the author. It answers in its
  status comment on the pull request, not inside the thread.

## How it learns

Comments, review-thread replies and submitted reviews that repository owners, members and
collaborators post on pull requests in the repositories the bot serves (and any
curator-only repositories) are feedback for a curator agent, whether or not they
answer the bot. Summons, acknowledgements, very short comments and other noise are left
out. For a reply in a thread the bot started, the curator also gets the bot's comment.
The curator records each piece of feedback as a concern. Each maintainer counts once per
pull request, and when the same point has been made enough times the concern graduates
into a skill that every later review loads. Feedback from other accounts is not used.

Standing decays without reinforcement. A concern that never graduates loses half its
standing every 30 days and is deleted after about 130 days. A graduated skill decays on
its own, slower half-life, 180 days by default, and every reinforcement resets it. A
skill nobody reinforces for about 26 months (180 x log2(20) days) is retired: reviewers
stop loading it, and its concern record stays as a tombstone. A later reinforcement
brings it back under a new name.

Skills are also checked against the code. After each GA release of the upstream
project, and at least every 90 days, the file paths, symbols and config names a skill
cites are looked up on the upstream default branch. A skill whose names are all there,
and whose names the code changes since the last check did not touch, is confirmed
without a model. Otherwise a read-only audit reads the upstream code to find out what
happened, and the check then does one of these:

- **Confirms** the skill.
- **Revises** it, without overwriting any fact. The stale lines stay, marked as
  superseded in that release, with the upstream line that proves the change, and the
  corrected lines follow. The edit can only swap a code name or number for one that
  appears on the cited line. Reviewers keep using the superseded text for backports to
  older release lines.
- **Retires** it, when deterministic evidence shows its subject is gone from the code.

The built-in skill files in this repository (`agents/*/config/skill.md`) get the same
check once per release, but are changed only by pull request: the check opens one
against this repository for maintainers to review. Revisions, retirements and pull
requests are each off until the operator turns them on. Until then the checks record
and log what they find, but change no skill text, retire nothing and open no pull
request.

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
                     ^                                     -> skills (AWS Agent Registry)
                     |                                     -> upstream code (read-only checks)
              decay job (daily)
```

- `agents/common`: shared runtime for the reviewers: workspace preparation, the agent
  loop, tools, the review state comment, skill loading.
- `agents/valkey-review`, `agents/valkey-glide-review`: one reviewer per project, each
  with its container image, prompt (`config/prompt.md`) and project knowledge
  (`config/skill.md`).
- `agents/curator`: turns maintainer feedback into concerns and graduated skills, and
  runs the release checks and retirements of those skills.
- `webhook`: the receiver, the per-route invoker and the token brokers.
- `ops`: the daily job that decays concerns and schedules skill checks and retirements.
- `infra`: the AWS CDK app that deploys all of it.
- `scripts`: operator tools, for example publishing curator reference skills, queuing a
  skill check, or checking a skill file against upstream code.

See [docs/architecture.md](docs/architecture.md) for the request flow in detail, and
[SECURITY.md](SECURITY.md) for how credentials are kept away from the code under review.

## Deploying your own

The reviewer runs on AWS: Amazon Bedrock models, Bedrock AgentCore runtimes, AWS Agent
Registry, Lambda, SQS and DynamoDB. [infra/README.md](infra/README.md) lists the
prerequisites (Node.js 24+, Docker that can build linux/arm64 images, the AWS CLI, a
GitHub App, a Secrets Manager secret, three registries, model access), every configuration
key, and the deploy
commands. All deployment-specific values live in `infra/deploy.config.json`, which is not
committed. Use an AWS account that runs nothing else: code from the pull requests under
review can use the reviewer runtime's AWS role, as [SECURITY.md](SECURITY.md) describes.
Skill checks start in report mode. [infra/README.md](infra/README.md#skill-lifecycle-operations)
describes how to review their reports, how to turn on edits, retirements and pull
requests, and the optional second GitHub App those pull requests need.

## Landing a new project

The reviewer can serve another project, for example valkey-search. A fork or mirror of
a project it already reviews needs only a route in the deployment configuration and the
GitHub App installed on it. A new project needs a reviewer of its own: an agent package
with its container image, prompt and skill file, its reviewer id added in five places in
`infra/lib`, a skills registry, and the GitHub App installed on the repository. Its
concerns table, token broker, decay, release checks and retirement then follow from the
id with no more code. [docs/landing-a-new-project.md](docs/landing-a-new-project.md)
walks through every step, with valkey-search as the worked example.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Every commit needs a DCO sign-off
(`git commit -s`). Please report security issues privately as described in
[SECURITY.md](SECURITY.md).

## License

BSD 3-Clause. See [LICENSE](LICENSE).
