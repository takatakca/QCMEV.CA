# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx prisma generate
RUN npm run build

# ─── Stage 2: Production runtime ──────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

# Only copy production deps
COPY package*.json ./
RUN npm ci --omit=dev

# Copy Prisma client and schema
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY prisma ./prisma

# Copy compiled output
COPY --from=builder /app/dist ./dist

EXPOSE 3001
CMD ["node", "dist/main"]
