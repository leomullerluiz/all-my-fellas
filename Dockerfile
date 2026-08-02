# Single image running either the web server or the worker, selected by the
# compose service's `command`. Both need the same code, prompts and native
# modules, so one build stage serves both.

FROM node:22-bookworm-slim AS base
WORKDIR /app
# git and gh are runtime dependencies of the worker: it clones task workspaces
# and opens pull requests itself, so agents never touch credentials.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
     -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
     > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
# better-sqlite3 is compiled here, against this image's Node ABI.
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/prompts ./prompts
COPY package.json next.config.ts ./
RUN mkdir -p /app/data /app/workspaces
EXPOSE 3000
CMD ["node_modules/.bin/next", "start"]
