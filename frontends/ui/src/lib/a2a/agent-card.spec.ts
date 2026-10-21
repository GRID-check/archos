/**
 * @vitest-environment node
 */
/**
 * Piloti's A2A agent card (ADR-0123): the endpoint and the two protocol
 * versions it speaks, the agent door's OAuth scheme, one skill, and the 1.0
 * serialization the well-known path answers.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { a2aEndpointUrl, agentCardResponse, buildAgentCard, A2A_SECURITY_SCHEME } from './agent-card'

const ENV = {
  WORKOS_AUTHKIT_DOMAIN: 'auth.piloti.test',
  GRID_MCP_RESOURCE_URL: 'https://app.piloti.test/api/mcp',
}

describe('buildAgentCard', () => {
  it('is null while the deployment has no AuthKit domain or origin', () => {
    expect(buildAgentCard({})).toBeNull()
    expect(buildAgentCard({ GRID_MCP_RESOURCE_URL: ENV.GRID_MCP_RESOURCE_URL })).toBeNull()
  })

  it('names /api/a2a on the agent door’s origin, for A2A 1.0 and 0.3 over JSON-RPC', () => {
    expect(a2aEndpointUrl(ENV)?.href).toBe('https://app.piloti.test/api/a2a')
    const card = buildAgentCard(ENV)
    expect(card?.supportedInterfaces.map((entry) => [entry.url, entry.protocolBinding, entry.protocolVersion])).toEqual(
      expect.arrayContaining([
        ['https://app.piloti.test/api/a2a', 'JSONRPC', '1.0'],
        ['https://app.piloti.test/api/a2a', 'JSONRPC', '0.3'],
      ]),
    )
    expect(card?.capabilities).toMatchObject({ streaming: true, pushNotifications: false })
  })

  it('requires the agent door’s OAuth scheme, AuthKit with PKCE, and names the resource to ask for', () => {
    const card = buildAgentCard(ENV)
    const scheme = card?.securitySchemes[A2A_SECURITY_SCHEME]?.scheme
    expect(scheme?.$case).toBe('oauth2SecurityScheme')
    if (scheme?.$case !== 'oauth2SecurityScheme') return
    expect(scheme.value.description).toContain('https://app.piloti.test/api/mcp')
    expect(scheme.value.flows?.flow).toMatchObject({
      $case: 'authorizationCode',
      value: {
        authorizationUrl: 'https://auth.piloti.test/oauth2/authorize',
        tokenUrl: 'https://auth.piloti.test/oauth2/token',
        pkceRequired: true,
      },
    })
    expect(card?.securityRequirements).toEqual([{ schemes: { [A2A_SECURITY_SCHEME]: { list: [] } } }])
  })

  it('offers one skill, consult, and leads with the workspace for architects', () => {
    const card = buildAgentCard(ENV)
    expect(card?.skills.map((skill) => skill.id)).toEqual(['consult'])
    expect(card?.description).toMatch(/^Piloti is the workspace for architects/)
  })
})

describe('agentCardResponse', () => {
  const saved = { ...process.env }
  beforeEach(() => Object.assign(process.env, ENV))
  afterEach(() => {
    process.env = { ...saved }
  })

  it('answers the card in the 1.0 JSON serialization, public and cacheable', async () => {
    const response = agentCardResponse()
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const json = (await response.json()) as Record<string, unknown>
    expect(json).toMatchObject({ name: 'Piloti', capabilities: { streaming: true } })
    expect(JSON.stringify(json.securitySchemes)).toContain('oauth2SecurityScheme')
  })

  it('answers 503 while the agent door is not configured', () => {
    delete process.env.WORKOS_AUTHKIT_DOMAIN
    expect(agentCardResponse().status).toBe(503)
  })
})
