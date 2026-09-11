# The API and worker image.
#
# One image, two entrypoints: `dist/api.js` serves HTTP, `dist/worker.js` owns the schedule, and
# `dist/index.js` is both for a single-instance deployment. They are the same build of the same code,
# so the worker can never be a release behind the API.
#
# TypeScript is compiled here and never shipped. The runtime stage has no compiler, no test runner and
# no `tsx`: it runs `node dist/…js` against a production dependency tree installed from the committed
# lockfile. What reaches the image is the generated JavaScript, its source maps, and the migrations for
# the release — nothing that could rebuild it, and nothing that was not in the repository.
#
# Nothing about a deployment is baked in. `.dockerignore` keeps `.env` and the retained forecast data
# out of the build context entirely, because a file copied into any layer stays in the image even if a
# later layer removes it. Configuration arrives as environment variables; the forecast feed arrives as
# a mounted volume the worker wrote. See docs/deployment.md.

# A tag here so a rebuild picks up the base image's security updates. Pin it to a digest for a release
# you intend to reproduce: docker build --build-arg NODE_IMAGE=node@sha256:…
ARG NODE_IMAGE=node:22-alpine

# --- Dependencies -------------------------------------------------------------------------------
# Only the manifests and the lockfile, so this layer is rebuilt when dependencies change and not when
# a line of application code does.
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/sleeper-client/package.json packages/sleeper-client/
COPY packages/ui/package.json packages/ui/
# `npm ci` rather than `npm install`: it installs exactly the lockfile and fails if the manifests and
# the lockfile disagree, so the image cannot quietly acquire a version nobody reviewed.
RUN npm ci --ignore-scripts

# --- Build --------------------------------------------------------------------------------------
FROM deps AS build
WORKDIR /app
COPY packages packages
COPY apps/api apps/api
# The workspace packages are built first: the API's generated JavaScript imports them by name, and Node
# resolves that to their `dist`. Only what the API imports is built — the web app's UI package is not
# part of this image.
RUN npm run build -w @sleeper/domain \
 && npm run build -w @sleeper/sleeper-client \
 && npm run build -w @sleeper/api

# --- Production dependencies --------------------------------------------------------------------
# A second install rather than a prune of the first, so the tree in the runtime image is the one the
# lockfile describes for production and not whatever survived a removal pass. Scoped to the API's
# workspace, so the web application's build tooling is never installed at all.
FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/sleeper-client/package.json packages/sleeper-client/
COPY packages/ui/package.json packages/ui/
RUN npm ci --omit=dev --ignore-scripts --include-workspace-root -w @sleeper/api

# --- Runtime ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Huddle API" \
      org.opencontainers.image.description="Huddle API and league synchronization worker" \
      org.opencontainers.image.source="https://github.com/tfishbeck95/sleeper_ff"

# Production is a refusal, not a hint: it is what makes the application decline to guess a storage
# adapter, serve the sample league, or drop the Secure attribute from a session cookie.
ENV NODE_ENV=production
WORKDIR /app

# Everything is copied root-owned, so the unprivileged process below cannot rewrite its own code; the
# only path it writes to is a mounted volume. npm hoists the whole tree to the root, so this is the only
# `node_modules` there is — the symlinks in it, `@sleeper/domain` and the rest, resolve to the workspace
# directories copied after it.
COPY --from=production-deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root package.json ./
COPY --chown=root:root apps/api/package.json ./apps/api/
COPY --chown=root:root packages/domain/package.json ./packages/domain/
COPY --chown=root:root packages/sleeper-client/package.json ./packages/sleeper-client/
COPY --from=build --chown=root:root /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=root:root /app/packages/sleeper-client/dist ./packages/sleeper-client/dist
COPY --from=build --chown=root:root /app/apps/api/dist ./apps/api/dist
# The migrations for this exact release travel with it, so `migrations:status` from a running container
# answers about the code that is actually deployed. Applying them is a separate step and a separate
# image: see deploy/migrate.Dockerfile.
COPY --chown=root:root apps/api/migrations ./apps/api/migrations

# The base image's own packages, brought up to date.
#
# A tag alone is not enough: `node:22-alpine` is rebuilt on its own cadence, so between an Alpine
# security release and upstream's next rebuild the image carries packages with fixed versions already
# published — openssl and libexpat are the recurring ones. This is the part of that gap we control,
# and it is why the image scan in CI has something to pass. It runs while this stage is still root,
# before the USER below.
RUN apk --no-cache upgrade

# The one path the process writes to. Creating it here, owned by the user that runs, is what makes a
# fresh named volume mounted over it writable: Docker copies the image directory's ownership onto an
# empty volume, and a volume it did not initialize from anywhere lands root-owned and unwritable.
RUN mkdir -p /var/lib/huddle && chown node:node /var/lib/huddle

# The working directory is the API workspace, so the relative paths in the configuration mean the same
# thing here as they do in a checkout: `../../data` is the repository's data directory.
WORKDIR /app/apps/api
# `node` (uid 1000) ships with the base image. A mounted data volume has to be writable by it; see
# docs/deployment.md.
USER node
EXPOSE 4000

# Liveness, not readiness. This check decides whether to *replace* the container, so it must not
# fail because a database is briefly unreachable — that turns one outage into a restart loop — and it
# must not fail while the process is draining, which is the process doing what it was asked. The load
# balancer asks `/health/ready` instead, which is the check that answers both of those with a 503.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/api.js"]
