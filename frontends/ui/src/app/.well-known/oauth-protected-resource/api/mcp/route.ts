/**
 * The path-inserted form of the same document (RFC 9728 section 3.1): a client
 * that learns the resource `https://host/api/mcp` asks for
 * `/.well-known/oauth-protected-resource/api/mcp`, and the 401 challenge points
 * here.
 */

import { protectedResourceMetadataResponse } from '@/lib/agent-api/mcp-config'

export const dynamic = 'force-dynamic'

export const GET = (): Response => protectedResourceMetadataResponse()
