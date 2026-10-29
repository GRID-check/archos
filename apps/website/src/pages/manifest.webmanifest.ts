import type { APIRoute } from 'astro'
import identity from '../lib/identity'
import { surfaceColor as surface } from '../lib/theme'

/**
 * The web app manifest: name and icons for a saved bookmark or home-screen
 * entry. Name and colours are read from the brand (identity.json, tokens.css),
 * so a rename or a retune needs no edit here. The icons in `public/icons/` are
 * rendered from `packages/brand/mark.svg` (README, "Icons").
 */
export const prerender = true

export const GET: APIRoute = () =>
  new Response(
    JSON.stringify(
      {
        name: identity.name,
        short_name: identity.name,
        description: identity.claim,
        lang: 'de',
        start_url: '/',
        scope: '/',
        display: 'browser',
        background_color: surface,
        theme_color: surface,
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      null,
      2,
    ),
    { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } },
  )
