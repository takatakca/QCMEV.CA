# ─── Stage 1: Build ───────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
# Backend address as seen from INSIDE the Docker network (baked into Next rewrites at build time)
ARG API_INTERNAL_URL=http://backend:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL
RUN npm run build

# ─── Stage 2: Production runtime ──────────────────────────────────────────────
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production
ARG API_INTERNAL_URL=http://backend:3001
ENV API_INTERNAL_URL=$API_INTERNAL_URL

COPY package*.json ./
RUN npm ci --omit=dev

# Copy Next.js build output
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.* ./

EXPOSE 3000
CMD ["npx", "next", "start"]
