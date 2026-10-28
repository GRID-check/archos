/**
 * RFC 9728 protected-resource metadata for the agent door (ADR-0122): tells an
 * MCP client which authorization server (WorkOS AuthKit) issues tokens for
 * `/api/mcp`. Public by specification; the proxy lets `/.well-known/*` through.
 */

import { protectedResourceMetadataResponse } from '@/lib/agent-api/mcp-config'

export const dynamic = 'force-dynamic'

export const GET = (): Response => protectedResourceMetadataResponse()
