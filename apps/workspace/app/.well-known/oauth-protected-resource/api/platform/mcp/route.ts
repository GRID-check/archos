/**
 * The platform door's protected-resource metadata (RFC 9728 section 3.1,
 * ADR-0126): a client that learns the resource `https://host/api/platform/mcp`
 * asks for `/.well-known/oauth-protected-resource/api/platform/mcp`, and the
 * door's 401 challenge points here. Its `resource` is the platform door's, so a
 * client asks WorkOS for a token of that audience and no other.
 */

import { protectedResourceMetadataResponse } from '@/lib/agent-api/mcp-config'

export const dynamic = 'force-dynamic'

export const GET = (): Response => protectedResourceMetadataResponse('platform')
