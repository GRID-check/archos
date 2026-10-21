/**
 * @vitest-environment node
 */
/**
 * The RFC 9728 document an MCP client reads to find the authorization server
 * (ADR-0121). Both well-known paths serve the same document: the bare one and
 * the path-inserted one the 401 challenge points at.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { GET as pathInserted } from './api/mcp/route'
import { GET } from './route'

beforeEach(() => {
  process.env.WORKOS_AUTHKIT_DOMAIN = 'auth.piloti.test'
  process.env.GRID_MCP_RESOURCE_URL = 'https://app.piloti.test/api/mcp'
})

describe('oauth-protected-resource', () => {
  for (const [name, handler] of [['bare', GET], ['path-inserted', pathInserted]] as const) {
    it(`serves the metadata at the ${name} path`, async () => {
      const response = handler()
      expect(response.status).toBe(200)
      expect(response.headers.get('access-control-allow-origin')).toBe('*')
      expect(await response.json()).toEqual({
        resource: 'https://app.piloti.test/api/mcp',
        authorization_servers: ['https://auth.piloti.test'],
        scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
        resource_name: 'Piloti',
        bearer_methods_supported: ['header'],
      })
    })
  }

  it('takes the resource from the pinned app origin when none is set', async () => {
    delete process.env.GRID_MCP_RESOURCE_URL
    process.env.WORKOS_REDIRECT_URI = 'https://app.piloti.test/api/auth/callback'
    const body = (await GET().json()) as { resource: string }
    expect(body.resource).toBe('https://app.piloti.test/api/mcp')
  })

  it('answers 503 while AuthKit is not configured', () => {
    delete process.env.WORKOS_AUTHKIT_DOMAIN
    expect(GET().status).toBe(503)
  })
})
