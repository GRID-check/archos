/**
 * Piloti's A2A agent card (ADR-0122): what an A2A client reads at
 * `/.well-known/agent-card.json` before it sends a message.
 *
 * One skill, `consult`: ask Piloti a question as the person the client acts
 * for. The JSON-RPC endpoint is `/api/a2a`, served for A2A 1.0 and, for
 * clients that still speak it, 0.3 (`duplicateInterfacesForLegacy`). The
 * security scheme is the agent door's: OAuth 2.1 authorization code with PKCE
 * at WorkOS AuthKit, and the token must be issued for the agent door's
 * resource (`mcpResourceUrl`, RFC 8707), because `/api/a2a` verifies it
 * exactly as `/api/mcp` does.
 *
 * Read from the environment at call time, like `mcp-config.ts`; `null` while
 * the deployment has no AuthKit domain or no app origin, and then the card
 * route answers 503, as the protected-resource metadata does.
 */

import { type AgentCard, AgentCard as AgentCardCodec } from '@a2a-js/sdk'
import { duplicateInterfacesForLegacy } from '@a2a-js/sdk/compat/v0_3'
import { authkitIssuer, MCP_SCOPES_SUPPORTED, mcpResourceUrl } from '@/lib/agent-api/mcp-config'
import { PRODUCT_NAME } from '@/lib/brand'
import { ASK_WAIT_SECONDS } from '@/lib/piloti-asks/ask-wire'

export const A2A_PATH = '/api/a2a'

/** The name the security scheme goes by in `securitySchemes` and `securityRequirements`. */
export const A2A_SECURITY_SCHEME = 'workos-authkit'

/** The protocol versions `/api/a2a` speaks: 1.0, and 0.3 through the SDK's compatibility layer. */
export const A2A_VERSIONS = ['1.0', '0.3'] as const

type Env = Record<string, string | undefined>

/** The A2A endpoint's URL: the agent door's origin plus `/api/a2a`, or null when there is none. */
export function a2aEndpointUrl(env: Env = process.env): URL | null {
  const resource = mcpResourceUrl(env)
  return resource ? new URL(A2A_PATH, resource.origin) : null
}

export function buildAgentCard(env: Env = process.env): AgentCard | null {
  const issuer = authkitIssuer(env)
  const resource = mcpResourceUrl(env)
  const endpoint = a2aEndpointUrl(env)
  if (!issuer || !resource || !endpoint) return null
  const scopes = Object.fromEntries(MCP_SCOPES_SUPPORTED.map((scope) => [scope, scope]))
  return {
    name: PRODUCT_NAME,
    description:
      'Piloti is the workspace for architects: a planning office runs its projects and processes in it, and ' +
      'Piloti, the agent, is a colleague in that office. Ask it what you would ask a colleague who knows the ' +
      'office’s documents, the project’s files and building law; it answers as the person you act for, with ' +
      'their rights, and may file a document.',
    supportedInterfaces: duplicateInterfacesForLegacy(
      [{ url: endpoint.href, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
      ['JSONRPC'],
    ),
    provider: { organization: PRODUCT_NAME, url: endpoint.origin },
    version: '1.0.0',
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes: {
      [A2A_SECURITY_SCHEME]: {
        scheme: {
          $case: 'oauth2SecurityScheme',
          value: {
            description:
              `Sign in to ${PRODUCT_NAME} with WorkOS AuthKit (authorization code with PKCE). Request the token ` +
              `for the resource ${resource.href} (RFC 8707): the A2A endpoint accepts the agent door's tokens.`,
            oauth2MetadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
            flows: {
              flow: {
                $case: 'authorizationCode',
                value: {
                  authorizationUrl: `${issuer}/oauth2/authorize`,
                  tokenUrl: `${issuer}/oauth2/token`,
                  refreshUrl: `${issuer}/oauth2/token`,
                  scopes,
                  pkceRequired: true,
                },
              },
            },
          },
        },
      },
    },
    securityRequirements: [{ schemes: { [A2A_SECURITY_SCHEME]: { list: [] } } }],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: [
      {
        id: 'consult',
        name: 'Ask Piloti',
        description:
          'A question or request for Piloti, in German or English. Piloti answers from the office’s documents, ' +
          'the project’s files and building law, as the signed-in person. Put a project id in the message ' +
          `metadata as "projectId" to ask about one project; send the task's contextId to follow up. A blocking ` +
          `call waits for the answer; with returnImmediately the task is "working" after at most ${ASK_WAIT_SECONDS} ` +
          'seconds and GetTask reads it later. An answer is an artifact of text; a document Piloti filed is an ' +
          'artifact naming it.',
        tags: ['architecture', 'building law', 'project documents', 'planning office'],
        examples: [
          'Welche Brandschutzanforderungen gelten für das Stiegenhaus im Projekt Hauptstraße 12?',
          'Summarize the open review comments in project Hauptstraße 12.',
        ],
        inputModes: ['text/plain'],
        outputModes: ['text/plain', 'application/json'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  }
}

/** The card as JSON, in the 1.0 serialization. */
export function agentCardJson(card: AgentCard): unknown {
  return AgentCardCodec.toJSON(card)
}

/** The response `/.well-known/agent-card.json` answers. Public by specification. */
export function agentCardResponse(env: Env = process.env): Response {
  const card = buildAgentCard(env)
  if (!card) {
    return Response.json(
      { error: 'The agent door is not configured on this deployment (WORKOS_AUTHKIT_DOMAIN)' },
      { status: 503 },
    )
  }
  return Response.json(agentCardJson(card), {
    headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' },
  })
}
