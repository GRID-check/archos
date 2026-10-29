import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import sitemap from '@astrojs/sitemap'

// The domain is a brand string: it lives in identity.json, never in this file.
const identity = JSON.parse(
  readFileSync(fileURLToPath(new URL('./src/styles/brand/identity.json', import.meta.url)), 'utf8'),
)

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || `https://${identity.domain}`,
  // Static output: no adapter, `astro build` writes dist/.
  integrations: [sitemap()],
})
