/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { nextConfig } from '../../../next.config'

describe('the old office-shelf URLs', () => {
  it('redirect permanently from /app/archiv, query string included by Next', async () => {
    const redirects = (await nextConfig.redirects?.()) ?? []
    expect(redirects).toContainEqual({ source: '/app/archiv', destination: '/app/office-shelf', permanent: true })
    expect(redirects).toContainEqual({
      source: '/app/archiv/:path*',
      destination: '/app/office-shelf/:path*',
      permanent: true,
    })
  })

  it('keep /api/archiv/* answering through a rewrite', async () => {
    const rewrites = await nextConfig.rewrites?.()
    expect(rewrites).toEqual([{ source: '/api/archiv/:path*', destination: '/api/office-shelf/:path*' }])
  })
})
