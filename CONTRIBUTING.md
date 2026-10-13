# Contributing

Thanks for helping improve the Valkey reviewer. This document covers how to report
problems, how to propose changes, and how to build and test the code.

## Questions and bugs

- Open an issue for bugs, unexpected review behavior, or feature ideas. For a
  review that went wrong, include a link to the pull request and the bot's comment.
- Report security issues privately, as described in [SECURITY.md](SECURITY.md).
  Please do not open a public issue for them.

## Developer Certificate of Origin

We respect the intellectual property rights of others and we want to make sure
all incoming contributions are correctly attributed and licensed. A Developer
Certificate of Origin (DCO) is a lightweight mechanism to do that. The DCO is
a declaration attached to every commit. In the commit message of the contribution,
the developer simply adds a `Signed-off-by` statement and thereby agrees to the DCO,
which you can find below or at [DeveloperCertificate.org](http://developercertificate.org/).

```text
Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the
    best of my knowledge, is covered under an appropriate open
    source license and I have the right under that license to
    submit that work with modifications, whether created in whole
    or in part by me, under the same open source license (unless
    I am permitted to submit under a different license), as
    Indicated in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including
    all personal information I submit with it, including my
    sign-off) is maintained indefinitely and may be redistributed
    consistent with this project or the open source license(s)
    involved.
```

We require that every contribution to this project be signed with a DCO. We require the
usage of known identity (such as a real or preferred name). We do not accept anonymous
contributors nor those utilizing pseudonyms. A DCO signed commit will contain a line like:


```text
Signed-off-by: Jane Smith <jane.smith@email.com>
```

You may type this line on your own when writing your commit messages. However, if your
user.name and user.email are set in your git configs, you can use `git commit` with `-s`
or `--signoff` to add the `Signed-off-by` line to the end of the commit message. We also
require revert commits to include a DCO.

If you're contributing code to this project in any other form, including
sending a code fragment or patch via private email or public discussion groups,
you need to ensure that the contribution is in accordance with the DCO.

## Use of AI tools

You own the quality of the code that you submit to the project. The project
doesn't impose any limitations on the use of AI tooling as long as the
contribution meets the quality bar of the project.

## How to propose a change

1. For a large change (a new review behavior, a new tool for the agent, or a change
   to how feedback becomes skills), open an issue first and describe what you want
   to change and why. That saves you from writing code that does not fit.
2. Fork the repository and create a topic branch.
3. Make the change, add or update tests, and run the checks below.
4. Open a pull request that explains the problem and how the change solves it.

Prompt and skill changes (`agents/*/config/*.md`) change what the reviewer says on
real pull requests. Describe the behavior you expect to change, and, if you can,
link a review that shows the problem.

## Building and testing

The repository has one npm package per component. Node.js 24 or later is required.

```sh
for pkg in agents/common agents/curator agents/valkey-review agents/valkey-glide-review webhook ops infra; do
  (cd "$pkg" && npm ci && npm run --if-present typecheck && npm run --if-present test)
done
```

To check that the CDK app still synthesizes, using placeholder values only:

```sh
cd infra && npx cdk synth --quiet -c config=deploy.config.example.json
```

CI runs the same commands, plus [agnix](https://github.com/agent-sh/agnix) on the
agent configuration files and a [scrump](https://github.com/avifenesh/scrump) secret
scan of every tracked file.

Never commit real deployment values (account IDs, App IDs, registry IDs, secrets).
They belong in `infra/deploy.config.json`, which is ignored by git.
