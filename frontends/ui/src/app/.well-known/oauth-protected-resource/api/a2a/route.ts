/**
 * The A2A door's protected-resource metadata (RFC 9728 section 3.1, ADR-0123):
 * a client that learns the resource `https://host/api/a2a` asks for
 * `/.well-known/oauth-protected-resource/api/a2a`, and the door's 401 challenge
 * points here. The `resource` must be the one the client asked about, so this is
 * not the MCP door's document.
 */

import { protectedResourceMetadataResponse } from '@/lib/agent-api/mcp-config'

export const dynamic = 'force-dynamic'

export const GET = (): Response => protectedResourceMetadataResponse('a2a')
