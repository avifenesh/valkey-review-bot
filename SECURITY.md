## Reporting a Vulnerability

If you believe you've discovered a security vulnerability, please contact the Valkey team at security@lists.valkey.io.
Please *DO NOT* create an issue.
We follow a responsible disclosure procedure, so depending on the severity of the issue we may notify Valkey vendors about the issue before releasing it publicly.
If you would like to be added to our list of vendors, please reach out to the Valkey team at maintainers@lists.valkey.io.

## What a deployment holds

The reviewer checks out and builds code from the pull requests it reviews, so the
review runtime is treated as running untrusted code. The design keeps credentials
away from it:

- The GitHub App private key and webhook secret are stored in AWS Secrets
  Manager. Only the webhook receiver and the token brokers can read them. The
  receiver verifies deliveries and acts as the App for permission checks,
  acknowledgement comments and reading pull requests. It never runs code from a
  pull request.
- Each reviewer has its own token broker. A review runtime asks its broker for a
  short-lived installation token limited to one of that reviewer's routed
  repositories, with `pull_requests: write` and `metadata: read`. The broker asks
  GitHub, as the App, for the App's installation on that repository and refuses
  the request unless it is the installation the runtime named, owned by the
  repository's owner. The runtime cannot read the App key, and cannot get tokens
  for repositories that are not routed to that reviewer.
- Git authenticates each fetch with a per-process header. No token is written to
  the repository's `.git/config`.
- Build and test processes the reviewer starts get an environment with AWS,
  GitHub, token and secret variables removed, and start in the checked-out
  workspace. They are not otherwise sandboxed inside the container, so code from
  a pull request can use the runtime's own AWS role. That role is kept small:
  - its models;
  - `s3:GetObject` on its own prefix in the assets bucket (no bucket listing),
    and `kms:Decrypt` on the substrate key, which also encrypts the concerns
    tables (the role has no DynamoDB access to them);
  - read access to its own skills registry;
  - `GetItem`, `PutItem` and `UpdateItem` on any item of the shared run
    heartbeat table;
  - invoke on its own token broker;
  - log writes to its own runtime log groups
    (`/aws/bedrock-agentcore/runtimes/<runtime name>-*`);
  - image pulls from the CDK bootstrap container-assets repository. ECR cannot
    grant less than a whole repository, and that repository holds the images of
    every CDK app in the account and region that uses the same bootstrap
    qualifier.

  Deploy the reviewer into an AWS account used for nothing else, so that the
  repository holds only this app's images.
- The reviewer has no shell tool. It works through file tools and argument-list
  wrappers for `git`, the GitHub REST API (GET only, limited to the repository
  under review and its upstream), and the project's build tool.
- Feedback that can change the reviewer's instructions (curator skills) is only
  accepted from repository owners, members and collaborators.

If you find a way around any of these, please report it as described above.
