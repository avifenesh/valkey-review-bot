# Curator agent container: the concerns-store tools and skill graduation
# into AWS Agent Registry. Unlike the reviewers it needs no repository
# checkout, language toolchains or language servers. The base image is
# pinned by digest.

FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS build

ENV NODE_ENV=development

WORKDIR /app/agents/curator

# Type-checking common's sources resolves their imports from
# agents/common/node_modules. At run time the compiled copy of common
# lives under the curator's dist/ and resolves from the curator's
# node_modules, which is why the curator declares the dependencies of
# the common modules it imports. Both then load one copy of the SDK.
COPY agents/common/package.json agents/common/package-lock.json* /app/agents/common/
RUN cd /app/agents/common && npm ci --no-audit --no-fund

COPY agents/curator/package.json agents/curator/package-lock.json* /app/agents/curator/
RUN npm ci --no-audit --no-fund

COPY agents/common/src/ /app/agents/common/src/
COPY agents/curator/tsconfig.json /app/agents/curator/
COPY agents/curator/src/ /app/agents/curator/src/
RUN npx tsc --noEmit && npx tsc -p tsconfig.json

RUN npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:26-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS runtime

ENV NODE_ENV=production

WORKDIR /app/agents/curator

COPY --from=build --chown=node:node /app/agents/curator/package.json /app/agents/curator/package.json
COPY --from=build --chown=node:node /app/agents/curator/node_modules /app/agents/curator/node_modules
COPY --from=build --chown=node:node /app/agents/curator/dist /app/agents/curator/dist

USER node

CMD ["node", "--enable-source-maps", "/app/agents/curator/dist/curator/src/agent.js"]
