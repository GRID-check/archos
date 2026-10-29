# =============================================================================
# The public website (Astro on the Node standalone adapter): production image
# =============================================================================
#
# Same runtime contract as the site it replaces, so the Pulumi Deployment
# (deploy/pulumi/src/app/web.ts) is unchanged: CMD `node runtime/server.mjs`
# (the Astro handler behind a Cache-Control step), port 4321, UID 1001, and the
# per-request env the SSR routes read: PUBLIC_APP_URL (/sign-in) and
# PUBLIC_POSTHOG_HOST / PUBLIC_POSTHOG_PROJECT_TOKEN (/web-analytics.js).
#
# The Astro client-dir path is baked into dist/server/entry.mjs at build time,
# so the site is built inside this image's WORKDIR layout.
#
# Build-time arg: PUBLIC_SITE_URL, the canonical URL for sitemap and Open
# Graph. Unset, astro.config.mjs derives it from the brand identity's domain.
# =============================================================================

FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.4.3-slim /usr/local/bin/bun /usr/local/bin/bun

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM base AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN rm -f .env .env.local .env.*.local .env.development .env.production 2>/dev/null || true
ARG PUBLIC_SITE_URL
ENV PUBLIC_SITE_URL=$PUBLIC_SITE_URL
ENV ASTRO_TELEMETRY_DISABLED=1
RUN bun run build

FROM base AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV ASTRO_TELEMETRY_DISABLED=1
ENV HOST=0.0.0.0
ENV PORT=4321
RUN groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs website \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/bun
COPY --from=builder --chown=website:nodejs /app/dist ./dist
COPY --from=prod-deps --chown=website:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=website:nodejs /app/package.json ./package.json
COPY --from=builder --chown=website:nodejs /app/runtime ./runtime
# The route fates: runtime/gone.mjs reads the 410 rows at request time.
COPY --from=builder --chown=website:nodejs /app/redirects.mjs ./redirects.mjs
USER website
EXPOSE 4321
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=5 \
    CMD curl -sf http://localhost:4321/healthz || exit 1
CMD ["node", "runtime/server.mjs"]
