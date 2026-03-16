# ---- build stage ----
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:20-alpine AS runtime
RUN apk add --no-cache dumb-init
WORKDIR /app

# non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN mkdir -p /data && chown appuser:appgroup /data

COPY --from=builder /app/node_modules ./node_modules
COPY --chown=appuser:appgroup . .

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA
ENV NODE_ENV=production PORT=3000

USER appuser
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
