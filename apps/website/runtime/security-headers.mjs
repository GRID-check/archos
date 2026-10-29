/**
 * Security headers on every response of the public site, set by `server.mjs`
 * before the Astro handler runs (the handler keeps headers already set).
 *
 * The Content-Security-Policy allows the site's own origin and, only when the
 * stack has analytics on, the two PostHog origins `web-analytics.mjs` talks to.
 * What makes `script-src 'self'` hold:
 * - the build writes no inline script: `vite.build.assetsInlineLimit: 0` in
 *   `astro.config.mjs` makes Astro emit every component script as a file;
 * - JSON-LD (`type="application/ld+json"`) is data, which CSP does not block.
 * `style-src` keeps `'unsafe-inline'`: the design system's components and the
 * views set `style` attributes, which only a hash-free policy allows. Styles
 * cannot run code, so this is the accepted trade-off.
 *
 * `form-action` allows `mailto:` because the contact and demo forms hand off
 * to the visitor's mail program when JavaScript is off (README, "Forms").
 *
 * HSTS has no `includeSubDomains` and no `preload`: both reach beyond this
 * site and cannot be taken back quickly. Widening it is a decision for the
 * domain owner, at the edge.
 */

/** Two years: the value hstspreload.org asks for, should the owner ever submit the domain. */
export const HSTS = 'max-age=63072000'

/**
 * @param {{ connect: string[], script: string[] }} analytics origins from `analyticsOrigins`
 * @returns {string}
 */
export function contentSecurityPolicy(analytics) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...analytics.script],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'media-src': ["'self'"],
    'connect-src': ["'self'", ...analytics.connect],
    'manifest-src': ["'self'"],
    // Session replay (only after consent) compresses in a worker it starts from a blob.
    'worker-src': ["'self'", ...(analytics.script.length ? ['blob:'] : [])],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", 'mailto:'],
    'frame-ancestors': ["'none'"],
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ')
}

/**
 * Every security header, as `[name, value]` pairs.
 *
 * @param {{ connect: string[], script: string[] }} analytics
 * @returns {[string, string][]}
 */
export function securityHeaders(analytics) {
  return [
    ['Content-Security-Policy', contentSecurityPolicy(analytics)],
    ['Strict-Transport-Security', HSTS],
    ['X-Content-Type-Options', 'nosniff'],
    ['X-Frame-Options', 'DENY'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
    [
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=(), browsing-topics=()',
    ],
  ]
}

/** The health probe's path: answered by the server itself, before Astro. */
export const HEALTH_PATH = '/healthz'
