import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'
import node from '@astrojs/node'
import sitemap from '@astrojs/sitemap'
import { redirects } from './redirects.mjs'
import { serializeSitemapItem, sitemapFilter } from './sitemap.mjs'

// The domain is a brand string: it lives in identity.json, never in this file.
const identity = JSON.parse(
  readFileSync(fileURLToPath(new URL('./src/styles/brand/identity.json', import.meta.url)), 'utf8'),
)

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || `https://${identity.domain}`,
  // German at the root, English under /en/. The table of routes (src/i18n/paths.ts) holds the
  // English segments; Astro only needs the locales and the default one.
  i18n: {
    locales: ['de', 'en'],
    defaultLocale: 'de',
    routing: { prefixDefaultLocale: false },
  },
  // Output stays static; the Node adapter serves the endpoints that opt out of prerendering
  // (`export const prerender = false`, e.g. /sign-in). `astro build` writes dist/.
  adapter: node({ mode: 'standalone' }),
  // Old public addresses and their new homes (301); see redirects.mjs (the 410s are read by src/pages/404.astro).
  redirects,
  integrations: [
    mdx(),
    // Each page with its other-locale twin (hreflang pairs) and its date; see sitemap.mjs.
    sitemap({
      i18n: { defaultLocale: 'de', locales: { de: 'de', en: 'en' } },
      filter: sitemapFilter,
      serialize: serializeSitemapItem,
    }),
  ],
  vite: {
    // Every component script becomes a file under /_astro/ instead of an inline <script>, so
    // the Content-Security-Policy can say `script-src 'self'` (runtime/security-headers.mjs).
    build: { assetsInlineLimit: 0 },
  },
})
