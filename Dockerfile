# ---- build stage ----
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:22.23.4-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
RUN apk add --no-cache dumb-init
WORKDIR /app

# non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
RUN mkdir -p /data && chown appuser:appgroup /data

COPY --from=builder /app/node_modules ./node_modules
ARG CACHEBUST=1
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
