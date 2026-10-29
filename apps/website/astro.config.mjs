import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import node from '@astrojs/node'
import sitemap from '@astrojs/sitemap'

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
  integrations: [sitemap()],
})
