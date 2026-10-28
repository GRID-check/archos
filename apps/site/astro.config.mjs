import { defineConfig } from 'astro/config'
import mdx from '@astrojs/mdx'
import sitemap from '@astrojs/sitemap'
import node from '@astrojs/node'
import keystatic from '@keystatic/astro'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { UNLISTED } from './src/lib/unlisted.ts'
import { englishToGermanPath, germanToEnglishPath } from './src/i18n/paths.ts'

export default defineConfig({
  site: process.env.PUBLIC_SITE_URL || 'https://piloti.at',
  // `react()` is not optional decoration: the Keystatic admin route injected by
  // `keystatic()` renders `<Keystatic client:only="react" />`. Without a React
  // renderer registered, `astro build` still succeeds - the failure only shows
  // up at request time, as a NoMatchingRenderer stream error that reaches the
  // browser as a blank /keystatic page. It must come before keystatic().
  integrations: [
    mdx(),
    react(),
    keystatic(),
    // Lists every prerendered page, paired with its twin in the other locale
    // (the same path under /en, its first segment in English where
    // src/i18n/paths.ts has one; `serialize` writes those pairs, which the
    // plugin cannot find by prefix alone). Blog posts whose slugs differ per
    // locale are paired by the hreflang links in their own <head> instead. Server-rendered
    // routes (/keystatic, /api, /sign-in, the /de redirect) are never listed;
    // the filter keeps out what is prerendered but not for search, and the
    // unlisted pages (src/lib/unlisted.ts), which exist only for who has the link.
    sitemap({
      i18n: { defaultLocale: 'de', locales: { de: 'de', en: 'en' } },
      filter: (page) => {
        const path = new URL(page).pathname
        if (UNLISTED.some((slug) => path.split('/').includes(slug))) return false
        return !/\/(404|keystatic|api|sign-in)(\/|$)/.test(path)
      },
      serialize: (item) => {
        const url = new URL(item.url)
        const english = /^\/en(?=\/|$)/.test(url.pathname)
        const dePath = english ? englishToGermanPath(url.pathname.replace(/^\/en/, '') || '/') : url.pathname
        const enPath = `/en${germanToEnglishPath(dePath)}`
        const twin = (path) => new URL(path, url).href
        // Only a page whose English twin is spelled differently needs its pair
        // set by hand; the rest keep what the plugin found.
        if (germanToEnglishPath(dePath) === dePath) return item
        item.links = [
          { url: twin(dePath), lang: 'de' },
          { url: twin(enPath), lang: 'en' },
        ]
        return item
      },
    }),
  ],
  adapter: node({ mode: 'standalone' }),
  // Astro's default cache lives in `node_modules/.astro`, which `npm ci` deletes
  // on every CI run — so the image pipeline reprocessed every blog image from
  // cold each time (44s vs 19s warm on the current content). Outside
  // node_modules it survives the install and can be restored by actions/cache.
  cacheDir: './.astro-cache',
  // Blog images arrive from Keystatic at whatever resolution the author's camera
  // or scanner produced - the first upload was 11 MB at 15798px wide. `constrained`
  // makes every processed image emit a srcset capped at its intrinsic size, so the
  // browser fetches a column-sized variant instead of the original, and
  // `responsiveStyles` ships the `max-width`/`height:auto` rules that go with it.
  image: {
    layout: 'constrained',
    responsiveStyles: true,
  },
  vite: {
    plugins: [tailwindcss()],
  },
})
