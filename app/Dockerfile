# Production Dockerfile for the rome-dex Next.js frontend (app/).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Client-lane RPC is inlined at build time by Next.js. Leave empty to bake the
# app's built-in Hadrian default; override per-build to repoint the client lane.
ARG NEXT_PUBLIC_EVM_RPC=""
ENV NEXT_PUBLIC_EVM_RPC=${NEXT_PUBLIC_EVM_RPC}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3200
ENV HOSTNAME="0.0.0.0"
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
USER nextjs
EXPOSE 3200
CMD ["npm", "run", "start"]
