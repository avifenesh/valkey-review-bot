# Container image for the valkey-review-bot-review agent.
#
# valkey-review-bot is TypeScript on Node.js: agents, Lambda functions and
# a CDK app, one npm package per component. The image carries Node.js,
# git and gh, a clone of valkey-io/valkey-review-bot with every package's
# dependencies installed, and the compiled agent.
#
# Stages:
#   base     Debian bookworm with Node.js.
#   build    Compiles the agent's TypeScript (agents/common and
#            agents/valkey-review-bot-review) and drops dev dependencies.
#   runtime  base plus git, gh, the clone with its dependencies, and the
#            build output.
#
# Build with the repository root as the context: the agent imports
# agents/common.
#
# Pinned: the base image by digest, and the clone's dependencies by each
# package's package-lock.json. Not pinned: Node.js comes from the
# NodeSource apt repository for NODE_MAJOR, and gh and the Debian
# packages from their apt repositories at build time.

ARG NODE_MAJOR=26

FROM public.ecr.aws/docker/library/debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS base
ARG NODE_MAJOR
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/* \
 && node --version | grep -q "^v${NODE_MAJOR}\."

FROM base AS build

# Type-checking common's sources resolves their imports from
# agents/common/node_modules. At run time the compiled copy of common
# lives under the agent's dist/ and resolves from the agent's
# node_modules, which is why the agent declares common's dependencies.
WORKDIR /app/agents/common
COPY agents/common/package.json agents/common/package-lock.json ./
RUN npm ci

WORKDIR /app/agents/valkey-review-bot-review
COPY agents/valkey-review-bot-review/package.json agents/valkey-review-bot-review/package-lock.json ./
RUN npm ci

COPY agents/common/src/ /app/agents/common/src/
COPY agents/valkey-review-bot-review/tsconfig.json ./
COPY agents/valkey-review-bot-review/src/ ./src/
# Dev dependencies are dropped by a production npm ci, not npm prune:
# prune resolves the tree again and stops on ERESOLVE, because
# @strands-agents/sdk declares an optional peer of openai 6 and the agent
# uses openai 7. npm ci installs the lockfile as it is.
RUN npx tsc -p tsconfig.json \
 && npm ci --omit=dev

FROM base AS runtime

# git and jq serve the scripts package's tests, bash comes with Debian.
RUN mkdir -p -m 0755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
      https://cli.github.com/packages/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      git gh \
      ripgrep jq \
 && rm -rf /var/lib/apt/lists/*

# The agent runs as an unprivileged user that owns the clone, so git
# needs no safe.directory exception. The agent's code goes in a
# root-owned directory: the agent user can read it but not change it.
RUN useradd --create-home --uid 1000 agent \
 && install -d -o agent -g agent /workspace \
 && install -d /app/agents/valkey-review-bot-review
USER agent

# Each run fetches the pull request into this clone instead of cloning
# from scratch. blob:limit=1m keeps every tree and every blob up to 1 MB,
# so blame and log -S run locally.
RUN git clone --filter=blob:limit=1m https://github.com/valkey-io/valkey-review-bot.git /workspace/valkey-review-bot

# The build tool installs nothing at review time, so every package with a
# lockfile is installed here, as CI installs it: npm ci in each, dev
# dependencies included. node_modules/ is gitignored, so it survives the
# `git clean -fd` and checkout of each run. A pull request is therefore
# type-checked and tested against main's dependencies as of this build,
# not against its own package-lock.json.
RUN cd /workspace/valkey-review-bot \
 && git ls-files -z -- '*package-lock.json' \
      | xargs -0 -n1 dirname \
      | while read -r pkg; do \
          echo "npm ci in ${pkg}"; \
          (cd "${pkg}" && npm ci --no-audit --no-fund) || exit 1; \
        done \
 && npm cache clean --force

WORKDIR /app/agents/valkey-review-bot-review
COPY --from=build /app/agents/valkey-review-bot-review/package.json ./
COPY --from=build /app/agents/valkey-review-bot-review/node_modules/ ./node_modules/
COPY --from=build /app/agents/valkey-review-bot-review/dist/ ./dist/

# NODE_ENV stays unset. Under NODE_ENV=production, npm ci would have
# skipped the dev dependencies (typescript, jest, aws-cdk) that the
# packages' typecheck, test and synth need.
ENV WORKSPACE_ROOT=/workspace/valkey-review-bot

CMD ["node", "--enable-source-maps", "/app/agents/valkey-review-bot-review/dist/valkey-review-bot-review/src/agent.js"]
