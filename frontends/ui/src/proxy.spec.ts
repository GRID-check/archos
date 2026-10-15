/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { artImage } from '@/lib/art'

const mockMiddleware = vi.fn()
const mockAuthkitMiddleware = vi.fn(() => mockMiddleware)

vi.doMock('@workos-inc/authkit-nextjs', () => ({
  authkitMiddleware: mockAuthkitMiddleware,
}))

describe('AuthKit v4 proxy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  test('configures authkitMiddleware with public landing, AuthKit callback, and error pages allow-listed', async () => {
    await import('./proxy')

    expect(mockAuthkitMiddleware).toHaveBeenCalledWith(
      expect.objectContaining({
        middlewareAuth: expect.objectContaining({
          unauthenticatedPaths: [
            '/',
            '/api/healthz',
            '/api/auth/callback',
            '/api/auth/signin',
            '/api/auth/websocket-scope',
            '/auth/error',
            '/api/internal/(.*)',
            // The image optimizer re-enters the router in-process, so
            // middleware runs on this route with a cookie-less mocked request.
            '/api/documents/(.*)/image',
          ],
        }),
      })
    )
  })

  test('leaves icons, riso art, manifest and robots.txt outside the auth redirect', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    const publicFiles = [
      '/favicon.ico',
      '/icon.svg',
      '/apple-icon.png',
      '/manifest.webmanifest',
      '/robots.txt',
      '/sw.js',
      '/icons/icon-192.png',
      // by id, as the app reaches art: a literal /art/ path fails the riso check
      new URL(artImage('vignetten/bauplatz/empty').src, 'http://localhost').pathname,
    ]

    for (const path of publicFiles) expect(matcher.test(path), path).toBe(false)
    expect(matcher.test('/app/projects')).toBe(true)
  })

  // The SDK posts from signed-out pages and mid-expiry; AuthKit would answer a
  // beacon with a redirect to the WorkOS login page and lose the event.
  test('leaves the first-party PostHog relay outside the auth redirect', async () => {
    const { config } = await import('./proxy')
    const matcher = new RegExp(`^${config.matcher[0]}$`)

    for (const path of ['/ingest/e/', '/ingest/s/', '/ingest/flags/', '/ingest/static/recorder.js', '/ingest/array/phc_x/config.js']) {
      expect(matcher.test(path), path).toBe(false)
    }
    // Only the relay's prefix: a page that merely starts with the word is still guarded.
    expect(matcher.test('/ingestion')).toBe(true)
    expect(matcher.test('/app/ingest/x')).toBe(true)
  })

  test('delegates requests to the authkitMiddleware', async () => {
    const { default: proxy } = await import('./proxy')
    const request = { url: 'http://localhost:3000/api/v1/collections' } as never
    const event = {} as never

    await proxy(request, event)

    expect(mockMiddleware).toHaveBeenCalledWith(request, event)
  })
})
