import type { MetadataRoute } from 'next'
import { PRODUCT_NAME } from '@/lib/brand'
import { THEME_COLOR } from './theme-boot'

/**
 * Web app manifest (served at /manifest.webmanifest). The icons are rendered
 * from packages/brand/mark.svg by packages/brand/build-brand-assets.mjs;
 * never edit the PNGs by hand.
 */
const manifest = (): MetadataRoute.Manifest => ({
  name: PRODUCT_NAME,
  short_name: PRODUCT_NAME,
  description: 'Workspace for planning offices',
  start_url: '/',
  display: 'standalone',
  // The paper the app opens on, from the same constant as `<meta
  // name="theme-color">` (theme-boot.ts), so the splash, the title bar and the
  // first frame are one surface. A manifest has one colour where the meta tag
  // has two, so the dark theme is the meta's alone. It was an olive
  // (`#2a301f`) that matched no token and drew a dark band over a light app.
  background_color: THEME_COLOR.light,
  theme_color: THEME_COLOR.light,
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
})

export default manifest
