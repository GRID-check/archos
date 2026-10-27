/**
 * The icons the door lists (MCP `Icon`: `src`, `mimeType`, `sizes`, `theme`).
 * Small inline SVG `data:` URIs, so no client fetches anything and no asset
 * route has to be public; each one repeats in every `tools/list`,
 * `prompts/list` and `resources/list`, so each stays a few hundred bytes.
 *
 * The server's own icon leads with the app's PNG tiles, served from the
 * deployment's pinned origin (`public/icons/`, the same origin as the MCP
 * endpoint): the spec obliges a client to render only PNG and JPEG, SVG is a
 * SHOULD, and Claude's connector UI showed nothing for an SVG-only list. The SVG
 * marks follow for clients that take them.
 *
 * Two variants per icon, one per client theme: the ink of the brand tile
 * (`packages/brand/piloti-mark.svg`: `#2a301f` on a light page, `#eef2e4` on a
 * dark one). The server's own icon is the Piloti column (`BRAND_MARK`); the
 * others are 24-unit line glyphs, one per meaning (search, describe, call,
 * report; the guide, glossary, catalog and project resources; the workflows).
 * Never per operation: in `tools` mode that would repeat ~700 bytes on each of
 * ~300 tools (the mode's budget is 1,000 characters a tool), so `tools` mode
 * carries none on its tools (its server, prompts and resources have them).
 */

import type { Icon } from '@modelcontextprotocol/server'
import { BRAND_MARK } from '@/lib/brand'

const INK = { light: '#2a301f', dark: '#eef2e4' } as const
const THEMES = ['light', 'dark'] as const

const ESCAPES: Readonly<Record<string, string>> = { '%': '%25', '<': '%3C', '>': '%3E', '#': '%23', '"': "'", ' ': '%20' }

/** `svg` as a data URI: only the characters a URL cannot carry are escaped, which keeps it short. */
function dataUri(svg: string): string {
  return `data:image/svg+xml,${svg.replace(/[%<>#" ]/g, (c) => ESCAPES[c] as string)}`
}

function icon(build: (ink: string) => string): Icon[] {
  return THEMES.map((theme) => ({ src: dataUri(build(INK[theme])), mimeType: 'image/svg+xml', sizes: ['any'], theme }))
}

/** A 24-unit line glyph; `d` may hold several subpaths. */
const glyph = (d: string): Icon[] =>
  icon(
    (ink) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`,
  )

/** The Piloti column, without its tile. */
const SERVER_MARK: Icon[] = icon(
  (ink) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${BRAND_MARK.viewBox}"><path fill="${ink}" d="${BRAND_MARK.path}"/></svg>`,
)

/** The app's PNG tiles (`public/icons/`), theme-neutral: the tile carries its own ground. */
const SERVER_TILES = [
  { path: '/icons/icon-192.png', size: '192x192' },
  { path: '/icons/icon-512.png', size: '512x512' },
] as const

/**
 * The server's icons: the PNG tiles from `origin` first, then the SVG mark. No
 * origin pinned (a dev box), no tiles: the request's own Host is never trusted
 * to name where an icon lives.
 */
export function serverIcons(origin: string | null): Icon[] {
  const tiles: Icon[] = origin
    ? SERVER_TILES.map(({ path, size }) => ({ src: `${origin}${path}`, mimeType: 'image/png', sizes: [size] }))
    : []
  return [...tiles, ...SERVER_MARK]
}

export const META_TOOL_ICONS = {
  'search-operations': glyph('M10.5 4.5a6 6 0 1 0 0 12 6 6 0 0 0 0-12ZM15 15l5 5'),
  'describe-operation': glyph('M7 3h7l4 4v14H7ZM14 3v4h4M10 12h5M10 16h5'),
  'call-operation': glyph('M8 5l11 7-11 7Z'),
  'report-missing-operation': glyph('M6 21V4M6 5h11l-2 4 2 4H6'),
} as const

export const RESOURCE_ICONS = {
  guide: glyph('M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3ZM5 17a3 3 0 0 1 3-3h10'),
  glossary: glyph('M4 5h16v11H10l-4 4v-4H4Z'),
  catalog: glyph('M9 7h11M9 12h11M9 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01'),
  project: glyph('M3 6h6l2 2h10v11H3Z'),
  // The proposal card (an MCP App view, ADR-0142): a card with a tick.
  'proposal-card': glyph('M4 5h16v14H4ZM8 12l3 3 5-6'),
} as const

export const PROMPT_ICONS = {
  'project-briefing': glyph('M8 4h8v3H8ZM6 5.5V21h12V5.5M9 12h6M9 16h6'),
  'building-law-check': glyph('M12 4v16M7 20h10M5 8h14M5 8l-2.5 6a2.5 2.5 0 0 0 5 0ZM19 8l-2.5 6a2.5 2.5 0 0 0 5 0Z'),
  'my-day': glyph('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM8 12l3 3 5-6'),
  'office-skill': glyph('M12 3l2.2 6.3L21 12l-6.8 2.7L12 21l-2.2-6.3L3 12l6.8-2.7Z'),
} as const
