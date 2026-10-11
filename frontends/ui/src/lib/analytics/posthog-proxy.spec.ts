/**
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { buildUpstreamUrl, forwardToPosthog } from './posthog-proxy'
import type { PostHogConfig } from './posthog-config'

const config: PostHogConfig = {
  host: 'https://eu.i.posthog.com',
  projectToken: 'phc_test',
  sessionReplay: true,
  replaySampleRate: 1,
  proxy: true,
}

const upstreamReply = (body: string | null = '{"status":1}', status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json', 'set-cookie': 'x=1', 'content-encoding': 'gzip' } })

describe('buildUpstreamUrl', () => {
  test('keeps the path, the trailing slash and the query', () => {
    expect(buildUpstreamUrl('https://app.example/ingest/e/?ip=0&ver=1.4', config.host)).toBe(
      'https://eu.i.posthog.com/e/?ip=0&ver=1.4'
    )
    expect(buildUpstreamUrl('https://app.example/ingest/i/v0/e/', config.host)).toBe(
      'https://eu.i.posthog.com/i/v0/e/'
    )
  })

  test('sends /static and /array to the asset host, everything else to the ingestion host', () => {
    expect(buildUpstreamUrl('https://app.example/ingest/static/recorder.js', config.host)).toBe(
      'https://eu-assets.i.posthog.com/static/recorder.js'
    )
    expect(buildUpstreamUrl('https://app.example/ingest/array/phc_x/config.js', config.host)).toBe(
      'https://eu-assets.i.posthog.com/array/phc_x/config.js'
    )
    expect(buildUpstreamUrl('https://app.example/ingest/flags/?v=2', config.host)).toBe(
      'https://eu.i.posthog.com/flags/?v=2'
    )
  })

  test('a self-hosted host serves its own assets', () => {
    expect(buildUpstreamUrl('https://app.example/ingest/static/x.js', 'https://ph.corp.example')).toBe(
      'https://ph.corp.example/static/x.js'
    )
  })

  test('cannot be steered to another host by the path', () => {
    expect(buildUpstreamUrl('https://app.example/ingest//evil.example/x', config.host)).toBe(
      'https://eu.i.posthog.com//evil.example/x'
    )
    expect(buildUpstreamUrl('https://app.example/ingest/@evil.example/x', config.host)).toBe(
      'https://eu.i.posthog.com/@evil.example/x'
    )
    expect(buildUpstreamUrl('https://app.example/ingest/%2e%2e/%2e%2e/x', config.host)).toBeNull()
  })

  test('is not an upstream for anything outside /ingest', () => {
    expect(buildUpstreamUrl('https://app.example/ingestion/e/', config.host)).toBeNull()
    expect(buildUpstreamUrl('https://app.example/api/healthz', config.host)).toBeNull()
  })
})

describe('forwardToPosthog', () => {
  test('answers 404 and calls nothing when analytics or the proxy is off', async () => {
    const fetchImpl = vi.fn()
    for (const off of [
      { ...config, proxy: false },
      { ...config, host: '' },
      { ...config, projectToken: '' },
    ]) {
      const response = await forwardToPosthog(new Request('https://app.example/ingest/e/', { method: 'POST' }), off, fetchImpl)
      expect(response.status).toBe(404)
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  test('forwards only the allow-listed headers, never a cookie or credential', async () => {
    const fetchImpl = vi.fn(async () => upstreamReply())
    await forwardToPosthog(
      new Request('https://app.example/ingest/e/?ip=0', {
        method: 'POST',
        body: 'data=1',
        headers: {
          'content-type': 'text/plain',
          cookie: 'wos-session=SECRET',
          authorization: 'Bearer SECRET',
          'x-grid-internal-token': 'SECRET',
          'x-forwarded-for': '203.0.113.7',
          'user-agent': 'Mozilla/5.0',
        },
      }),
      config,
      fetchImpl as unknown as typeof fetch
    )

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://eu.i.posthog.com/e/?ip=0')
    expect(init.method).toBe('POST')
    const sent = init.headers as Headers
    expect(Object.fromEntries(sent.entries())).toEqual({
      'content-type': 'text/plain',
      'user-agent': 'Mozilla/5.0',
      'x-forwarded-for': '203.0.113.7',
    })
  })

  test('returns status and body, and drops the upstream cookie and encoding headers', async () => {
    const fetchImpl = vi.fn(async () => upstreamReply('{"ok":true}', 200))
    const response = await forwardToPosthog(new Request('https://app.example/ingest/flags/'), config, fetchImpl as unknown as typeof fetch)

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"ok":true}')
    expect(response.headers.get('content-type')).toBe('application/json')
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(response.headers.get('content-encoding')).toBeNull()
  })

  test('does not send a body with a GET', async () => {
    const fetchImpl = vi.fn(async () => upstreamReply('x'))
    await forwardToPosthog(new Request('https://app.example/ingest/static/recorder.js'), config, fetchImpl as unknown as typeof fetch)
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.body).toBeUndefined()
  })

  test('an unreachable PostHog is a 502, never a throw', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network')
    })
    const response = await forwardToPosthog(new Request('https://app.example/ingest/e/', { method: 'POST', body: 'x' }), config, fetchImpl as unknown as typeof fetch)
    expect(response.status).toBe(502)
  })
})

/**
 * The route lives outside `app/api`, so `authz-coverage.spec.ts` never sees it.
 * The two facts that spec guards are pinned here: it comes from a factory, and
 * it states why it is public.
 */
describe('the /ingest route file', () => {
  const source = readFileSync(join(process.cwd(), 'src/app/ingest/[...path]/route.ts'), 'utf8')

  test('declares every handler through publicApiRoute with a why', () => {
    expect(source).toMatch(/export const GET = publicApiRoute\(/)
    expect(source).toMatch(/export const POST = publicApiRoute\(/)
    expect(source).toMatch(/\bwhy:/)
    expect(source).not.toMatch(/export (async )?function (GET|POST|PUT|PATCH|DELETE)/)
  })

  test('is left out of the auth proxy matcher', () => {
    expect(readFileSync(join(process.cwd(), 'src/proxy.ts'), 'utf8')).toContain('|ingest/')
  })
})
