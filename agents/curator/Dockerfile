# Curator agent container: the concerns-store tools and skill graduation
# into AWS Agent Registry. Unlike the reviewers it needs no repository
# checkout, language toolchains or language servers.

FROM --platform=$BUILDPLATFORM public.ecr.aws/docker/library/node:26-bookworm-slim AS build

ENV NODE_ENV=development

WORKDIR /app/agents/curator

COPY agents/common/package.json agents/common/package-lock.json* /app/agents/common/
RUN cd /app/agents/common && npm ci --no-audit --no-fund

COPY agents/curator/package.json agents/curator/package-lock.json* /app/agents/curator/
RUN npm ci --no-audit --no-fund

COPY agents/common/tsconfig.json /app/agents/common/
COPY agents/common/src/ /app/agents/common/src/
RUN cd /app/agents/common && npx tsc -p tsconfig.json

COPY agents/curator/tsconfig.json /app/agents/curator/
COPY agents/curator/src/ /app/agents/curator/src/
RUN npx tsc --noEmit && npx tsc -p tsconfig.json

RUN cd /app/agents/common && npm prune --omit=dev
RUN npm prune --omit=dev

FROM public.ecr.aws/docker/library/node:26-bookworm-slim AS runtime

ENV NODE_ENV=production

WORKDIR /app/agents/curator

COPY --from=build --chown=node:node /app/agents/common/package.json /app/agents/common/package.json
COPY --from=build --chown=node:node /app/agents/common/node_modules /app/agents/common/node_modules
COPY --from=build --chown=node:node /app/agents/common/dist /app/agents/common/dist
COPY --from=build --chown=node:node /app/agents/curator/package.json /app/agents/curator/package.json
COPY --from=build --chown=node:node /app/agents/curator/node_modules /app/agents/curator/node_modules
COPY --from=build --chown=node:node /app/agents/curator/dist /app/agents/curator/dist

# Shared compiled modules must resolve the common package's provider dependencies.
RUN mkdir -p /app/agents/curator/dist/common \
 && ln -s /app/agents/common/node_modules /app/agents/curator/dist/common/node_modules

USER node

CMD ["node", "--enable-source-maps", "/app/agents/curator/dist/curator/src/agent.js"]
