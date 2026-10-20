import path from 'node:path'
import type { NextConfig } from 'next'
import type { withPostHogConfig } from '@posthog/nextjs-config'
import { LEGACY_ROUTES } from './src/lib/api/legacy-routes'
import { AVATAR_IMAGE_PATTERNS } from './src/lib/images/avatar-hosts'
import { LOCAL_IMAGE_PATTERNS } from './src/lib/images/optimizable'
import { requestBodyLimitBytes } from './src/shared/config/request-body-limit'

/**
 * The TRANSPORT ceiling, which has to clear the largest body any route may
 * legitimately accept — not the largest DOCUMENT.
 *
 * `.ifc` is measured against `BIM_MAX_IFC_BYTES` (250 MB), deliberately
 * separate from the 100 MB document limit because a building model is an order
 * of magnitude bigger than a PDF. Leaving the body limit at the document
 * figure made that unreachable in the worst possible way: the request was cut
 * off in front of the handler, so `request.formData()` threw
 * `TypeError: Failed to parse body as FormData` — an unhandled 500 naming
 * neither the file nor a size, rather than the readable refusal both
 * validators are careful to produce.
 */
const requestBodyLimitMB = Math.ceil(requestBodyLimitBytes(process.env) / (1024 * 1024))

/** The config as written; the default export below adds PostHog source maps on the upload path. */
export const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Renamed paths keep answering for one release: the API paths in
  // src/lib/api/legacy-routes.ts, and the office shelf's old page URL. A stored
  // link (an inbox item, a shared link: `/app/archiv?doc=<id>`) and a bookmark
  // keep working through the permanent redirect, query string included.
  async redirects() {
    return [
      ...LEGACY_ROUTES.map(({ from, to }) => ({ source: from, destination: to, permanent: true })),
      { source: '/app/archiv', destination: '/app/office-shelf', permanent: true },
      { source: '/app/archiv/:path*', destination: '/app/office-shelf/:path*', permanent: true },
    ]
  },

  // PostHog's endpoints end in a slash (`/e/`, `/s/`, `/flags/`). With the
  // default, Next answers `/ingest/e/` with a 308 to `/ingest/e`, and a
  // redirected beacon is a lost event (PostHog docs, advanced/proxy/nextjs).
  // Both forms are served as written; the site has no other use for the
  // redirect (`trailingSlash` stays unset).
  skipTrailingSlashRedirect: true,

  // The build typechecks production code only: tsconfig.build.json leaves the
  // specs and test helpers out of its roots, so a type error in a test cannot
  // fail `next build`. `task fe:types` (tsc on tsconfig.json) still checks them.
  typescript: {
    tsconfigPath: 'tsconfig.build.json',
  },

  images: {
    // The optimizer refuses any remote host that is not named here, which is
    // what keeps it from being an open image proxy. Directory avatars are the
    // only remote images we serve; see `avatar-hosts.ts` for why one entry
    // covers the whole directory and what happens to a host that is not on it.
    //
    // Document images are NOT here and must not be: they are streamed from a
    // same-origin route (`/api/documents/[id]/image`), so they are governed by
    // `localPatterns` below. Presigning them to the object store instead would
    // put them on a per-environment host that resolves to a private IP inside
    // the compose network, which the optimizer rejects outright.
    remotePatterns: AVATAR_IMAGE_PATTERNS.map((pattern) => ({ ...pattern })),

    // Same-origin paths the optimizer may serve. Leaving this unset does NOT
    // mean "no allow-list": Next 16 defaults it to `[{ pathname: '**', search:
    // '' }]`, which rejects every local URL that carries a query string with
    // `"url" parameter is not allowed`. Our signed document images carry their
    // authorization in the query, so the default blanked every preview and
    // thumbnail in the app. See `optimizable.ts` for the patterns and why the
    // document route is allowed a query string.
    localPatterns: LOCAL_IMAGE_PATTERNS.map((pattern) => ({ ...pattern })),

    // No server-side cache of optimized images. A document image's route
    // re-checks the token and the reader's folder access on every fetch, and a
    // cached copy is served WITHOUT that fetch: a hit straight from disk, a
    // stale entry too while it revalidates, and a failed revalidation (our
    // 403/404) writes the stale entry back for another `minimumCacheTTL`. So a
    // picture kept loading, for anyone holding the URL, after its folder was
    // closed to them and after the token expired. Lowering the TTL does not
    // close that loop; only switching the cache off does. What it cost: each
    // request re-encodes. Document URLs carry the person and a five-minute
    // window, so the cache only ever served that person within those minutes,
    // mostly to a browser already holding the image; avatars are re-fetched
    // from workoscdn.com.
    // `optimizer-cache.spec.ts` runs Next's own cache against this config.
    maximumDiskCacheSize: 0,

    // The floor on the max-age `/_next/image` sends to the browser, which it
    // sends as `public` whatever the route said. The default (4 hours) let any
    // shared cache keep a tenant's picture long after the token had expired.
    // One token window (`IMAGE_URL_WINDOW_SECONDS`); upstreams that send a
    // longer max-age, like the avatar CDN, keep theirs.
    minimumCacheTTL: 300,
  },

  // Loaded from node_modules at runtime instead of bundled into the route that
  // uses it (the answer-feedback workbook export). exceljs is CommonJS with
  // ~60 dependencies (archiver, jszip, saxes, …) and circular requires, which
  // the server bundle gains nothing from inlining; the production image ships
  // node_modules (deploy/Dockerfile), so Node resolves it as it does in tests.
  // `ws` likewise: the wake job's chat socket (`lib/turns/headless-turn.ts`),
  // whose optional native peers (`bufferutil`, `utf-8-validate`) a bundler
  // would try to resolve and inline.
  serverExternalPackages: ['exceljs', 'ws'],

  experimental: {
    serverActions: {
      bodySizeLimit: `${requestBodyLimitMB}mb`,
    },
    proxyClientMaxBodySize: `${requestBodyLimitMB}mb`,
  },

  // `@ifc-lite/renderer` re-exports a point-cloud renderer that reaches
  // `laz-perf`, whose Emscripten loader imports `wasi_snapshot_preview1` and two
  // virtual specifiers no bundler can resolve — it fails `next build` outright.
  // Grid never decodes a point cloud (a STEP IFC building model contains none),
  // so the dependency is aliased to a loud stub instead. Both bundlers are
  // configured: turbopack serves `next dev` and webpack the production build.
  turbopack: {
    resolveAlias: {
      'laz-perf': './src/lib/bim/laz-perf-stub.ts',
      // The decoder also imports its own `.wasm` through a `?url` specifier,
      // which resolves to an Emscripten loader importing `env` and
      // `wasi_snapshot_preview1`. Aliasing the package alone leaves that second
      // request behind, so both spellings are mapped.
      'laz-perf/lib/web/laz-perf.wasm?url': './src/lib/bim/laz-perf-stub.ts',
      'laz-perf/lib/web/laz-perf.wasm': './src/lib/bim/laz-perf-stub.ts',
    },
  },

  webpack: (config) => {
    config.resolve = config.resolve ?? {}
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      'laz-perf': path.resolve(process.cwd(), 'src/lib/bim/laz-perf-stub.ts'),
      'laz-perf/lib/web/laz-perf.wasm': path.resolve(process.cwd(), 'src/lib/bim/laz-perf-stub.ts'),
    }
    return config
  },

  // The office shelf's old API paths are REWRITTEN, not redirected: an open tab
  // or an agent pod mid-rollout calls `/api/archiv/*` with a body, and a rewrite
  // answers it from the new route in place. Remove after one release.
  async rewrites() {
    return [{ source: '/api/archiv/:path*', destination: '/api/office-shelf/:path*' }]
  },

  // Baseline security headers. A full Content-Security-Policy needs nonce
  // plumbing for Next's inline scripts and is tracked as a follow-up —
  // these four are safe unconditionally. HSTS is terminated at the proxy.
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // The microphone is allowed for our own origin only: voice dictation
          // in the composer records from it (docs/architecture/voice-dictation.md).
          // `microphone=()` refused getUserMedia on every page with a
          // NotAllowedError that reads exactly like a member denying access.
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
          // Behind sign-in, so in no search index; the public site is what
          // gets found. Covers non-HTML responses the metadata cannot reach.
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      // The service worker for system notifications (ADR-0112). A browser
      // checks `/sw.js` for a new version on its own schedule and through its
      // own HTTP cache, so any max-age here would keep a fixed worker away from
      // devices for as long as it says: it is never cached. Scope is the whole
      // origin (the file sits at the root already; the header makes it explicit).
      // It has no fetch handler and caches nothing, so nothing tenant-scoped can
      // ever be served from it. After the global rule, which it must override.
      {
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'no-cache, no-store, must-revalidate' },
          { key: 'Content-Type', value: 'text/javascript; charset=utf-8' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
      // The base-corpus source-PDF stream is displayed inside a same-origin
      // iframe by the in-app PDF viewer (clicked citations). The global rule
      // above stamps X-Frame-Options: DENY on every route, which the browser
      // honours by refusing to render the preview. Override that single route
      // to allow same-origin framing. This entry must stay AFTER the global
      // `/(.*)` rule: when two matching entries set the same header key, Next
      // emits the last one (see next.config headers "Header Overriding
      // Behavior"), so the more specific SAMEORIGIN replaces DENY here rather
      // than both being emitted. The route handler
      // (streamKnowledgeBaseDocument) sets the same two headers on its Response
      // as defense-in-depth.
      {
        source: '/api/knowledge-base/documents/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
      // The stored-document stream, for the same reason and under the same
      // ordering rule: when the in-app PDF viewer cannot run, it degrades to a
      // same-origin iframe on this route, which the global DENY above would
      // otherwise refuse to render. `streamDocumentFile` sets the same two
      // headers on its Response as defense-in-depth.
      {
        source: '/api/documents/:id/file',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ]
  },
}

type PostHogSourcemapConfig = Parameters<typeof withPostHogConfig>[1]
type NextConfigFunction = (
  phase: string,
  context: { defaultConfig: NextConfig }
) => Promise<NextConfig>

/**
 * PostHog source maps (`@posthog/nextjs-config`), for the one build that can
 * upload them, or `null` for every other build and for the running server.
 *
 * On only when the image build hands `next build` a personal API key
 * (`POSTHOG_CLI_API_KEY`, read from a BuildKit secret inside the same RUN,
 * `deploy/Dockerfile`) and a project id. A fork, a pull request, a local build
 * and the runtime have neither, and get `nextConfig` exactly as written. With
 * both, the package turns browser maps on, the PostHog CLI injects chunk ids
 * into the shipped JavaScript, uploads the maps for release `grid-ui` at the
 * commit being built (the `GRID_GIT_SHA` the container reports) and deletes
 * them. The Dockerfile then deletes any map left over and fails the build if
 * one survives: Next serves `.next/static` to anyone, and a map carries the
 * original source.
 *
 * `symbol-set` binds the uploaded maps to the release, as the CLI did before
 * this package. Its newer `event` mode injects the release id for posthog-js
 * to send, which the posthog-js this app pins is not known to do.
 */
export const posthogSourcemapConfig = (
  env: NodeJS.ProcessEnv = process.env
): PostHogSourcemapConfig | null => {
  const personalApiKey = env.POSTHOG_CLI_API_KEY?.trim()
  const projectId = env.POSTHOG_PROJECT_ID?.trim()
  if (!personalApiKey || !projectId) return null
  const releaseVersion = env.GRID_GIT_SHA?.trim()
  if (!releaseVersion) {
    throw new Error('GRID_GIT_SHA is empty; a PostHog release needs the commit it was built from')
  }
  return {
    personalApiKey,
    projectId,
    host: env.POSTHOG_CLI_HOST?.trim() || 'https://eu.posthog.com',
    sourcemaps: {
      enabled: true,
      releaseName: 'grid-ui',
      releaseVersion,
      releaseMode: 'symbol-set',
      deleteAfterUpload: true,
    },
  }
}

/**
 * The config Next loads, at build time and again at runtime. The package is
 * imported only on the upload path: it is a devDependency (it brings the CLI
 * and webpack), absent from the runtime image, which loads this file too.
 * `withPostHogConfig` is the outermost wrapper, as the package requires, and
 * server maps are switched on beside it so server stack frames resolve too.
 */
export default async function config(
  phase: string,
  context: { defaultConfig: NextConfig }
): Promise<NextConfig> {
  const posthog = posthogSourcemapConfig()
  if (!posthog) return nextConfig
  const { withPostHogConfig } = await import('@posthog/nextjs-config')
  const withServerMaps: NextConfig = {
    ...nextConfig,
    experimental: { ...nextConfig.experimental, serverSourceMaps: true },
  }
  // Typed as a NextConfig, returned as the function Next calls with the phase.
  const wrapped = withPostHogConfig(withServerMaps, posthog) as unknown as NextConfigFunction
  return wrapped(phase, context)
}
