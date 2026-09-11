# The migration image.
#
# A separate image from the API on purpose. It is the one thing in a deployment that holds credentials
# able to alter the schema, and it runs to completion and exits — so it is a job, not a service, and it
# has no reason to share a filesystem with the process that serves requests. The API image keeps a copy
# of the migrations for reference; this is the image that applies them.
#
# It is built from the same commit as the API image it is deployed with, so the schema a release runs
# against is the schema that release's migrations describe. See docs/deployment.md for where this step
# sits in a deploy, and for the rollback.
#
# Keep the PostgreSQL version in step with the server being migrated: a newer client is fine, an older
# one can fail to parse syntax the migrations use.
ARG POSTGRES_IMAGE=postgres:17-alpine
FROM ${POSTGRES_IMAGE}

LABEL org.opencontainers.image.title="Huddle migrations" \
      org.opencontainers.image.description="Applies and rolls back the Huddle PostgreSQL schema" \
      org.opencontainers.image.source="https://github.com/tfishbeck95/sleeper_ff"

# The alpine image has no bash, and the scripts use arrays.
RUN apk add --no-cache bash

COPY apps/api/migrations /migrations
USER postgres
WORKDIR /migrations

# `apply.sh` reads DATABASE_URL, applies only what the ledger says is pending, and exits 0 when there is
# nothing to do — so re-running a deploy is a no-op rather than a second application. Pass `--status` or
# `--dry-run` to look without touching anything, and run `/migrations/rollback.sh` to go back.
ENTRYPOINT ["/migrations/apply.sh"]
