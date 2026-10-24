# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
# Prisma's query engine needs OpenSSL on Alpine (otherwise: libssl not found at runtime)
RUN apk add --no-cache openssl

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Stage 2: Production runtime ──────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app
RUN apk add --no-cache openssl
ENV NODE_ENV=production

# Only copy production deps (includes the prisma CLI, needed for migrate deploy)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy Prisma client and schema
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

# Copy compiled output
COPY --from=builder /app/dist ./dist

EXPOSE 3001
# Apply pending migrations (never `migrate dev` in production), then start the API.
# Lives here so ANY deployment migrates, not only docker-compose.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
