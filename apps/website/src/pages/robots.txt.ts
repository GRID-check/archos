import type { APIRoute } from 'astro'

// Static robots.txt: every page may be crawled, and the sitemap index is named.
export const prerender = true

export const GET: APIRoute = ({ site }) =>
  new Response(`User-agent: *\nAllow: /\nSitemap: ${new URL('sitemap-index.xml', site)}\n`, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
