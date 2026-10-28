// @disk-inputs: src/styles/tokens.css
/**
 * @vitest-environment node
 */
/**
 * The installed app's chrome agrees with itself: the manifest, the
 * `theme-color` meta and the paper token are one colour, and iOS gets the
 * standalone metadata it reads from `<head>` rather than from the manifest.
 *
 * The manifest once carried an olive (`#2a301f`) that matched no token, so an
 * installed Piloti opened with a dark title band over a light app.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

import manifest from './manifest'
import { THEME_COLOR } from './theme-boot'
import { PRODUCT_NAME } from '@/lib/brand'

vi.mock('next/font/google', () => {
  const font = (options: Record<string, unknown>) => ({ className: '', variable: String(options.variable), style: {} })
  return { Geist: font, Geist_Mono: font }
})
vi.mock('./providers', () => ({ Providers: () => null }))
vi.mock('./chunk-reload-guard', () => ({ ChunkReloadGuard: () => null }))
vi.mock('@/components/shell/navigation-trail', () => ({ NavigationTrail: () => null }))
vi.mock('@/lib/auth/session', () => ({ getGridSession: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ runWithTenantSlot: vi.fn() }))
vi.mock('@/lib/documents/vlm-capability', () => ({ isVlmConfigured: vi.fn() }))
vi.mock('@/i18n/server', () => ({ getLocale: vi.fn() }))

describe('installed app chrome', () => {
  test('the manifest paints the paper the app opens on', () => {
    const { theme_color, background_color } = manifest()

    expect(theme_color).toBe(THEME_COLOR.light)
    expect(background_color).toBe(THEME_COLOR.light)
  })

  test('THEME_COLOR is still the --background token of each theme', () => {
    // The token is oklch with its hex in a comment; the comment is the contract
    // `theme-boot.ts` states ("Retune both together").
    const tokens = readFileSync(join(__dirname, '..', 'styles', 'tokens.css'), 'utf8')
    const backgrounds = [...tokens.matchAll(/^\s*--background:[^;]+;\s*\/\*\s*(#[0-9a-f]{6})/gim)].map((m) => m[1])

    expect(backgrounds).toEqual([THEME_COLOR.light, THEME_COLOR.dark])
  })

  test('iOS gets standalone metadata, under the product name', async () => {
    const { metadata } = await import('./layout')

    expect(metadata.appleWebApp).toEqual({ capable: true, title: PRODUCT_NAME, statusBarStyle: 'default' })
  })
})
