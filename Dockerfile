# PickSched production image: API + built web app on one origin.
#
#   docker build -t picksched .
#   docker run -p 3000:3000 --env-file <(your secret store) picksched
#
# Release commands (same image, same environment as the server):
#   docker run --rm ... picksched npm run migrate -w api     # with MIGRATION_DATABASE_URL
#   docker run --rm ... picksched npm run preflight -w api
#
# No configuration or secrets are baked in: everything comes from the
# environment at runtime (see docs/deployment.md). NODE_ENV=production makes
# the server use production rules unless APP_ENV=staging is set.

ARG NODE_IMAGE=node:22-alpine
# Behind a TLS-intercepting proxy, pass its CA as a build secret:
#   docker build --secret id=build_ca,src=/path/to/ca.pem ...

# --- Build ---------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export npm_config_cafile=/run/secrets/build_ca; fi; \
    npm ci --workspace api --workspace web --include-workspace-root --no-audit --no-fund
COPY api api
COPY web web
RUN npm run build -w api && npm run build -w web

# --- Runtime -------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    WEB_DIST=/app/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY api/package.json api/
COPY web/package.json web/
COPY e2e/package.json e2e/
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export npm_config_cafile=/run/secrets/build_ca; fi; \
    npm ci --workspace api --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/api/dist api/dist
COPY --from=build /app/web/dist web/dist
# Sources for the release scripts (migrate, preflight), run with tsx.
COPY api/src api/src
COPY api/scripts api/scripts
COPY api/tsconfig.json api/
COPY db/migrations db/migrations

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "api/dist/server.js"]
