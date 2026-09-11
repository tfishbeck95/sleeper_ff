# The web image: a static bundle and a server that does nothing but hand it out.
#
# The dashboard is static files. It talks to the API from the browser and has no server side of its
# own, so the serving half of this image has no application code in it at all — which is the point.
# The same `dist/` this builds is what goes to a CDN when the deployment uses one; the static server
# below is for when it does not, and the cache policy is deliberately the same in both, because a CDN
# that caches `index.html` forever pins every visitor to the release that was current when they first
# arrived. See docs/deployment.md.
#
# `VITE_API_URL` is a build argument rather than a runtime variable, because Vite substitutes it into
# the bundle: the built assets already contain it, and one build cannot serve two environments. Staging
# and production are separate builds. Nothing secret ever goes in one — anything substituted into a
# bundle is readable by anyone who loads the page.

ARG NODE_IMAGE=node:22-alpine
# nginx-unprivileged is the same nginx configured to run as a non-root user on an unprivileged port,
# rather than the usual root master process. Pin it to a digest for a release you intend to reproduce.
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29-alpine

# --- Build --------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/domain/package.json packages/domain/
COPY packages/sleeper-client/package.json packages/sleeper-client/
COPY packages/ui/package.json packages/ui/
RUN npm ci --ignore-scripts

COPY packages packages
COPY apps/web apps/web

# Empty by default, which is what a deployment serving the dashboard and the API from one origin wants:
# the session cookie is `__Host-` prefixed and `SameSite=Strict`, so a cross-origin front end needs the
# API on the same site or it will not be sent at all.
ARG VITE_API_URL=""
ENV VITE_API_URL=${VITE_API_URL}
RUN npm run build -w @sleeper/web

# --- Serve --------------------------------------------------------------------------------------
FROM ${NGINX_IMAGE} AS runtime

LABEL org.opencontainers.image.title="Huddle web" \
      org.opencontainers.image.description="Huddle dashboard: static bundle behind a static server" \
      org.opencontainers.image.source="https://github.com/tfishbeck95/sleeper_ff"

# Substituted into the template at container start by the base image's entrypoint, so one image can be
# pointed at the API origin its `connect-src` has to allow. It is a policy value, not a secret.
ENV API_ORIGIN="'self'"
COPY deploy/web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

# 8080: the unprivileged image binds a port it does not need root for. TLS is terminated in front of it.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD ["/bin/sh", "-c", "wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1"]
