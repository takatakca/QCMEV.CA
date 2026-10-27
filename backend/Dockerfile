# Takatak MEV backend — production image (Coolify / Docker).
# Build: npm ci → prisma generate → nest build. Start: prisma migrate deploy → node dist/main.js.
# No secret is baked in: every value comes from the environment at run time (see .env.example).

# Development image (docker-compose.dev.yml only): every dependency, nest --watch, SIMULATOR. Never deployed.
FROM node:22-alpine AS dev
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/qcmev-ca.pem; \
      export SSL_CERT_FILE=/tmp/qcmev-ca.pem; \
    fi; \
    apk add --no-cache openssl; \
    rm -f /tmp/qcmev-ca.pem
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund
COPY prisma ./prisma
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
EXPOSE 3001
CMD ["sh", "-c", "npx ts-node src/cli/check-database.ts && npx prisma migrate deploy && npx nest start --watch"]

FROM node:22-alpine AS build
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/qcmev-ca.pem; \
      export SSL_CERT_FILE=/tmp/qcmev-ca.pem; \
    fi; \
    apk add --no-cache openssl; \
    rm -f /tmp/qcmev-ca.pem
COPY package.json package-lock.json ./
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm ci --no-audit --no-fund
COPY prisma ./prisma
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npx prisma generate
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm run build && npm prune --omit=dev --no-audit --no-fund && npx prisma generate

FROM node:22-alpine
WORKDIR /app
RUN --mount=type=secret,id=proxy_ca \
    set -eu; \
    if [ -f /run/secrets/proxy_ca ]; then \
      cat /etc/ssl/certs/ca-certificates.crt /run/secrets/proxy_ca > /tmp/qcmev-ca.pem; \
      export SSL_CERT_FILE=/tmp/qcmev-ca.pem; \
    fi; \
    apk add --no-cache openssl tini && addgroup -S app && adduser -S app -G app; \
    rm -f /tmp/qcmev-ca.pem
ENV NODE_ENV=production PORT=3001
COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/prisma ./prisma
COPY --chown=app:app package.json ./
USER app
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD wget -qO- http://127.0.0.1:3001/api/health/ready || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sh", "-c", "node dist/cli/check-database.js && npx prisma migrate deploy && node dist/main.js"]
